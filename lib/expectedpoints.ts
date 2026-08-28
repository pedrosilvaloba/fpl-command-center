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
 * (small and near-unpredictable). Goalkeeper save points ARE modelled as
 * of v1.24 — see the saves term below; before that, keepers were priced on
 * clean sheets alone, which cannot distinguish a busy shot-stopper from a
 * spectator at a better club. Each remaining gap is a known, bounded
 * understatement rather than a silent error.
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

import { type ModelParams, withParams, DEFAULT_MODEL_PARAMS } from "./modelparams";

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
  isPreseason: boolean,
  paramsOver?: Partial<ModelParams>
): MinutesModel {
  const params = withParams(paramsOver);
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
    avgMinutesPerStart <= params.minutes60Floor
      ? 0
      : Math.min(
          params.minutes60Cap,
          (avgMinutesPerStart - params.minutes60Floor) / params.minutes60Span
        );

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
  /** Goalkeeper save points (1 per 3 saves). Zero for outfielders. */
  saves: number;
  /** Expected card cost. Always negative or zero. */
  cards: number;
  total: number;
}

export interface PlayerRates {
  /** Blended expected goals per 90. */
  xg90: number;
  /** Blended expected assists per 90. */
  xa90: number;
  /** Expected bonus points per 90, predicted from BPS rate rather than
   * from realised bonus alone — see computePlayerRates. */
  bonus90: number;
  /** Goalkeeper saves per 90. */
  saves90: number;
  /** Defensive-contribution actions per 90. */
  dc90: number;
  /** Yellow cards per 90. */
  yellow90: number;
  /** Red cards per 90. */
  red90: number;
  /** Extra goal involvement per 90 attributable to set-piece duty. */
  setPieceXg90: number;
  reasons: string[];
}

/**
 * P(X >= k) for X ~ Poisson(lambda). The FPL scoring table is full of
 * thresholds — 3 saves, 2 goals conceded, 10 defensive actions — and every
 * one of them needs a tail probability rather than a ratio of averages.
 */
export function poissonSurvival(k: number, lambda: number): number {
  if (!(lambda > 0)) return k <= 0 ? 1 : 0;
  if (k <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/**
 * E[floor(X / d)] for X ~ Poisson(lambda), by the identity
 * E[floor(X/d)] = sum over j >= 1 of P(X >= j*d).
 *
 * This exists because the model previously computed lambda/d, which is the
 * function of the average rather than the average of the function. For a
 * step payout that is not an approximation, it is a one-sided bias: with
 * d = 2 it over-penalises every defender by a near-constant 0.23 points a
 * fixture, and with d = 3 it over-credits every goalkeeper by 0.33.
 */
export function expectedFloorDivide(lambda: number, d: number, maxTerms = 12): number {
  if (!(lambda > 0) || d <= 0) return 0;
  let total = 0;
  for (let j = 1; j <= maxTerms; j++) {
    const p = poissonSurvival(j * d, lambda);
    if (p < 1e-6) break;
    total += p;
  }
  return total;
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
export function computePlayerRates(
  el: FplElement,
  paramsOver?: Partial<ModelParams>
): PlayerRates {
  const params = withParams(paramsOver);
  const reasons: string[] = [];
  const minutes = toNum(el.minutes);
  const per90 = (total: number) => (minutes > 0 ? (total / minutes) * 90 : 0);

  const xgUnderlying = toNum(el.expected_goals_per_90);
  const xaUnderlying = toNum(el.expected_assists_per_90);
  const xgActual = per90(toNum(el.goals_scored));
  const xaActual = per90(toNum(el.assists));

  const blend = (underlying: number, actual: number) =>
    underlying > 0 || actual > 0
      ? underlying * params.underlyingBlend + actual * (1 - params.underlyingBlend)
      : 0;

  const xg90 = blend(xgUnderlying, xgActual);
  const xa90 = blend(xaUnderlying, xaActual);

  if (xg90 + xa90 >= 0.5) {
    reasons.push(
      `ameaça alta: ~${(xg90 + xa90).toFixed(2)} golos+assistências esperados por 90min`
    );
  }

  // BONUS POINTS, PREDICTED FROM BPS RATHER THAN FROM PAST BONUS.
  //
  // Bonus is decided by the Bonus Points System: the top three BPS scores
  // in a match collect 3, 2 and 1 points. Modelling bonus from a player's
  // REALISED bonus — as this did until v1.24 — predicts a lumpy,
  // all-or-nothing outcome from a handful of past all-or-nothing outcomes,
  // which is about the noisiest estimator available. His BPS RATE is the
  // underlying quantity that actually produces those outcomes, and it
  // accumulates every match whether or not he finishes top three.
  //
  // The mapping below is a calibration, not a derivation: a BPS rate
  // around 12/90 almost never reaches the podium, ~25 gets there
  // occasionally, and 40+ is the territory of players who collect bonus
  // most weeks. Capped because no one earns 3 bonus points every match.
  const bps90 = per90(toNum(el.bps));
  const bonusFromBps = Math.min(
    params.bpsMaxBonus,
    Math.max(0, (bps90 - params.bpsIntercept) / params.bpsDivisor)
  );
  const bonusRealised = per90(toNum(el.bonus));
  // Blend, favouring the more stable BPS-derived figure but letting a
  // player who genuinely converts BPS into bonus better than the curve
  // suggests be recognised.
  const bonus90 =
    bps90 > 0
      ? bonusFromBps * params.bpsBlend + bonusRealised * (1 - params.bpsBlend)
      : bonusRealised;
  if (bonus90 >= 0.5) {
    reasons.push(
      `forte candidato a pontos de bónus (~${bps90.toFixed(0)} BPS/90min)`
    );
  }

  // GOALKEEPER SAVE POINTS — 1 point per 3 saves.
  //
  // Until v1.24 keepers were scored on clean sheets alone, which cannot
  // express the single most useful goalkeeper archetype in FPL: the busy
  // shot-stopper at a mid-table club, who concedes more but faces far more
  // shots and banks save points every week. Two keepers with identical
  // clean-sheet odds are NOT equivalent assets.
  const saves90 = per90(toNum(el.saves));
  if (saves90 >= 3) {
    reasons.push(`guarda-redes muito solicitado (~${saves90.toFixed(1)} defesas/90min)`);
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

  // Cards. Both fields are in the bootstrap payload and were simply never
  // read. Shrunk like every other rate below, because a single early
  // booking on 90 minutes played implies a 1.0/90 rate that is obviously
  // noise.
  const yellow90 = per90(toNum(el.yellow_cards));
  const red90 = per90(toNum(el.red_cards));
  if (yellow90 >= 0.3) {
    reasons.push(
      `propensão a cartões: ~${yellow90.toFixed(2)} amarelos por 90min`
    );
  }

  // SMALL-SAMPLE SHRINKAGE.
  //
  // Every rate above is a per-90 computed from whatever minutes exist. On
  // 90 minutes played, one 60-BPS match implies a BPS rate of 60 and one
  // booking implies a card every game. The global trust ramp elsewhere
  // keys off total minutes and treats all statistics alike, but they do not
  // accumulate alike: expected goals builds shot by shot, bonus realises a
  // handful of times a season. Each rate is therefore pulled toward a
  // neutral prior by its own sample size, with a heavier prior on the
  // statistics that realise rarely.
  const matches = minutes / 90;
  const shrink = (rate: number, k: number, prior = 0) =>
    matches > 0 ? (rate * matches + prior * k) / (matches + k) : prior;

  return {
    xg90: shrink(xg90, params.shrinkXg),
    xa90: shrink(xa90, params.shrinkXa),
    bonus90: shrink(bonus90, params.shrinkBonus),
    saves90: shrink(saves90, params.shrinkSaves),
    dc90: shrink(dc90, params.shrinkDc),
    yellow90: shrink(yellow90, params.shrinkYellow, params.priorYellow90),
    red90: shrink(red90, params.shrinkRed, params.priorRed90),
    setPieceXg90,
    reasons,
  };
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
    /** The team's own average goals conceded this season. Used to scale the
     * keeper's save rate against his own normal level rather than against a
     * league constant — see the saves block below. Optional so callers that
     * predate it still work. */
    teamSeasonGoalsAgainst?: number;
  }
): ExpectedPointsBreakdown {
  const minuteShare = mins.expectedMinutes / 90;

  const appearance = mins.pPlay60 * 2 + Math.max(0, mins.pAppear - mins.pPlay60) * 1;

  // `rates.xg90` is blended from FPL's own expected_goals_per_90 and from
  // realised goals. BOTH of those already contain penalties — Opta prices a
  // penalty at ~0.79 xG and a converted one is obviously a goal. Adding
  // `setPieceXg90` on top counted the designated taker's penalties a second
  // time, inflating exactly the premium attackers who are captaincy
  // candidates, where an error costs double.
  //
  // The set-piece rate is still computed and still surfaces as a reason,
  // because knowing a player is on penalties is genuinely useful — it just
  // must not be added to a number that already has it.
  const goalRate = rates.xg90 * ctx.teamAttackRatio;
  const goals = goalRate * minuteShare * (GOAL_POINTS[elementType] ?? 4);

  const assists = rates.xa90 * ctx.teamAttackRatio * minuteShare * ASSIST_POINTS;

  // A clean sheet only pays if the player is on the pitch at 60 minutes.
  const cleanSheet =
    (CLEAN_SHEET_POINTS[elementType] ?? 0) * ctx.cleanSheetProbability * mins.pPlay60;

  // -1 for EVERY 2 goals conceded, keepers and defenders only.
  //
  // This used to be -(xGA / 2), which is the average divided by the step
  // instead of the average OF the step. Verified numerically: at 1.35 xGA
  // the old form charged 0.68 where the true expectation is 0.44, and the
  // gap is near-constant (0.19 to 0.25) across the whole realistic range.
  // Because it applies only to GK and DEF, it was a fixed tax on the
  // defensive block that no midfielder or forward ever paid.
  //
  // The gate is also corrected: goals are conceded while a player is on the
  // pitch at all, not only after 60 minutes, so the rate scales by minutes
  // played rather than by P(reaching 60).
  const concededLambda = Math.max(0, ctx.expectedGoalsAgainst) * minuteShare;
  const concededPenalty = CONCEDE_PENALTY_POSITIONS.has(elementType)
    ? -expectedFloorDivide(concededLambda, 2)
    : 0;

  // Defensive contribution: 2 points once a player crosses a threshold of
  // defensive actions in a match. That is a TAIL PROBABILITY — an S-curve —
  // and the old `(actions / threshold) * 0.5` was a straight line through
  // the origin. Verified numerically: at 5 actions per 90 the line claimed
  // 25% where the truth is 3%; at 15 it claimed 75% where the truth is 93%.
  // Wrong in both directions at once, which broke exactly the cheap-defender
  // lever this scoring rule created.
  //
  // The 60-minute gate is dropped too: the bonus pays on the action count,
  // so a defender withdrawn at 55 minutes with enough actions still earns
  // it. Scaling the rate by minutes played handles that correctly.
  const threshold = DC_THRESHOLD[elementType];
  const defensiveContribution = threshold
    ? poissonSurvival(threshold, rates.dc90 * minuteShare) * DC_POINTS
    : 0;

  const bonus = rates.bonus90 * minuteShare;

  // Cards. Previously omitted as "small and unpredictable"; the yellow-card
  // rate is in fact one of the more stable per-player rates there is, and
  // the omission was not neutral. It fell hardest on high-tackle centre-backs
  // and defensive midfielders running 0.25-0.40 yellows per 90 — which is
  // precisely the archetype the defensive-contribution bonus above rewards.
  // The model was paying them to tackle and never charging them for the
  // bookings tackling produces.
  const cards = -(rates.yellow90 * 1 + rates.red90 * 3) * minuteShare;

  // Saves scale with how much shooting the opponent does, so a harder
  // fixture RAISES a keeper's save points even as it lowers his clean-sheet
  // points — the two move in opposite directions, which is exactly why
  // clean sheets alone misprice the position.
  //
  // Two corrections here. First, the fixture adjustment now divides by the
  // team's OWN season baseline rather than by a league constant: the
  // keeper's save rate was earned behind this defence and already contains
  // its quality, so dividing by the league average counted team strength
  // twice — the very error the attacking side of this function fixed and
  // this side did not. Second, 1 point per 3 saves is a step, so it needs
  // the same exact treatment as goals conceded; lambda/3 over-credited
  // every keeper by a flat 0.33 points a fixture.
  const savesBaseline = ctx.teamSeasonGoalsAgainst && ctx.teamSeasonGoalsAgainst > 0
    ? ctx.teamSeasonGoalsAgainst
    : 1.35;
  const saveRateAdjustment =
    ctx.expectedGoalsAgainst > 0
      ? Math.min(1.8, Math.max(0.5, ctx.expectedGoalsAgainst / savesBaseline))
      : 1;
  const saves =
    elementType === 1
      ? expectedFloorDivide(rates.saves90 * saveRateAdjustment * minuteShare, 3)
      : 0;

  const total =
    appearance +
    goals +
    assists +
    cleanSheet +
    concededPenalty +
    defensiveContribution +
    bonus +
    saves +
    cards;

  return {
    appearance,
    goals,
    assists,
    cleanSheet,
    concededPenalty,
    defensiveContribution,
    bonus,
    saves,
    cards,
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
    saves: b.saves * n,
    cards: b.cards * n,
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
export const MODEL_TRUST_MINUTES = DEFAULT_MODEL_PARAMS.modelTrustMinutes;

export function modelTrust(
  minutesPlayed: number,
  paramsOver?: Partial<ModelParams>
): number {
  return Math.min(1, Math.max(0, minutesPlayed / withParams(paramsOver).modelTrustMinutes));
}
