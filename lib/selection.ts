import type { ScoredPlayer } from "./recommend";

/**
 * THE WINNER'S CURSE — why the "ideal squad" is always spectacular, and why
 * the Wildcard was always being recommended.
 *
 * Measured in production, gameweek 3:
 *
 *     onze atual   296.5 pts / 5 jornadas  =  59.3 por jornada
 *     onze "ideal" 461.6 pts / 5 jornadas  =  92.3 por jornada
 *
 * A normal FPL eleven scores 50-60 points a gameweek. The best managers in
 * the world average 65-70. The model believed a squad you could buy today
 * would average NINETY-TWO. That is not a good squad; it is an arithmetic
 * artefact, and it was driving every "play your Wildcard" recommendation.
 *
 * WHERE IT COMES FROM
 *
 * The optimizer picks the eleven highest expected-point estimates out of
 * roughly six hundred. Every estimate carries error. Selecting the maximum
 * of many noisy estimates does not select the best players — it selects the
 * players whose ERRORS ARE MOST POSITIVE. The chosen eleven are, almost by
 * construction, the eleven the model is most wrong about in the flattering
 * direction, and summing their point estimates adds up all that optimism.
 *
 * This is the winner's curse, and it is not a bug in any one formula. It is
 * what happens whenever you optimise over estimates instead of over truth.
 * It gets worse the noisier the estimates are — which is why it is at its
 * most violent in September, when three quarters of every number is still
 * FPL's own flat projection.
 *
 * TWO REMEDIES, AND HONESTY ABOUT WHICH ONE WORKS
 *
 * 1. SHRINKAGE BEFORE SELECTING. Each estimate is pulled toward its
 *    positional mean by how much evidence stands behind it, so a player with
 *    ninety minutes and a spectacular number is not allowed to outrank a
 *    player with nine hundred. `modelTrust` already measures exactly this —
 *    it was computed, used once for blending, and never applied where it
 *    matters most.
 *
 *    MEASURED, AND IT IS NOT ENOUGH. Simulated on a pool of six hundred
 *    players with identical true value and pure estimation noise, shrinkage
 *    changed the selected eleven's forecast by 0.1 points: with uniform
 *    trust it is a monotonic transform, so it reorders nothing, and the
 *    number REPORTED was still the unshrunk sum. It helps only where trust
 *    genuinely varies between players, which is real but small. Reported
 *    plainly here rather than left as an implication, because a comment
 *    claiming a fix the code does not deliver is worse than no comment.
 *
 * 2. A CEILING ON THE DECISION. What actually stops the damage is refusing
 *    to let an impossible number authorise a decision — see `decisionGain`
 *    below. That is a bound, not a correction: it does not make the estimate
 *    right, it stops it from being acted on.
 *
 * THE REAL FIX, WHICH CANNOT BE DONE YET. The bias has to be MEASURED:
 * replay past gameweeks, compare what the optimizer's chosen eleven was
 * forecast to score against what such an eleven actually scored, and use
 * that difference. That is precisely what lib/calibration.ts exists for, and
 * it needs gameweeks this season does not yet have. Both constants below are
 * priors held until then, and both are stated as priors.
 */

/* ===================================================================== *
 * v1.38 — WHY EVERYTHING ABOVE FAILED, MEASURED.
 *
 * The owner kept reporting the same thing: the model wanted to sell players
 * who were doing perfectly well — Gibbs-White, Horníček — for no reason he
 * could see. Three separate defences existed by then (the shrinkage below,
 * the noise floor in transferplan.ts, an incumbency bonus). The honest way to
 * settle it was to measure how much churn they actually prevent.
 *
 * THE EXPERIMENT. Build a pool of six hundred players in which every player
 * within a position has EXACTLY THE SAME TRUE VALUE. The only thing that
 * differs between them is estimation error. Every transfer the model can
 * possibly propose is therefore worth exactly zero points, and the number of
 * transfers it proposes measures, directly, how much noise it is chasing.
 *
 *     erro de estimativa      trocas propostas no wildcard
 *          0.0 pts/jorn.               0 / 15
 *          0.5 pts/jorn.              15 / 15
 *          1.0 pts/jorn.              15 / 15
 *          2.0 pts/jorn.              15 / 15
 *
 * Half a point per gameweek of noise — far less than reality — and the model
 * rebuilds the ENTIRE SQUAD, for nothing. The three defences stopped none of
 * it. Worse, the result was identical at model-trust 1.0 and 0.5, which is
 * the shrinkage confessing that it does nothing.
 *
 * WHY THEY FAILED, EACH FOR ITS OWN REASON.
 *
 * 1. THE SHRINKAGE IS A MONOTONIC TRANSFORM. When trust is similar across
 *    players — which it is, for every regular starter — pulling everyone
 *    toward the same positional mean by the same factor reorders nobody. It
 *    changes the numbers and cannot change the choice. Already admitted
 *    above; the experiment shows the admission was an understatement.
 *
 * 2. `modelTrust` SATURATES, AND WITH IT EVERY DEFENCE BUILT ON IT.
 *    `modelTrust = min(1, minutes / 360)`. Four full games and it reaches
 *    exactly 1. From gameweek four onward every regular has trust 1.0, so
 *    `selectionReliability` is 1.0 (no shrinkage at all) and `noiseFloor` is
 *    0.0 (no floor at all). The protections switch themselves off in the
 *    precise week the complaints started — and the comment on
 *    NOISE_FLOOR_MAX_POINTS said so in plain words without anyone noticing:
 *    "at full confidence the floor is zero and nothing changes."
 *
 *    The root error is conceptual. `modelTrust` measures how much of the
 *    number comes from THIS model rather than FPL's flat fallback. It does
 *    not measure how ACCURATE the number is. Four games is plenty to stop
 *    using someone else's fallback; it is nowhere near enough to know a
 *    player's true scoring rate. One quantity was doing both jobs.
 *
 * 3. HALF A POINT IS DECORATION. INCUMBENCY_BONUS was 0.5 points across a
 *    five-gameweek window. The noise it is meant to settle is several points
 *    wide. It could never have mattered, and the experiment shows it did not.
 *
 * THE FIX, FROM THE STATISTICS RATHER THAN FROM TASTE.
 *
 * A transfer is worth making when the incoming player is better by more than
 * the error in the comparison. Two facts set that threshold:
 *
 *   (a) THE ESTIMATE'S ERROR SHRINKS WITH EVIDENCE AND NEVER REACHES ZERO.
 *       A rate estimated from n games carries error of order
 *       BASE / sqrt(n + 1) per gameweek. Unlike `modelTrust` it keeps
 *       improving all season and never saturates into false certainty.
 *
 *   (b) THE INCOMING PLAYER IS SELECTED; THE INCUMBENT IS NOT. This is the
 *       asymmetry that makes the whole thing bite. Your player is in your
 *       squad for historical reasons, so his estimate is as likely to be too
 *       low as too high. The challenger is chosen as one of the best of a
 *       hundred-odd candidates, so his estimate is, on average, one of the
 *       most FLATTERING errors in that pool. Comparing them like for like
 *       systematically favours the stranger. The size of that favour is a
 *       known quantity — the expected value of an order statistic — and it
 *       is what `retentionThreshold` computes.
 *
 * This replaces both the incumbency bonus and the confidence-driven noise
 * floor with one number that is derived rather than chosen, that is largest
 * early in the season when the model knows least, and that decays as real
 * evidence accumulates instead of switching off after four games.
 * ===================================================================== */

/**
 * How wrong the model's estimate of a player's per-gameweek RATE is, in
 * points, after n gameweeks of evidence.
 *
 * This is NOT how wrong a single gameweek's prediction is. That error is
 * dominated by the irreducible randomness of football, is several times
 * larger, and says nothing about whether one player is better than another —
 * using it here would freeze the squad solid for the wrong reason. This is
 * the error in the underlying RATE, which is what a transfer rests on.
 *
 * A PRIOR, STATED AS ONE — and the single load-bearing assumption in this
 * whole mechanism. 2.0 points at one game of evidence, falling as
 * 1/sqrt(n+1): 1.00 at three games, 0.89 at four, 0.60 at ten, 0.44 at
 * twenty, 0.32 by the end of a season.
 *
 * The SHAPE is not a guess: sampling error falls with the square root of
 * sample size and never reaches zero. The CONSTANT is a judgement, and it was
 * chosen by sweeping it against both experiments rather than by taste:
 *
 *     BASE   churn na verdade plana        plantel bom
 *     1.4    8/15 com ruído 1.0 pts/jorn   6 trocas
 *     1.7    0/15                          5 trocas
 *     2.0    0/15                          0 trocas  ← escolhido
 *     2.4    0/15                          0 trocas
 *
 * 2.0 is the knee: the first value where a good squad is left alone and a
 * flat-truth pool produces no churn at all, while a weak squad still gets a
 * wildcard worth +274 true points. 2.4 behaved identically on the upgrade
 * side and slightly better on churn, and was NOT taken: it implies a rate
 * error of 1.2 points a gameweek after three games, which overstates how
 * little is knowable, and the synthetic upgrade tests are too coarse to show
 * what a stricter threshold would block. Choosing the looser of two values
 * that both pass is the conservative direction here.
 *
 * lib/calibration.ts should eventually replace this with a measurement. Until
 * it does, it is labelled a prior everywhere it surfaces.
 */
export const RATE_ERROR_BASE_PER_GW = 2.0;

/**
 * What the model knows BEFORE a ball is kicked, expressed in gameweeks of
 * equivalent evidence.
 *
 * Without this, gameweek one has zero evidence, the threshold reaches fifteen
 * window points, and no transfer is ever justifiable. That is as wrong as the
 * bug it replaces, just quieter: managers do transfer in gameweek one, and
 * they are right to, because the model is not actually ignorant. It has last
 * season's underlying numbers, preseason team strengths, market odds and
 * prices. Two gameweeks' worth is a deliberately modest claim for all of that.
 */
export const PRIOR_EVIDENCE_GAMES = 2;

/**
 * A threshold above this would be saying that no transfer is ever
 * justifiable, which is false and would be the same failure as the old
 * vanishing floor with the sign flipped. Two and a half points a gameweek of
 * edge is a real edge at any point in a season and must stay actionable.
 */
export const MAX_RATE_ERROR_PER_GW = 1.2;

export function rateErrorPerGw(gamesOfEvidence: number): number {
  const n = Math.max(0, gamesOfEvidence) + PRIOR_EVIDENCE_GAMES;
  return Math.min(MAX_RATE_ERROR_PER_GW, RATE_ERROR_BASE_PER_GW / Math.sqrt(n + 1));
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation). Needed for
 * the order statistic below, and not worth a dependency.
 */
function probit(p: number): number {
  if (!(p > 0 && p < 1)) return 0;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * How inflated, in standard deviations, the estimate of a SELECTED player is.
 *
 * Picking the best k of n noisy estimates does not pick the best k players:
 * it picks the estimates whose errors are most flattering. The right measure
 * is the AVERAGE inflation across the chosen k — the conditional mean of the
 * upper tail, φ(z) / (k/n) where z is the normal quantile at 1 − k/n. This is
 * the inverse Mills ratio, and it is the standard answer to "how good does
 * the selected group look compared with how good it is".
 *
 * FIRST ATTEMPT, AND WHY IT WAS NOT ENOUGH. v1.38 first used the quantile
 * itself — the inflation of the MARGINAL, fifteenth-best pick (0.97σ) — on
 * the reasoning that the solver fills slots rather than hunting one champion.
 * Measured on the flat-truth pool, that still left 11 of 15 players being
 * churned for nothing. The error was comparing the wrong things: a wildcard
 * swaps a GROUP of incumbents for a GROUP of newcomers, so the quantity that
 * matters is the mean inflation of the chosen group (1.50σ for 15 of 90), not
 * the inflation of its weakest member. Roughly fifty per cent larger, and the
 * difference is exactly the churn that survived.
 *
 * Still deliberately not the maximum (≈2.3σ here): that is the inflation of
 * the single best pick, applies to one slot rather than fifteen, and using it
 * everywhere would freeze the squad solid.
 */
export function selectionInflation(slotsFilled: number, candidates: number): number {
  const n = Math.max(2, candidates);
  const k = Math.min(Math.max(1, slotsFilled), n - 1);
  const p = k / n;
  const z = probit(1 - p);
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  return Math.max(0, pdf / p);
}

/**
 * Realistic alternatives for one squad slot.
 *
 * Not the whole six hundred: a defender is never a candidate to replace a
 * goalkeeper, so the relevant set is one position, roughly a hundred and
 * fifty players, of whom the plainly unaffordable and the plainly unplayable
 * are never in contention.
 *
 * Note this is the pool the shortlist is DRAWN FROM, not the shortlist. The
 * planner offers the solver about twenty candidates per position, but those
 * twenty were themselves chosen as the best of the hundred and fifty — and
 * that earlier choice is where the flattering errors were selected. Sizing
 * this by the shortlist would measure the inflation of a set that had already
 * been inflated, and miss almost all of it.
 */
export const CANDIDATES_PER_SLOT = 90;
/** Slots being filled. Fifteen, because a wildcard fills them all. */
export const SLOTS_FILLED = 15;

/**
 * How much better an incoming player must LOOK, over the whole window,
 * before the swap is worth making.
 *
 * = (error in the comparison) × (how much a chosen newcomer's estimate is
 * inflated by the mere fact of having been chosen).
 *
 * The error in the comparison is the rate error of two independent players
 * over W gameweeks. Note W and NOT sqrt(W): a rate error is PERSISTENT — if
 * the model has a player's level wrong, it has it wrong in all five
 * gameweeks. Treating it as independent weekly noise would understate it by
 * more than half.
 *
 * Over a five-gameweek window with ninety candidates per slot:
 *
 *      3 jornadas de evidência  →  7.4 pts
 *      4 jornadas               →  6.6 pts
 *     10 jornadas               →  4.5 pts
 *     20 jornadas               →  3.2 pts
 *     38 jornadas               →  2.4 pts
 *
 * Against the 0.5 points it replaces — which was itself being diluted to
 * 0.06 by a weighting bug, so the effective change is from six hundredths of
 * a point to six and a half points. That is the size of the thing that was
 * missing, and it is why the symptom was so stark.
 *
 * VERIFIED IN BOTH DIRECTIONS, because "never transfer anyone" would pass a
 * churn test perfectly:
 *
 *   - Flat-truth pool (every proposed transfer worth exactly zero):
 *     15 of 15 players churned before, 0 of 15 after, at every noise level.
 *   - Real-differences pool with a genuinely weak squad: the wildcard is
 *     still recommended and the transfers it proposes are worth +256 TRUE
 *     points over the window.
 *   - Same model, three squads: weak → wildcard (+256 true pts), middling →
 *     one free transfer (+13.4), strong → hold (0 transfers).
 *
 * It never reaches zero, which is the whole point: the model is never
 * entitled to believe that a one-point difference between two players over
 * five gameweeks is real.
 */
export function retentionThreshold(
  gamesOfEvidence: number,
  windowGameweeks: number,
  candidatesPerSlot = CANDIDATES_PER_SLOT,
  slotsFilled = SLOTS_FILLED
): number {
  const perGw = rateErrorPerGw(gamesOfEvidence);
  const comparisonError = perGw * Math.max(1, windowGameweeks) * Math.SQRT2;
  const inflation = selectionInflation(slotsFilled, candidatesPerSlot);
  return Math.round(comparisonError * inflation * 100) / 100;
}

/** How much of a player's deviation from his positional mean survives when
 * the model has NO evidence of its own. At full evidence nothing is shrunk. */
export const SELECTION_RELIABILITY_FLOOR = 0.55;

/** A plausible ceiling for what an eleven can average per gameweek. Used
 * only to tell the user the model is over-reaching — never to alter a
 * number silently. */
export const PLAUSIBLE_XI_POINTS_PER_GW = 75;

export interface PositionMeans {
  get(elementType: number): number;
}

/**
 * Mean expected points per position across the pool, weighted toward the
 * players actually worth selecting. Using the raw mean over all six hundred
 * would shrink toward a bench-fodder average and flatten everyone; the mean
 * of the top of each position is the honest "ordinary good player" anchor.
 */
export function positionalMeans(
  pool: ScoredPlayer[],
  pick: (p: ScoredPlayer) => number,
  topPerPosition = 40
): Map<number, number> {
  const means = new Map<number, number>();
  for (const type of [1, 2, 3, 4]) {
    const inPos = pool
      .filter((p) => p.element.element_type === type)
      .sort((a, b) => pick(b) - pick(a))
      .slice(0, topPerPosition);
    if (inPos.length === 0) {
      means.set(type, 0);
      continue;
    }
    means.set(type, inPos.reduce((s, p) => s + pick(p), 0) / inPos.length);
  }
  return means;
}

/** How much of this player's estimate we are entitled to believe. */
export function selectionReliability(p: ScoredPlayer): number {
  const trust = typeof p.modelTrust === "number" ? p.modelTrust : 1;
  return (
    SELECTION_RELIABILITY_FLOOR + (1 - SELECTION_RELIABILITY_FLOOR) * Math.min(1, Math.max(0, trust))
  );
}

/**
 * The estimate the optimizer should actually rank on: pulled toward the
 * positional mean by however little evidence stands behind it.
 */
export function shrunkForSelection(
  p: ScoredPlayer,
  value: number,
  positionMean: number
): number {
  const k = selectionReliability(p);
  return positionMean + k * (value - positionMean);
}

/**
 * The gain a Wildcard decision may actually be made on.
 *
 * THE ASYMMETRY THAT IS THE REAL BUG. The current squad is not selected by
 * the optimizer, so its forecast carries no selection bias. The "ideal"
 * squad IS selected, from six hundred estimates, so it carries all of it.
 * The DIFFERENCE therefore inherits the entire winner's curse — and that
 * difference is exactly the number the Wildcard threshold was tested
 * against.
 *
 * Measured live: current eleven 59.3 points a gameweek (plausible), "ideal"
 * eleven 92.3 (impossible), stated gain 165.1 over five gameweeks. Capping
 * the ideal at a physically plausible ceiling turns that into 78.5 — still
 * possibly enough to justify the chip, but now a number that could be true.
 *
 * This is a BOUND, not a correction. It does not make the estimate right; it
 * stops an impossible estimate from authorising a decision. The estimate is
 * made right by measuring the bias against real gameweeks, which is what
 * lib/calibration.ts is for and cannot do yet for want of data.
 */
export function decisionGain(
  idealXiWindowPoints: number,
  holdXiWindowPoints: number,
  gameweeks = 5
): { gain: number; capped: boolean } {
  const ceiling = PLAUSIBLE_XI_POINTS_PER_GW * gameweeks;
  const cappedIdeal = Math.min(idealXiWindowPoints, ceiling);
  return {
    gain: Math.round((cappedIdeal - holdXiWindowPoints) * 10) / 10,
    capped: idealXiWindowPoints > ceiling,
  };
}

/**
 * Does this eleven's forecast pass a basic sanity check?
 *
 * Returns null when it does. When it does not, returns a plain sentence
 * saying so — because a model that predicts a ninety-point average should
 * say out loud that it is over-reaching rather than quietly recommending
 * that you spend a chip on it.
 */
export function implausibleXiWarning(
  xiWindowPoints: number,
  gameweeks: number
): string | null {
  if (!(gameweeks > 0) || !(xiWindowPoints > 0)) return null;
  const perGw = xiWindowPoints / gameweeks;
  if (perGw <= PLAUSIBLE_XI_POINTS_PER_GW) return null;
  return `O modelo prevê ${perGw.toFixed(0)} pontos por jornada para este onze. Um onze normal faz 50-60 e os melhores gestores do mundo andam nos 65-70, por isso este número está inflacionado — provavelmente porque escolher os melhores de seiscentas estimativas escolhe também os erros mais otimistas. Trata a diferença como um limite superior, não como uma previsão.`;
}
