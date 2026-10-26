import type { AdviceRecord, OutcomeRecord } from "./decisions";

/**
 * Offline-only, read-only evaluation of decisions archived BEFORE a deadline.
 * Does not alter production advice, write Redis, or assert transfer legality.
 * Unit of observation is a gameweek, not each correlated player prediction.
 */
export interface FrozenDecisionWeek {
  advice: AdviceRecord;
  outcome: OutcomeRecord;
  deadlineIso: string;
}

export interface DecisionWeekScore {
  event: number;
  /** Hypothetical app XI vs frozen hold-XI, adjusted for substitutions/hits. */
  gainVsHold: number;
  /** Difference between app and actual manager, not causal evidence. */
  differenceVsManager: number;
}

export interface DecisionAudit {
  inspected: number;
  eligible: number;
  excluded: Record<string, number>;
  rows: DecisionWeekScore[];
  meanGainVsHold: number | null;
  totalGainVsHold: number | null;
  positiveWeeks: number;
  negativeWeeks: number;
  verdict: "insufficient-evidence" | "descriptive-only";
}

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

const validLineup = (xi: number[], bench: number[]): boolean => {
  const ids = [...xi, ...bench];
  return xi.length === 11 && bench.length === 4 &&
    new Set(ids).size === 15 && ids.every((id) => Number.isSafeInteger(id) && id > 0);
};

const excludedReason = (week: FrozenDecisionWeek): string | null => {
  const { advice, outcome, deadlineIso } = week;
  const deadline = Date.parse(deadlineIso);
  const recorded = Date.parse(advice.at);
  const settled = Date.parse(outcome.settledAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(recorded) ||
      !Number.isFinite(settled) || recorded >= deadline ||
      settled <= deadline) return "invalid-or-postdeadline-snapshot";
  if (!Number.isSafeInteger(advice.event) || advice.event < 1 ||
      advice.event !== outcome.event) return "event-mismatch";
  if (advice.chip !== null || !advice.holdBaseline)
    return "chip-or-hold-baseline-unavailable";
  if (!validLineup(advice.xi, advice.bench) ||
      !validLineup(advice.holdBaseline.xi, advice.holdBaseline.bench))
    return "incomplete-lineup";
  const s = outcome.settlement;
  if (!s || !finite(s.gainVsHold) || !finite(s.holdPoints) ||
      !finite(s.simulated) || !finite(s.netDifference) ||
      !finite(s.officialDelta) || Math.abs(s.officialDelta) > 1)
    return "unverified-settlement";
  if (Math.abs(s.simulated - s.holdPoints - s.gainVsHold) > 0.001)
    return "inconsistent-points";
  return null;
};

/**
 * Duplicated event snapshots would exaggerate evidence. Exclude the whole
 * event when multiple observations are supplied, even if values agree.
 */
export function auditFrozenDecisions(weeks: FrozenDecisionWeek[]): DecisionAudit {
  const counts = new Map<number, number>();
  for (const w of weeks) counts.set(w.advice.event, (counts.get(w.advice.event) ?? 0) + 1);
  const excluded: Record<string, number> = {};
  const rows: DecisionWeekScore[] = [];
  for (const w of weeks) {
    const reason = counts.get(w.advice.event)! > 1
      ? "duplicate-gameweek" : excludedReason(w);
    if (reason) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    rows.push({
      event: w.advice.event,
      gainVsHold: w.outcome.settlement!.gainVsHold!,
      differenceVsManager: w.outcome.settlement!.netDifference,
    });
  }
  rows.sort((a, b) => a.event - b.event);
  const total = rows.reduce((s, r) => s + r.gainVsHold, 0);
  return {
    inspected: weeks.length,
    eligible: rows.length,
    excluded,
    rows,
    meanGainVsHold: rows.length ? total / rows.length : null,
    totalGainVsHold: rows.length ? total : null,
    positiveWeeks: rows.filter((r) => r.gainVsHold > 0).length,
    negativeWeeks: rows.filter((r) => r.gainVsHold < 0).length,
    // A set of observed weeks alone is never proof of superior recommendations.
    verdict: rows.length < 6 ? "insufficient-evidence" : "descriptive-only",
  };
}
