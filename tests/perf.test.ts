/** Timing harness — the transfer planner runs several integer programs per
 * page render, and Vercel's function timeout is not generous. */
import { planTransfers } from "../lib/transferplan";
import { buildOptimalSquad } from "../lib/optimizer";
import type { ScoredPlayer } from "../lib/recommend";
import { summariseChips, type SquadState } from "../lib/squadstate";
import { makeElement, makeTeam } from "./fixtures";

function mk(id: number, type: number, teamId: number, ep: number, price: number, own: number): ScoredPlayer {
  const pos: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
  return {
    element: makeElement({ id, element_type: type, selected_by_percent: String(own) }),
    team: makeTeam(teamId), positionShort: pos[type], priceM: price, ownershipPct: own,
    formNum: 3, fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.5,
    cleanSheetProbability: 0.3, individualExpectedGI: 0.4, ceilingGI: 1, floorGI: 0,
    expectedPoints: ep * 5, expectedPointsNext: ep,
    breakdown: { appearance: 10, goals: 5, assists: 3, cleanSheet: 2, concededPenalty: -1, defensiveContribution: 0, bonus: 2, saves: 0, total: ep * 5 },
    score: ep * 5, isDifferential: own < 10, isPreseason: false, reasons: [],
  } as ScoredPlayer;
}

// A realistic pool: ~600 players across 20 clubs and 4 positions.
const scored: ScoredPlayer[] = [];
let id = 1;
for (let i = 0; i < 600; i++) {
  const type = (i % 4) + 1;
  scored.push(mk(id++, type, (i % 20) + 1, 2 + ((i * 7) % 60) / 10, 4 + ((i * 3) % 70) / 10, (i % 60) + 1));
}
scored.sort((a, b) => b.score - a.score);

// A LEGAL starting squad: at most three players per club, exactly 2-5-5-3.
// (Building it by slicing a score-sorted list produced squads with four or
// five players from one club, which makes every constrained solve
// infeasible — a harness bug that looked exactly like a solver bug.)
const perClub = new Map<number, number>();
const owned: ScoredPlayer[] = [];
for (const [type, want] of [[1, 2], [2, 5], [3, 5], [4, 3]] as [number, number][]) {
  let taken = 0;
  const inPos = scored.filter((q) => q.element.element_type === type);
  for (const p of inPos.slice(Math.floor(inPos.length / 2))) {
    if (taken >= want) break;
    if (owned.some((q) => q.element.id === p.element.id)) continue;
    const n = perClub.get(p.team.id) ?? 0;
    if (n >= 3) continue;
    // Skip the very best so there is real headroom for the planner to find.
    if (owned.length + taken < 0) continue;
    perClub.set(p.team.id, n + 1);
    owned.push(p);
    taken++;
  }
}
const squadValueM = Math.round(owned.reduce((s, p) => s + p.priceM, 0) * 10) / 10;
const state: SquadState = {
  available: true, reason: null, fromEvent: 10,
  owned: owned.map((p, i) => ({ elementId: p.element.id, priceM: p.priceM, sellingPriceM: p.priceM, wasStarter: i < 11, wasCaptain: i === 0, wasViceCaptain: i === 1 })),
  bankM: 1.5, squadValueM, totalBudgetM: squadValueM + 1.5,
  sellingPriceIsEstimated: false, sellingPriceNote: "", freeTransfers: 1, freeTransfersNote: "",
  chips: summariseChips([]), entryName: "T", overallPoints: 0, overallRank: 0,
};

const t0 = Date.now();
const advice = planTransfers(scored, state, { beta: 0.3 });
const t1 = Date.now();
const ideal = buildOptimalSquad(scored, state.totalBudgetM, 0.3);
if (ideal.squad.length !== 15) { console.error("plantel ideal inválido"); process.exit(1); }
const t2 = Date.now();

console.log(`\nplanTransfers (4 solves): ${t1 - t0}ms — ${advice.plans.length} planos, recomendado "${advice.recommended?.key}"`);
console.log(`buildOptimalSquad:        ${t2 - t1}ms`);
console.log(`total:                    ${t2 - t0}ms\n`);

const budget = advice.plans.every((p) => {
  const cost = p.squad.reduce((s, q) => {
    const o = state.owned.find((x) => x.elementId === q.element.id);
    return s + (o ? o.sellingPriceM : q.priceM);
  }, 0);
  return cost <= state.totalBudgetM + 1e-6;
});
console.log(budget ? "orçamento respeitado em todos os planos" : "ORÇAMENTO VIOLADO");
if (t2 - t0 > 12000) { console.error("DEMASIADO LENTO"); process.exit(1); }

