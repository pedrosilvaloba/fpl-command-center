import assert from "node:assert/strict";
import { simulateLineup, type SimulatedPlayer } from "../lib/lineupsettlement";
import { settleOutcome, type AdviceRecord } from "../lib/decisions";
import { parseAppView, parseTeamId, viewHref } from "../lib/appcontext";
import { planSensitivity, toDecisionAlternatives, transferRobustness, compareTransferPolicies } from "../lib/decisionrobustness";
import { scenarioHref } from "../lib/chipscenarioview";
import type { TransferPlan } from "../lib/transferplan";
import { planMultipleGameweeks, multiPeriodStateKey } from "../lib/multiperiod";
import { multiPeriodCacheKey } from "../lib/multiperiodcache";
import { answerAdviser, buildChatGPTContext, type AdviserContext } from "../lib/adviser";
import { buildJournal, parseJournal, type LocalDecision } from "../lib/localjournal";
import { makeElement, makeTeam } from "./fixtures";
import type { ScoredPlayer } from "../lib/recommend";
import { EMPTY_SQUAD_STATE } from "../lib/squadstate";

const pos: Record<number, 1 | 2 | 3 | 4> = {
  1: 1, 2: 1,
  3: 2, 4: 2, 5: 2, 13: 2, 14: 2,
  6: 3, 7: 3, 8: 3, 9: 3, 10: 3,
  11: 4, 12: 4, 15: 4,
};
const points = new Map<number, number>([
  [1, 2], [2, 6], [3, 0], [4, 4], [5, 3],
  [6, 5], [7, 9], [8, 4], [9, 2], [10, 2],
  [11, 0], [12, 2], [13, 8], [14, 1], [15, 6],
]);
const played = new Map<number, number>(Object.keys(pos).map((key) => [Number(key), 90]));
played.set(3, 0);
played.set(11, 0);
const players = new Map<number, SimulatedPlayer>(Object.keys(pos).map((key) => {
  const id = Number(key);
  return [id, { id, position: pos[id], points: points.get(id) ?? 0, minutes: played.get(id) ?? 0 }];
}));
const xi = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const bench = [2, 13, 14, 15];
const normal = simulateLineup({ xi, bench, captain: 11, vice: 7, hitCost: 4, players });
assert.equal(normal.reliable, true);
assert.deepEqual(normal.subs, [{ inId: 13, outId: 3 }, { inId: 14, outId: 11 }], "second defender is first eligible bench player; legal 4-5-1 formation");
assert.equal(normal.captainUsed, 7);
const expected = [1, 13, 4, 5, 6, 7, 8, 9, 10, 14, 12]
  .reduce((n, id) => n + (points.get(id) ?? 0), 0) + (points.get(7) ?? 0) - 4;
assert.equal(normal.points, expected);
assert.equal(normal.counted.length, 11);
const noSecondDef = new Map(players);
noSecondDef.set(14, { ...players.get(14)!, minutes: 0, points: 0 });
const forwardSub = simulateLineup({ xi, bench, captain: 11, vice: 7, hitCost: 4, players: noSecondDef });
assert.equal(forwardSub.subs[1].inId, 15, "next eligible bench FWD enters when preceding DEF has no minutes");

const triple = simulateLineup({ xi, bench, captain: 11, vice: 7, chip: "3xc", hitCost: 4, players });
assert.equal(triple.points, normal.points + 9, "triple captain increases by one extra vice score");
const bboost = simulateLineup({ xi, bench, captain: 11, vice: 7, chip: "bboost", players });
assert.equal(bboost.subs.length, 0, "no autosubs are needed with Bench Boost");
assert.equal(bboost.points,
  [...xi, ...bench].reduce((n, id) => n + (points.get(id) ?? 0), 0) + 9);

const keeperOut = new Map(players);
keeperOut.set(1, { ...players.get(1)!, minutes: 0, points: 0 });
const keeper = simulateLineup({ xi, bench, captain: 7, vice: 6, players: keeperOut });
assert.equal(keeper.subs[0].inId, 2, "reserve GK must replace absent starting GK");

const bad = simulateLineup({ xi: xi.slice(1), bench, captain: 11, vice: 7, players });
assert.equal(bad.reliable, false);
const missing = new Map(players); missing.delete(12);
assert.equal(simulateLineup({ xi, bench, captain: 7, vice: 6, players: missing }).reliable, false);

const advice: AdviceRecord = {
  event: 8, at: "2026-10-23T16:00:00Z",
  captain: 11, vice: 7, xi, bench, transfers: [],
  hitCost: 4, chip: null, captainSource: "modelo", predictedXi: 40,
  holdBaseline: { xi, bench, captain: 7, vice: 6 },
};
const officialPicks = [...xi, ...bench].map((id, i) => ({
  element: id, position: i + 1,
  is_captain: id === 7, multiplier: id === 7 ? 2 : i < 11 ? 1 : 0,
}));
const compare = settleOutcome(advice, {
  picks: officialPicks, activeChip: null, officialPoints: 0,
  transfersCost: 0, transfersIn: [],
  minutesById: played,
  positionById: new Map(Object.keys(pos).map((x) => [Number(x), pos[Number(x)]])),
}, (id) => points.get(id) ?? 0);
assert.equal(compare.settlement?.simulated, normal.points);
assert.equal(compare.settlement?.subCount, 2);
const withShadow = settleOutcome({
  ...advice,
  shadowPlan: {xi,bench,captain:7,vice:6,hitCost:0,transfers:[]},
}, {
  picks:officialPicks,activeChip:null,officialPoints:0,transfersCost:0,transfersIn:[],
  minutesById:played,positionById:new Map(Object.keys(pos).map(k=>[Number(k),pos[Number(k)]])),
},id=>points.get(id)??0);
assert.equal(withShadow.settlement?.shadowVsLive,4,
  "Same players with captain 7 and no -4 must score four more by avoiding the hit with identical effective captain");
assert.equal(withShadow.settlement?.shadowVsHold,0,
  "Exact shadow baseline matches hold when same captain and no hits");

assert.equal(compare.settlement?.holdPoints, normal.points + 4);
assert.equal(compare.settlement?.gainVsHold, -4, "hit cost must reduce realised gain vs holding");
assert.ok(compare.settlement?.officialDelta !== undefined);
const compareCaptain = settleOutcome({...advice, captain:7, vice:6, captainMaxXp:6}, {
  picks: officialPicks, activeChip:null, officialPoints:0, transfersCost:0, transfersIn:[],
  minutesById:played, positionById:new Map(Object.keys(pos).map(k=>[Number(k),pos[Number(k)]])),
}, id=>points.get(id)??0);
assert.equal(compareCaptain.settlement?.captainPolicyVsMaxXp, 4,
  "Actual captain policy vs frozen best-xP same-XI candidate, extra armband points");
const notComparable = settleOutcome({...advice, captain:11, captainMaxXp:7}, {
  picks: officialPicks, activeChip:null, officialPoints:0, transfersCost:0, transfersIn:[],
  minutesById:played, positionById:new Map(Object.keys(pos).map(k=>[Number(k),pos[Number(k)]])),
}, id=>points.get(id)??0);
assert.equal(notComparable.settlement?.captainPolicyVsMaxXp,undefined,
  "Absent captain with automatic vice switch is excluded, not mis-scored");
console.log("decision integrity tests passed");

assert.equal(parseTeamId("2107193"), 2107193);
assert.equal(parseTeamId(["321", "123"]), 321);
assert.equal(parseTeamId("1%20or%201"), 2107193);
assert.equal(parseTeamId(""), 2107193);
assert.equal(parseTeamId("99999999999999999"), 2107193);
assert.equal(parseAppView("simular"), "simular");
assert.equal(parseAppView("unknown"), "hoje");
assert.equal(viewHref(321, "simular", { chip: "wildcard" }), "/?team=321&view=simular&chip=wildcard");

const dummyMove = (id: number, incoming: number) => ({
  out: { element: { id, web_name: "Out" }, expectedPoints: 12 },
  in: { element: { id: id + 100, web_name: "In" }, expectedPoints: incoming },
});
const hypothetical = {
  key: "gratuitas", label: "Duas trocas", netGainVsHold: 5,
  requiredEdge: 3, confidence: .6, hitCost: 0,
  moves: [dummyMove(12, 20), dummyMove(13, 15)],
} as unknown as TransferPlan;
const noTransfer = {
  key: "manter", label: "Manter", netGainVsHold: 0,
  requiredEdge: 0, confidence: 1, hitCost: 0, moves: [],
} as unknown as TransferPlan;
assert.equal(planSensitivity(hypothetical, 20).stressedGain, -2,
  "5 points of edge disappear with 7 points lost on incoming forecasts");
assert.equal(planSensitivity(hypothetical, 20).reversesDecision, true);
assert.equal(planSensitivity(hypothetical, -5).downsidePct, 0);
assert.equal(planSensitivity(hypothetical, 80).downsidePct, 50);
const robustInput={...hypothetical,netGainVsHold:20,requiredEdge:3};
assert.equal(transferRobustness(noTransfer).verdict,"hold");
assert.equal(transferRobustness(hypothetical).verdict,"fragile");
assert.equal(transferRobustness(robustInput).verdict,"robust");
assert.equal(transferRobustness({...hypothetical,netGainVsHold:1,requiredEdge:3}).verdict,"below-threshold");
assert.equal(transferRobustness(hypothetical).evidence,"hypothetical");
const liveHold = { ...noTransfer, feasible: true } as TransferPlan;
const liveRisky = { ...hypothetical, feasible: true, netGainVsHold: 5, requiredEdge: 3 } as TransferPlan;
const shadowCompare = compareTransferPolicies([liveHold, liveRisky], liveRisky);
assert.equal(shadowCompare.current, "gratuitas");
assert.equal(shadowCompare.shadow, "manter", "Fragile transfer cannot be shadow-recommended");
assert.equal(shadowCompare.differs, true);
const shadowStrong = compareTransferPolicies([liveHold, {
  ...liveRisky, netGainVsHold: 30
} as TransferPlan], liveHold);
assert.equal(shadowStrong.shadow, "gratuitas");
assert.equal(shadowStrong.shadowReason, "robust-plan");
assert.equal(compareTransferPolicies([], null).shadowReason, "no-valid-hold");
const variants = toDecisionAlternatives([noTransfer, hypothetical, hypothetical], hypothetical);
assert.equal(variants.length, 2, "duplicate solver paths should not clutter UX");
assert.equal(variants[1].robustness.verdict,"fragile");
assert.equal(variants[1].recommended, true);
assert.equal(variants[1].transfers.length, 2);

const scenario = scenarioHref("?team=321&view=simular&foo=bar", "wildcard", [11, 12], [13], "continuidade");
const params = new URL(scenario, "https://example.test/").searchParams;
assert.equal(params.get("team"), "321", "Wildcard actions must preserve authoritative team");
assert.equal(params.get("view"), "simular", "Wildcard actions must stay on simulator screen");
assert.equal(params.get("manter"), "11,12");
assert.equal(params.get("incluir"), "13");
assert.equal(params.get("perfil"), "continuidade");
const cleared = new URL(scenarioHref("?team=321&manter=11", "wildcard", [], [], "equilibrado"), "https://example.test/");
assert.equal(cleared.searchParams.has("manter"), false);

const stateKeyA=multiPeriodStateKey([2,1],1,20,new Map([[1,45],[2,50]]));
const stateKeyB=multiPeriodStateKey([1,2],1,20,new Map([[1,46],[2,50]]));
assert.notEqual(stateKeyA,stateKeyB,"Same roster/bank with different sale proceeds must remain distinct");
assert.equal(stateKeyA,multiPeriodStateKey([1,2],1,20,new Map([[2,50],[1,45]])),
  "Search deduplication must not depend on roster order");
const legalPositions = [1,1,2,2,2,2,2,3,3,3,3,3,4,4,4];
const weeklyPool = legalPositions.map((pos,i) => {
  const id=i+200;
  return {
    element: makeElement({id,web_name:"Base"+id,team:(i%8)+1,element_type:pos,now_cost:50,minutes:700,starts:7}),
    team:makeTeam((i%8)+1),
    priceM:5,expectedPointsNext:pos===4?2:3,expectedPoints:15,
  } as ScoredPlayer;
});
weeklyPool.push({
  element:makeElement({id:500,web_name:"Upgrade",team:12,element_type:4,now_cost:50}),
  team:makeTeam(12),priceM:5,expectedPoints:35,expectedPointsNext:7,
} as ScoredPlayer);
const multiState = {
  ...EMPTY_SQUAD_STATE, available:true, reason:null, bankM:0, totalBudgetM:75,
  freeTransfers:1, owned:weeklyPool.slice(0,15).map(p=>({
    elementId:p.element.id,priceM:5,sellingPriceM:5,
    wasStarter:true,wasCaptain:false,wasViceCaptain:false,
  })),
};
const weeks = [9,10,11].map(event=>({event,players:weeklyPool}));
const path = planMultipleGameweeks(multiState,weeks,{horizon:3,beamWidth:10});
assert.equal(path.available,true);
assert.equal(path.steps.length,3);
assert.ok(path.evaluated>3);
assert.ok(path.plannedPoints>=path.baselinePoints);
assert.ok(path.steps.flatMap(step=>step.moves).some(move=>move.into===500),
  "strong forward should enter a legal multiperiod plan");
for(const week of path.steps) {
  assert.ok(week.bankAfterM>=0);
  assert.ok(week.hitCost>=0 && week.hitCost%4===0);
  assert.ok(week.freeAfter<=5);
}
const failed = planMultipleGameweeks({...multiState,available:false},weeks);
assert.equal(failed.available,false);
const unsequenced = planMultipleGameweeks(multiState,[weeks[0],weeks[2]]);
assert.equal(unsequenced.available,false);
const keyBefore=multiPeriodCacheKey(multiState,weeks,3,10);
const changedWeeks=weeks.map((w,i)=>i!==0?w:{...w,players:w.players.map(p=>
  p.element.id===500?{...p,expectedPointsNext:p.expectedPointsNext+1}:p)});
const keyAfter=multiPeriodCacheKey(multiState,changedWeeks,3,10);
assert.notEqual(keyBefore,keyAfter,"A changed player projection must invalidate the cached plan");
assert.notEqual(keyBefore,multiPeriodCacheKey({...multiState,bankM:.1},weeks,3,10),
  "Budget changes must invalidate all cached plans");
assert.notEqual(keyBefore,multiPeriodCacheKey(multiState,weeks,5,10),
  "The planning horizon must be reflected in cache identity");
console.log("multiperiod cache invalidation tests passed");
console.log("multiperiod planning tests passed");

const adviceContext:AdviserContext={
  event:9,teamName:"Synthetic",
  recommendation:"Guardar FT",recommendedMoveNames:[],gainVsHold:0,requiredEdge:2,
  captain:"Haaland",captainEp:7.2,
  wildcardAvailable:true,wildcardAdvised:false,wildcardGain:3,wildcardRequired:20,
  waiting:"Aguardar para fazer duas trocas",horizon:3,multiGain:5,
  multiMoves:[{event:9,description:"Não transferir"},{event:10,description:"Trocar um médio"}],
  riskPlayers:["Jogador A"]
};
assert.ok(answerAdviser("Porquê este capitão?",adviceContext).answer.includes("Haaland"));
assert.ok(answerAdviser("E se jogar wildcard?",adviceContext).answer.includes("guardá-lo"));
assert.ok(answerAdviser("Que jogadas fazes nas próximas jornadas?",adviceContext).evidence.includes("GW10"));
assert.ok(answerAdviser("Quem tem risco de minutos?",adviceContext).answer.includes("Jogador A"));
assert.ok(answerAdviser("Notícia completamente fora da lista de perguntas?",adviceContext).subject.includes("fora"));
console.log("contextual consultant tests passed");

const exportedPrompt=buildChatGPTContext(adviceContext);
assert.ok(exportedPrompt.includes("Contexto JSON"));
assert.ok(exportedPrompt.includes("Haaland"));
assert.ok(exportedPrompt.includes("não fiáveis"));
assert.ok(exportedPrompt.length<10000,"Do not copy megabytes of app state into an external chat");
const selfReport:LocalDecision={
  event:9,teamId:321,at:"2026-10-25T17:00:00.000Z",
  action:"followed",note:"Sem chip",
  captain:"Test",transfers:["A → B"],source:"self-reported-local",
};
const journal=buildJournal(321,[selfReport,{...selfReport,teamId:999},null]);
assert.equal(journal.entries.length,1);
assert.equal(parseJournal(JSON.stringify(journal),321).entries[0].event,9);
assert.throws(()=>parseJournal(JSON.stringify(journal),999),/outra equipa/);
assert.throws(()=>parseJournal("not json",321));
assert.throws(()=>parseJournal(JSON.stringify({...journal,entries:[{...selfReport,event:48}]}),321));
console.log("portable local journal and ChatGPT handoff tests passed");
