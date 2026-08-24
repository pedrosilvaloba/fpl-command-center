import type { FplBootstrap, FplElement, FplFixture } from "./types";
import { buildScoredPlayers } from "./recommend";

/**
 * BACKTESTING HARNESS — replaying the model against gameweeks that have
 * already happened.
 *
 * The external audit's single structural recommendation, the one it said
 * was worth more than the ten individual defects it found: every number in
 * this project is currently justified by an argument, and arguments are
 * cheap. A blended weight of 0.65/0.35, a shrinkage prior of 3 matches, a
 * horizon decay of 4 gameweeks — each was chosen because it sounded right.
 * None of them has ever been checked against a result. Until something
 * replays the model over real gameweeks and scores it, there is no way to
 * tell an improvement from a plausible-sounding regression, and every
 * future change to the model is a guess.
 *
 * WHAT THIS DOES
 *
 * For each finished gameweek g in a range, it rebuilds the world as it
 * stood at g's deadline, runs the REAL scoring pipeline against that
 * reconstruction — `buildScoredPlayers`, not a copy of it — and compares
 * the `expectedPointsNext` it produces against the points each player
 * actually scored in g.
 *
 * Reusing the shipped pipeline is the whole point. A backtest that
 * reimplements the model tests the reimplementation.
 *
 * WHERE THE DATA COMES FROM
 *
 * FPL's bootstrap only ever publishes season-to-date totals, so it cannot
 * say what a player's numbers looked like in November. `element-summary/
 * {id}/` can: it returns one row per match played, and summing the rows
 * before gameweek g reconstructs exactly the totals the bootstrap would
 * have shown at g's deadline. That is one request per player, which is why
 * this runs server-side and against a sample rather than all ~700.
 *
 * LEAKAGE — THE ONLY THING THAT MATTERS IN A BACKTEST
 *
 * A backtest that can see the future reports whatever accuracy you want it
 * to. Every field is therefore reconstructed from rows STRICTLY BEFORE the
 * target gameweek, and the four fields that cannot be reconstructed are
 * neutralised rather than passed through from today:
 *
 *   - `status` / `chance_of_playing_next_round`: today's injury flags. A
 *     player injured in April would otherwise be marked doubtful for every
 *     gameweek of the season. Forced to "available", which means the
 *     backtest measures the model WITHOUT its availability layer. Stated
 *     plainly because it flatters nothing: the availability layer is one
 *     of the model's better components and this test gets no credit for it.
 *   - `ep_next`: FPL's own forecast, which is not archived anywhere. It is
 *     replaced by the player's points per game to date, which is roughly
 *     what it approximates. Rows are tagged with `trust` so the model-
 *     dominated rows can be scored separately from the ones where this
 *     stand-in still carries weight.
 *   - `selected_by_percent`: ownership only feeds differential flags and
 *     the risk posture, never `expectedPointsNext`. Zeroed.
 *   - set-piece order: a role, published only for today. It feeds the
 *     `reasons` list and nothing arithmetic (since v1.28 penalties are no
 *     longer added on top of xG), so carrying it back is harmless.
 *
 * Price is NOT in that list: the per-match rows carry `value`, so each
 * gameweek is scored at the price that actually applied.
 */

/** One row of FPL's per-player match history. Every field is read
 * defensively — this is the same undocumented API as everywhere else. */
export interface ElementHistoryRow {
  element?: number;
  round?: number;
  minutes?: number;
  total_points?: number;
  goals_scored?: number;
  assists?: number;
  clean_sheets?: number;
  goals_conceded?: number;
  yellow_cards?: number;
  red_cards?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  starts?: number;
  expected_goals?: string | number;
  expected_assists?: string | number;
  expected_goals_conceded?: string | number;
  defensive_contribution?: string | number;
  clearances_blocks_interceptions?: string | number;
  recoveries?: string | number;
  tackles?: string | number;
  value?: number;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/** Defensive-contribution actions for one match. FPL added a dedicated
 * field for this in 2025/26 but has not been consistent about publishing
 * it in the per-match history, so fall back to summing its components. */
export function defensiveActions(row: ElementHistoryRow): number {
  if (row.defensive_contribution !== undefined) return num(row.defensive_contribution);
  return (
    num(row.clearances_blocks_interceptions) + num(row.recoveries) + num(row.tackles)
  );
}

/**
 * The `FplElement` the bootstrap would have shown at the deadline of
 * `event` — built by summing only the matches played before it.
 */
export function reconstructElementAsOf(
  base: FplElement,
  history: ElementHistoryRow[],
  event: number
): FplElement {
  // STRICTLY BEFORE. A `<=` here is the whole backtest silently invalidated.
  const past = history.filter((h) => num(h.round) > 0 && num(h.round) < event);

  const sum = (pick: (h: ElementHistoryRow) => number) =>
    past.reduce((t, h) => t + pick(h), 0);

  const minutes = sum((h) => num(h.minutes));
  const points = sum((h) => num(h.total_points));
  const xg = sum((h) => num(h.expected_goals));
  const xa = sum((h) => num(h.expected_assists));
  const per90 = (total: number) => (minutes > 0 ? (total / minutes) * 90 : 0);

  // Recent form, on FPL's own definition: mean points over the last four
  // matches played. Its only job in the model is a display/reason signal,
  // but leaving it at today's value would still be leakage.
  const last4 = past.slice(-4);
  const form = last4.length > 0
    ? last4.reduce((t, h) => t + num(h.total_points), 0) / last4.length
    : 0;

  const appearances = past.filter((h) => num(h.minutes) > 0).length;
  const ppg = appearances > 0 ? points / appearances : 0;

  const priceTenths = past.length > 0 ? num(past[past.length - 1].value) : base.now_cost;

  return {
    ...base,
    minutes,
    total_points: points,
    event_points: 0,
    points_per_game: ppg.toFixed(1),
    form: form.toFixed(1),
    starts: sum((h) => num(h.starts)),
    goals_scored: sum((h) => num(h.goals_scored)),
    assists: sum((h) => num(h.assists)),
    clean_sheets: sum((h) => num(h.clean_sheets)),
    bonus: sum((h) => num(h.bonus)),
    bps: sum((h) => num(h.bps)),
    saves: sum((h) => num(h.saves)),
    yellow_cards: sum((h) => num(h.yellow_cards)),
    red_cards: sum((h) => num(h.red_cards)),
    defensive_contribution: sum(defensiveActions),
    expected_goals_per_90: per90(xg).toFixed(4),
    expected_assists_per_90: per90(xa).toFixed(4),
    now_cost: priceTenths > 0 ? priceTenths : base.now_cost,
    // Neutralised — see the leakage note at the top of this file.
    status: "a",
    chance_of_playing_next_round: null,
    news: "",
    news_added: null,
    selected_by_percent: "0",
    ep_next: ppg.toFixed(1),
    ep_this: ppg.toFixed(1),
  } as FplElement;
}

/**
 * The fixture list as it stood at `event`'s deadline: everything from
 * `event` onward becomes an unplayed fixture again, with its scores
 * removed. Elo, team form and the league baselines all read `finished`,
 * so forgetting this hands the model every result it is being asked to
 * predict.
 */
export function reconstructFixturesAsOf(fixtures: FplFixture[], event: number): FplFixture[] {
  return fixtures.map((f) =>
    f.event !== null && f.event >= event
      ? { ...f, finished: false, team_h_score: null, team_a_score: null }
      : f
  );
}

/** The bootstrap as it stood at `event`'s deadline. */
export function reconstructBootstrapAsOf(
  base: FplBootstrap,
  historyByElement: Map<number, ElementHistoryRow[]>,
  event: number,
  elementIds: number[]
): FplBootstrap {
  const wanted = new Set(elementIds);
  return {
    ...base,
    events: base.events.map((e) => ({
      ...e,
      is_current: e.id === event - 1,
      is_next: e.id === event,
      finished: e.id < event,
    })),
    elements: base.elements
      .filter((el) => wanted.has(el.id))
      .map((el) => reconstructElementAsOf(el, historyByElement.get(el.id) ?? [], event)),
  };
}

// ---------------------------------------------------------------------
// Scoring the replay
// ---------------------------------------------------------------------

export interface BacktestRow {
  event: number;
  elementId: number;
  webName: string;
  elementType: number;
  predicted: number;
  actual: number;
  minutes: number;
  priceM: number;
  /** How much of the prediction came from the model rather than from the
   * points-per-game stand-in for FPL's `ep_next`. */
  trust: number;
}

export interface BacktestBucket {
  label: string;
  n: number;
  meanPredicted: number;
  meanActual: number;
}

export interface BacktestMetrics {
  n: number;
  events: number[];
  /** Mean absolute error, points per player per gameweek. */
  mae: number;
  rmse: number;
  /** Mean signed error. Positive = the model is optimistic. */
  bias: number;
  /** Spearman rank correlation between predicted and actual. This, not
   * MAE, is what FPL decisions actually depend on: picking the right
   * player is a ranking problem, and a model can be systematically
   * optimistic by two points and still rank perfectly. */
  spearman: number;
  /** Mean actual points of the model's top decile minus its bottom decile,
   * per gameweek. The plainest statement of "does following this help". */
  decileLift: number;
  /** How often the model's single highest-rated player finished in the
   * real top 10 scorers of that gameweek. The captaincy question. */
  captainTop10Rate: number;
  /** Predicted-value buckets, to expose miscalibration that averages hide. */
  calibration: BacktestBucket[];
  /** A naive comparator: predicting each player's own season points per
   * game. If the model cannot beat this, it is not earning its complexity. */
  baselineMae: number;
  baselineSpearman: number;
}

function spearmanCorrelation(pairs: { a: number; b: number }[]): number {
  const n = pairs.length;
  if (n < 3) return 0;
  const rank = (pick: (p: { a: number; b: number }) => number) => {
    const order = pairs
      .map((p, i) => ({ i, v: pick(p) }))
      .sort((x, y) => x.v - y.v);
    const ranks = new Array<number>(n);
    let i = 0;
    while (i < n) {
      // Average ranks across ties, or the coefficient is wrong wherever
      // the data has repeated values — and FPL scores are mostly 1s, 2s
      // and 0s, so ties are the common case, not an edge case.
      let j = i;
      while (j + 1 < n && order[j + 1].v === order[i].v) j++;
      const shared = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k].i] = shared;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank((p) => p.a);
  const rb = rank((p) => p.b);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

const CALIBRATION_EDGES = [0, 2, 3, 4, 5, 6, 8, Infinity];

export function scoreBacktest(rows: BacktestRow[]): BacktestMetrics {
  const n = rows.length;
  const empty: BacktestMetrics = {
    n: 0, events: [], mae: 0, rmse: 0, bias: 0, spearman: 0, decileLift: 0,
    captainTop10Rate: 0, calibration: [], baselineMae: 0, baselineSpearman: 0,
  };
  if (n === 0) return empty;

  let absErr = 0;
  let sqErr = 0;
  let signed = 0;
  for (const r of rows) {
    const e = r.predicted - r.actual;
    absErr += Math.abs(e);
    sqErr += e * e;
    signed += e;
  }

  const spearman = spearmanCorrelation(rows.map((r) => ({ a: r.predicted, b: r.actual })));

  // Per-gameweek decile lift and captaincy, because both are questions
  // about a single gameweek's ranking and pooling the events first would
  // answer a different question.
  const byEvent = new Map<number, BacktestRow[]>();
  for (const r of rows) {
    if (!byEvent.has(r.event)) byEvent.set(r.event, []);
    byEvent.get(r.event)!.push(r);
  }
  let liftTotal = 0;
  let liftEvents = 0;
  let captainHits = 0;
  let captainEvents = 0;
  for (const list of byEvent.values()) {
    if (list.length < 20) continue;
    const sorted = [...list].sort((a, b) => b.predicted - a.predicted);
    const k = Math.max(1, Math.floor(sorted.length / 10));
    const mean = (xs: BacktestRow[]) => xs.reduce((s, x) => s + x.actual, 0) / xs.length;
    liftTotal += mean(sorted.slice(0, k)) - mean(sorted.slice(-k));
    liftEvents++;

    const realTop10 = new Set(
      [...list].sort((a, b) => b.actual - a.actual).slice(0, 10).map((r) => r.elementId)
    );
    if (realTop10.has(sorted[0].elementId)) captainHits++;
    captainEvents++;
  }

  const calibration: BacktestBucket[] = [];
  for (let i = 0; i < CALIBRATION_EDGES.length - 1; i++) {
    const lo = CALIBRATION_EDGES[i];
    const hi = CALIBRATION_EDGES[i + 1];
    const inBucket = rows.filter((r) => r.predicted >= lo && r.predicted < hi);
    if (inBucket.length === 0) continue;
    calibration.push({
      label: hi === Infinity ? `${lo}+` : `${lo}-${hi}`,
      n: inBucket.length,
      meanPredicted: inBucket.reduce((s, r) => s + r.predicted, 0) / inBucket.length,
      meanActual: inBucket.reduce((s, r) => s + r.actual, 0) / inBucket.length,
    });
  }

  return {
    n,
    events: [...byEvent.keys()].sort((a, b) => a - b),
    mae: absErr / n,
    rmse: Math.sqrt(sqErr / n),
    bias: signed / n,
    spearman,
    decileLift: liftEvents > 0 ? liftTotal / liftEvents : 0,
    captainTop10Rate: captainEvents > 0 ? captainHits / captainEvents : 0,
    calibration,
    baselineMae: 0,
    baselineSpearman: 0,
  };
}

/**
 * The naive comparator, scored the same way: predict every player's own
 * points per game to date. Anything the model does beyond this has to earn
 * its place, and reporting the model's error without it is meaningless —
 * an MAE of 1.8 could be excellent or embarrassing depending on what the
 * trivial answer scores.
 */
export function scoreBaseline(rows: { predicted: number; actual: number }[]): {
  mae: number;
  spearman: number;
} {
  if (rows.length === 0) return { mae: 0, spearman: 0 };
  const mae =
    rows.reduce((s, r) => s + Math.abs(r.predicted - r.actual), 0) / rows.length;
  return {
    mae,
    spearman: spearmanCorrelation(rows.map((r) => ({ a: r.predicted, b: r.actual }))),
  };
}

// ---------------------------------------------------------------------
// The replay itself
// ---------------------------------------------------------------------

export interface BacktestResult {
  ranAt: string;
  fromEvent: number;
  toEvent: number;
  playersSampled: number;
  metrics: BacktestMetrics;
  /** Metrics restricted to rows where the model, not the points-per-game
   * stand-in, dominated the prediction. */
  highTrustMetrics: BacktestMetrics;
  notes: string[];
}

export interface BacktestInput {
  bootstrap: FplBootstrap;
  fixtures: FplFixture[];
  historyByElement: Map<number, ElementHistoryRow[]>;
  fromEvent: number;
  toEvent: number;
  /** Minimum minutes in the target gameweek for a row to count. A player
   * who did not play is a minutes question, not a scoring question, and
   * including thousands of guaranteed 0-0 rows would make every error
   * metric look far better than the model deserves. */
  minMinutes?: number;
}

/** How many minutes of evidence a prediction needs before it counts as
 * the model's own rather than the stand-in's. Mirrors MODEL_TRUST_MINUTES
 * in lib/expectedpoints.ts. */
const HIGH_TRUST_MINUTES = 360;

export function runBacktest(input: BacktestInput): BacktestResult {
  const { bootstrap, fixtures, historyByElement, fromEvent, toEvent } = input;
  const minMinutes = input.minMinutes ?? 1;
  const elementIds = [...historyByElement.keys()];

  const rows: BacktestRow[] = [];
  const baselineRows: { predicted: number; actual: number }[] = [];

  for (let event = fromEvent; event <= toEvent; event++) {
    const asOfBootstrap = reconstructBootstrapAsOf(
      bootstrap,
      historyByElement,
      event,
      elementIds
    );
    const asOfFixtures = reconstructFixturesAsOf(fixtures, event);

    // The real pipeline, with no qualitative notes: those are written by
    // hand today and applying them to a past gameweek is leakage of the
    // most flattering kind.
    const scored = buildScoredPlayers(asOfBootstrap, asOfFixtures, event, 5, null, []);

    for (const p of scored) {
      const history = historyByElement.get(p.element.id) ?? [];
      const played = history.filter((h) => num(h.round) === event);
      if (played.length === 0) continue;
      const minutes = played.reduce((s, h) => s + num(h.minutes), 0);
      if (minutes < minMinutes) continue;
      const actual = played.reduce((s, h) => s + num(h.total_points), 0);
      const minutesBefore = history
        .filter((h) => num(h.round) < event)
        .reduce((s, h) => s + num(h.minutes), 0);

      rows.push({
        event,
        elementId: p.element.id,
        webName: p.element.web_name,
        elementType: p.element.element_type,
        predicted: p.expectedPointsNext,
        actual,
        minutes,
        priceM: p.priceM,
        trust: Math.min(1, minutesBefore / HIGH_TRUST_MINUTES),
      });
      baselineRows.push({ predicted: parseFloat(p.element.points_per_game) || 0, actual });
    }
  }

  const metrics = scoreBacktest(rows);
  const baseline = scoreBaseline(baselineRows);
  metrics.baselineMae = baseline.mae;
  metrics.baselineSpearman = baseline.spearman;

  // `rows` and `baselineRows` are built in lockstep, so the same index
  // selects the matching pair. Filtering by index rather than by value
  // keeps that guarantee (and avoids an O(n^2) lookup on ~10k rows).
  const highTrustIdx = rows.map((r, i) => (r.trust >= 1 ? i : -1)).filter((i) => i >= 0);
  const highTrustRows = highTrustIdx.map((i) => rows[i]);
  const highTrustMetrics = scoreBacktest(highTrustRows);
  const highTrustBaseline = scoreBaseline(highTrustIdx.map((i) => baselineRows[i]));
  highTrustMetrics.baselineMae = highTrustBaseline.mae;
  highTrustMetrics.baselineSpearman = highTrustBaseline.spearman;

  return {
    ranAt: new Date().toISOString(),
    fromEvent,
    toEvent,
    playersSampled: elementIds.length,
    metrics,
    highTrustMetrics,
    notes: [
      "Sem camada de disponibilidade: os estados de lesão são os de hoje e não podem ser reconstruídos, por isso foram neutralizados.",
      "A estimativa da própria FPL (ep_next) não fica arquivada; foi substituída pela média de pontos por jogo até à jornada.",
      "Só contam jogadores que efetivamente jogaram na jornada — prever zeros de quem não jogou é uma questão de minutos, não de pontuação.",
      "As notas táticas manuais não foram aplicadas: são escritas com conhecimento de hoje.",
    ],
  };
}
