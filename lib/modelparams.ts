/**
 * THE MODEL'S TUNABLE CONSTANTS, IN ONE PLACE AND INJECTABLE.
 *
 * Every number below was, until now, a literal buried in the middle of a
 * function: a 0.65/0.35 blend, a shrinkage prior of 3 matches, a 12-BPS
 * intercept. Each was chosen because it sounded right. None had ever been
 * measured against a result, and none COULD be — you cannot calibrate a
 * constant you cannot vary.
 *
 * That is the whole reason this file exists. `lib/calibration.ts` sweeps
 * these values against real gameweeks and reports which ones actually
 * predict better. Without a seam like this, "let's tune the model with real
 * data" is not a project, it is a wish.
 *
 * THE CONTRACT: `DEFAULT_MODEL_PARAMS` holds exactly the values the model
 * shipped with. Every function that takes params defaults to these, so
 * behaviour is unchanged unless a caller deliberately overrides something.
 * There is a regression test asserting each default equals the literal it
 * replaced, because a silent drift here would move the whole model without
 * anyone deciding to.
 */

export interface ModelParams {
  /** Weight on FPL's published per-90 expected goals/assists versus the
   * player's own realised rate. The realised rate gets the remainder.
   * Underlying numbers are more stable; realised ones catch the finisher
   * genuinely outperforming his xG. */
  underlyingBlend: number;

  /** Shrinkage priors, in matches. Each rate is pulled toward a neutral
   * value by its own sample size: a rate that realises rarely (bonus,
   * cards) needs a heavier prior than one that accumulates shot by shot. */
  shrinkXg: number;
  shrinkXa: number;
  shrinkBonus: number;
  shrinkSaves: number;
  shrinkDc: number;
  shrinkYellow: number;
  shrinkRed: number;

  /** Neutral priors for the card rates — a league-typical booking rate,
   * rather than zero, so a player with no minutes is not assumed clean. */
  priorYellow90: number;
  priorRed90: number;

  /** Bonus from BPS rate: bonus ≈ (bps90 − intercept) / divisor, capped.
   * A calibration, not a derivation — which is exactly why it should be
   * measured rather than argued about. */
  bpsIntercept: number;
  bpsDivisor: number;
  bpsMaxBonus: number;
  /** Weight on the BPS-derived estimate versus realised bonus. */
  bpsBlend: number;

  /** P(reaching 60 minutes | started) ramps linearly from `floor` minutes
   * to `floor + span`, capped at `cap`. */
  minutes60Floor: number;
  minutes60Span: number;
  minutes60Cap: number;

  /** Minutes of evidence before the model's own numbers fully replace
   * FPL's `ep_next`. */
  modelTrustMinutes: number;
}

export const DEFAULT_MODEL_PARAMS: ModelParams = {
  underlyingBlend: 0.65,
  shrinkXg: 3,
  shrinkXa: 3,
  shrinkBonus: 6,
  shrinkSaves: 3,
  shrinkDc: 6,
  shrinkYellow: 6,
  shrinkRed: 10,
  priorYellow90: 0.12,
  priorRed90: 0.012,
  bpsIntercept: 12,
  bpsDivisor: 18,
  bpsMaxBonus: 2.2,
  bpsBlend: 0.7,
  minutes60Floor: 35,
  minutes60Span: 45,
  minutes60Cap: 0.97,
  modelTrustMinutes: 360,
};

/** Merge an override onto the defaults. Anything absent keeps its shipped
 * value, so a caller can vary one constant without restating the rest. */
export function withParams(over?: Partial<ModelParams>): ModelParams {
  return over ? { ...DEFAULT_MODEL_PARAMS, ...over } : DEFAULT_MODEL_PARAMS;
}

/**
 * The values a sweep is allowed to try for each parameter, and the range
 * outside which a "best" value should be treated as a red flag rather than
 * a discovery.
 *
 * Grids are deliberately coarse. A fine grid over a small sample finds a
 * precise-looking minimum that is entirely noise, and the precision is what
 * makes it convincing — which is the dangerous part.
 */
export const PARAM_GRIDS: Partial<Record<keyof ModelParams, number[]>> = {
  underlyingBlend: [0.4, 0.5, 0.65, 0.8, 0.9, 1],
  shrinkXg: [1, 2, 3, 5, 8],
  shrinkXa: [1, 2, 3, 5, 8],
  shrinkBonus: [2, 4, 6, 9, 14],
  shrinkSaves: [1, 2, 3, 5, 8],
  shrinkDc: [2, 4, 6, 9, 14],
  bpsIntercept: [6, 9, 12, 16, 20],
  bpsDivisor: [12, 15, 18, 22, 28],
  bpsBlend: [0.4, 0.55, 0.7, 0.85, 1],
  minutes60Floor: [20, 28, 35, 42, 50],
  minutes60Span: [30, 38, 45, 55, 65],
  modelTrustMinutes: [180, 270, 360, 540, 720],
};

export type TunableParam = keyof typeof PARAM_GRIDS;
