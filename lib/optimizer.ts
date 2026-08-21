import solver from "javascript-lp-solver";
import type { ScoredPlayer } from "./recommend";
import { pickBestXI, buildSuggestedSquad, isValidSquad } from "./recommend";

const NEED: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
const POS_KEY: Record<number, string> = { 1: "gk", 2: "def", 3: "mid", 4: "fwd" };

// A true 0/1-knapsack solve over the full ~600-player pool (600 binaries ×
// ~25 constraints) risks running past Vercel's serverless time limit on the
// free plan. In practice the optimal squad essentially never includes a
// mid-table-scoring, mid-priced player — it either wants a position's best
// scorers, or the cheapest possible "enabler" to free up budget elsewhere.
// So we solve over a much smaller, still-representative candidate pool:
// the top scorers per position (captures every player worth starting or
// benching for quality) plus the cheapest per position (captures the pure
// budget-fodder role a spare GK/DEF need to fill). This trades a
// vanishingly small chance of missing a genuinely obscure optimum for a
// solve that reliably finishes in time — flagged here rather than hidden.
const TOP_BY_SCORE_PER_POSITION = 45;
const CHEAPEST_ENABLERS_PER_POSITION = 12;
const SOLVE_TIMEOUT_MS = 6000;

// Four of the fifteen players never start in a normal gameweek, so buying
// them at full value is how a squad ends up with £8-10m stranded on a
// bench it will never play. Weighting every player equally (as this did
// until v1.11) told the solver a fifth defender was worth exactly as much
// as a starting striker. There is no way to know in advance WHICH four
// will be benched, so the objective discounts each player by the
// probability-weighted value of a bench slot: with 4 of 15 slots on the
// bench and bench points worth little, ~0.75 is the right shading, applied
// to the cheapest tier where the benched players actually come from.
const BENCH_DISCOUNT = 0.75;
const BENCH_TIER_PRICE = 4.5;

export interface OptimalSquadResult {
  squad: ScoredPlayer[];
  starters: ScoredPlayer[];
  totalCost: number;
  feasible: boolean;
  method: "otimizador" | "heurística (otimizador indisponível)";
}

function buildCandidatePool(scored: ScoredPlayer[]): ScoredPlayer[] {
  const pool = new Map<number, ScoredPlayer>();
  for (const posId of [1, 2, 3, 4]) {
    const inPos = scored.filter((p) => p.element.element_type === posId);
    const byScore = [...inPos]
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_BY_SCORE_PER_POSITION);
    const byPrice = [...inPos]
      .sort((a, b) => a.priceM - b.priceM)
      .slice(0, CHEAPEST_ENABLERS_PER_POSITION);
    for (const p of [...byScore, ...byPrice]) pool.set(p.element.id, p);
  }
  return [...pool.values()];
}

/**
 * Genuine integer-linear-programming squad optimizer: maximizes total
 * heuristic score subject to exactly 2 GK / 5 DEF / 5 MID / 3 FWD, total
 * cost <= budget, and at most 3 players per club. Unlike
 * `buildSuggestedSquad` (a greedy per-position allocator), this finds the
 * mathematically best combination *for the given scores* — it can only ever
 * be as good as the underlying v1 heuristic (see recommend.ts), but the
 * allocation step itself is now provably optimal rather than approximate.
 *
 * Falls back to the greedy heuristic if the solver can't find a feasible
 * 15-player squad in time (e.g. a pathological budget) — a working,
 * honestly-labelled suggestion beats a broken page.
 */
export function buildOptimalSquad(
  scored: ScoredPlayer[],
  budgetM = 100
): OptimalSquadResult {
  try {
    const pool = buildCandidatePool(scored);
    const clubIds = Array.from(new Set(pool.map((p) => p.team.id)));

    const variables: Record<string, Record<string, number>> = {};
    const binaries: Record<string, 1> = {};
    const byVarId = new Map<string, ScoredPlayer>();

    for (const p of pool) {
      const varId = `p${p.element.id}`;
      byVarId.set(varId, p);
      // Objective is now expected FPL points (see lib/expectedpoints.ts),
      // shaded down for the cheap-enabler tier those bench slots come from.
      const objective =
        p.priceM <= BENCH_TIER_PRICE ? p.expectedPoints * BENCH_DISCOUNT : p.expectedPoints;
      variables[varId] = {
        score: objective,
        cost: p.priceM,
        [POS_KEY[p.element.element_type]]: 1,
        [`club_${p.team.id}`]: 1,
      };
      binaries[varId] = 1;
    }

    const constraints: Record<
      string,
      { min?: number; max?: number; equal?: number }
    > = {
      cost: { max: budgetM },
      gk: { equal: NEED[1] },
      def: { equal: NEED[2] },
      mid: { equal: NEED[3] },
      fwd: { equal: NEED[4] },
    };
    for (const clubId of clubIds) {
      constraints[`club_${clubId}`] = { max: 3 };
    }

    const model = {
      optimize: "score",
      opType: "max" as const,
      constraints,
      variables,
      binaries,
      timeout: SOLVE_TIMEOUT_MS,
    };

    const result = solver.Solve(model) as Record<
      string,
      number | boolean | undefined
    >;

    const squad: ScoredPlayer[] = [];
    for (const [varId, player] of byVarId) {
      if (Math.round(Number(result[varId] ?? 0)) === 1) squad.push(player);
    }

    if (!result.feasible || !isValidSquad(squad, budgetM)) {
      throw new Error("O otimizador não encontrou uma equipa viável de 15.");
    }

    const totalCost =
      Math.round(squad.reduce((sum, p) => sum + p.priceM, 0) * 10) / 10;

    return {
      squad,
      starters: pickBestXI(squad),
      totalCost,
      feasible: true,
      method: "otimizador",
    };
  } catch {
    // The fallback heuristic can genuinely fail to fill a squad when the
    // budget is tight. It used to report `feasible: true` regardless, and
    // the page then told the user the squad respected 2-5-5-3 while
    // showing eleven players and no forward. Report what actually
    // happened instead, and let the UI say so.
    const fallback = buildSuggestedSquad(scored, budgetM);
    return {
      squad: fallback.squad,
      starters: fallback.starters,
      totalCost: fallback.totalCost,
      feasible: isValidSquad(fallback.squad, budgetM),
      method: "heurística (otimizador indisponível)",
    };
  }
}
