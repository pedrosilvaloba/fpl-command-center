import assert from "node:assert/strict";
import { buildMinuteSnapshot, gradeMinuteSnapshot, judgeMinuteExperiment } from "../lib/minutebenchmark";
import { makeElement } from "./fixtures";
import type { ScoredPlayer } from "../lib/recommend";
import { deriveRecentMinutes } from "../lib/recentminutes";
const before=Date.parse("2026-10-25T10:00:00Z");
const deadline="2026-10-25T18:00:00Z";
const elements=Array.from({length:20},(_,i)=>makeElement({id:i+1,web_name:"P"+i}));
const player=elements.map((e,i)=>({
 element:e,expectedMinutesNext:i===0?0:65,pPlay:i===0?.1:.85,
 pStart:.75,pPlay60:.7,
} as ScoredPlayer));
const recent=deriveRecentMinutes([4,5,6,7].map(event=>({
 event,elements:elements.map(e=>({id:e.id,stats:{
  minutes:e.id===1?0:70,starts:e.id===1?0:1,
 }})),
})));
const snapshot=buildMinuteSnapshot(player,recent,8,deadline,before);
assert.ok(snapshot);
assert.equal(snapshot.players.length,20);
assert.equal(snapshot.lastCompletedEvents.length,4);
assert.equal(buildMinuteSnapshot(player,recent,8,deadline,Date.parse(deadline)),null);
const actual=new Map(elements.map((e,i)=>[
 e.id,{minutes:i%5===0?0:80,starts:i%5===0?0:1},
] as const));
const result=gradeMinuteSnapshot(snapshot,actual);
assert.equal(result.eligible,20);
assert.equal(result.recentEligible,20);
assert.equal(result.base.n,20);
assert.equal(result.recent.n,20);
assert.ok(result.base.appearanceBrier>0);
assert.ok(Number.isFinite(result.recent.minutesMAE));
assert.ok(result.base.startsBrier!==null);
const noStarts=new Map(elements.map((e,i)=>[e.id,{
 minutes:i%5===0?0:80,starts:null,
}] as const));
const missingGrade=gradeMinuteSnapshot(snapshot,noStarts);
assert.equal(missingGrade.base.startsBrier,null);
assert.equal(missingGrade.recent.startsN,0);
const zeros=new Map(elements.map(e=>[e.id,{minutes:0,starts:0}] as const));
const blank=gradeMinuteSnapshot(snapshot,zeros);
assert.equal(blank.recentEligible,20,"Actual zero-minute players must not be discarded");
const n1=gradeMinuteSnapshot(snapshot,actual);
const n2=gradeMinuteSnapshot(snapshot,actual);
assert.deepEqual(n1.base,n2.base,"Metric reproducibility must not depend on current date");
console.log("minutes paired benchmark tests passed");

assert.equal(judgeMinuteExperiment([result]).status,"insufficient");
const historical = Array.from({length:12},(_,i)=>({
  ...result,event:10+i,
  base:{...result.base,minutesMAE:20+(i%3)*.1,appearanceBrier:.18},
  recent:{...result.recent,minutesMAE:17+(i%3)*.1,appearanceBrier:.15},
}));
const winning=judgeMinuteExperiment(historical);
assert.equal(winning.events,12);
assert.equal(winning.status,"improved");
assert.ok(winning.confidenceLow!==null && winning.confidenceLow>0);
const losing=judgeMinuteExperiment(historical.map(r=>({
  ...r,base:{...r.base,minutesMAE:14},
  recent:{...r.recent,minutesMAE:20},
})));
assert.equal(losing.status,"worse");
const brierBad=judgeMinuteExperiment(historical.map(r=>({
  ...r,recent:{...r.recent,appearanceBrier:.27},
})));
assert.equal(brierBad.status,"not-better");
console.log("minutes evidence gates passed");
