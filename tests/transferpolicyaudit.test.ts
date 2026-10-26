import assert from "node:assert/strict";
import {auditTransferShadow} from "../lib/transferpolicyaudit";
import type {AdviceRecord,OutcomeRecord} from "../lib/decisions";
const xi=[1,2,3,4,5,6,7,8,9,10,11],bench=[12,13,14,15];
const base:AdviceRecord={
 event:9,at:"2026-10-30T09:00:00Z",captain:7,vice:8,xi,bench,
 transfers:[],hitCost:0,chip:null,captainSource:"modelo",predictedXi:40,
 holdBaseline:{xi,bench,captain:7,vice:8},
 shadowPlan:{xi:[...xi.slice(0,10),16],bench,captain:7,vice:8,
   transfers:[{out:11,in:16}],hitCost:0}
};
const result:OutcomeRecord={
 event:9,settledAt:"2026-11-03T09:00:00Z",
 app:{points:40,captain:7,captainPts:7},
 pedro:{points:40,captain:7,captainPts:7,official:40,chip:null},
 followedCaptain:true,followedTransfers:true,diff:0,
 settlement:{simulated:40,actualViaMultipliers:40,netDifference:0,subCount:0,
  shadowPoints:43,shadowVsLive:3,shadowVsHold:3,
  holdPoints:40,gainVsHold:0,officialDelta:0,officialReported:40,note:"valid"}
};
const week={advice:base,outcome:result,deadlineIso:"2026-10-31T11:00:00Z"};
const score=auditTransferShadow([week]);
assert.equal(score.pairedGameweeks,1);
assert.equal(score.shadowMinusCurrent,3);
assert.equal(score.wins,1);
assert.equal(score.verdict,"insufficient-evidence");
assert.equal(auditTransferShadow([week,week]).pairedGameweeks,0);
assert.equal(auditTransferShadow([week,week]).excluded["duplicate-event"],2);
assert.equal(auditTransferShadow([{...week,advice:{...base,at:"2026-11-01T12:00:00Z"}}]).excluded.timing,1);
assert.equal(auditTransferShadow([{...week,advice:{...base,shadowPlan:{...base.shadowPlan!,transfers:[]}}}]).excluded["invalid-transfer-diff"],1);
assert.equal(auditTransferShadow([{...week,outcome:{...result,settlement:{...result.settlement!,shadowVsLive:9}}}]).excluded["inconsistent-settlement"],1);
assert.equal(auditTransferShadow([{...week,outcome:{...result,settlement:{...result.settlement!,officialDelta:5}}}]).excluded["unverified-settlement"],1);
assert.equal(auditTransferShadow([{...week,advice:{...base,shadowPlan:undefined}}]).excluded["missing-comparable-plan"],1);
console.log("transfer policy integrity audit passed");
