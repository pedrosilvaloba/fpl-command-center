import assert from "node:assert/strict";
import { buildMinuteSnapshot, gradeMinuteSnapshot, judgeMinuteExperiment } from "../lib/minutebenchmark";
import { makeElement } from "./fixtures";
import type { ScoredPlayer } from "../lib/recommend";
import { deriveRecentMinutes, recentMinutesVariant, detectMinutesRoleTrend } from "../lib/recentminutes";
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
// A missing historical player record is not evidence that the player sat out.
// Genuine explicit zero-minute records remain part of the paired benchmark.
const partial=deriveRecentMinutes([4,5,6,7].map(event=>({
 event,elements:[
  {id:1,stats:{minutes:0,starts:0}},
  ...(event===4?[]:[{id:2,stats:{minutes:90,starts:1}}]),
  ...(event===6?[]:[{id:3,stats:{minutes:80,starts:1}}]),
 ],
})));
assert.deepEqual(Object.keys(partial.players),["1"],
  "Incomplete histories are excluded rather than filled with artificial zeros");
const missingMinutes=deriveRecentMinutes([4,5,6,7].map(event=>({
 event,elements:[{id:1,stats:{minutes:0,starts:0}},
 {id:2,stats:event===6?({starts:1} as Record<string,number>):{minutes:90,starts:1}}],
})));
assert.equal(missingMinutes.players["2"],undefined,
  "Missing minutes fields must not be turned into zero appearances");
assert.deepEqual(partial.players["1"].minutes,[0,0,0,0],
  "Actual recorded zero-minute gameweeks must remain valid");
const baseMinutes={pStart:.25,pAppear:.6,pPlay60:.55,expectedMinutes:35,avgMinutesPerStart:75,reasons:[]};
const coherent=recentMinutesVariant(baseMinutes,{minutes:[90,90,90,90],starts:[0,0,0,0]});
assert.ok(coherent.pPlay60<=coherent.pStart,"P(60+) must not exceed P(start)");
assert.ok(coherent.pStart<=coherent.pAppear,"P(start) must not exceed P(appear)");
assert.deepEqual(recentMinutesVariant(baseMinutes,{minutes:[90,90,90,90],starts:[1,1,1]}),baseMinutes,
  "Partial starts arrays must not distort probabilities");
assert.deepEqual(recentMinutesVariant(baseMinutes,{minutes:[90,-1,90,90],starts:[1,1,1,1]}),baseMinutes,
  "Malformed negative historical minutes must fail closed");
const reduced={minutes:[90,90,20,10],starts:[1,1,0,0]};
const increased={minutes:[0,15,80,90],starts:[0,0,1,1]};
assert.equal(detectMinutesRoleTrend(reduced),"reduced");
assert.equal(detectMinutesRoleTrend(increased),"increased");
assert.equal(detectMinutesRoleTrend({minutes:[90,90,10,90],starts:[1,1,0,1]}),"stable",
  "A single benching must not trigger a role-change warning");
assert.equal(detectMinutesRoleTrend({minutes:[90,90,10],starts:[1,1,0]}),"insufficient");
const reducedModel=recentMinutesVariant(
  {pStart:.8,pAppear:.95,pPlay60:.8,expectedMinutes:75,avgMinutesPerStart:80,reasons:[]},
  reduced);
assert.ok(reducedModel.expectedMinutes<75);
assert.ok(reducedModel.reasons.some(reason=>reason.includes("redução de minutos")));
const increasedModel=recentMinutesVariant(
  {pStart:.25,pAppear:.45,pPlay60:.2,expectedMinutes:25,avgMinutesPerStart:70,reasons:[]},
  increased);
assert.ok(increasedModel.expectedMinutes>25);
assert.ok(increasedModel.reasons.some(reason=>reason.includes("subida de minutos")));
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
assert.equal(result.roleTrendBands?.reduce((total,b)=>total+b.base.n,0),20,
  "Every valid prospective player must belong to exactly one observed role group");
const changedRecent=deriveRecentMinutes([4,5,6,7].map((event,index)=>({
  event,elements:elements.map(e=>({id:e.id,stats:{
    minutes:e.id===2?(index<2?90:10):e.id===3?(index<2?10:90):70,
    starts:1,
  }})),
})));
const changedSnapshot=buildMinuteSnapshot(player,changedRecent,8,deadline,before)!;
const changedResult=gradeMinuteSnapshot(changedSnapshot,actual);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="reduced")?.base.n,1);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="increased")?.base.n,1);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="stable")?.base.n,18);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="reduced")?.recent.n,1,
  "Paired role groups must use identical player cohorts for both models");

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
const corrupt=new Map<number,{minutes:number;starts:number|null}>(actual);
corrupt.set(2,{minutes:-20,starts:1});
corrupt.set(3,{minutes:Number.NaN,starts:1});
corrupt.set(4,{minutes:80,starts:2});
const guarded=gradeMinuteSnapshot(snapshot,corrupt);
assert.equal(guarded.recentEligible,18,"Invalid actual-minute outcomes cannot be silently turned into zero");
assert.equal(guarded.base.startsN,17,"Invalid start labels must not be counted as evidence");
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
assert.equal(winning.startsEvaluatedGameweeks,12);
const badStarts=judgeMinuteExperiment(historical.map(r=>({
  ...r,base:{...r.base,startsBrier:.16,startsN:20},
  recent:{...r.recent,startsBrier:.34,startsN:20},
})));
assert.equal(badStarts.status,"not-better",
  "A minutes gain cannot promote a model that predicts starts materially worse");
assert.ok((badStarts.meanGainStartsBrier??0)<0);
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

const futureHistory = { ...recent, events: [4,5,6,8] };
const noLeak = buildMinuteSnapshot(player,futureHistory,8,deadline,before);
assert.ok(noLeak);
assert.equal(noLeak.lastCompletedEvents.length,0,"future GW can never influence a predeadline model");
assert.ok(noLeak.players.every(p=>!p.hasRecent));
const afterCapture = { ...recent, at:"2026-10-26T12:00:00Z" };
const noLateHistory=buildMinuteSnapshot(player,afterCapture,8,deadline,before);
assert.ok(noLateHistory);
assert.equal(noLateHistory.lastCompletedEvents.length,0,"postdeadline history must be rejected");
const duplicateHistory={...recent,events:[4,5,5,7]};
assert.equal(buildMinuteSnapshot(player,duplicateHistory,8,deadline,before)?.lastCompletedEvents.length,0);
const duplicateResults=judgeMinuteExperiment([...historical,historical[0]]);
assert.equal(duplicateResults.events,11,"duplicate GW cannot manufacture independent weeks");
assert.equal(duplicateResults.status,"insufficient");
console.log("prospective minute data leakage and distinct-GW guards passed");
