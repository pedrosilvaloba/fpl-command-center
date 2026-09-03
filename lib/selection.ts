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
