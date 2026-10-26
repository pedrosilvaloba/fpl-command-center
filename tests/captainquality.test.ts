import assert from "node:assert/strict";
import { auditCaptainBaselines } from "../lib/captainquality";
import type { ForwardResult } from "../lib/forwardbenchmark";
const base={
 event:9,capturedAt:"2026-10-30T12:00:00Z",settledAt:"2026-11-03T12:00:00Z",
 captain:{
  model:{id:1,name:"A",points:5},
  ppg:{id:2,name:"B",points:3},
  fpl:{id:3,name:"C",points:8},
 }
} as ForwardResult;
const sample=auditCaptainBaselines([base]);
assert.equal(sample.pairedGameweeks,1);
assert.equal(sample.againstPPG.totalNetExtraCaptainPoints,2);
assert.equal(sample.againstOfficialFPL.totalNetExtraCaptainPoints,-3);
assert.equal(sample.verdict,"insufficient-data");
assert.equal(auditCaptainBaselines([base,base]).pairedGameweeks,1);
assert.equal(auditCaptainBaselines([{...base,capturedAt:"2026-11-04T12:00:00Z"}]).pairedGameweeks,0);
assert.equal(auditCaptainBaselines([{...base,captain:{...base.captain,fpl:null}}]).pairedGameweeks,0);
console.log("captain baseline audit tests passed");
