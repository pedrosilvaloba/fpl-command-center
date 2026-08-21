import type { FplElement } from "./types";

/**
 * Expected-points model — converts a player plus a fixture context into an
 * estimate of the FPL points they will actually score.
 *
 * WHY THIS FILE REPLACED THE OLD WEIGHTED SUM
 * -------------------------------------------
 * Until v1.11 the scoring engine produced an arbitrary weighted sum: form
 * times some constant, plus points-per-game times another, plus expected
 * goal involvements times another, and so on. An independent audit showed
 * that number had three structural problems that no amount of retuning the
 * constants could fix:
 *
 *  1. It had no unit. Midfielders scored 22-64, defenders 9-32, purely
 *     because the attacking terms were bigger — so any decision that
 *     compares ACROSS positions (which XI to start, which transfer is
 *     worth more) was decided by position rather than by merit, and a -4
 *     transfer hit could not be priced at all because "-4" and "score"
 *     were not the same kind of thing.
 *  2. It counted recent form roughly five times over. `form`, `ppg`,
 *     `ep_next` (FPL's own projection, which itself is built from form and
 *     fixtures), the realised-returns half of the threat blend, and the
 *     Influence part of the ICT index are all substantially the same
 *     signal. Around 60% of a premium player's score came from "has scored
 *     recently", which is precisely the bias the individual-threat model
 *     was built to counteract.
 *  3. Several genuinely predictive, already-fetched signals were unused
 *     because there was no natural slot for them in a sum of unlike
 *     things — most notably bonus points, which are worth roughly 0.5-1.5
 *     points a gameweek for a premium and are highly predictable.
 *
 * Modelling expected points directly fixes all three at once: every
 * component is in the same unit (points), each real scoring mechanism is
 * counted exactly once because it corresponds to one term, and adding a
 * new mechanism means adding the points it actually pays rather than
 * inventing another multiplier.
 *
 * HONEST LIMITS
 * -------------
 * This is a model, not a simulation. It assumes goals and assists arrive
 * at the player's blended per-90 rate scaled by expected minutes; it does
 * not model the correlation between a team keeping a clean sheet and that
 * team's attackers scoring, it does not model cards or penalty misses
 * (small and near-unpredictable), and it does not model goalkeeper save
 * points at all because FPL's bootstrap payload does not carry a `saves`
 * field. Each of those is a known, bounded understatement rather than a
 * silent error — see the comments on the individual terms.
 */

function toNum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// FPL 2026/27 scoring, mirrored from RULES_2026_27 in lib/strategy.ts —
// element_type: 1 GK, 2 DEF, 3 MID, 4 FWD.
const GOAL_POINTS: Record<number, number> = { 1: 10, 2: 6, 3: 5, 4: 4 };
const CLEAN_SHEET_POINTS: Record<number, number> = { 1: 4, 2: 4, 3: 1, 4: 0 };
const ASSIST_POINTS = 3;
// Defensive-contribution thresholds: DEF needs 10 CBIT, MID/FWD 12 CBIRT.
// Goalkeepers do not earn this bonus.
const DC_THRESHOLD: Record<number, number> = { 2: 10, 3: 12, 4: 12 };
const DC_POINTS = 2;

/** Positions that concede the -1-per-2-goals penalty. */
const CONCEDE_PENALTY_POSITIONS = new Set([1, 2]);

export interface MinutesModel {
  /** P(this player starts a given fixture). */
  pStart: number;
  /** Expected minutes played when he does start, capped at 90. */
  avgMinutesPerStart: number;
  /** P(reaching the 60-minute threshold in a given fixture). */
  pPlay60: number;
  /** P(appearing at all in a given fixture). */
  pAppear: number;
  /** Expected minutes per fixture. */
  expectedMinutes: number;
  reasons: string[];
}

/**
 * Estimates how much of a fixture a player is actually on the pitch for.
 *
 * This is the single most important input to the whole model: FPL pays
 * appearance points at 60 minutes, requires 60 minutes for a clean sheet,
 * and a player who does not play scores nothing regardless of how good he
 * is. Two separate risks are modelled, because they are genuinely
 * different things — whether he starts at all (rotation), and whether he
 * stays on long enough to matter when he does (early substitution, the
 * "Rice pattern").
 *
 * KNOWN BIAS, STATED PLAINLY: FPL publishes total `minutes` and total
 * `starts`, but not minutes-while-starting. `minutes / starts` therefore
 * includes any minutes earned as a substitute in the numerator without
 * those appearances appearing in the denominator, so it is an UPPER BOUND
 * on true minutes-per-start. The practical consequence is that a player
 * who is both hooked early when he starts and used off the bench in other
 * games can escape the early-substitution penalty. Capping the estimate at
 * 90 limits how far wrong this can go, and expected minutes deliberately
 * ignores substitute cameos entirely (worth ~1 appearance point), which
 * biases the estimate slightly downward as a partial offset. There is no
 * way to remove this bias with the data FPL publishes.
 */
export function computeMinutesModel(
  el: FplElement,
  teamFinishedFixtures: number,
  isPreseason: boolean
): MinutesModel {
  const reasons: string[] = [];
  const minutes = toNum(el.minutes);
  const starts = toNum(el.starts);

  // Before any football has been played there is no evidence either way,
  // so assume a full-time starter rather than inventing a penalty. The
  // preseason branch of the scoring engine leans on FPL's own `ep_next`
  // instead, which already embeds their read on who is expected to play.
  if (isPreseason || teamFinishedFixtures <= 0) {
    return {
      pStart: 1,
      avgMinutesPerStart: 90,
      pPlay60: 0.9,
      pAppear: 1,
      expectedMinutes: 81,
      reasons,
    };
  }

  const pStart = Math.min(1, Math.max(0, starts / teamFinishedFixtures));
  if (pStart < 0.5 && starts > 0) {
    reasons.push(
      `risco de rotação: titular em ${Math.round(pStart * 100)}% dos jogos da equipa esta época`
    );
  }

  // Upper-bound estimate (see the bias note above), capped at a full match.
  const avgMinutesPerStart =
    starts > 0 ? Math.min(90, minutes / starts) : 0;

  // P(reaching 60 minutes | started). A player averaging ~85min almost
  // always gets there; one averaging ~60 gets there roughly half the
  // time, because that average is made of full matches and early hooks.
  const pPlay60GivenStart =
    avgMinutesPerStart <= 35
      ? 0
      : Math.min(0.97, (avgMinutesPerStart - 35) / 45);

  if (starts >= 3 && avgMinutesPerStart > 0 && avgMinutesPerStart < 65) {
    reasons.push(
      `padrão de substituição cedo: ~${Math.round(avgMinutesPerStart)}min por jogo como titular (limiar de 60min para pontos de presença completos e clean sheet)`
    );
  }

  const pPlay60 = pStart * pPlay60GivenStart;
  // Substitute cameos are deliberately not modelled (see bias note).
  const pAppear = pStart;
  const expectedMinutes = pStart * avgMinutesPerStart;

  return { pStart, avgMinutesPerStart, pPlay60, pAppear, expectedMinutes, reasons };
}

export interface ExpectedPointsBreakdown {
  appearance: number;
  goals: number;
  assists: number;
  cleanSheet: number;
  concededPenalty: number;
  defensiveContribution: number;
  bonus: number;
  total: number;
}

export interface PlayerRates {
  /** Blended expected goals per 90. */
  xg90: number;
  /** Blended expected assists per 90. */
  xa90: number;
  /** Realised bonus points per 90. */
  bonus90: number;
  /** Defensive-contribution actions per 90. */
  dc90: number;
  /** Extra goal involvement per 90 attributable to set-piece duty. */
  setPieceXg90: number;
  reasons: string[];
}

const PENALTY_XG90: Record<number, number> = { 1: 0.22, 2: 0.05 };
const FREEKICK_XG90: Record<number, number> = { 1: 0.05, 2: 0.01 };

/**
 * Per-90 scoring rates for one player, blending FPL's underlying
 * expected-goals data with what he has actually produced.
 *
 * The 65/35 split favours the underlying numbers because they are the
 * better forward-looking predictor — finishing regresses to the mean far
 * faster than chance creation does — while still leaving room for a
 * genuinely elite finisher to be recognised as one. Note that this is the
 * ONLY place realised output enters the model; the old formula let it in
 * through five separate doors.
 */
export function computePlayerRates(el: FplElement): PlayerRates {
  const reasons: string[] = [];
  const minutes = toNum(el.minutes);
  const per90 = (total: number) => (minutes > 0 ? (total / minutes) * 90 : 0);

  const xgUnderlying = toNum(el.expected_goals_per_90);
  const xaUnderlying = toNum(el.expected_assists_per_90);
  const xgActual = per90(toNum(el.goals_scored));
  const xaActual = per90(toNum(el.assists));

  const blend = (underlying: number, actual: number) =>
    underlying > 0 || actual > 0 ? underlying * 0.65 + actual * 0.35 : 0;

  const xg90 = blend(xgUnderlying, xgActual);
  const xa90 = blend(xaUnderlying, xaActual);

  if (xg90 + xa90 >= 0.5) {
    reasons.push(
      `ameaça alta: ~${(xg90 + xa90).toFixed(2)} golos+assistências esperados por 90min`
    );
  }

  // Bonus points: a real, highly predictable points source (roughly
  // 0.5-1.5 per gameweek for a premium) that the previous model fetched
  // and then ignored entirely.
  const bonus90 = per90(toNum(el.bonus));
  if (bonus90 >= 0.5) {
    reasons.push(`acumula bónus com regularidade (~${bonus90.toFixed(2)}/90min)`);
  }

  const dc90 = per90(toNum(el.defensive_contribution));

  // Set-piece duty. Unlike form or xG this is a ROLE, not an accumulated
  // statistic, so it is known before a ball is kicked — which makes it the
  // strongest individual differentiator available in preseason. The old
  // model computed it and then discarded it in exactly that branch.
  let setPieceXg90 = 0;
  const penOrder = el.penalties_order ?? null;
  if (penOrder && PENALTY_XG90[penOrder]) {
    setPieceXg90 += PENALTY_XG90[penOrder];
    if (penOrder === 1) reasons.push("marcador de grandes penalidades");
  }
  const fkOrder = el.direct_freekicks_order ?? el.corners_and_indirect_freekicks_order ?? null;
  if (fkOrder && FREEKICK_XG90[fkOrder]) {
    setPieceXg90 += FREEKICK_XG90[fkOrder];
    if (fkOrder === 1) reasons.push("responsável por bolas paradas");
  }

  return { xg90, xa90, bonus90, dc90, setPieceXg90, reasons };
}

/**
 * Expected FPL points for ONE fixture, given the player's rates, his
 * minutes model, and that fixture's team-level context.
 *
 * `teamAttackRatio` scales the player's own scoring rate by how good this
 * particular fixture is for his team's attack RELATIVE TO THAT TEAM'S OWN
 * NORMAL LEVEL — not relative to the league. That distinction matters: the
 * player's per-90 rate was earned while playing for this team, so it
 * already contains the team's standing quality. Dividing by the league
 * baseline instead (as the previous model did) counted strong teams twice
 * and systematically inflated their players.
 */
export function expectedPointsForFixture(
  elementType: number,
  rates: PlayerRates,
  mins: MinutesModel,
  ctx: {
    teamAttackRatio: number;
    cleanSheetProbability: number;
    expectedGoalsAgainst: number;
  }
): ExpectedPointsBreakdown {
  const minuteShare = mins.expectedMinutes / 90;

  const appearance = mins.pPlay60 * 2 + Math.max(0, mins.pAppear - mins.pPlay60) * 1;

  const goalRate = (rates.xg90 + rates.setPieceXg90) * ctx.teamAttackRatio;
  const goals = goalRate * minuteShare * (GOAL_POINTS[elementType] ?? 4);

  const assists = rates.xa90 * ctx.teamAttackRatio * minuteShare * ASSIST_POINTS;

  // A clean sheet only pays if the player is on the pitch at 60 minutes.
  const cleanSheet =
    (CLEAN_SHEET_POINTS[elementType] ?? 0) * ctx.cleanSheetProbability * mins.pPlay60;

  // -1 per 2 goals conceded, for keepers and defenders, again only while
  // on the pitch. Using expected goals against as a continuous proxy for
  // the step function is a deliberate simplification.
  const concededPenalty = CONCEDE_PENALTY_POSITIONS.has(elementType)
    ? -(ctx.expectedGoalsAgainst / 2) * mins.pPlay60
    : 0;

  // Defensive contribution is an all-or-nothing per-match bonus, so it
  // scales linearly with the number of fixtures — and needs close to a
  // full match to accumulate the required actions.
  const threshold = DC_THRESHOLD[elementType];
  const pDC = threshold
    ? Math.min(0.9, Math.max(0, (rates.dc90 / threshold) * 0.5))
    : 0;
  const defensiveContribution = pDC * mins.pPlay60 * DC_POINTS;

  const bonus = rates.bonus90 * minuteShare;

  const total =
    appearance + goals + assists + cleanSheet + concededPenalty + defensiveContribution + bonus;

  return {
    appearance,
    goals,
    assists,
    cleanSheet,
    concededPenalty,
    defensiveContribution,
    bonus,
    total,
  };
}

/** Sums a per-fixture breakdown across `n` equivalent fixtures. */
export function scaleBreakdown(b: ExpectedPointsBreakdown, n: number): ExpectedPointsBreakdown {
  return {
    appearance: b.appearance * n,
    goals: b.goals * n,
    assists: b.assists * n,
    cleanSheet: b.cleanSheet * n,
    concededPenalty: b.concededPenalty * n,
    defensiveContribution: b.defensiveContribution * n,
    bonus: b.bonus * n,
    total: b.total * n,
  };
}

/**
 * How much to trust our own structural model versus FPL's published
 * `ep_next` projection, as a function of how much this season's data we
 * actually have.
 *
 * With no minutes played our model has nothing to work with and FPL's
 * projection — informed by their own read on expected lineups and team
 * news — is strictly better information. By around four full matches our
 * model has real per-90 rates and fixture context that `ep_next` does not
 * expose, and should dominate. Blending on a ramp rather than switching
 * also removes the hard discontinuity the audit found at the GW1 deadline,
 * where scores jumped by a factor of three and reordered players with no
 * new information having arrived.
 *
 * Using `ep_next` here as a BLEND PARTNER rather than as one more additive
 * term is what keeps it from double-counting: it appears exactly once, and
 * its influence shrinks as independent evidence accumulates.
 */
export const MODEL_TRUST_MINUTES = 360; // ~4 full matches

export function modelTrust(minutesPlayed: number): number {
  return Math.min(1, Math.max(0, minutesPlayed / MODEL_TRUST_MINUTES));
}
