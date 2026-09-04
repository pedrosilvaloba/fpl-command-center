import { getBootstrap, getFixtures, getElementSummary } from "./fpl-client";
import { getRedis } from "./kv";
import { runBacktest, type ElementHistoryRow, type BacktestResult } from "./backtest";
import { calibrate, type CalibrationReport } from "./calibration";
import { PARAM_GRIDS, type TunableParam } from "./modelparams";
import type { FplBootstrap, FplElement, FplFixture } from "./types";

/**
 * THE TWO JOBS THAT NEVER NEEDED A LANGUAGE MODEL.
 *
 * The weekly maintenance of this project was scheduled as three assistant
 * sessions: one to run the backtest, one to run the calibration sweep, one to
 * do tactical research. Two of the three failed silently for weeks — a run
 * lasted eight and a half minutes, did real work, returned FAILED, and left
 * `lastRun` untouched. From inside a session there is nothing to fix: the
 * scheduler is not part of this codebase, and the sandbox those sessions run
 * in cannot even reach *.vercel.app except through one specific tool.
 *
 * The insight that actually resolves it is that TWO OF THE THREE JOBS DO NOT
 * NEED AN ASSISTANT AT ALL. The backtest is arithmetic over FPL's own match
 * history. The calibration sweep is a grid search. Neither needs judgement,
 * language, or research — an assistant was only ever calling an HTTP endpoint
 * and reading the answer back. That is a cron job wearing a very expensive
 * costume.
 *
 * So this module extracts both jobs out of their routes and into plain
 * functions the app can call in-process. /api/cron/refresh then runs them on
 * Vercel's own scheduler: no assistant session, no token round-trip, no
 * proxy, no HTTP hop, and one fewer moving part that can fail without saying
 * so. The tactical research genuinely does need an assistant, so it stays
 * where it is — and the staleness alarm is what makes ITS failures visible.
 *
 * WHAT WAS ALSO WRONG, AND IS FIXED HERE. The two routes had byte-identical
 * copies of `mapWithLimit` and `chooseSample`, and a third copy of the
 * history-caching logic each. Duplicated code drifts; the sampling rule in
 * particular MUST be identical between backtest and calibration, because a
 * calibration tuned on one sample and validated against another is measuring
 * the difference between the samples.
 */

/** Per-player match history is immutable once a gameweek has finished, so it
 * is cached hard and only re-fetched when the season moves on. */
const HISTORY_KEY = (id: number, upTo: number) => `backtest:hist:${id}:${upTo}`;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 14;

export const BACKTEST_CACHE_KEY = "backtest:last";
export const CALIBRATION_CACHE_KEY = "calibration:last";

/** Bounded-concurrency map. The FPL API is public and unthrottled in theory;
 * hammering it with 150 simultaneous requests is still the wrong way to treat
 * someone else's free service, and the fastest way to be rate-limited into a
 * useless result. */
export async function mapWithLimit<T, R>(
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

/**
 * The sample.
 *
 * SELECTED ON PRICE, NOT ON POINTS — AND THE REASON IS A REAL BUG THAT
 * PRODUCED A REAL, WRONG NUMBER ON THE LIVE DASHBOARD.
 *
 * This used to rank by `total_points` and take the top 150. The first live
 * backtest, over gameweek 2, reported:
 *
 *     MAE 4.04 (base 4.49) · Spearman -0.241
 *
 * A NEGATIVE rank correlation: the model's ordering appeared to be inverted
 * against reality. That is not a model that is merely weak, it is a model
 * that would be worth following backwards — and it was not true.
 *
 * `total_points` is the season total INCLUDING the gameweek being tested.
 * With two gameweeks played it is almost entirely made OF that gameweek. So
 * the sample was selected on the very outcome being predicted, and selection
 * on a common effect is the textbook way to manufacture a negative
 * correlation out of nothing:
 *
 *   - A player the model rated HIGHLY is in the top 150 on that rating's
 *     merits, whatever he scored.
 *   - A player the model rated POORLY is only in the top 150 if he scored
 *     heavily anyway.
 *
 * Condition on the total and the two become anti-correlated inside the
 * sample even if the model is perfectly sound outside it. This is a collider,
 * and I built one into the measuring instrument.
 *
 * Price is the honest alternative. FPL sets it before a ball is kicked and
 * moves it in £0.1 steps, so after two gameweeks it is almost pure
 * pre-season prior — and it selects exactly the players anyone would
 * actually consider. It is not perfectly clean (prices do drift with
 * performance over a season, so late-season samples carry a little of the
 * same contamination), and saying so here is cheaper than discovering it
 * again from another impossible number.
 *
 * The positional floor stays: the model's error profile differs most BY
 * POSITION, and a single ranking would quietly produce a sample of forwards
 * and no goalkeepers.
 */
export function chooseSample(elements: FplElement[], size: number): FplElement[] {
  const perPosition = Math.max(4, Math.floor(size / 8));
  const byPrior = (a: FplElement, b: FplElement) => b.now_cost - a.now_cost;
  const chosen = new Map<number, FplElement>();
  for (const type of [1, 2, 3, 4]) {
    elements
      .filter((el) => el.element_type === type)
      .sort(byPrior)
      .slice(0, perPosition)
      .forEach((el) => chosen.set(el.id, el));
  }
  for (const el of [...elements].sort(byPrior)) {
    if (chosen.size >= size) break;
    chosen.set(el.id, el);
  }
  return [...chosen.values()];
}

export interface SeasonWindow {
  bootstrap: FplBootstrap;
  fixtures: FplFixture[];
  finishedEvents: number[];
  lastFinished: number;
}

/** Fetches the season state both jobs start from. Throws only on a real
 * network failure; "not enough gameweeks yet" is a normal answer, handled by
 * the callers. */
export async function loadSeason(): Promise<SeasonWindow> {
  const [bootstrap, fixtures] = await Promise.all([getBootstrap(), getFixtures()]);
  const finishedEvents = bootstrap.events
    .filter((e) => e.finished)
    .map((e) => e.id)
    .sort((a, b) => a - b);
  return {
    bootstrap,
    fixtures,
    finishedEvents,
    lastFinished: finishedEvents[finishedEvents.length - 1] ?? 0,
  };
}

export interface HistoryLoad {
  historyByElement: Map<number, ElementHistoryRow[]>;
  fetched: number;
  fromCache: number;
  requested: number;
}

export async function loadHistories(
  season: SeasonWindow,
  sampleSize: number
): Promise<HistoryLoad> {
  const redis = getRedis();
  const sample = chooseSample(season.bootstrap.elements, sampleSize);
  let fetched = 0;
  let fromCache = 0;

  const rows = await mapWithLimit(sample, 8, async (el) => {
    const key = HISTORY_KEY(el.id, season.lastFinished);
    if (redis) {
      const hit = await redis.get<ElementHistoryRow[]>(key);
      if (hit) {
        fromCache++;
        return [el.id, hit] as const;
      }
    }
    try {
      const summary = await getElementSummary(el.id);
      const history = (summary.history ?? []) as ElementHistoryRow[];
      fetched++;
      if (redis) await redis.set(key, history, { ex: HISTORY_TTL_SECONDS });
      return [el.id, history] as const;
    } catch {
      // One player's history failing must not take the whole run with it;
      // the sample simply loses that player.
      return [el.id, [] as ElementHistoryRow[]] as const;
    }
  });

  return {
    historyByElement: new Map(rows.filter(([, h]) => h.length > 0)),
    fetched,
    fromCache,
    requested: sample.length,
  };
}

export type JobOutcome<T> =
  | {
      ok: true;
      result: T;
      summary: string;
      /** Did the run actually produce something, as opposed to merely
       * finishing without error? See the `productive` note in lib/joblog.ts:
       * a job that completes cleanly and does nothing must not show green. */
      productive: boolean;
      detail: Record<string, unknown>;
    }
  | { ok: false; error: string; retryable: boolean };

export interface BacktestJobOptions {
  sampleSize?: number;
  fromEvent?: number;
  toEvent?: number;
}

export async function runBacktestJob(
  opts: BacktestJobOptions = {}
): Promise<JobOutcome<BacktestResult>> {
  const season = await loadSeason();
  if (season.finishedEvents.length < 2) {
    return {
      ok: false,
      retryable: false,
      error: `jornadas terminadas insuficientes para um backtest (${season.finishedEvents.length})`,
    };
  }

  // The first gameweek can never be backtested: there is no history before
  // it, so the model would be scored on a prediction it had no evidence to
  // make. Start from the second at the earliest.
  const fromEvent = Math.max(2, Math.min(season.lastFinished, opts.fromEvent ?? 2));
  const toEvent = Math.max(
    fromEvent,
    Math.min(season.lastFinished, opts.toEvent ?? season.lastFinished)
  );
  const sampleSize = Math.min(400, Math.max(40, opts.sampleSize ?? 150));

  const load = await loadHistories(season, sampleSize);
  if (load.historyByElement.size === 0) {
    return {
      ok: false,
      retryable: true,
      error: "não foi possível obter histórico de nenhum jogador",
    };
  }

  const result = runBacktest({
    bootstrap: season.bootstrap,
    fixtures: season.fixtures,
    historyByElement: load.historyByElement,
    fromEvent,
    toEvent,
  });

  const redis = getRedis();
  if (redis) await redis.set(BACKTEST_CACHE_KEY, result);

  const m = result.metrics;
  return {
    ok: true,
    result,
    // A backtest over zero rows is arithmetic over nothing. It cannot fail,
    // and it cannot tell you anything either.
    productive: m.n > 0 && result.playersSampled > 0,
    summary:
      m.n > 0 && result.playersSampled > 0
        ? `jornadas ${fromEvent}-${toEvent}, ${result.playersSampled} jogadores · MAE ${m.mae.toFixed(2)} (base ${m.baselineMae.toFixed(2)}) · Spearman ${m.spearman.toFixed(3)}`
        : `correu sobre zero linhas (jornadas ${fromEvent}-${toEvent}) — não mediu nada`,
    detail: {
      fromEvent,
      toEvent,
      playersSampled: result.playersSampled,
      mae: m.mae,
      baselineMae: m.baselineMae,
      spearman: m.spearman,
      bias: m.bias,
      fetched: load.fetched,
      fromCache: load.fromCache,
      stored: !!redis,
    },
  };
}

/** Most parameters one run may sweep. A full twelve-parameter sweep cannot
 * fit inside a serverless function's wall, and pretending otherwise just
 * wastes the run. The scheduled job rotates through them instead. */
export const MAX_PARAMS_PER_RUN = 4;

const CALIBRATION_CURSOR_KEY = "automation:calibration-cursor";

/**
 * Which parameters this run should sweep.
 *
 * WHY A ROTATING CURSOR AND NOT "THE FIRST FOUR". Both routes previously
 * defaulted to `Object.keys(PARAM_GRIDS).slice(0, 4)`, so every unattended run
 * swept the same four parameters forever and the other eight were never tested
 * once. A daily job that always measures the same thing is not automation, it
 * is a very reliable way of learning nothing. The cursor advances by however
 * many were covered, so three days cover the whole set and then start again
 * with fresher data.
 */
export function allTunableParams(): TunableParam[] {
  return Object.keys(PARAM_GRIDS) as TunableParam[];
}

/** The rotation itself, as arithmetic, so it can be tested without a Redis.
 * Wraps around the end of the list rather than stopping there — a run that
 * stopped at the last parameter would cover fewer and fewer each cycle. */
export function paramsFromCursor(
  all: TunableParam[],
  cursor: number,
  count: number
): TunableParam[] {
  if (all.length === 0) return [];
  const start = ((Math.trunc(cursor) % all.length) + all.length) % all.length;
  const out: TunableParam[] = [];
  for (let i = 0; i < Math.min(count, all.length); i++) {
    out.push(all[(start + i) % all.length]);
  }
  return out;
}

export async function nextCalibrationParams(count = MAX_PARAMS_PER_RUN): Promise<{
  params: TunableParam[];
  cursor: number;
}> {
  const all = allTunableParams();
  const redis = getRedis();
  let cursor = 0;
  if (redis) {
    const stored = await redis.get<number>(CALIBRATION_CURSOR_KEY);
    if (typeof stored === "number" && Number.isFinite(stored)) {
      cursor = ((stored % all.length) + all.length) % all.length;
    }
  }
  return { params: paramsFromCursor(all, cursor, count), cursor };
}

export async function advanceCalibrationCursor(by: number): Promise<void> {
  const all = allTunableParams();
  const redis = getRedis();
  if (!redis || by <= 0) return;
  const { cursor } = await nextCalibrationParams(1);
  await redis.set(CALIBRATION_CURSOR_KEY, (cursor + by) % all.length);
}

export interface CalibrationJobOptions {
  sampleSize?: number;
  fromEvent?: number;
  toEvent?: number;
  params?: TunableParam[];
  /** Absolute timestamp after which no NEW parameter is started. */
  deadlineMs?: number;
  /** Advance the rotating cursor after the run. Off for manual runs, which
   * would otherwise skip parameters the scheduled job was about to cover. */
  rotate?: boolean;
}

export async function runCalibrationJob(
  opts: CalibrationJobOptions = {}
): Promise<JobOutcome<CalibrationReport>> {
  const season = await loadSeason();
  if (season.finishedEvents.length < 2) {
    return {
      ok: false,
      retryable: false,
      error: `jornadas terminadas insuficientes para calibrar (${season.finishedEvents.length}) — a calibração precisa de jornadas passadas para reconstruir`,
    };
  }

  const fromEvent = Math.max(2, opts.fromEvent ?? 2);
  const toEvent = Math.min(season.lastFinished, opts.toEvent ?? season.lastFinished);
  const sampleSize = Math.min(300, Math.max(40, opts.sampleSize ?? 150));

  const explicit = !!(opts.params && opts.params.length > 0);
  const chosen = explicit
    ? opts.params!.slice(0, MAX_PARAMS_PER_RUN)
    : (await nextCalibrationParams()).params;

  const load = await loadHistories(season, sampleSize);
  if (load.historyByElement.size === 0) {
    return {
      ok: false,
      retryable: true,
      error: "não foi possível obter histórico de nenhum jogador",
    };
  }

  const report = calibrate({
    bootstrap: season.bootstrap,
    fixtures: season.fixtures,
    historyByElement: load.historyByElement,
    fromEvent,
    toEvent,
    params: chosen,
    deadlineMs: opts.deadlineMs,
  });

  const redis = getRedis();
  if (redis) await redis.set(CALIBRATION_CACHE_KEY, report);
  // Only the rotation itself may move the cursor. Advancing it after a run
  // that named its own parameters would skip whatever the scheduled job was
  // about to cover next — the one thing the cursor exists to prevent.
  if (opts.rotate && !explicit) {
    await advanceCalibrationCursor(chosen.length - report.notCovered.length);
  }

  const covered = chosen.filter((p) => !report.notCovered.includes(p));
  return {
    ok: true,
    result: report,
    // A sweep that covered NO parameter did nothing, whatever the reason —
    // usually the time budget cutting it off before the first one finished.
    // "Not enough evidence yet" is different: it swept, it measured, and the
    // honest answer was "too early to tell". That counts as work done.
    productive: covered.length > 0 && report.rows > 0,
    summary:
      covered.length === 0 || report.rows === 0
        ? `não chegou a varrer nenhum parâmetro (${report.rows} linhas) — provavelmente ficou sem tempo`
        : report.sufficientEvidence
          ? `${covered.join(", ")} · ${report.recommendations.length} ajuste(s) recomendado(s) em ${report.rows} linhas`
          : `${covered.join(", ")} · sem evidência suficiente ainda (${report.rows} linhas, ${report.events.length} jornadas)`,
    detail: {
      params: chosen,
      covered,
      notCovered: report.notCovered,
      truncated: report.truncated,
      rows: report.rows,
      sufficientEvidence: report.sufficientEvidence,
      recommendations: report.recommendations.map((r) => ({
        param: r.param,
        currentValue: r.currentValue,
        bestValue: r.bestValue,
        improvement: r.improvement,
      })),
      stored: !!redis,
    },
  };
}
