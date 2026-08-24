import { NextRequest, NextResponse } from "next/server";
import { getBootstrap, getFixtures, getElementSummary } from "@/lib/fpl-client";
import { getRedis } from "@/lib/kv";
import {
  runBacktest,
  type ElementHistoryRow,
  type BacktestResult,
} from "@/lib/backtest";
import type { FplElement } from "@/lib/types";

/**
 * Runs the backtesting harness (lib/backtest.ts) and caches the result.
 *
 * WHY THIS IS A ROUTE AND NOT A SCRIPT
 *
 * The environment this project is developed in reaches the internet through
 * a proxy with a strict host allowlist, and `fantasy.premierleague.com` is
 * not on it — every direct fetch dies at the CONNECT stage. The per-player
 * match history the harness needs therefore cannot be downloaded during
 * development at all. It can only be fetched from inside the deployed app,
 * which has ordinary outbound access. Same constraint, same reason, as
 * /api/insights/push.
 *
 * COST CONTROL
 *
 * One HTTP request per player. That is the expensive part, and it is why
 * this samples rather than sweeping all ~700: the default 150 covers
 * essentially every player anyone realistically owns. Per-player history
 * for a FINISHED gameweek never changes, so each player's rows are cached
 * in Redis and re-fetched only when the sample or the season moves on.
 *
 * Not linked from the dashboard's normal flow and never called on page
 * load — it is a model-development instrument, run deliberately.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CACHE_KEY = "backtest:last";
const HISTORY_KEY = (id: number, upTo: number) => `backtest:hist:${id}:${upTo}`;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 14;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.INSIGHTS_API_TOKEN;
  if (!expected) return false;
  const provided = req.nextUrl.searchParams.get("token") ?? "";
  return provided.length > 0 && provided === expected;
}

/** Bounded-concurrency map. The FPL API is public and unthrottled in
 * theory; hammering it with 150 simultaneous requests is still the wrong
 * way to treat someone else's free service, and it is the fastest way to
 * get rate-limited into a useless result. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The sample. Ranked by total points, but with a floor of players per
 * position so a points ranking does not quietly produce a sample of
 * forwards and no goalkeepers — the model's error profile differs most by
 * position, which is exactly what a skewed sample would hide.
 */
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

  // The cached read needs no token: it exposes aggregate accuracy numbers
  // about this app's own model and nothing about anyone's team.
  if (params.get("cached") === "1") {
    const cached = redis ? await redis.get<BacktestResult>(CACHE_KEY) : null;
    if (!cached) {
      return NextResponse.json(
        { error: "ainda não há backtest guardado", configured: !!redis },
        { status: 404 }
      );
    }
    return NextResponse.json(cached);
  }

  if (!isAuthorized(req)) {
    return NextResponse.json(
      { error: "não autorizado — falta o parâmetro 'token' ou não corresponde a INSIGHTS_API_TOKEN" },
      { status: 401 }
    );
  }

  try {
    const [bootstrap, fixtures] = await Promise.all([getBootstrap(), getFixtures()]);

    const finishedEvents = bootstrap.events
      .filter((e) => e.finished)
      .map((e) => e.id)
      .sort((a, b) => a - b);
    if (finishedEvents.length < 2) {
      return NextResponse.json(
        {
          error: "jornadas terminadas insuficientes para um backtest",
          finished: finishedEvents.length,
        },
        { status: 409 }
      );
    }

    // The first gameweek can never be backtested: there is no history
    // before it, so the model would be scored on a prediction it had no
    // evidence to make. Start from the second at the earliest.
    const lastFinished = finishedEvents[finishedEvents.length - 1];
    const fromEvent = Math.max(
      2,
      Math.min(lastFinished, parseInt(params.get("from") ?? "2", 10) || 2)
    );
    const toEvent = Math.max(
      fromEvent,
      Math.min(lastFinished, parseInt(params.get("to") ?? String(lastFinished), 10) || lastFinished)
    );
    const sampleSize = Math.min(
      400,
      Math.max(40, parseInt(params.get("sample") ?? "150", 10) || 150)
    );

    const sample = chooseSample(bootstrap.elements, sampleSize);

    let fetched = 0;
    let fromCache = 0;
    const histories = await mapWithLimit(sample, 8, async (el) => {
      const key = HISTORY_KEY(el.id, lastFinished);
      if (redis) {
        const hit = await redis.get<ElementHistoryRow[]>(key);
        if (hit) {
          fromCache++;
          return [el.id, hit] as const;
        }
      }
      try {
        const summary = await getElementSummary(el.id);
        const rows = (summary.history ?? []) as ElementHistoryRow[];
        fetched++;
        if (redis) await redis.set(key, rows, { ex: HISTORY_TTL_SECONDS });
        return [el.id, rows] as const;
      } catch {
        // One player's history failing must not take the whole run with
        // it; the sample simply loses that player.
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

    const result = runBacktest({
      bootstrap,
      fixtures,
      historyByElement,
      fromEvent,
      toEvent,
    });

    if (redis) await redis.set(CACHE_KEY, result);

    return NextResponse.json({
      ...result,
      fetch: { fetched, fromCache, requested: sample.length },
      stored: !!redis,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falha a correr o backtest" },
      { status: 500 }
    );
  }
}
