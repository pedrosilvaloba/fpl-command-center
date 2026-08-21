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
// Pool reduced from 45/12 when the model gained a second binary variable
// per player (squad AND starting eleven): the solve is roughly twice the
// size, so the candidate list is trimmed to keep it inside Vercel's time
// limit. Measured solve time is reported by the test suite.
const TOP_BY_SCORE_PER_POSITION = 30;
const CHEAPEST_ENABLERS_PER_POSITION = 8;
const SOLVE_TIMEOUT_MS = 6000;

/**
 * How much a bench place is actually worth, relative to a starting place.
 *
 * Four of the fifteen players do not play in a normal gameweek. The second
 * goalkeeper essentially never plays at all. Yet until now the objective
 * summed all fifteen players' expected points equally, with only a crude
 * 25% haircut for anyone under £4.5m — so a £5.5m squad filler was told to
 * be worth exactly as much as a £5.5m guaranteed starter, and the solver
 * duly spent real money on players who would sit on the bench all season.
 *
 * The fix is not a better discount, because the flaw is structural: the
 * old model could not express WHICH players start. This version optimises
 * two decisions at once — who is in the squad, and who is in the starting
 * eleven — and puts almost all of the objective weight on the eleven. The
 * bench keeps a small non-zero weight because it is not worthless: it
 * covers injuries and rotation, and it is what a Bench Boost cashes in.
 */
const BENCH_WEIGHT = 0.12;

/**
 * The price of stacking one club's defence in the starting eleven.
 *
 * A clean sheet is a single event, so a goalkeeper plus two defenders from
 * the same club are one bet, not three (see lib/correlation.ts). Expected
 * points do not change; variance roughly triples. A model that only
 * maximises expected points therefore cannot tell a diversified eleven
 * from an all-eggs-in-one-basket eleven — they score identically.
 *
 * This is deliberately a PRICE, not a ban. Loading up on a strong defence
 * before good fixtures is a legitimate and often correct play, and whether
 * you want that variance depends on your league position, which this model
 * does not know. So the third clean-sheet-dependent starter from a single
 * club is allowed — it just has to be worth more than the penalty to earn
 * its place, instead of being chosen by accident.
 */
const FREE_DEFENSIVE_STACK = 2; // up to two is not penalised at all
const STACK_PENALTY_POINTS = 1.5; // charged per starter beyond that

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

    // Two binary decisions per player:
    //   s_<id>  — is this player in the 15-man squad?
    //   x_<id>  — is this player in the starting eleven?
    // linked by  x <= s  (you cannot start a player you do not own).
    const variables: Record<string, Record<string, number>> = {};
    const binaries: Record<string, 1> = {};
    const byVarId = new Map<string, ScoredPlayer>();
    const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
      cost: { max: budgetM },
      gk: { equal: NEED[1] },
      def: { equal: NEED[2] },
      mid: { equal: NEED[3] },
      fwd: { equal: NEED[4] },
      xi: { equal: 11 },
      // Legal formations: always exactly one keeper, and never fewer than
      // three defenders, two midfielders or one forward.
      xi_gk: { equal: 1 },
      xi_def: { min: 3 },
      xi_mid: { min: 2 },
      xi_fwd: { min: 1 },
    };
    for (const clubId of clubIds) {
      constraints[`club_${clubId}`] = { max: 3 };
      // stack_<club> absorbs clean-sheet-dependent starters beyond the free
      // allowance, and is charged for in the objective.
      constraints[`stack_${clubId}`] = { max: FREE_DEFENSIVE_STACK };
    }

    for (const p of pool) {
      const squadVar = `s${p.element.id}`;
      const xiVar = `x${p.element.id}`;
      byVarId.set(squadVar, p);

      // Squad membership carries only the bench share of the player's
      // value; being picked for the eleven adds the rest.
      variables[squadVar] = {
        score: p.expectedPoints * BENCH_WEIGHT,
        cost: p.priceM,
        [POS_KEY[p.element.element_type]]: 1,
        [`club_${p.team.id}`]: 1,
        [`link_${p.element.id}`]: -1,
      };
      const isCleanSheetDependent =
        p.element.element_type === 1 || p.element.element_type === 2;
      variables[xiVar] = {
        score: p.expectedPoints * (1 - BENCH_WEIGHT),
        xi: 1,
        [`xi_${POS_KEY[p.element.element_type]}`]: 1,
        [`link_${p.element.id}`]: 1,
        // Only clean-sheet-dependent starters count toward the stack.
        ...(isCleanSheetDependent ? { [`stack_${p.team.id}`]: 1 } : {}),
      };
      constraints[`link_${p.element.id}`] = { max: 0 };
      binaries[squadVar] = 1;
      binaries[xiVar] = 1;
    }

    // One relief variable per club: buying it raises that club's allowed
    // defensive stack by one, at a cost. This is what turns "forbidden"
    // into "has to be worth it".
    const ints: Record<string, 1> = {};
    for (const clubId of clubIds) {
      const reliefVar = `relief${clubId}`;
      variables[reliefVar] = {
        score: -STACK_PENALTY_POINTS,
        [`stack_${clubId}`]: -1,
      };
      ints[reliefVar] = 1;
    }

    const model = {
      optimize: "score",
      opType: "max" as const,
      constraints,
      variables,
      binaries,
      ints,
      timeout: SOLVE_TIMEOUT_MS,
    };

    const result = solver.Solve(model) as Record<string, number | boolean | undefined>;

    const squad: ScoredPlayer[] = [];
    const chosenXi: ScoredPlayer[] = [];
    for (const [varId, player] of byVarId) {
      if (Math.round(Number(result[varId] ?? 0)) === 1) squad.push(player);
      if (Math.round(Number(result[`x${player.element.id}`] ?? 0)) === 1) {
        chosenXi.push(player);
      }
    }

    if (!result.feasible || !isValidSquad(squad, budgetM)) {
      throw new Error("O otimizador não encontrou uma equipa viável de 15.");
    }

    const totalCost =
      Math.round(squad.reduce((sum, p) => sum + p.priceM, 0) * 10) / 10;

    // Use the eleven the solver itself committed to. It optimised the
    // squad AROUND that eleven, so re-deriving it afterwards could pick a
    // different one and quietly invalidate the trade-offs the solver made.
    // Fall back to the standalone picker only if the solver's XI is
    // somehow not a legal eleven.
    const starters =
      chosenXi.length === 11 ? chosenXi : pickBestXI(squad);

    return {
      squad,
      starters,
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
