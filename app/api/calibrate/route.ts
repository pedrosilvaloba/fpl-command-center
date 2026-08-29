import { NextRequest, NextResponse } from "next/server";
import { getBootstrap, getFixtures, getElementSummary } from "@/lib/fpl-client";
import { getRedis } from "@/lib/kv";
import { checkApiToken, unauthorizedBody } from "@/lib/apitoken";
import { calibrate, type CalibrationReport } from "@/lib/calibration";
import { PARAM_GRIDS, type TunableParam } from "@/lib/modelparams";
import type { ElementHistoryRow } from "@/lib/backtest";
import type { FplElement } from "@/lib/types";

/**
 * Runs the calibration sweep (lib/calibration.ts) and caches the report.
 *
 * COST. This is the most expensive thing in the project by a wide margin:
 * one full replay of every gameweek per candidate value per parameter. The
 * twelve tunable parameters have five or six candidates each, so a full
 * sweep is roughly sixty replays. That is why it is a deliberate, on-demand
 * route with a long timeout and not something a page load can trigger.
 *
 * Pass `?params=underlyingBlend,shrinkXg` to sweep a subset, which is what
 * the weekly scheduled run does — a couple of parameters at a time, rotating,
 * keeps each run cheap while the whole set still gets covered.
 *
 * Same access shape as /api/backtest: `?cached=1` reads the last report and
 * needs no token; running a fresh sweep does.
 */

export const dynamic = "force-dynamic";
// 300 is the ceiling on Vercel's Hobby plan. Setting it higher does not
// give a longer function — the DEPLOYMENT is rejected outright
// ("invalid_max_duration"), which is how the v1.30 deploy died. The sweep
// therefore works to a time budget instead of assuming it has all day.
export const maxDuration = 300;

/** Leave headroom for fetching histories and serialising the reply. */
const SWEEP_BUDGET_MS = 210_000;

/** Most parameters one request may sweep. A full twelve-parameter sweep
 * cannot fit in 300 seconds, and pretending otherwise just wastes the run.
 * The weekly scheduled task rotates through them three at a time. */
const MAX_PARAMS_PER_RUN = 4;

const CACHE_KEY = "calibration:last";
const HISTORY_KEY = (id: number, upTo: number) => `backtest:hist:${id}:${upTo}`;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 14;

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

function chooseSample(elements: FplElement[], size: number): FplElement[] {
  const perPosition = Math.max(4, Math.floor(size / 8));
  const chosen = new Map<number, FplElement>();
  for (const type of [1, 2, 3, 4]) {
    elements
      .filter((el) => el.element_type === type)
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, perPosition)
      .forEach((el) => chosen.set(el.id, el));
  }
  for (const el of [...elements].sort((a, b) => b.total_points - a.total_points)) {
    if (chosen.size >= size) break;
    chosen.set(el.id, el);
  }
  return [...chosen.values()];
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const redis = getRedis();

  if (params.get("cached") === "1") {
    const cached = redis ? await redis.get<CalibrationReport>(CACHE_KEY) : null;
    if (!cached) {
      return NextResponse.json(
        { error: "ainda não há calibração guardada", configured: !!redis },
        { status: 404 }
      );
    }
    return NextResponse.json(cached);
  }

  const auth = checkApiToken(params.get("token"));
  if (!auth.ok) {
    return NextResponse.json(unauthorizedBody(auth), { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const [bootstrap, fixtures] = await Promise.all([getBootstrap(), getFixtures()]);
    const finishedEvents = bootstrap.events
      .filter((e) => e.finished)
      .map((e) => e.id)
      .sort((a, b) => a - b);

    if (finishedEvents.length < 2) {
      return NextResponse.json(
        {
          error: "jornadas terminadas insuficientes para calibrar",
          finished: finishedEvents.length,
          note: "A calibração precisa de jornadas passadas para reconstruir. Volta quando houver mais.",
        },
        { status: 409 }
      );
    }

    const lastFinished = finishedEvents[finishedEvents.length - 1];
    const fromEvent = Math.max(2, parseInt(params.get("from") ?? "2", 10) || 2);
    const toEvent = Math.min(
      lastFinished,
      parseInt(params.get("to") ?? String(lastFinished), 10) || lastFinished
    );
    const sampleSize = Math.min(
      300,
      Math.max(40, parseInt(params.get("sample") ?? "150", 10) || 150)
    );

    const requested = (params.get("params") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => s in PARAM_GRIDS) as TunableParam[];

    const sample = chooseSample(bootstrap.elements, sampleSize);
    const histories = await mapWithLimit(sample, 8, async (el) => {
      const key = HISTORY_KEY(el.id, lastFinished);
      if (redis) {
        const hit = await redis.get<ElementHistoryRow[]>(key);
        if (hit) return [el.id, hit] as const;
      }
      try {
        const summary = await getElementSummary(el.id);
        const rows = (summary.history ?? []) as ElementHistoryRow[];
        if (redis) await redis.set(key, rows, { ex: HISTORY_TTL_SECONDS });
        return [el.id, rows] as const;
      } catch {
        return [el.id, [] as ElementHistoryRow[]] as const;
      }
    });

    const historyByElement = new Map<number, ElementHistoryRow[]>(
      histories.filter(([, rows]) => rows.length > 0)
    );
    if (historyByElement.size === 0) {
      return NextResponse.json(
        { error: "não foi possível obter histórico de nenhum jogador" },
        { status: 502 }
      );
    }

    const report = calibrate({
      bootstrap,
      fixtures,
      historyByElement,
      fromEvent,
      toEvent,
      params:
        requested.length > 0
          ? requested.slice(0, MAX_PARAMS_PER_RUN)
          : (Object.keys(PARAM_GRIDS) as TunableParam[]).slice(0, MAX_PARAMS_PER_RUN),
      deadlineMs: startedAt + SWEEP_BUDGET_MS,
    });

    if (redis) await redis.set(CACHE_KEY, report);

    return NextResponse.json({ ...report, playersSampled: historyByElement.size, stored: !!redis });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falha a calibrar" },
      { status: 500 }
    );
  }
}
