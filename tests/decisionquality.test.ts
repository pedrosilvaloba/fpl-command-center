import assert from "node:assert/strict";
import { auditFrozenDecisions } from "../lib/decisionquality";
import type { AdviceRecord, OutcomeRecord } from "../lib/decisions";

const xi = Array.from({ length: 11 }, (_, i) => i + 1);
const bench = [12, 13, 14, 15];
const advice: AdviceRecord = {
  event: 9, at: "2026-10-30T12:00:00Z", captain: 1, vice: 2,
  xi, bench, transfers: [], hitCost: 0, chip: null,
  captainSource: "model", predictedXi: 50,
  holdBaseline: { xi: [...xi], bench: [...bench], captain: 1, vice: 2 },
};
const outcome: OutcomeRecord = {
  event: 9, settledAt: "2026-11-02T20:00:00Z",
  app: { points: 52, captain: 1, captainPts: 8 },
  pedro: { points: 49, captain: 2, captainPts: 6, official: 49, chip: null },
  followedCaptain: false, followedTransfers: true, diff: 3,
  settlement: {
    simulated: 52, actualViaMultipliers: 49, netDifference: 3,
    subCount: 0, holdPoints: 49, gainVsHold: 3,
    officialReported: 49, officialDelta: 0, note: "validated",
  },
};
const deadlineIso = "2026-10-31T11:00:00Z";
const week = { advice, outcome, deadlineIso };
const valid = auditFrozenDecisions([week]);
assert.equal(valid.eligible, 1);
assert.equal(valid.totalGainVsHold, 3);
assert.equal(valid.meanGainVsHold, 3);
assert.equal(valid.verdict, "insufficient-evidence");
assert.equal(valid.rows[0].differenceVsManager, 3);

const afterDeadline = auditFrozenDecisions([{
  ...week, advice: { ...advice, at: "2026-10-31T11:01:00Z" },
}]);
assert.equal(afterDeadline.eligible, 0);
assert.equal(afterDeadline.excluded["invalid-or-postdeadline-snapshot"], 1);

const noHold = auditFrozenDecisions([{ ...week, advice: { ...advice, holdBaseline: undefined } }]);
assert.equal(noHold.eligible, 0);
assert.equal(noHold.excluded["chip-or-hold-baseline-unavailable"], 1);

const dishonest = auditFrozenDecisions([{ ...week, outcome: {
  ...outcome, settlement: { ...outcome.settlement!, officialDelta: 7 },
} }]);
assert.equal(dishonest.eligible, 0);
assert.equal(dishonest.excluded["unverified-settlement"], 1);

const mismatch = auditFrozenDecisions([{ ...week, outcome: {
  ...outcome, settlement: { ...outcome.settlement!, gainVsHold: 100 },
} }]);
assert.equal(mismatch.eligible, 0);
assert.equal(mismatch.excluded["inconsistent-points"], 1);

const duplicates = auditFrozenDecisions([week, week]);
assert.equal(duplicates.eligible, 0);
assert.equal(duplicates.excluded["duplicate-gameweek"], 2);

const invalid = auditFrozenDecisions([{ ...week, advice: {
  ...advice, xi: [1, 1, ...xi.slice(2)],
} }]);
assert.equal(invalid.eligible, 0);
assert.equal(invalid.excluded["incomplete-lineup"], 1);

const six = auditFrozenDecisions(Array.from({ length: 6 }, (_, i) => ({
  advice: { ...advice, event: i + 1 },
  outcome: { ...outcome, event: i + 1 },
  deadlineIso,
})));
assert.equal(six.eligible, 6);
assert.equal(six.verdict, "descriptive-only", "six weeks are not automatic evidence of edge");
console.log("decision-quality frozen benchmark tests passed");
