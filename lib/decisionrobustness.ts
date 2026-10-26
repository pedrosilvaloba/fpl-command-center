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

/**
 * A counterfactual stress diagnostic, NOT a recommendation policy. Identifies
 * nominal improvements that disappear under a modest downgrade of incoming
 * forecasts. The live planner remains authoritative until paired prospective
 * decision outcomes establish which threshold improves actual points.
 */
export function transferRobustness(plan: TransferPlan): {
  verdict: "hold" | "below-threshold" | "fragile" | "robust";
  stressedGain10: number;
  stressedGain20: number;
  requiredEdge: number;
  evidence: "hypothetical";
} {
  const threshold = Number.isFinite(plan.requiredEdge) ? Math.max(0,plan.requiredEdge) : Infinity;
  const ten = planSensitivity(plan,10).stressedGain;
  const twenty = planSensitivity(plan,20).stressedGain;
  const verdict = plan.moves.length===0 ? "hold" :
    !Number.isFinite(plan.netGainVsHold) || plan.netGainVsHold < threshold
      ? "below-threshold" :
      twenty >= threshold ? "robust" : "fragile";
  return {verdict,stressedGain10:ten,stressedGain20:twenty,
    requiredEdge:threshold,evidence:"hypothetical"};
}

/** Paired decision policies over exactly the same already-computed plans.
 * Shadow is counterfactual: no automatic promotion, no extra solver calls.
 * Do not confuse 20% hypothetical stress with calibrated risk.
 */
export function compareTransferPolicies(
  plans: TransferPlan[],
  live: TransferPlan | null
): {
  current: string | null;
  shadow: string | null;
  differs: boolean;
  shadowReason: "robust-plan" | "hold" | "no-valid-hold";
  evidence: "hypothetical";
} {
  const hold = plans.find(p => p.key === "manter" && p.feasible);
  const eligible = plans.filter(p => p.feasible && p.key !== "manter" &&
    p.moves.length > 0 && p.moves.every(m => m.in.element.id > 0 && m.out.element.id > 0) &&
    transferRobustness(p).verdict === "robust" &&
    Number.isFinite(p.netGainVsHold) && p.netGainVsHold >= p.requiredEdge &&
    !p.moves.some(m => m.in.expectedPoints - m.out.expectedPoints < -2));
  eligible.sort((a,b)=>b.netGainVsHold-a.netGainVsHold || a.key.localeCompare(b.key));
  const shadow = eligible[0] ?? hold ?? null;
  return {
    current: live?.key ?? null,
    shadow: shadow?.key ?? null,
    differs: !!live && !!shadow && (live.key !== shadow.key ||
      live.moves.map(m=>m.out.element.id+":"+m.in.element.id).sort().join("|") !==
      shadow.moves.map(m=>m.out.element.id+":"+m.in.element.id).sort().join("|")),
    shadowReason: eligible.length ? "robust-plan" : hold ? "hold" : "no-valid-hold",
    evidence: "hypothetical",
  };
}

export interface DecisionAlternative {
  id: string;
  label: string;
  gain: number;
  incomingProjection: number;
  requiredEdge: number;
  hits: number;
  transfers: string[];
  confidence: number;
  recommended: boolean;
  robustness: ReturnType<typeof transferRobustness>;
}
export function toDecisionAlternatives(
  plans: TransferPlan[],
  recommended: TransferPlan | null
): DecisionAlternative[] {
  const unique = new Map<string, DecisionAlternative>();
  for (const p of plans) {
    const fingerprint = [...p.moves].map(m => m.out.element.id + ":" + m.in.element.id).sort().join("|");
    if (unique.has(fingerprint)) continue;
    unique.set(fingerprint, {
      id: p.key + "-" + fingerprint,
      label: p.label,
      gain: p.netGainVsHold,
      incomingProjection: p.moves.reduce((s, m) => s + Math.max(0, m.in.expectedPoints), 0),
      requiredEdge: p.requiredEdge,
      hits: p.hitCost,
      transfers: p.moves.map(m => m.out.element.web_name + " → " + m.in.element.web_name),
      confidence: p.confidence,
      robustness: transferRobustness(p),
      recommended: p.key === recommended?.key && p.moves.length === recommended?.moves.length &&
        p.moves.every((m, i) => m.in.element.id === recommended.moves[i]?.in.element.id),
    });
  }
  return [...unique.values()].slice(0, 5);
}
export function alternativeSensitivity(plan: DecisionAlternative, downsidePct: number): SensitivityCase {
  const pct = Math.min(50, Math.max(0, Number.isFinite(downsidePct) ? downsidePct : 20));
  const stressedGain = Math.round((plan.gain - plan.incomingProjection * pct / 100) * 10) / 10;
  return {
    downsidePct: pct,
    rawGain: plan.gain,
    stressedGain,
    breakEvenPct: plan.gain > 0 && plan.incomingProjection > 0 ?
      Math.round(Math.min(100, 100 * plan.gain / plan.incomingProjection) * 10) / 10 : null,
    reversesDecision: plan.gain > 0 && stressedGain <= 0,
    evidence: "hypothetical",
  };
}
