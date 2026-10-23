import type { FplElement } from "./types";
import type { ScoredPlayer } from "./recommend";
import { getEventLive } from "./fpl-client";
import { getRedis } from "./kv";

/**
 * PROSPECTIVE BENCHMARK — data exists BEFORE the deadline.
 *
 * Unlike a historical replay, this stores exactly what was available when a
 * visitor saw the recommendations. No current injuries, projected FPL points
 * or prices can leak backwards into an earlier gameweek.
 *
 * The comparison uses the same fixed, pre-selected cohort for model and
 * naive PPG; the FPL ep_next baseline is scored only where it was published.
 * A single gameweek can diagnose mistakes, NOT establish statistical edge.
 */
const snapshotKey = (gw: number) => "fpl:forward:snapshot:" + gw;
const resultKey = (gw: number) => "fpl:forward:result:" + gw;
const INDEX_KEY = "fpl:forward:index:v1";
const MIN_REFRESH_MS = 20 * 60 * 1000;

export interface ForwardPlayer {
  id: number;
  name: string;
  position: number;
  model: number;
  ppg: number;
  fpl: number | null;
  playProbability: number;
  expectedMinutes: number;
}

export interface ForwardSnapshot {
  version: 1;
  event: number;
  capturedAt: string;
  deadlineIso: string;
  players: ForwardPlayer[];
}

export interface ForwardMetric {
  n: number;
  mae: number;
  bias: number;
  spearman: number;
}

export interface ForwardCaptain {
  id: number;
  name: string;
  points: number;
}

export interface ForwardResult {
  event: number;
  capturedAt: string;
  settledAt: string;
  eligible: number;
  model: ForwardMetric;
  ppg: ForwardMetric;
  fpl: ForwardMetric;
  captain: {
    model: ForwardCaptain | null;
    ppg: ForwardCaptain | null;
    fpl: ForwardCaptain | null;
  };
  notes: string[];
}

export interface ForwardHistory {
  configured: boolean;
  rows: ForwardResult[];
  pending: number[];
}

function finiteNonNegative(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function buildForwardSnapshot(
  scored: ScoredPlayer[],
  elements: FplElement[],
  event: number,
  deadlineIso: string,
  now = Date.now()
): ForwardSnapshot | null {
  const deadline = Date.parse(deadlineIso);
  if (!Number.isFinite(deadline) || now >= deadline || !Number.isInteger(event) || event < 1) return null;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const players: ForwardPlayer[] = [];
  const seen = new Set<number>();
  for (const s of scored) {
    const id = s.element.id;
    const e = byId.get(id);
    if (!e || seen.has(id) || !Number.isFinite(s.expectedPointsNext)) continue;
    seen.add(id);
    players.push({
      id,
      name: e.web_name,
      position: e.element_type,
      model: s.expectedPointsNext,
      ppg: finiteNonNegative(e.points_per_game) ?? 0,
      fpl: finiteNonNegative(e.ep_next),
      playProbability: Math.max(0, Math.min(1, Number.isFinite(s.pPlay) ? s.pPlay : 0)),
      expectedMinutes: Math.max(0, Math.min(180, Number.isFinite(s.expectedMinutesNext)
        ? s.expectedMinutesNext!
        : s.pPlay * 90)),
    });
  }
  if (!players.length) return null;
  return {
    version: 1, event, capturedAt: new Date(now).toISOString(), deadlineIso, players,
  };
}

function ranks(values: number[]): number[] {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let first = 0; first < sorted.length;) {
    let end = first + 1;
    while (end < sorted.length && sorted[end].v === sorted[first].v) end++;
    const rank = (first + 1 + end) / 2;
    for (let j = first; j < end; j++) out[sorted[j].i] = rank;
    first = end;
  }
  return out;
}

function spearman(pred: number[], actual: number[]): number {
  if (pred.length < 3) return 0;
  const a = ranks(pred), b = ranks(actual);
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; aa += x * x; bb += y * y;
  }
  return aa > 0 && bb > 0 ? num / Math.sqrt(aa * bb) : 0;
}

function metric(rows: { predicted: number; actual: number }[]): ForwardMetric {
  if (!rows.length) return { n: 0, mae: 0, bias: 0, spearman: 0 };
  const n = rows.length;
  return {
    n,
    mae: rows.reduce((s, x) => s + Math.abs(x.predicted - x.actual), 0) / n,
    bias: rows.reduce((s, x) => s + x.predicted - x.actual, 0) / n,
    spearman: spearman(rows.map((r) => r.predicted), rows.map((r) => r.actual)),
  };
}

export function scoreForwardSnapshot(
  snapshot: ForwardSnapshot,
  points: Map<number, number>,
  settledAt = new Date().toISOString()
): ForwardResult {
  // Cohort locked by forecast BEFORE the GW; NEVER filter by actual minutes,
  // actual points, or retrospectively selected "winning" managers.
  const eligible = snapshot.players.filter((p) =>
    p.playProbability >= 0.7 && p.expectedMinutes >= 45 && points.has(p.id)
  );
  const rows = (k: "model" | "ppg" | "fpl") => eligible
    .filter((p) => p[k] !== null)
    .map((p) => ({ predicted: p[k] as number, actual: points.get(p.id)! }));

  const captain = (k: "model" | "ppg" | "fpl"): ForwardCaptain | null => {
    const possible = eligible.filter((p) =>
      p.playProbability >= 0.8 && p.expectedMinutes >= 60 && p[k] !== null
    );
    possible.sort((a, b) => (b[k] as number) - (a[k] as number) || a.id - b.id);
    const chosen = possible[0];
    return chosen ? { id: chosen.id, name: chosen.name, points: points.get(chosen.id)! } : null;
  };

  return {
    event: snapshot.event,
    capturedAt: snapshot.capturedAt,
    settledAt,
    eligible: eligible.length,
    model: metric(rows("model")),
    ppg: metric(rows("ppg")),
    fpl: metric(rows("fpl")),
    captain: { model: captain("model"), ppg: captain("ppg"), fpl: captain("fpl") },
    notes: [
      "Previsões e referências arquivadas antes do deadline; sem dados futuros.",
      "Coorte fixa: probabilidade de jogar >=70%, >=45 minutos esperados; zeros reais incluídos.",
      "Amostra filtrada antes dos jogos, não pelos jogadores que pontuaram.",
      "A comparação de capitania não inclui chips nem o orçamento do plantel e não prova vantagem de transferências.",
    ],
  };
}

export async function saveForwardSnapshot(
  scored: ScoredPlayer[],
  elements: FplElement[],
  event: number,
  deadlineIso: string
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const now = Date.now();
  const snapshot = buildForwardSnapshot(scored, elements, event, deadlineIso, now);
  if (!snapshot) return;
  try {
    const existing = await redis.get<ForwardSnapshot>(snapshotKey(event));
    const last = existing ? Date.parse(existing.capturedAt) : 0;
    if (Number.isFinite(last) && now - last < MIN_REFRESH_MS) return;
    // Re-check deadline after Redis network operations: a slow write must not
    // turn a pre-deadline benchmark into a hindsight benchmark.
    if (Date.now() >= Date.parse(deadlineIso)) return;
    await redis.set(snapshotKey(event), snapshot);
    await redis.sadd(INDEX_KEY, String(event));
  } catch {
    // A tracking failure must not take down the decision page.
  }
}

export async function settleForwardSnapshots(finishedEvents: number[]): Promise<void> {
  const redis = getRedis();
  if (!redis || !finishedEvents.length) return;
  for (const gw of finishedEvents) {
    try {
      if (await redis.get(resultKey(gw))) continue;
      const snapshot = await redis.get<ForwardSnapshot>(snapshotKey(gw));
      if (!snapshot || snapshot.version !== 1 || snapshot.event !== gw ||
          Date.parse(snapshot.capturedAt) >= Date.parse(snapshot.deadlineIso)) continue;
      const live = await getEventLive(gw);
      if (!Array.isArray(live.elements)) continue;
      const points = new Map(live.elements
        .filter((e) => Number.isFinite(e.stats?.total_points))
        .map((e) => [e.id, e.stats.total_points] as const));
      const scored = scoreForwardSnapshot(snapshot, points);
      if (scored.eligible < 10) continue;
      await redis.set(resultKey(gw), scored);
    } catch {
      // Another GW may be available; do not abort the whole batch.
    }
  }
}

export async function getForwardHistory(): Promise<ForwardHistory> {
  const redis = getRedis();
  if (!redis) return { configured: false, rows: [], pending: [] };
  try {
    const events = ((await redis.smembers(INDEX_KEY)) ?? [])
      .map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)
      .sort((a, b) => b - a).slice(0, 12);
    const recs = await Promise.all(events.map((gw) => redis.get<ForwardResult>(resultKey(gw))));
    return {
      configured: true,
      rows: recs.filter((x): x is ForwardResult => !!x && x.eligible > 0),
      pending: events.filter((_, i) => !recs[i]),
    };
  } catch {
    return { configured: true, rows: [], pending: [] };
  }
}
