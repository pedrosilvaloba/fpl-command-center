import assert from "node:assert/strict";
import { minuteDecisionAlerts } from "../lib/minutedecisionimpact";
import { compareMinutesDecisions } from "../lib/minutesdecisioncomparison";
import { makeFrozenPair, gradeFrozenPair, type FrozenPair } from "../lib/minutesdecisionoutcomes";
import { buildMinuteSnapshot, gradeMinuteSnapshot, judgeMinuteExperiment } from "../lib/minutebenchmark";
import { makeElement } from "./fixtures";
import type { ScoredPlayer } from "../lib/recommend";
import { deriveRecentMinutes, recentMinutesVariant, detectMinutesRoleTrend, detectReturnPattern, validProspectiveMinutesSnapshot } from "../lib/recentminutes";
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
const cameoPattern={minutes:[0,0,12,24],starts:[0,0,0,0]};
const starterReturn={minutes:[0,15,75,90],starts:[0,0,1,1]};
assert.equal(detectReturnPattern(cameoPattern),"cameos");
assert.equal(detectReturnPattern(starterReturn),"starting-return");
assert.equal(detectReturnPattern({minutes:[0,0,12,0],starts:[0,0,0,0]}),"none",
  "One brief appearance cannot confirm a stable comeback");
assert.equal(detectReturnPattern({minutes:[0,0,12,24],starts:[0,0,null,0]}),"cameos",
  "Known substitute appearance remains a cameo even with one unknown start");
assert.equal(detectReturnPattern({minutes:[0,0,12],starts:[0,0,0]}),"insufficient");
const cameoModel=recentMinutesVariant(baseMinutes,cameoPattern);
assert.ok(cameoModel.reasons.some(r=>r.includes("Duas entradas curtas")));
assert.ok(cameoModel.pStart<=cameoModel.pAppear);
const starterReturnModel=recentMinutesVariant(baseMinutes,starterReturn);
assert.ok(starterReturnModel.reasons.some(r=>r.includes("Duas titularidades longas")));
const extremeDown=recentMinutesVariant(
  {pStart:.9,pAppear:.95,pPlay60:.85,expectedMinutes:85,avgMinutesPerStart:85,reasons:[]},
  {minutes:[90,90,0,0],starts:[1,1,0,0]});
assert.ok(extremeDown.expectedMinutes>=63,
  "Confirmed downturn must not reduce forecast more than 22 minutes");
const extremeUp=recentMinutesVariant(
  {pStart:.1,pAppear:.2,pPlay60:.05,expectedMinutes:5,avgMinutesPerStart:60,reasons:[]},
  {minutes:[0,0,90,90],starts:[0,0,1,1]});
assert.ok(extremeUp.expectedMinutes<=27,
  "Confirmed return cannot increase forecast more than 22 minutes");
const singleSpike=recentMinutesVariant(
  {pStart:.2,pAppear:.3,pPlay60:.15,expectedMinutes:10,avgMinutesPerStart:50,reasons:[]},
  {minutes:[0,0,0,90],starts:[0,0,0,1]});
assert.ok(singleSpike.expectedMinutes<=25,
  "One match must not shift baseline by over 15 minutes");
const cappedBaseline={pStart:.9,pAppear:.95,pPlay60:.85,expectedMinutes:85,avgMinutesPerStart:85,reasons:[]};
const highToZero={minutes:[90,90,0,0],starts:[1,1,0,0]};
const withCap=recentMinutesVariant(cappedBaseline,highToZero);
const withoutCap=recentMinutesVariant(cappedBaseline,highToZero,false);
assert.ok(withoutCap.expectedMinutes<withCap.expectedMinutes,
  "The uncapped frozen challenger must retain the raw recency blend");
assert.equal(validProspectiveMinutesSnapshot(recent,8,deadline),true);
assert.equal(validProspectiveMinutesSnapshot({...recent,events:[4,5,6,8]},8,deadline),false,
  "A current or future GW is never valid evidence");
assert.equal(validProspectiveMinutesSnapshot({...recent,at:deadline},8,deadline),false,
  "A postdeadline archive cannot generate a fair shadow");
assert.equal(validProspectiveMinutesSnapshot({...recent,players:{
  ...recent.players,["1"]:{...recent.players["1"],minutes:[0,0,Number.NaN,0]}
}},8,deadline),false,"Non-finite past minutes must not enter the shadow");
const snapshot=buildMinuteSnapshot(player,recent,8,deadline,before);
assert.ok(snapshot);
assert.equal(snapshot.players.length,20);
const sensitive={...snapshot,players:snapshot.players.map((p,i)=>i===1?{
  ...p,availabilityContext:"available" as const,recent:{...p.recent,minutes:p.base.minutes-17}
}:i===2?{
  ...p,availabilityContext:"doubtful" as const,recent:{...p.recent,minutes:p.base.minutes-19}
}:p)};
const alerts=minuteDecisionAlerts(sensitive,12);
assert.equal(alerts.length,1,"Only substantial available-player shifts should be surfaced");
assert.equal(alerts[0].id,2);
assert.equal(minuteDecisionAlerts({...sensitive,capturedAt:deadline}).length,0,
  "Never use postdeadline snapshots for decision sensitivity");

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
assert.equal(result.uncappedComparableN,20);
assert.ok(Number.isFinite(result.uncappedMinutesMAE));
assert.equal(result.roleTrendBands?.reduce((total,b)=>total+b.base.n,0),20,
  "Every valid prospective player must belong to exactly one observed role group");
const changedRecent=deriveRecentMinutes([4,5,6,7].map((event,index)=>({
  event,elements:elements.map(e=>({id:e.id,stats:{
    minutes:e.id===2?(index<2?90:10):e.id===3?(index<2?10:90):70,
    starts:1,
  }})),
})));
const patternRecent=deriveRecentMinutes([4,5,6,7].map((event,i)=>({
  event,elements:elements.map(e=>({id:e.id,stats:{
    minutes:e.id===2?[0,0,12,24][i]:e.id===3?[0,15,75,90][i]:70,
    starts:e.id===3?(i>=2?1:0):e.id===2?0:1,
  }}))
})));
const patternSnapshot=buildMinuteSnapshot(player,patternRecent,8,deadline,before)!;
const patternScore=gradeMinuteSnapshot(patternSnapshot,actual);
assert.equal(patternScore.returnPatternBands?.find(b=>b.pattern==="cameos")?.base.n,1);
assert.equal(patternScore.returnPatternBands?.find(b=>b.pattern==="starting-return")?.recent.n,1);
const changedSnapshot=buildMinuteSnapshot(player,changedRecent,8,deadline,before)!;
const changedResult=gradeMinuteSnapshot(changedSnapshot,actual);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="reduced")?.base.n,1);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="increased")?.base.n,1);
assert.equal(changedResult.roleTrendBands?.find(b=>b.trend==="stable")?.base.n,18);
assert.equal(changedResult.availabilityBands?.reduce((total,b)=>total+b.base.n,0),20,
  "Availability cohorts must cover all scored players exactly once");
const flaggedPlayer=player.map((p,i)=>i===1 ? {
  ...p,element:{...p.element,status:"i" as const,chance_of_playing_next_round:0}
}:i===2 ? {...p,element:{...p.element,status:"d" as const,
  chance_of_playing_next_round:50}}:p);
const flaggedSnapshot=buildMinuteSnapshot(flaggedPlayer,changedRecent,8,deadline,before)!;
const flaggedGrade=gradeMinuteSnapshot(flaggedSnapshot,actual);
assert.equal(flaggedSnapshot.players[1].availabilityContext,"unavailable");
assert.equal(flaggedSnapshot.players[1].roleTrend,"insufficient",
  "Confirmed injury must not be labeled a lost starting role");
assert.equal(flaggedSnapshot.players[2].availabilityContext,"doubtful");
assert.equal(flaggedSnapshot.players[2].roleTrend,"insufficient",
  "An official fitness doubt is not sufficient to infer a new bench role");
assert.equal(flaggedGrade.availabilityBands?.find(b=>b.context==="unavailable")?.base.n,1);
assert.equal(flaggedGrade.availabilityBands?.find(b=>b.context==="doubtful")?.recent.n,1);
assert.equal(flaggedGrade.roleTrendBands?.find(b=>b.trend==="stable")?.base.n,18);

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
// Same 15-player squad: a shadow minutes change can move the starting XI
// without ever pretending this is a live recommendation or realised gain.
const assigned=elements.slice(0,15).map((e,i)=>({
  ...player[i],element:{...e,element_type:i<2?1:i<7?2:i<12?3:4},
  expectedPointsNext:i===0?8:i===1?4:i===6?3:i===7?6:5,
  pPlay:.9,
}));
const challenger=assigned.map(p=>p.element.id===7?
  {...p,expectedPointsNext:9}:p);
const compare=compareMinutesDecisions(assigned,challenger,assigned.map(p=>p.element.id));
assert.equal(compare.comparable,true);
const validPair=makeFrozenPair(8,deadline,compare,assigned.map(p=>p.element.id),before);
assert.ok(validPair);
const knownPoints=new Map(assigned.map(p=>[p.element.id,{id:p.element.id,
  position:p.element.element_type as 1|2|3|4,minutes:90,points:2}] as const));
assert.ok(gradeFrozenPair(validPair,knownPoints,"2026-10-27T20:00:00Z"));
assert.equal(makeFrozenPair(8,deadline,compare,assigned.map(p=>p.element.id),Date.parse(deadline)),null);

assert.equal(compare.baseline.xi.length,11);
assert.equal(compare.challenger.xi.length,11);
assert.equal(compare.changes.out.length,compare.changes.in.length);
assert.ok(compare.changes.out.length>=1,
  "A full-scored shadow may change the lineup on the same squad");
assert.equal(compareMinutesDecisions(assigned,challenger,assigned.slice(0,14).map(p=>p.element.id)).comparable,false);
assert.equal(compareMinutesDecisions(assigned,assigned,assigned.map(p=>p.element.id)).changes.out.length,0);
const invalidPair:FrozenPair={version:1,event:8,capturedAt:deadline,deadline,baseline:{valid:true,xi:[],captain:1,vice:2,expectedXI:0},challenger:{valid:true,xi:[],captain:1,vice:2,expectedXI:0},benchBase:[],benchChallenger:[]};
assert.equal(gradeFrozenPair(invalidPair,new Map()),null);
const identicalPlayers=new Map(Array.from({length:15},(_,i)=>{
 const id=i+1;
 return [id,{id,position:(id<=2?1:id<=7?2:id<=12?3:4) as 1|2|3|4,
 minutes:90,points:2}] as const;
}));
const validFrozen:FrozenPair={
 ...invalidPair,capturedAt:"2026-10-25T10:00:00Z",
 baseline:{valid:true,xi:[1,3,4,5,6,8,9,10,11,13,14],captain:8,vice:9,expectedXI:50},
 challenger:{valid:true,xi:[1,3,4,5,6,8,9,10,11,13,14],captain:9,vice:8,expectedXI:50},
 benchBase:[2,7,12,15],benchChallenger:[2,7,12,15],
};
assert.ok(gradeFrozenPair(validFrozen,identicalPlayers,"2026-10-27T20:00:00Z"));
assert.equal(gradeFrozenPair({...validFrozen,capturedAt:"not-a-time"},identicalPlayers,"2026-10-27T20:00:00Z"),null);
assert.equal(gradeFrozenPair(validFrozen,identicalPlayers,"not-a-time"),null);
assert.equal(gradeFrozenPair(validFrozen,new Map([...identicalPlayers].filter(([id])=>id!==15)),"2026-10-27T20:00:00Z"),null);
assert.equal(gradeFrozenPair(validFrozen,new Map([...identicalPlayers].map(([id,p])=>
 [id,id===12?{...p,minutes:200}:p])),"2026-10-27T20:00:00Z"),null);

assert.equal(gradeFrozenPair({...validFrozen,challenger:{...validFrozen.challenger,captain:15}},
 identicalPlayers,"2026-10-27T20:00:00Z"),null,
 "Captain outside XI cannot settle");
assert.equal(gradeFrozenPair({...validFrozen,benchChallenger:[2,7,12,12]},
 identicalPlayers,"2026-10-27T20:00:00Z"),null,
 "Duplicate player cannot settle");

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
