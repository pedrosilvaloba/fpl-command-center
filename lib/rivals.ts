import type { ScoredPlayer } from "./recommend";
import type { FplLeagueStandingsEntry } from "./types";
import { getEntryPicks } from "./fpl-client";

/**
 * CAMADA 2 — simulação contra os rivais reais da liga.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Every layer of this app until now answered one question: "which squad
 * scores the most expected points?" That is the right question for exactly
 * one goal — maximising your own score in a vacuum. It is NOT the goal.
 * The goal is finishing above specific, named people in the Haal of Fame.
 *
 * Those two objectives come apart in a way that matters. If you are 80
 * points clear with six gameweeks left, the squad that maximises expected
 * points is the wrong squad: you want the squad that maximises the
 * probability of STAYING ahead, which means owning what your rivals own so
 * that whatever happens, it happens to both of you. If you are 80 points
 * behind, the reverse: a squad identical to theirs guarantees you finish
 * 80 points behind. You need divergence, even at a cost in expected points.
 *
 * `lib/rankvalue.ts` (v1.24) got halfway there — it measured ownership
 * against the global FPL field. But the global field is not who you are
 * playing. Your league has a handful of managers with concrete, knowable
 * squads, and the FPL API serves any manager's picks publicly by Team ID.
 * So instead of a proxy, this module uses the real thing.
 *
 * HOW THE SIMULATION WORKS
 * ------------------------
 * Monte Carlo at the PLAYER level, not the manager level. Each run draws
 * one outcome per player — one clean sheet per club, one goal count per
 * attacker, one bonus outcome — and then every manager's score for that run
 * is the sum over their own eleven of those same draws.
 *
 * Drawing per player rather than per manager is the whole point. It means
 * two managers who both own Haaland automatically move together on the runs
 * where he hauls, and two defenders from the same club automatically share
 * one clean sheet. The correlation structure that decides mini-leagues —
 * squad overlap — falls out of the mechanism rather than being estimated.
 *
 * The RNG is seeded from the gameweek, so the same gameweek always produces
 * the same numbers. A dashboard whose probabilities jitter on every refresh
 * is a dashboard nobody trusts.
 *
 * WHAT COMES OUT, AND WHERE IT GOES
 * ---------------------------------
 * A probability of finishing above each rival, and from that a single
 * number — `beta` — that says how much variance the situation calls for.
 * Negative means protect a lead (prefer what rivals own); positive means
 * chase (prefer what they do not). That number is fed straight into the
 * optimizer's objective, so the recommended squad actually changes when the
 * league situation changes. It is not a panel for the manager to read and
 * act on manually.
 */

/** Typical points scored per goal, by position. */
const GOAL_POINTS: Record<number, number> = { 1: 10, 2: 6, 3: 5, 4: 4 };
const CLEAN_SHEET_POINTS: Record<number, number> = { 1: 4, 2: 4, 3: 1, 4: 0 };
const ASSIST_POINTS = 3;

/** How many simulated gameweeks to run. 4000 puts the Monte Carlo error on
 * a probability near 0.5 at roughly ±0.8 percentage points, which is well
 * inside the honest precision of the inputs, and costs a few milliseconds
 * on the ~150 distinct players a small league actually owns. */
const DEFAULT_RUNS = 4000;

/** Rivals fetched at most. A classic league can have thousands of entries
 * and each one costs an API round-trip, so a cap has to exist. What must
 * NOT exist is a cap that can exclude YOU — see `selectRivals`. */
const MAX_RIVALS = 60;

/** How many managers immediately above and below you are always included,
 * whatever the cap. These are the people one gameweek can actually move you
 * past, which is what a variance posture is really about. */
const NEIGHBOURS_EACH_SIDE = 8;

/** Concurrent requests when reading rival squads. An unbounded `Promise.all`
 * over a whole league fires sixty simultaneous requests at someone else's
 * free, unthrottled API — the quickest way to be rate-limited into a broken
 * page. */
const RIVAL_FETCH_CONCURRENCY = 8;

const LAST_EVENT = 38;

// --------------------------------------------------------------------------
// Seeded RNG — mulberry32. Deterministic per gameweek by design.
// --------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Knuth's method. Fine for the small lambdas involved here (< 2). */
function poissonSample(lambda: number, rand: () => number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 12) return Math.round(lambda); // never happens for one player
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// --------------------------------------------------------------------------
// Rival squads
// --------------------------------------------------------------------------

export interface RivalSquad {
  entry: number;
  entryName: string;
  playerName: string;
  rank: number;
  totalPoints: number;
  /** Element ids of the eleven that actually played (multiplier > 0). */
  xi: number[];
  captainId: number | null;
  isMe: boolean;
}

/**
 * Fetches each league entry's most recent public squad.
 *
 * FPL only serves `/entry/{id}/event/{gw}/picks/` for a gameweek whose
 * deadline has already passed. So the freshest squad available for a rival
 * is always the one from the last FINISHED gameweek — it may be one or two
 * transfers out of date by the time the next deadline arrives. That is a
 * real limitation of the public API, not something to paper over: the
 * probabilities below are computed against last week's squads, and the
 * page says so.
 */
/**
 * Which managers in the league actually get simulated.
 *
 * THE BUG THIS EXISTS TO PREVENT. This used to be `standings.slice(0, 24)`,
 * on the reasoning that beyond the top handful the standings are not the
 * competition you are really in. That reasoning has a hole in it big enough
 * to disable the entire layer: if YOU are not in the top 24, you are not in
 * the sample — and `simulateLeague` cannot simulate a league you are not in.
 * It returned "could not identify your team", the posture fell back to
 * neutral, and beta went to zero.
 *
 * That is exactly what was happening in production: 29th of 47, so Camada 2
 * was switched off and the page said so in small text that read like a
 * temporary data problem rather than a permanent exclusion. A whole layer
 * was dead for the one user this app has.
 *
 * The selection now has a fixed order of priority:
 *   1. You. Always, whatever your rank. Without this nothing else works.
 *   2. Your neighbours — the managers just above and below you, who are the
 *      ones a single gameweek can actually move you past.
 *   3. The leaders, who set the pace you have to match to win the thing.
 *   4. Everyone else, until the cap.
 *
 * Returned in standings order so downstream output reads like the table.
 */
export function selectRivals(
  standings: FplLeagueStandingsEntry[],
  myEntryId: number,
  max = MAX_RIVALS
): FplLeagueStandingsEntry[] {
  if (standings.length <= max) return [...standings];

  const chosen = new Map<number, FplLeagueStandingsEntry>();
  const take = (e: FplLeagueStandingsEntry | undefined) => {
    if (e && chosen.size < max) chosen.set(e.entry, e);
  };

  const myIndex = standings.findIndex((e) => e.entry === myEntryId);
  if (myIndex >= 0) {
    take(standings[myIndex]);
    // Neighbours, alternating outwards so the nearest are taken first.
    for (let d = 1; d <= NEIGHBOURS_EACH_SIDE; d++) {
      take(standings[myIndex - d]);
      take(standings[myIndex + d]);
    }
  }
  for (const e of standings) take(e);

  const order = new Map(standings.map((e, i) => [e.entry, i]));
  return [...chosen.values()].sort(
    (a, b) => (order.get(a.entry) ?? 0) - (order.get(b.entry) ?? 0)
  );
}

/** Bounded-concurrency map — see RIVAL_FETCH_CONCURRENCY. */
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

export async function fetchRivalSquads(
  standings: FplLeagueStandingsEntry[],
  lastFinishedEvent: number,
  myEntryId: number
): Promise<RivalSquad[]> {
  if (lastFinishedEvent < 1) return [];
  const targets = selectRivals(standings, myEntryId);
  const results = await mapWithLimit(
    targets,
    RIVAL_FETCH_CONCURRENCY,
    async (entry): Promise<RivalSquad | null> => {
      try {
        const picks = await getEntryPicks(entry.entry, lastFinishedEvent);
        const xi = picks.picks.filter((p) => p.multiplier > 0).map((p) => p.element);
        if (xi.length === 0) return null;
        const captain = picks.picks.find((p) => p.is_captain)?.element ?? null;
        return {
          entry: entry.entry,
          entryName: entry.entry_name,
          playerName: entry.player_name,
          rank: entry.rank,
          totalPoints: entry.total,
          xi,
          captainId: captain,
          isMe: entry.entry === myEntryId,
        };
      } catch {
        // One unreachable manager must not take the whole layer down.
        return null;
      }
    }
  );
  return results.filter((r): r is RivalSquad => r !== null);
}

// --------------------------------------------------------------------------
// Player-level draw
// --------------------------------------------------------------------------

interface DrawProfile {
  elementId: number;
  teamId: number;
  elementType: number;
  cleanSheetProbability: number;
  pPlay: number;
  /** Expected goals, assists etc. CONDITIONAL on playing. */
  goalLambda: number;
  assistLambda: number;
  dcProbability: number;
  bonusExpected: number;
  savesLambda: number;
  concedePenalty: number;
}

/**
 * Turns a scored player into the parameters of a single-gameweek random
 * draw.
 *
 * The shape (how much of his points come from goals vs a clean sheet vs
 * bonus) is taken from the model's own multi-gameweek breakdown, because
 * that mix is a property of the player and barely moves fixture to fixture.
 * The SCALE is then set by `expectedPointsNext`, which is the number the
 * rest of the app actually acts on. Doing it this way means the simulation
 * can never disagree with the recommendation about how good a player is —
 * it only adds the spread around it.
 */
function toDrawProfile(p: ScoredPlayer): DrawProfile {
  const b = p.breakdown;
  const windowTotal = Math.max(0.01, b.total);
  // Scale the window breakdown down to one gameweek.
  const k = Math.min(1, Math.max(0, p.expectedPointsNext / windowTotal));
  const type = p.element.element_type;

  const appearance = b.appearance * k;
  const pPlay = Math.min(0.99, Math.max(0.02, appearance / 2));

  const goalPts = GOAL_POINTS[type] ?? 5;
  // Conditional on playing: divide the unconditional expectation by pPlay.
  const goalLambda = Math.max(0, (b.goals * k) / goalPts / pPlay);
  const assistLambda = Math.max(0, (b.assists * k) / ASSIST_POINTS / pPlay);
  const dcProbability = Math.min(1, Math.max(0, (b.defensiveContribution * k) / 2 / pPlay));
  const bonusExpected = Math.min(2, Math.max(0, (b.bonus * k) / pPlay));
  const savesLambda = Math.max(0, ((b.saves * k) / pPlay) * 3);

  const csProb = Math.min(0.95, Math.max(0.02, p.cleanSheetProbability));
  // The conceded-goals penalty only bites when there is no clean sheet, so
  // the unconditional expectation is spread over those runs only.
  const concedePenalty = Math.min(0, (b.concededPenalty * k) / Math.max(0.05, 1 - csProb));

  return {
    elementId: p.element.id,
    teamId: p.team.id,
    elementType: type,
    cleanSheetProbability: csProb,
    pPlay,
    goalLambda,
    assistLambda,
    dcProbability,
    bonusExpected,
    savesLambda,
    concedePenalty,
  };
}

function drawPoints(
  profile: DrawProfile,
  cleanSheet: boolean,
  rand: () => number
): number {
  if (rand() > profile.pPlay) return 0;
  // Minutes: most appearances are full ones, so 2 points is the common case.
  let pts = rand() < 0.82 ? 2 : 1;

  const goals = poissonSample(profile.goalLambda, rand);
  if (goals > 0) pts += goals * (GOAL_POINTS[profile.elementType] ?? 5);
  const assists = poissonSample(profile.assistLambda, rand);
  if (assists > 0) pts += assists * ASSIST_POINTS;

  // Keepers and defenders get 4 for a clean sheet, midfielders 1, forwards
  // nothing — and only the first two are docked for goals conceded.
  if (profile.elementType <= 3) {
    if (cleanSheet) {
      pts += CLEAN_SHEET_POINTS[profile.elementType] ?? 0;
    } else if (profile.elementType <= 2) {
      pts += profile.concedePenalty;
    }
  }

  if (profile.dcProbability > 0 && rand() < profile.dcProbability) pts += 2;

  if (profile.savesLambda > 0) {
    pts += Math.floor(poissonSample(profile.savesLambda, rand) / 3);
  }

  // Bonus as a three-outcome draw whose mean is exactly the expected bonus:
  // P(3) = P(2) = P(1) = bonus/6  =>  E = (3+2+1) * bonus/6 = bonus.
  if (profile.bonusExpected > 0) {
    const step = profile.bonusExpected / 6;
    const u = rand();
    if (u < step) pts += 3;
    else if (u < 2 * step) pts += 2;
    else if (u < 3 * step) pts += 1;
  }

  return pts;
}

// --------------------------------------------------------------------------
// The simulation
// --------------------------------------------------------------------------

export interface RivalOutlook {
  entry: number;
  entryName: string;
  playerName: string;
  rank: number;
  totalPoints: number;
  /** Mean simulated score for the coming gameweek. */
  expectedGwPoints: number;
  /** Probability my gameweek score beats theirs. */
  pWinGameweek: number;
  /** Probability I am ahead of them when the season ends. */
  pAheadAtSeasonEnd: number;
  /** My total minus theirs, right now. Negative = I am behind. */
  gap: number;
  /** How many of their eleven I also own — the reason our scores move
   * together, and the reason a gap is hard to close. */
  overlap: number;
}

export type PostureLabel = "proteger" | "equilibrar" | "atacar";

export interface Posture {
  /**
   * The variance dial, fed directly into the optimizer objective:
   *   objective_i = expectedPoints_i × (1 − beta × ownershipShare_i)
   *
   * beta > 0 penalises widely-owned players (chase: you need divergence).
   * beta = 0 is pure expected points.
   * beta < 0 rewards them (protect: you want to move with the field).
   */
  beta: number;
  label: PostureLabel;
  headline: string;
  rationale: string;
  /** The rival whose situation set the posture. */
  targetName: string | null;
  source: "simulação" | "predefinição";
}

export interface LeagueOutlook {
  available: boolean;
  reason: string | null;
  /** Gameweek the rival squads were read from — always a finished one. */
  squadsFromEvent: number | null;
  gameweeksRemaining: number;
  runs: number;
  me: RivalOutlook | null;
  rivals: RivalOutlook[];
  posture: Posture;
}

/** What the app does before there is any league to simulate against. */
export const NEUTRAL_POSTURE: Posture = {
  beta: 0,
  label: "equilibrar",
  headline: "Sem inclinação — a maximizar pontos esperados",
  rationale:
    "Ainda não há jornadas jogadas nem plantéis de rivais para simular, por isso o modelo não tem base para preferir template ou diferenciais. Nesta situação a jogada certa é simplesmente maximizar pontos esperados: qualquer inclinação seria inventada.",
  targetName: null,
  source: "predefinição",
};

function buildPosture(
  me: RivalOutlook | null,
  rivals: RivalOutlook[],
  gameweeksRemaining: number
): Posture {
  if (!me || rivals.length === 0) return NEUTRAL_POSTURE;

  // The rival that defines the objective. If you are not top, the thing you
  // are trying to do is catch the leader — not edge past whoever is one
  // place above you. If you ARE top, the thing you are trying to do is stay
  // there, so the threat is second place.
  const others = rivals.filter((r) => r.entry !== me.entry);
  if (others.length === 0) return NEUTRAL_POSTURE;
  // Sorted by league rank, so the first entry is the leader when you are
  // chasing, and second place when you are the one being chased. Either
  // way it is the manager whose position defines what you are playing for.
  const target = [...others].sort((a, b) => a.rank - b.rank)[0];

  const p = target.pAheadAtSeasonEnd;
  // Linear in the probability, clamped. Symmetric around a coin flip, but
  // capped harder on the protective side: a template squad you did not
  // choose is a worse failure mode than a differential that misses.
  const raw = (0.5 - p) * 1.8;
  const beta = Math.round(Math.min(0.9, Math.max(-0.6, raw)) * 100) / 100;

  let label: PostureLabel;
  let headline: string;
  let rationale: string;

  if (beta >= 0.25) {
    label = "atacar";
    headline = `A perseguir ${target.playerName} — o modelo vai procurar variância`;
    rationale = `A simulação dá-te ${Math.round(p * 100)}% de hipóteses de acabar à frente de ${target.playerName} (${target.entryName}), com ${gameweeksRemaining} jornadas por jogar e ${target.overlap} jogadores em comum no onze. Uma equipa parecida com a dele mantém a diferença de ${Math.abs(target.gap)} pontos até ao fim — é preciso divergir. O otimizador passa a descontar jogadores muito possuídos, aceitando perder algum ponto esperado em troca da hipótese de recuperar.`;
  } else if (beta <= -0.25) {
    label = "proteger";
    headline = `A proteger a vantagem sobre ${target.playerName}`;
    rationale = `A simulação dá-te ${Math.round(p * 100)}% de hipóteses de acabar à frente de ${target.playerName} (${target.entryName}). Com uma vantagem destas, a jogada certa deixa de ser marcar mais pontos e passa a ser reduzir a probabilidade de algo correr mal: quanto mais o teu onze se parecer com o dele, menos jornadas existem em que ele te ultrapassa. O otimizador passa a preferir os jogadores que o pelotão também tem.`;
  } else {
    label = "equilibrar";
    headline = "Corrida equilibrada — sem inclinação artificial";
    rationale = `A simulação dá-te ${Math.round(p * 100)}% de hipóteses de acabar à frente de ${target.playerName} (${target.entryName}) — perto de uma moeda ao ar. Nesta zona nem procurar variância nem suprimi-la melhora as tuas hipóteses de forma clara, por isso o modelo fica a maximizar pontos esperados.`;
  }

  return { beta, label, headline, rationale, targetName: target.playerName, source: "simulação" };
}

/**
 * Folds Camada 3's tournament evidence into Camada 2's posture.
 *
 * The league situation is the primary signal — it is specific, current, and
 * about the people you are actually playing. The tournament is a correction
 * on top: evidence about whether THIS season is rewarding divergence at all.
 * A season where two premiums score half the points in the game punishes
 * differentials no matter how far behind you are, and the reverse is also
 * true. The tilt is deliberately capped small at source, and the result is
 * clamped to the same range the posture itself lives in.
 */
export function applyLearningTilt(
  posture: Posture,
  tilt: number,
  reason: string | null
): Posture {
  if (!tilt) return posture;
  const beta = Math.round(Math.min(0.9, Math.max(-0.6, posture.beta + tilt)) * 100) / 100;
  if (beta === posture.beta) return posture;
  return {
    ...posture,
    beta,
    rationale: reason ? `${posture.rationale} ${reason}` : posture.rationale,
  };
}

/**
 * Runs the league simulation. Pure and synchronous — the squads are fetched
 * separately so this can be tested without a network.
 */
export function simulateLeague(
  squads: RivalSquad[],
  scored: ScoredPlayer[],
  options: {
    currentEvent: number;
    squadsFromEvent: number | null;
    runs?: number;
  }
): LeagueOutlook {
  const runs = options.runs ?? DEFAULT_RUNS;
  const gameweeksRemaining = Math.max(0, LAST_EVENT - options.currentEvent);

  const me = squads.find((s) => s.isMe) ?? null;
  if (!me || squads.length < 2) {
    return {
      available: false,
      reason:
        squads.length === 0
          ? "Ainda não há plantéis públicos para simular — a FPL só publica o onze de um gestor depois do fecho de uma jornada."
          : "Não foi possível identificar a tua equipa entre os plantéis carregados desta liga.",
      squadsFromEvent: options.squadsFromEvent,
      gameweeksRemaining,
      runs: 0,
      me: null,
      rivals: [],
      posture: NEUTRAL_POSTURE,
    };
  }

  // Only the players somebody in this league actually owns need simulating.
  const needed = new Set<number>();
  for (const s of squads) for (const id of s.xi) needed.add(id);

  const byId = new Map(scored.map((p) => [p.element.id, p]));
  const profiles = new Map<number, DrawProfile>();
  for (const id of needed) {
    const p = byId.get(id);
    if (p) profiles.set(id, toDrawProfile(p));
  }

  const clubIds = Array.from(new Set([...profiles.values()].map((p) => p.teamId)));
  const clubCleanSheetProb = new Map<number, number>();
  for (const clubId of clubIds) {
    const any = [...profiles.values()].find((p) => p.teamId === clubId);
    clubCleanSheetProb.set(clubId, any?.cleanSheetProbability ?? 0.3);
  }

  // Seeded on the gameweek: same week, same numbers, every refresh.
  const rand = mulberry32(0x5f11 + options.currentEvent * 7919);

  const scoresByEntry = new Map<number, number[]>();
  for (const s of squads) scoresByEntry.set(s.entry, new Array(runs).fill(0));

  const playerPoints = new Map<number, number>();
  const cleanSheets = new Map<number, boolean>();

  for (let run = 0; run < runs; run++) {
    cleanSheets.clear();
    for (const clubId of clubIds) {
      cleanSheets.set(clubId, rand() < (clubCleanSheetProb.get(clubId) ?? 0.3));
    }
    playerPoints.clear();
    for (const [id, profile] of profiles) {
      playerPoints.set(
        id,
        drawPoints(profile, cleanSheets.get(profile.teamId) ?? false, rand)
      );
    }
    for (const s of squads) {
      let total = 0;
      for (const id of s.xi) {
        const pts = playerPoints.get(id) ?? 0;
        total += id === s.captainId ? pts * 2 : pts;
      }
      scoresByEntry.get(s.entry)![run] = total;
    }
  }

  const myScores = scoresByEntry.get(me.entry)!;
  const myXi = new Set(me.xi);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

  const toOutlook = (s: RivalSquad): RivalOutlook => {
    const theirScores = scoresByEntry.get(s.entry)!;
    let wins = 0;
    let diffSum = 0;
    let diffSqSum = 0;
    for (let i = 0; i < runs; i++) {
      const d = myScores[i] - theirScores[i];
      if (d > 0) wins++;
      diffSum += d;
      diffSqSum += d * d;
    }
    const diffMean = diffSum / runs;
    const diffVar = Math.max(0, diffSqSum / runs - diffMean * diffMean);
    const diffSd = Math.sqrt(diffVar);

    const gap = me.totalPoints - s.totalPoints;
    // Project the season out: the per-gameweek difference compounds, and its
    // spread grows with the square root of the gameweeks left.
    const projectedGap = gap + diffMean * gameweeksRemaining;
    const seasonSd = Math.max(1e-6, diffSd * Math.sqrt(Math.max(1, gameweeksRemaining)));
    const pAhead = s.entry === me.entry ? 1 : normalCdf(projectedGap / seasonSd);

    return {
      entry: s.entry,
      entryName: s.entryName,
      playerName: s.playerName,
      rank: s.rank,
      totalPoints: s.totalPoints,
      expectedGwPoints: Math.round(mean(theirScores) * 10) / 10,
      pWinGameweek: Math.round((wins / runs) * 1000) / 1000,
      pAheadAtSeasonEnd: Math.round(pAhead * 1000) / 1000,
      gap,
      overlap: s.xi.filter((id) => myXi.has(id)).length,
    };
  };

  const meOutlook = toOutlook(me);
  const rivals = squads
    .filter((s) => !s.isMe)
    .map(toOutlook)
    .sort((a, b) => a.rank - b.rank);

  return {
    available: true,
    reason: null,
    squadsFromEvent: options.squadsFromEvent,
    gameweeksRemaining,
    runs,
    me: meOutlook,
    rivals,
    posture: buildPosture(meOutlook, rivals, gameweeksRemaining),
  };
}
