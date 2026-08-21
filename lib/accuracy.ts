import { getRedis } from "./kv";
import { getEventLive } from "./fpl-client";
import type { ScoredPlayer } from "./recommend";

/**
 * Forward-looking, honest accuracy tracker for the scoring model.
 *
 * Claims like "this model is 40-50% better" are worth nothing without a
 * way to actually check them against real results. This module does the
 * simplest defensible thing: the first time the app is opened while a
 * gameweek's deadline hasn't passed yet (so none of its fixtures have
 * kicked off), it snapshots the model's current top picks by position.
 * Once that gameweek finishes, it fetches the REAL points each
 * snapshotted player scored (via FPL's own /event/{id}/live/ endpoint —
 * already wrapped as getEventLive in lib/fpl-client.ts, just never
 * called from anywhere) and records whether the model's own ranking
 * held up: did the players it rated highest actually outscore the ones
 * it rated lowest.
 *
 * Two honesty caveats, stated plainly rather than glossed over:
 *   1. This can only start measuring from now on. There is no reliable
 *      way to reconstruct what the model "would have said" before a
 *      past gameweek without re-fetching each of ~700 players' historical
 *      per-gameweek stats individually — not attempted here.
 *   2. The snapshot is taken on whichever visit happens first after a
 *      gameweek's deadline is still in the future — guaranteed to be
 *      before any of that gameweek's matches kick off (the deadline IS
 *      the first kickoff), so there's no lookahead leakage from the
 *      snapshot itself. What it can't control for is which day within
 *      that window the snapshot happens to land on (form/underlying
 *      numbers may shift slightly between the gameweek becoming "next"
 *      and its deadline) — a minor timing caveat, not a correctness bug.
 *
 * Entirely optional: requires the same Upstash Redis integration the
 * Shadow Team sync already uses. Without it, every function here is a
 * no-op that returns "not configured" — never blocks or breaks the page.
 */

const SNAPSHOT_KEY = (event: number) => `fpl-command-center:accuracy:snapshot:${event}`;
const RESULT_KEY = (event: number) => `fpl-command-center:accuracy:result:${event}`;
const RESULT_INDEX_KEY = "fpl-command-center:accuracy:index";
const TOP_N_PER_POSITION = 10;

interface SnapshotPick {
  elementId: number;
  positionShort: string;
  score: number;
  webName: string;
}

interface Snapshot {
  event: number;
  takenAt: string;
  picks: SnapshotPick[];
}

export interface AccuracyResult {
  event: number;
  comparedAt: string;
  topAvgPoints: number;
  restAvgPoints: number;
  topCount: number;
  restCount: number;
  lift: number; // topAvgPoints - restAvgPoints
}

/** Best-effort snapshot of the model's current top-N-per-position picks
 * for `eventId` — only writes once per gameweek (idempotent), and only
 * ever called by the page for a gameweek whose deadline hasn't passed
 * yet. Never throws. */
export async function snapshotIfMissing(scored: ScoredPlayer[], eventId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const existing = await redis.get(SNAPSHOT_KEY(eventId));
    if (existing) return;

    const picks: SnapshotPick[] = [];
    for (const posId of [1, 2, 3, 4]) {
      const top = scored
        .filter((p) => p.element.element_type === posId)
        .slice(0, TOP_N_PER_POSITION);
      for (const p of top) {
        picks.push({
          elementId: p.element.id,
          positionShort: p.positionShort,
          score: p.score,
          webName: p.element.web_name,
        });
      }
    }
    if (picks.length === 0) return;
    const snapshot: Snapshot = { event: eventId, takenAt: new Date().toISOString(), picks };
    await redis.set(SNAPSHOT_KEY(eventId), snapshot);
  } catch {
    // Best-effort only — never let a tracking failure affect the page.
  }
}

/** For any finished gameweek that has a snapshot but no recorded
 * comparison yet, fetches real per-gameweek points and computes a
 * simple "did the model's own top half outscore its bottom half"
 * lift metric. Reads a single index key in the common case (nothing
 * new to process) to keep this cheap on every page load. */
export async function recordOutcomesForFinishedEvents(finishedEventIds: number[]): Promise<void> {
  const redis = getRedis();
  if (!redis || finishedEventIds.length === 0) return;
  try {
    const index = (await redis.get<number[]>(RESULT_INDEX_KEY)) ?? [];
    const pending = finishedEventIds.filter((e) => !index.includes(e));
    if (pending.length === 0) return;

    const newlyRecorded: number[] = [];
    for (const event of pending) {
      const snapshot = await redis.get<Snapshot>(SNAPSHOT_KEY(event));
      if (!snapshot || snapshot.picks.length === 0) continue;

      const live = await getEventLive(event);
      const pointsById = new Map(live.elements.map((e) => [e.id, e.stats?.total_points ?? 0]));

      const withPoints = snapshot.picks.map((p) => ({
        ...p,
        actualPoints: pointsById.get(p.elementId) ?? 0,
      }));
      const sortedByScore = [...withPoints].sort((a, b) => b.score - a.score);
      const cut = Math.max(1, Math.floor(sortedByScore.length / 2));
      const top = sortedByScore.slice(0, cut);
      const rest = sortedByScore.slice(cut);
      const avg = (arr: { actualPoints: number }[]) =>
        arr.length ? arr.reduce((s, x) => s + x.actualPoints, 0) / arr.length : 0;
      const topAvg = avg(top);
      const restAvg = avg(rest);

      const result: AccuracyResult = {
        event,
        comparedAt: new Date().toISOString(),
        topAvgPoints: Math.round(topAvg * 100) / 100,
        restAvgPoints: Math.round(restAvg * 100) / 100,
        topCount: top.length,
        restCount: rest.length,
        lift: Math.round((topAvg - restAvg) * 100) / 100,
      };
      await redis.set(RESULT_KEY(event), result);
      newlyRecorded.push(event);
    }
    if (newlyRecorded.length > 0) {
      await redis.set(RESULT_INDEX_KEY, [...index, ...newlyRecorded]);
    }
  } catch {
    // Best-effort — skip this round, retried automatically on next visit.
  }
}

export interface AccuracyHistory {
  configured: boolean;
  results: AccuracyResult[];
}

export async function getAccuracyHistory(): Promise<AccuracyHistory> {
  const redis = getRedis();
  if (!redis) return { configured: false, results: [] };
  try {
    const index = (await redis.get<number[]>(RESULT_INDEX_KEY)) ?? [];
    if (index.length === 0) return { configured: true, results: [] };
    const results = await Promise.all(index.map((event) => redis.get<AccuracyResult>(RESULT_KEY(event))));
    const clean = results.filter((r): r is AccuracyResult => r !== null);
    clean.sort((a, b) => a.event - b.event);
    return { configured: true, results: clean };
  } catch {
    return { configured: true, results: [] };
  }
}
