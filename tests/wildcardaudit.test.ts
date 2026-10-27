import assert from "node:assert/strict";
import {auditWildcardXI} from "../lib/wildcardaudit";
import type {ScenarioPlayerView} from "../lib/chipscenarioview";
const xi=Array.from({length:11},(_,i)=>({
 id:i+1,name:"P"+(i+1),team:"T",pos:"MID",price:6,next:2,window:10,
 seasonPts:30,ppg:i===2?9:2,officialNext:i===1?8:1,elite:null,
} satisfies ScenarioPlayerView));
const audit=auditWildcardXI(xi,1);
assert.equal(audit.comparable,true);
assert.equal(audit.ppgCaptain,3);
assert.equal(audit.officialCaptain,2);
assert.equal(audit.modelVsPpgDisagree,true);
assert.equal(audit.modelVsOfficialDisagree,true);
assert.equal(audit.coverage,11);
assert.equal(auditWildcardXI(xi.map((x,i)=>({...x,officialNext:i===3?null:x.officialNext})),1).officialCaptain,null);
assert.equal(auditWildcardXI([...xi.slice(1),xi[1]],1).comparable,false);
console.log("Wildcard independent baseline audit passed");
