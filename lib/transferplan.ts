import solver from "javascript-lp-solver";
import type { ScoredPlayer } from "./recommend";
import { pickBestXI, pickCaptain } from "./recommend";
import { strategicValue } from "./optimizer";
import { HIT_COST_POINTS, type SquadState } from "./squadstate";

/**
 * The transfer planner — what this app should have been producing all along.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every recommendation until v1.25 answered "what is the best possible
 * fifteen?". A manager in a running season cannot act on that answer. He can
 * make one transfer, or two at a cost of four points, from the squad he
 * already owns, with the money he actually has. The right question is
 * therefore not "what is the best squad" but:
 *
 *     "Given THIS squad, THIS bank, and THIS many free transfers, what is
 *      the single best thing to do before the deadline — including the
 *      possibility that the best thing is nothing at all?"
 *
 * HOW IT IS ANSWERED
 * ------------------
 * The same integer program as the squad optimizer, with three changes that
 * turn a fantasy into a plan:
 *
 *   1. Players already owned cost their SELLING price to keep, and free up
 *      that selling price when sold. Players not owned cost their listed
 *      price. The budget is the real one (squad value + bank), not £100m.
 *   2. The number of owned players dropped IS the number of transfers, and
 *      an explicit integer variable absorbs everything beyond the free
 *      allowance at -4 points each, directly in the objective. The solver
 *      therefore only takes a hit when the transfer is worth more than four
 *      points — which is exactly the judgement a good manager makes, and
 *      which only became expressible when the score became real points.
 *   3. The horizon is the five-gameweek window, not the next gameweek. A hit
 *      is a one-off cost paid against a benefit that recurs; comparing it to
 *      a single gameweek's gain would reject transfers that are clearly
 *      right, and comparing it to nothing at all would accept transfers that
 *      are clearly wrong.
 *
 * Four plans are produced and ranked on the same honest metric — expected
 * points of the starting eleven over the window, minus any hit — so "do
 * nothing" competes on equal terms with the rest and often wins, which is
 * itself the most commonly ignored piece of FPL advice.
 */

const POS_KEY: Record<number, string> = { 1: "gk", 2: "def", 3: "mid", 4: "fwd" };
const NEED: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
const SQUAD_SIZE = 15;

/** Candidates offered per position on top of the squad already owned. */
const CANDIDATES_PER_POSITION = 18;
const CHEAP_ENABLERS_PER_POSITION = 5;
const SOLVE_TIMEOUT_MS = 5000;
/** Bench places carry a fraction of a starter's value — see lib/optimizer.ts. */
const BENCH_WEIGHT = 0.12;
/** The most transfers this planner will consider without a chip. Beyond
 * this you are not making transfers, you are rebuilding — which is what the
 * wildcard signal below is for. */
const MAX_TRANSFERS_CONSIDERED = 3;

export interface TransferMove {
  out: ScoredPlayer;
  in: ScoredPlayer;
  /** Window expected-points difference for this single swap. */
  gain: number;
  /** Cash freed (positive) or spent (negative) by this swap, £m. */
  cashDeltaM: number;
  urgency: string | null;
}

export type PlanKey = "manter" | "gratuitas" | "com-hit" | "wildcard";

export interface TransferPlan {
  key: PlanKey;
  label: string;
  feasible: boolean;
  moves: TransferMove[];
  transfers: number;
  hits: number;
  hitCost: number;
  squad: ScoredPlayer[];
  xi: ScoredPlayer[];
  bench: ScoredPlayer[];
  captain: ScoredPlayer | undefined;
  viceCaptain: ScoredPlayer | undefined;
  /** Expected points of the eleven over the five-gameweek window. */
  xiWindowPoints: number;
  /** Expected points of the eleven in the next gameweek alone. */
  xiNextPoints: number;
  /** xiWindowPoints minus the hit cost — the number plans are ranked on. */
  netValue: number;
  /** Versus doing nothing. Negative means the plan is worse than holding. */
  netGainVsHold: number;
  bankAfterM: number;
  rationale: string;
}

export interface WildcardSignal {
  /** How many of the ideal fifteen are not in the current squad. */
  distance: number;
  /** Window points gained by moving all the way to the ideal squad. */
  gain: number;
  available: boolean;
  advise: boolean;
  text: string;
}

export interface TransferAdvice {
  available: boolean;
  reason: string | null;
  hold: TransferPlan | null;
  plans: TransferPlan[];
  recommended: TransferPlan | null;
  wildcard: WildcardSignal | null;
  shortTerm: string;
  mediumTerm: string;
  longTerm: string;
}

// --------------------------------------------------------------------------
// Squad evaluation
// --------------------------------------------------------------------------

function evaluate(squad: ScoredPlayer[], beta: number) {
  const xi = pickBestXI(
    // pickBestXI ranks on the window score; the eleven that actually plays is
    // a NEXT-GAMEWEEK decision, so rank on that instead by temporarily
    // presenting next-gameweek points as the score.
    squad.map((p) => ({ ...p, score: p.expectedPointsNext }))
  ).map((p) => squad.find((q) => q.element.id === p.element.id)!);
  const bench = squad.filter((p) => !xi.some((q) => q.element.id === p.element.id));
  const { captain, viceCaptain } = pickCaptain(xi, beta);
  return {
    xi,
    bench,
    captain,
    viceCaptain,
    xiWindowPoints: Math.round(xi.reduce((s, p) => s + p.expectedPoints, 0) * 10) / 10,
    xiNextPoints: Math.round(xi.reduce((s, p) => s + p.expectedPointsNext, 0) * 10) / 10,
  };
}

// --------------------------------------------------------------------------
// The integer program
// --------------------------------------------------------------------------

interface SolveOptions {
  pool: ScoredPlayer[];
  ownedIds: Set<number>;
  costM: Map<number, number>;
  budgetM: number;
  maxTransfers: number;
  freeTransfers: number;
  allowHits: boolean;
  beta: number;
}

function solveSquad(opts: SolveOptions): ScoredPlayer[] | null {
  const { pool, ownedIds, costM, budgetM, maxTransfers, freeTransfers, allowHits, beta } = opts;
  const clubIds = Array.from(new Set(pool.map((p) => p.team.id)));

  const variables: Record<string, Record<string, number>> = {};
  const binaries: Record<string, 1> = {};
  const ints: Record<string, 1> = {};
  const byVarId = new Map<string, ScoredPlayer>();

  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
    cost: { max: budgetM },
    gk: { equal: NEED[1] },
    def: { equal: NEED[2] },
    mid: { equal: NEED[3] },
    fwd: { equal: NEED[4] },
    xi: { equal: 11 },
    xi_gk: { equal: 1 },
    xi_def: { min: 3 },
    xi_mid: { min: 2 },
    xi_fwd: { min: 1 },
    // At least this many of the current squad must survive.
    kept: { min: Math.max(0, SQUAD_SIZE - maxTransfers) },
  };
  for (const clubId of clubIds) constraints[`club_${clubId}`] = { max: 3 };

  for (const p of pool) {
    const squadVar = `s${p.element.id}`;
    const xiVar = `x${p.element.id}`;
    byVarId.set(squadVar, p);
    const value = strategicValue(p, beta);
    const isOwned = ownedIds.has(p.element.id);

    variables[squadVar] = {
      score: value * BENCH_WEIGHT,
      cost: costM.get(p.element.id) ?? p.priceM,
      [POS_KEY[p.element.element_type]]: 1,
      [`club_${p.team.id}`]: 1,
      [`link_${p.element.id}`]: -1,
      ...(isOwned ? { kept: 1 } : {}),
    };
    variables[xiVar] = {
      score: value * (1 - BENCH_WEIGHT),
      xi: 1,
      [`xi_${POS_KEY[p.element.element_type]}`]: 1,
      [`link_${p.element.id}`]: 1,
    };
    constraints[`link_${p.element.id}`] = { max: 0 };
    binaries[squadVar] = 1;
    binaries[xiVar] = 1;
  }

  if (allowHits) {
    // hits >= transfers - freeTransfers, i.e. kept + hits >= 15 - free.
    // The variable carries a negative objective coefficient, so the solver
    // drives it down to exactly that bound rather than inflating it.
    constraints.hitbound = { min: SQUAD_SIZE - freeTransfers };
    variables.hits = { score: -HIT_COST_POINTS, hitbound: 1 };
    ints.hits = 1;
    for (const p of pool) {
      if (ownedIds.has(p.element.id)) variables[`s${p.element.id}`].hitbound = 1;
    }
  } else {
    constraints.kept.min = Math.max(
      constraints.kept.min ?? 0,
      SQUAD_SIZE - Math.min(maxTransfers, freeTransfers)
    );
  }

  try {
    const result = solver.Solve({
      optimize: "score",
      opType: "max" as const,
      constraints,
      variables,
      binaries,
      ints,
      timeout: SOLVE_TIMEOUT_MS,
    }) as Record<string, number | boolean | undefined>;

    if (!result.feasible) return null;
    const squad: ScoredPlayer[] = [];
    for (const [varId, player] of byVarId) {
      if (Math.round(Number(result[varId] ?? 0)) === 1) squad.push(player);
    }
    return squad.length === SQUAD_SIZE ? squad : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Plan assembly
// --------------------------------------------------------------------------

function buildMoves(
  before: ScoredPlayer[],
  after: ScoredPlayer[],
  costM: Map<number, number>,
  risers: Set<number>,
  fallers: Set<number>
): TransferMove[] {
  const afterIds = new Set(after.map((p) => p.element.id));
  const beforeIds = new Set(before.map((p) => p.element.id));
  const out = before.filter((p) => !afterIds.has(p.element.id));
  const incoming = after.filter((p) => !beforeIds.has(p.element.id));

  // Position counts are preserved by the constraints, so every outgoing
  // player has a same-position replacement. Pairing them that way makes the
  // plan readable as swaps rather than as two unrelated lists.
  const moves: TransferMove[] = [];
  const pool = [...incoming];
  for (const o of out) {
    const idx = pool.findIndex((p) => p.element.element_type === o.element.element_type);
    const i = idx >= 0 ? pool.splice(idx, 1)[0] : pool.shift();
    if (!i) continue;
    const urgencyParts: string[] = [];
    if (risers.has(i.element.id)) {
      urgencyParts.push(`${i.element.web_name} está prestes a subir de preço — fazer hoje poupa £0.1m`);
    }
    if (fallers.has(o.element.id)) {
      urgencyParts.push(`${o.element.web_name} está prestes a descer — adiar custa £0.1m do valor da equipa`);
    }
    moves.push({
      out: o,
      in: i,
      gain: Math.round((i.expectedPoints - o.expectedPoints) * 10) / 10,
      cashDeltaM:
        Math.round(((costM.get(o.element.id) ?? o.priceM) - i.priceM) * 10) / 10,
      urgency: urgencyParts.length > 0 ? urgencyParts.join(" · ") : null,
    });
  }
  return moves;
}

function makePlan(
  key: PlanKey,
  label: string,
  squad: ScoredPlayer[],
  ownedSquad: ScoredPlayer[],
  state: SquadState,
  costM: Map<number, number>,
  beta: number,
  risers: Set<number>,
  fallers: Set<number>,
  hitsOverride?: number
): TransferPlan {
  const moves = buildMoves(ownedSquad, squad, costM, risers, fallers);
  const transfers = moves.length;
  const hits =
    hitsOverride !== undefined
      ? hitsOverride
      : Math.max(0, transfers - state.freeTransfers);
  const evaluated = evaluate(squad, beta);
  const hitCost = hits * HIT_COST_POINTS;
  const spent = squad.reduce((s, p) => {
    const owned = ownedSquad.some((o) => o.element.id === p.element.id);
    return s + (owned ? (costM.get(p.element.id) ?? p.priceM) : p.priceM);
  }, 0);
  const bankAfterM = Math.round((state.totalBudgetM - spent) * 10) / 10;

  return {
    key,
    label,
    feasible: true,
    moves,
    transfers,
    hits,
    hitCost,
    squad,
    ...evaluated,
    netValue: Math.round((evaluated.xiWindowPoints - hitCost) * 10) / 10,
    netGainVsHold: 0, // filled in by the caller once the hold plan exists
    bankAfterM,
    rationale: "",
  };
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

export function planTransfers(
  scored: ScoredPlayer[],
  state: SquadState,
  opts: {
    beta?: number;
    /** Element ids flagged as likely to rise / fall in price today. */
    likelyRisers?: number[];
    likelyFallers?: number[];
  } = {}
): TransferAdvice {
  const beta = opts.beta ?? 0;
  const risers = new Set(opts.likelyRisers ?? []);
  const fallers = new Set(opts.likelyFallers ?? []);

  if (!state.available || state.owned.length !== SQUAD_SIZE) {
    return {
      available: false,
      reason:
        state.reason ??
        "Sem plantel real carregado, qualquer plano de transferências seria inventado.",
      hold: null,
      plans: [],
      recommended: null,
      wildcard: null,
      shortTerm: "",
      mediumTerm: "",
      longTerm: "",
    };
  }

  const byId = new Map(scored.map((p) => [p.element.id, p]));
  const ownedSquad: ScoredPlayer[] = [];
  const missing: number[] = [];
  for (const o of state.owned) {
    const p = byId.get(o.elementId);
    if (p) ownedSquad.push(p);
    else missing.push(o.elementId);
  }
  if (ownedSquad.length !== SQUAD_SIZE) {
    return {
      available: false,
      reason: `${missing.length} jogador(es) do teu plantel não aparecem nos dados atuais da FPL (provavelmente saíram da Premier League). Sem eles não dá para calcular um plano fiável.`,
      hold: null,
      plans: [],
      recommended: null,
      wildcard: null,
      shortTerm: "",
      mediumTerm: "",
      longTerm: "",
    };
  }

  const ownedIds = new Set(ownedSquad.map((p) => p.element.id));
  const costM = new Map<number, number>();
  for (const o of state.owned) costM.set(o.elementId, o.sellingPriceM);
  for (const p of scored) if (!costM.has(p.element.id)) costM.set(p.element.id, p.priceM);

  // Candidate pool: everything owned (keeping is always an option) plus the
  // best and cheapest available at each position.
  const poolMap = new Map<number, ScoredPlayer>();
  for (const p of ownedSquad) poolMap.set(p.element.id, p);
  for (const posId of [1, 2, 3, 4]) {
    const inPos = scored.filter((p) => p.element.element_type === posId);
    const best = [...inPos]
      .sort((a, b) => strategicValue(b, beta) - strategicValue(a, beta))
      .slice(0, CANDIDATES_PER_POSITION);
    const cheap = [...inPos]
      .sort((a, b) => a.priceM - b.priceM)
      .slice(0, CHEAP_ENABLERS_PER_POSITION);
    for (const p of [...best, ...cheap]) poolMap.set(p.element.id, p);
  }
  const pool = [...poolMap.values()];

  const base = {
    pool,
    ownedIds,
    costM,
    budgetM: state.totalBudgetM,
    beta,
  };

  // --- 1. hold ---------------------------------------------------------
  const hold = makePlan(
    "manter",
    "Não fazer nada",
    ownedSquad,
    ownedSquad,
    state,
    costM,
    beta,
    risers,
    fallers,
    0
  );
  hold.rationale =
    "Guardar a transferência é uma jogada legítima e subvalorizada: acumula até 5 e dá-te liberdade quando uma lesão ou uma oportunidade real aparecer. Só perde se alguma das opções abaixo render mais do que ela.";

  const plans: TransferPlan[] = [hold];

  // --- 2. free transfers only ------------------------------------------
  if (state.freeTransfers > 0) {
    const squad = solveSquad({
      ...base,
      maxTransfers: state.freeTransfers,
      freeTransfers: state.freeTransfers,
      allowHits: false,
    });
    if (squad) {
      const plan = makePlan(
        "gratuitas",
        state.freeTransfers === 1
          ? "Usar a transferência livre"
          : `Usar até ${state.freeTransfers} transferências livres`,
        squad,
        ownedSquad,
        state,
        costM,
        beta,
        risers,
        fallers,
        0
      );
      if (plan.transfers > 0) {
        plan.rationale =
          "O melhor que consegues fazer sem pagar pontos. Como não há hit, qualquer ganho positivo já compensa — a única coisa que perdes é a flexibilidade de guardar a transferência.";
        plans.push(plan);
      }
    }
  }

  // --- 3. hits allowed --------------------------------------------------
  const withHits = solveSquad({
    ...base,
    maxTransfers: MAX_TRANSFERS_CONSIDERED,
    freeTransfers: state.freeTransfers,
    allowHits: true,
  });
  if (withHits) {
    const plan = makePlan(
      "com-hit",
      "Aceitar um hit",
      withHits,
      ownedSquad,
      state,
      costM,
      beta,
      risers,
      fallers
    );
    if (plan.hits > 0) {
      plan.rationale = `O solver só aceita um hit quando a transferência extra vale mais do que os ${HIT_COST_POINTS} pontos que custa, medido ao longo de 5 jornadas — não da próxima apenas. Se este plano não aparecer, é porque nada justificava pagar.`;
      plans.push(plan);
    }
  }

  // --- 4. wildcard ------------------------------------------------------
  const wildcardChip = state.chips.find((c) => c.name === "wildcard");
  const wildcardAvailable = (wildcardChip?.remaining ?? 0) > 0;
  const idealSquad = solveSquad({
    ...base,
    maxTransfers: SQUAD_SIZE,
    freeTransfers: SQUAD_SIZE,
    allowHits: false,
  });
  let wildcard: WildcardSignal | null = null;
  if (idealSquad) {
    const plan = makePlan(
      "wildcard",
      "Wildcard — reconstruir o plantel",
      idealSquad,
      ownedSquad,
      state,
      costM,
      beta,
      risers,
      fallers,
      0
    );
    const distance = plan.transfers;
    const gain = Math.round((plan.xiWindowPoints - hold.xiWindowPoints) * 10) / 10;
    // A wildcard is worth playing when the squad is far enough from where it
    // should be that free transfers cannot close the gap in reasonable time.
    // Four transfers is roughly a month of holding; if the gap is bigger than
    // that AND the prize is bigger than the hits it would take to get there
    // the chip is the cheaper route.
    const advise = wildcardAvailable && distance >= 5 && gain >= 12;
    wildcard = {
      distance,
      gain,
      available: wildcardAvailable,
      advise,
      text: !wildcardAvailable
        ? `O teu plantel está a ${distance} transferências do ideal (${gain >= 0 ? "+" : ""}${gain} pts em 5 jornadas), mas já não tens Wildcard disponível nesta metade da época — o caminho é por transferências livres, uma de cada vez.`
        : advise
          ? `Sinal de Wildcard: o teu plantel está a ${distance} transferências do ideal e a diferença vale ${gain} pontos em 5 jornadas. Fechar isso com transferências livres levaria cerca de ${distance} jornadas; com hits custaria ${(distance - state.freeTransfers) * HIT_COST_POINTS} pontos. O chip é o caminho mais barato.`
          : `Plantel a ${distance} transferências do ideal (${gain >= 0 ? "+" : ""}${gain} pts em 5 jornadas) — perto o suficiente para fechar com transferências livres. Guardar o Wildcard.`,
    };
    if (advise) {
      plan.rationale =
        "Com o Wildcard não pagas pontos por nenhuma transferência, por isso este é simplesmente o melhor plantel que o teu dinheiro compra hoje. Aparece aqui porque a distância ao ideal já justifica gastar o chip.";
      plans.push(plan);
    }
  }

  // --- ranking ----------------------------------------------------------
  for (const p of plans) {
    p.netGainVsHold = Math.round((p.netValue - hold.netValue) * 10) / 10;
  }
  const ranked = [...plans].sort((a, b) => b.netValue - a.netValue);
  const recommended = ranked[0];

  // --- horizons ---------------------------------------------------------
  const shortTerm =
    recommended.key === "manter"
      ? `Esta jornada: não faças nenhuma transferência. Alinha ${recommended.captain?.element.web_name ?? "o teu melhor jogador"} com a braçadeira e guarda a transferência (ficas com ${Math.min(5, state.freeTransfers + 1)} na próxima).`
      : `Esta jornada: ${recommended.moves
          .map((m) => `sai ${m.out.element.web_name}, entra ${m.in.element.web_name}`)
          .join("; ")}. Capitão: ${recommended.captain?.element.web_name ?? "—"}.` +
        (recommended.hitCost > 0
          ? ` Custa ${recommended.hitCost} pontos de hit, já descontados no ganho indicado.`
          : " Sem custo de pontos.");

  const upgradeTargets = plans
    .filter((p) => p.key !== "manter")
    .flatMap((p) => p.moves.map((m) => m.in.element.web_name));
  const uniqueTargets = [...new Set(upgradeTargets)].slice(0, 4);
  const mediumTerm =
    uniqueTargets.length > 0
      ? `Próximas 5 jornadas: os alvos que o modelo continua a querer são ${uniqueTargets.join(", ")}. Se não entrarem já, entram nas próximas semanas — vale a pena guardar dinheiro e transferências a pensar neles, e comprá-los antes de subirem de preço.`
      : "Próximas 5 jornadas: o modelo não identifica nenhuma melhoria clara ao plantel atual — a jogada de médio prazo é acumular transferências e reagir a lesões.";

  const longTerm = wildcard
    ? wildcard.text
    : "Sem leitura de longo prazo enquanto não houver plantel ideal calculável.";

  return {
    available: true,
    reason: null,
    hold,
    plans: ranked,
    recommended,
    wildcard,
    shortTerm,
    mediumTerm,
    longTerm,
  };
}
