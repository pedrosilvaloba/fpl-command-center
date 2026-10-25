import type { TransferPlan } from "./transferplan";

/**
 * Deterministic scenario sensitivity, NOT a probability or recalibration.
 * Stress incoming players' original five-GW projection, keeping the
 * comparison to a zero-transfer hold fixed. Never mutate solver outputs.
 */
export interface SensitivityCase {
  downsidePct: number;
  rawGain: number;
  stressedGain: number;
  breakEvenPct: number | null;
  reversesDecision: boolean;
  evidence: "hypothetical";
}
export function planSensitivity(plan: TransferPlan, downsidePct = 20): SensitivityCase {
  const pct = Math.min(50, Math.max(0, Number.isFinite(downsidePct) ? downsidePct : 20));
  const incomingProjection = plan.moves.reduce((sum, m) => sum + Math.max(0, m.in.expectedPoints), 0);
  const rawGain = Number.isFinite(plan.netGainVsHold) ? plan.netGainVsHold : 0;
  const stressedGain = Math.round((rawGain - incomingProjection * pct / 100) * 10) / 10;
  return {
    downsidePct: pct,
    rawGain,
    stressedGain,
    breakEvenPct: incomingProjection > 0 && rawGain > 0
      ? Math.round(Math.min(100, rawGain / incomingProjection * 100) * 10) / 10
      : null,
    reversesDecision: rawGain > 0 && stressedGain <= 0,
    evidence: "hypothetical",
  };
}
