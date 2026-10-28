import solver from "javascript-lp-solver";
import type { ScoredPlayer } from "./recommend";
import { pickBestXI, pickCaptain, orderBench } from "./recommend";
import { WILDCARD_BREAK_PREMIUM, type CalendarContext } from "./chipplan";
import {
  positionalMeans,
  shrunkForSelection,
  implausibleXiWarning,
  decisionGain,
  retentionThreshold,
  rateErrorPerGw,
} from "./selection";

/** The horizon every "window" number in this file is measured over. It was
 * the literal 5 in eight different places, which is how a horizon quietly
 * becomes two different horizons. */
export const WINDOW_GAMEWEEKS = 5;
import { strategicValue, strategicValueNext } from "./optimizer";
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

/**
 * How much of a transfer's value BEYOND the coming gameweek to count.
 *
 * This is the single most consequential number in the file, and it used to
 * be an implicit 1.0.
 *
 * The old objective charged the -4 once and credited the incoming player's
 * edge across all five gameweeks of the window, so it accepted a hit
 * whenever 5g > 4 — from 0.8 points a gameweek. That compares against a
 * counterfactual that does not exist. The alternative to paying four points
 * now is not "never make this transfer". It is "make it next week with the
 * free transfer you are about to receive anyway", which captures gameweeks
 * two through five of the same benefit at no cost. What the hit actually
 * buys is ONE gameweek of the edge.
 *
 * So the horizon has to sit on both sides of the comparison or neither.
 * Weeks beyond the next one are still worth something — you might spend
 * next week's transfer elsewhere, the player might rise in price, the
 * opportunity might close — but nothing like their face value. At 0.15 a
 * hit needs roughly 2.5 points a gameweek of edge rather than 0.8, which is
 * close to what strong managers actually demand.
 */
const FUTURE_DISCOUNT = 0.15;

/**
 * THE NOISE FLOOR — how big an edge a transfer must show before it is worth
 * making, given how little the model actually knows yet.
 *
 * Reported from production in gameweek 2: the app recommended selling a
 * defender who had just scored 9 points, for a gain of +0.4 points over five
 * gameweeks. The owner could not see why, and he was right not to.
 *
 * The reason is in the scoring engine. `expectedPointsNext` blends this
 * model with FPL's own `ep_next`, weighted by minutes played: a full-90
 * player in gameweek 2 has 90 of the 360 minutes the blend wants, so THREE
 * QUARTERS of every number on the page is FPL's own estimate — which is
 * deliberately flat early in a season. It showed: the whole squad priced
 * between 1.9 and 3.8 expected points, with a goalkeeper rated above a
 * premium striker.
 *
 * The arithmetic was not wrong. What was wrong is that the decision layer
 * treated those numbers as if they were confident, and recommended acting on
 * differences that are entirely inside the noise.
 *
 * So a plan must now beat holding by more than a floor that shrinks as the
 * model earns the right to an opinion. At full confidence the floor is zero
 * and nothing changes. In gameweek 2 it is around 2.3 points over five
 * gameweeks, which is roughly the width of the noise — and a +0.4 "upgrade"
 * correctly becomes "hold your transfer".
 */
const NOISE_FLOOR_MAX_POINTS = 3;

/**
 * The most REAL expected points a single swap may give up, whatever the risk
 * posture says.
 *
 * Reported from production: a recommended plan contained "sai B.Fernandes,
 * entra Gakpo — -16.9 pts / 5 jorn." and "sai João Pedro, entra Wissa —
 * -14.6 pts". Those numbers were shown to the manager in real points, and
 * they were real: the optimizer was maximising posture-discounted points, so
 * a heavily-owned star could be worth selling on the objective while being
 * an obvious loss in the currency the panel displayed and the manager cares
 * about.
 *
 * Two different currencies, one recommendation, and the one on screen said
 * the advice was nonsense. It was.
 *
 * The posture may reorder near-equals. It may not licence a swap that throws
 * away real points, so any plan containing one cannot be recommended. The
 * plan stays visible with its reasoning; it just cannot be the advice.
 */
const MAX_POINTS_SACRIFICE_PER_MOVE = 2;

/**
 * INCUMBENCY — how much better a challenger must look before he displaces a
 * player you already own.
 *
 * The Wildcard plan is built by solving for the best squad from scratch and
 * then diffing it against the current one, so any player whose replacement
 * looks better by a hundredth of a point gets churned. Reported from
 * production, twice: a Wildcard that moved Gibbs-White and Horníček, both
 * playing well, for no visible reason.
 *
 * v1.37 answered this with a flat 0.5 points and the reasoning that it
 * "settles ties toward stability". THAT WAS MEASURED IN v1.38 AND IT SETTLED
 * NOTHING. On a pool where every player within a position has identical true
 * value — so every possible transfer is worth exactly zero — half a point of
 * incumbency let the model churn 15 of 15 players at just half a point per
 * gameweek of estimation noise. The bonus was a tenth the width of the noise
 * it was meant to absorb.
 *
 * It is now DERIVED rather than chosen: the error in comparing two players
 * over the window, times how much a chosen newcomer's estimate is inflated by
 * the mere fact of having been chosen. See `retentionThreshold` in
 * lib/selection.ts, which also explains why your own player's estimate does
 * not carry that inflation and the challenger's does.
 *
 * It is largest early in the season, when the model knows least, and decays
 * with real evidence — 6.6 points at four gameweeks played, 3.2 by gameweek
 * twenty, 2.4 by the end. It never reaches zero, because the model is never
 * entitled to believe a one-point difference over five gameweeks is real.
 *
 * Measured after the change, on the same flat-truth pool: 0 of 15 churned at
 * every noise level, and — the check that matters just as much — a genuinely
 * weak squad still gets a wildcard worth +256 TRUE points, while a strong one
 * is told to hold.
 */

/**
 * Converts a threshold expressed in WINDOW POINTS into the units the solver's
 * objective is actually denominated in.
 *
 * THE UNIT BUG, WHICH BIT TWICE IN OPPOSITE DIRECTIONS.
 *
 * The objective is not points. It is
 *
 *     valueSquad × BENCH_WEIGHT  +  valueXi × (1 − BENCH_WEIGHT)
 *
 * where `valueSquad` is on a five-gameweek scale and `valueXi` is on a
 * NEXT-GAMEWEEK scale. Two different horizons, deliberately, and mixed by
 * weight. A player who is genuinely T window-points better is T/W better in
 * the NEXT gameweek, so he improves `valueXi` by
 *
 *     T/W  +  FUTURE_DISCOUNT × T × (1 − 1/W)
 *
 * and the objective as a whole by about 0.40 × T — not by T. A threshold
 * added raw therefore demands roughly two and a half times what it claims.
 *
 * THIS WAS GOT WRONG TWICE, IN OPPOSITE DIRECTIONS, WHICH IS THE POINT.
 * The old incumbency bonus lived inside `valueSquad`, so BENCH_WEIGHT (0.12)
 * multiplied it and the advertised half point was worth six hundredths. The
 * first version of this fix added the new threshold raw, so it demanded
 * around twenty-two window points before sanctioning any transfer at all —
 * it froze the squad solid and broke a dozen tests that check real upgrades
 * still happen. The same mistake both times: mixing units, in a file that
 * mixes two horizons on purpose.
 *
 * The factor is therefore DERIVED from the very constants that define the
 * objective, so it cannot drift away from them when one of them is tuned.
 */
/** O inverso de `retentionInObjectiveUnits`: leva um valor do objetivo de
 * volta a pontos-janela, que é a única escala em que faz sentido mostrar um
 * número ao gestor ou compará-lo com um travão de ruído. */
export function objectiveToWindowPoints(objective: number): number {
  const perPoint = retentionInObjectiveUnits(1);
  return perPoint > 0 ? objective / perPoint : objective;
}

export function retentionInObjectiveUnits(windowPoints: number): number {
  const perGwShare = 1 / WINDOW_GAMEWEEKS;
  const xiShare = perGwShare + FUTURE_DISCOUNT * (1 - perGwShare);
  return windowPoints * (BENCH_WEIGHT + (1 - BENCH_WEIGHT) * xiShare);
}

/** Moves in a plan that give up more real expected points than the cap. */
export function costlyMoves(plan: TransferPlan): TransferMove[] {
  return plan.moves.filter(
    (m) => m.in.expectedPoints - m.out.expectedPoints < -MAX_POINTS_SACRIFICE_PER_MOVE
  );
}

/** Confidence of a plan: the mean model-trust of the players it moves, or of
 * the whole XI when it moves nobody. A transfer's confidence is about the
 * two players being swapped, not about the squad at large. */
export function planConfidence(plan: TransferPlan): number {
  const trustOf = (p: ScoredPlayer) =>
    typeof p.modelTrust === "number" ? p.modelTrust : 1;
  const involved =
    plan.moves.length > 0
      ? plan.moves.flatMap((m) => [m.out, m.in])
      : plan.xi;
  if (involved.length === 0) return 1;
  return involved.reduce((s, p) => s + trustOf(p), 0) / involved.length;
}

/**
 * How much a plan must beat holding by before it can be recommended.
 *
 * WHAT THIS USED TO BE, AND WHY IT WAS WORSE THAN NOTHING.
 *
 *     noiseFloor(confidence) = NOISE_FLOOR_MAX_POINTS * (1 - confidence)
 *
 * with `confidence` the mean `modelTrust` of the players being moved. Since
 * `modelTrust = min(1, minutes / 360)`, every regular starter reaches 1.0
 * after four full games — so from gameweek four the floor was EXACTLY ZERO
 * and any positive gain, however small, could be recommended. The comment
 * above even said so out loud: "at full confidence the floor is zero and
 * nothing changes." It read like a reassurance. It was a description of the
 * bug, and it was in the file the whole time.
 *
 * A floor that vanishes as soon as players have played is precisely backwards
 * for the season's first months, and it is the direct cause of "why is it
 * telling me to sell a player who just scored well".
 *
 * WHAT IT IS NOW, AND WHY IT IS NOT SIMPLY THE RETENTION THRESHOLD.
 *
 * The first attempt reused `retentionThreshold` here verbatim, which
 * double-counted: the solver already refuses any individual swap that fails
 * that threshold, so demanding it again of the finished plan charged for the
 * same protection twice and blocked a genuine six-points-a-gameweek upgrade.
 *
 * The two checks answer different questions and deserve different numbers.
 * The solver asks "is this player better than mine?" — a comparison between
 * a chosen challenger and an unchosen incumbent, so it carries the selection
 * inflation. This asks "is the whole plan better than doing nothing?", where
 * the selection has already been paid for. What remains is the plain
 * uncertainty of the comparison, and it grows with the NUMBER of moves — m
 * independent comparisons stack as sqrt(m), not as m and not as a constant.
 *
 * `confidence` still adds a penalty for a plan built on unusually thin
 * minutes. It can no longer relax the floor to nothing, which was the bug.
 */
export function noiseFloor(confidence: number, gamesOfEvidence = 0, moves = 1): number {
  const comparisonError =
    rateErrorPerGw(gamesOfEvidence) * WINDOW_GAMEWEEKS * Math.SQRT2;
  const c = Math.min(1, Math.max(0, confidence));
  const thinEvidencePenalty = NOISE_FLOOR_MAX_POINTS * (1 - c);
  const floor = comparisonError * Math.sqrt(Math.max(1, moves)) + thinEvidencePenalty;
  return Math.round(floor * 100) / 100;
}

/**
 * What a banked free transfer is worth as an option on next week's
 * information — injuries, team news, price moves, a fixture swing.
 *
 * Without this the planner spent every accumulated transfer on any positive
 * gain, and the "do nothing" plan could never express why holding is often
 * right, even though its own explanatory text said so.
 */
const FT_OPTION_VALUE = 1.5;
/** The most transfers this planner will consider without a chip. Beyond
 * this you are not making transfers, you are rebuilding — which is what the
 * wildcard signal below is for. */
const MAX_TRANSFERS_CONSIDERED = 3;
/** Window points that justify burning a wildcard once the season has settled. */
const WILDCARD_MIN_GAIN = 12;
/** Before this gameweek, the bar rises — see the wildcard threshold below. */
const WILDCARD_SETTLED_EVENT = 10;

/**
 * The value of one player to the SQUAD (a multi-week asset) and to the
 * ELEVEN (a one-week decision), under the active posture.
 *
 * Both the integer program's objective coefficients and the ranking of the
 * finished plans are computed from this single function. They diverged twice
 * during development — once by horizon and once by posture — and each time
 * the symptom was the same: the solver optimised one quantity and the plan
 * list was sorted by another, so the recommendation shown to the user was
 * not the one the solver had chosen.
 */
export function playerValue(p: ScoredPlayer, beta: number): { squad: number; xi: number } {
  const squad = strategicValue(p, beta);
  const next = strategicValueNext(p, beta);
  return { squad, xi: next + FUTURE_DISCOUNT * Math.max(0, squad - next) };
}

/** The objective the integer program maximises, evaluated on a finished
 * plan. Ranking and optimisation are therefore the same quantity by
 * construction rather than by discipline. */
export function planObjective(
  squad: ScoredPlayer[],
  xi: ScoredPlayer[],
  beta: number,
  hits: number,
  transfers: number,
  perTransferCost: number
): number {
  const xiIds = new Set(xi.map((p) => p.element.id));
  let total = 0;
  for (const p of squad) {
    const v = playerValue(p, beta);
    total += v.squad * BENCH_WEIGHT;
    if (xiIds.has(p.element.id)) total += v.xi * (1 - BENCH_WEIGHT);
  }
  // ═══ v1.45 — OS CUSTOS TÊM DE ESTAR NAS MESMAS UNIDADES QUE O VALOR ═══
  //
  // `total` acima é a soma dos valores dos jogadores, que estão na escala do
  // OBJETIVO: cerca de 0.40 unidades por ponto-janela (ver
  // `retentionInObjectiveUnits`). O custo do hit e o valor de opção da
  // transferência eram subtraídos em BRUTO, em pontos.
  //
  // Consequência medida: um hit de 4 pontos era cobrado como se custasse
  // 4 / 0.4016 = 10 PONTOS-JANELA, e guardar uma transferência valia 3.7 e
  // não 1.5. O planeador recusava sistematicamente hits que valem a pena e
  // sobrevalorizava guardar transferências, por um fator de dois e meio.
  //
  // É exatamente o mesmo erro que a v1.38 corrigiu para o limiar de retenção,
  // no mesmo ficheiro. Corrigi-o lá e não verifiquei se a mistura existia
  // mais acima — existia, nos dois sítios onde o solver e o ranking somam
  // custos.
  return (
    total -
    retentionInObjectiveUnits(hits * HIT_COST_POINTS) -
    retentionInObjectiveUnits(transfers * perTransferCost)
  );
}

export interface TransferMove {
  out: ScoredPlayer;
  in: ScoredPlayer;
  /** Window expected-points difference for this single swap. */
  gain: number;
  /** Cash freed (positive) or spent (negative) by this swap, £m. */
  cashDeltaM: number;
  /** What selling this player ACTUALLY pays you. FPL only refunds half of
   * any rise since you bought him, so this can be below his listed price —
   * and it is the number the transfer has to be paid for with. Showing the
   * listed price instead makes a move look more affordable than it is. */
  outSellingPriceM: number;
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
  /** The eleven's value under the active variance posture — the quantity the
   * solver actually maximised, and therefore the one plans are ranked on. */
  xiStrategicPoints: number;
  /** Mean model-trust of the players this plan moves. Low means the numbers
   * behind it are mostly FPL's own flat estimate, not this model. */
  confidence: number;
  /** How much this plan had to beat holding by to be recommended. */
  requiredEdge: number;
  /** True when this plan was solved WITHOUT the retention margin and is
   * shown only so the user can see what was refused. */
  unguarded?: boolean;
  /** xiWindowPoints minus the hit cost — the number plans are ranked on. */
  netValue: number;
  /** Versus doing nothing. Negative means the plan is worse than holding. */
  netGainVsHold: number;
  /** True quando o ganho acima foi limitado pelo teto de plausibilidade —
   * ou seja, o modelo queria reportar um número que nenhum onze consegue
   * produzir. Ver `decisionGain` em lib/selection.ts. */
  gainCapped: boolean;
  bankAfterM: number;
  rationale: string;
}

export interface WildcardSignal {
  /** Quantos pontos o wildcard teria de valer para ser aconselhado agora,
   * já com todos os prémios somados (início de época, paragem para seleções,
   * confiança do modelo).
   *
   * Existia apenas embutido numa frase em português. Um número que a
   * interface mostra e que os testes precisam de verificar não pode viver só
   * dentro de prosa: obriga a raspá-lo com expressões regulares, que partem
   * quando o texto muda, e impede-o de ser mostrado noutro sítio. */
  requiredGain: number;
  /** Set when the "ideal" eleven's forecast is not physically plausible —
   * the model saying out loud that it is over-reaching. See lib/selection.ts. */
  overreach?: string | null;
  /** How many of the ideal fifteen are not in the current squad. */
  distance: number;
  /** Window points gained by moving all the way to the ideal squad. */
  gain: number;
  available: boolean;
  advise: boolean;
  text: string;
}

/**
 * A PERGUNTA QUE O GESTOR FAZ, E NÃO A QUE O MODELO ACHA QUE DEVIA FAZER.
 *
 * Até aqui o plantel de Wildcard era calculado em todas as visitas e só era
 * mostrado quando o modelo aconselhava o chip. Quem quisesse saber "se eu
 * usar o Wildcard esta semana, o que faço?" não tinha resposta, porque o
 * modelo já tinha decidido que a pergunta não interessava. Agora cada chip
 * tem um cenário calculado, com a recomendação do modelo ao lado — a
 * decisão é do Pedro, a conta é da app.
 */
export type ChipKey = "wildcard" | "freehit" | "bboost" | "3xc";
export type WildcardProfile = "equilibrado" | "imediato" | "continuidade";

export interface ChipScenario {
  chip: ChipKey;
  label: string;
  /** Perfil escolhido pelo gestor para um cenário hipotético de Wildcard. */
  wildcardProfile?: WildcardProfile;
  /** Ainda há um destes chips por usar nesta metade da época. */
  available: boolean;
  /** O plantel com que se joga o chip. Para Wildcard e Free Hit é um
   * plantel reconstruído; para Bench Boost e Triple Captain é o plano
   * recomendado desta jornada, com o chip por cima. */
  plan: TransferPlan | null;
  /** Pontos esperados a mais na PRÓXIMA jornada face a não jogar o chip
   * (mantendo o plano recomendado). */
  gainNext: number;
  /** Pontos esperados a mais nas próximas 5 jornadas, quando o chip mexe
   * nelas (só o Wildcard). Já limitado pelo teto de plausibilidade. */
  gainWindow: number | null;
  /** O que o modelo faria: true = o chip compensa agora. */
  advised: boolean;
  /** Frase pronta para o ecrã: o veredicto e porquê. */
  verdict: string;
  /** Uma por troca do plano, na mesma ordem de `plan.moves`:
   *  - "clara": o reforço ganha mais do que o erro com que o modelo
   *    distingue os dois jogadores;
   *  - "indiferente": ganha, mas menos do que esse erro — é ruído;
   *  - "financia": o reforço vale MENOS do que quem sai; a troca só existe
   *    para libertar dinheiro para outra. */
  moveKinds: MoveKind[];
  /** Os jogadores que o gestor fixou e que o cenário respeitou. */
  keptIds: number[];
  /** Jogadores que o gestor pediu para comprar ("incluir"). */
  includedIds: number[];
  /** Os incluídos que vieram do núcleo da elite e não do gestor. */
  includedByDefault?: number[];
}

export type MoveKind = "clara" | "indiferente" | "financia";

export interface TransferAdvice {
  available: boolean;
  reason: string | null;
  hold: TransferPlan | null;
  plans: TransferPlan[];
  recommended: TransferPlan | null;
  wildcard: WildcardSignal | null;
  /** "E se eu jogasse o chip X esta semana?" — sempre calculado, mesmo
   * quando o modelo não aconselha o chip. Ver `ChipScenario`. */
  scenarios: ChipScenario[];
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
  const bench = orderBench(
    squad.filter((p) => !xi.some((q) => q.element.id === p.element.id))
  );
  const { captain, viceCaptain } = pickCaptain(xi, beta);
  return {
    xi,
    bench,
    captain,
    viceCaptain,
    xiWindowPoints: Math.round(xi.reduce((s, p) => s + p.expectedPoints, 0) * 10) / 10,
    xiNextPoints: Math.round(xi.reduce((s, p) => s + p.expectedPointsNext, 0) * 10) / 10,
    // The value the SOLVER was maximising, so plans are ranked on the same
    // quantity they were built to optimise. Ranking on raw expected points
    // while the squad had been chosen under a variance posture meant the
    // posture picked a differential eleven and was then judged by exactly
    // the metric it had just traded away — measured at seven window points
    // destroyed, reported to the user as if it were the gain.
    xiStrategicPoints:
      Math.round(xi.reduce((s, p) => s + playerValue(p, beta).xi, 0) * 10) / 10,
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
  /** How much better a challenger must look to displace an incumbent. See
   * the INCUMBENCY note above and `retentionThreshold` in lib/selection.ts. */
  retention: number;
  /** Jogadores que o gestor fixou: têm de ficar no plantel. Só usado nos
   * cenários de chip — ver `keepIds` em planTransfers. */
  forceIds?: Set<number>;
  /** Retenção por jogador, em pontos-janela, a substituir `retention` para
   * quem está no plantel. Ver `provenIncumbentBonus`. */
  incumbentBonus?: Map<number, number>;
}

function solveSquad(opts: SolveOptions): ScoredPlayer[] | null {
  const { pool, ownedIds, costM, budgetM, maxTransfers, freeTransfers, allowHits, beta, retention } =
    opts;
  const clubIds = Array.from(new Set(pool.map((p) => p.team.id)));

  // Positional anchors for the shrinkage below, computed once per solve.
  const meanSquad = positionalMeans(pool, (p) => playerValue(p, beta).squad);
  const meanXi = positionalMeans(pool, (p) => playerValue(p, beta).xi);

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
    // Two horizons, deliberately different. Squad membership is a
    // multi-week asset, so it carries the window value. The starting eleven
    // is a decision about ONE gameweek, so it carries next-gameweek value
    // plus a discounted tail — which is also what puts the -4 hit on a
    // comparable scale. See FUTURE_DISCOUNT above.
    const isOwned = ownedIds.has(p.element.id);
    const rawValue = playerValue(p, beta);
    // THE WINNER'S CURSE — see lib/selection.ts. Optimising over estimates
    // selects the most flattering ERRORS, not the best players. Each value is
    // pulled toward its positional mean by how little evidence stands behind
    // it, BEFORE the solver gets to hunt through them.
    const raw = {
      squad: shrunkForSelection(p, rawValue.squad, meanSquad.get(p.element.element_type) ?? 0),
      xi: shrunkForSelection(p, rawValue.xi, meanXi.get(p.element.element_type) ?? 0),
    };
    const valueSquad = raw.squad;
    const valueXi = raw.xi;

    variables[squadVar] = {
      score:
        valueSquad * BENCH_WEIGHT +
        (isOwned
          ? retentionInObjectiveUnits(opts.incumbentBonus?.get(p.element.id) ?? retention)
          : 0),
      cost: costM.get(p.element.id) ?? p.priceM,
      [POS_KEY[p.element.element_type]]: 1,
      [`club_${p.team.id}`]: 1,
      [`link_${p.element.id}`]: -1,
      ...(isOwned ? { kept: 1 } : {}),
      ...(opts.forceIds?.has(p.element.id) ? { [`force_${p.element.id}`]: 1 } : {}),
    };
    if (opts.forceIds?.has(p.element.id)) constraints[`force_${p.element.id}`] = { equal: 1 };
    variables[xiVar] = {
      score: valueXi * (1 - BENCH_WEIGHT),
      xi: 1,
      [`xi_${POS_KEY[p.element.element_type]}`]: 1,
      [`link_${p.element.id}`]: 1,
    };
    constraints[`link_${p.element.id}`] = { max: 0 };
    binaries[squadVar] = 1;
    binaries[xiVar] = 1;
  }

  // Every transfer consumes a banked free transfer, and a banked transfer is
  // an option worth roughly FT_OPTION_VALUE. Charging it makes "hold" a real
  // competitor instead of losing automatically to any positive gain. The
  // charge is waived once the bank is full, where the marginal transfer
  // genuinely is free because it would otherwise be forfeited.
  const perTransferCost = freeTransfers >= 5 ? 0 : FT_OPTION_VALUE;
  if (perTransferCost > 0) {
    constraints.transferbound = { min: SQUAD_SIZE };
    // Em unidades do objetivo — ver planObjective.
    variables.transfers = {
      score: -retentionInObjectiveUnits(perTransferCost),
      transferbound: 1,
    };
    ints.transfers = 1;
    for (const p of pool) {
      if (ownedIds.has(p.element.id)) variables[`s${p.element.id}`].transferbound = 1;
    }
  }

  if (allowHits) {
    // hits >= transfers - freeTransfers, i.e. kept + hits >= 15 - free.
    // The variable carries a negative objective coefficient, so the solver
    // drives it down to exactly that bound rather than inflating it.
    constraints.hitbound = { min: SQUAD_SIZE - freeTransfers };
    // Em unidades do objetivo — ver planObjective.
    variables.hits = {
      score: -retentionInObjectiveUnits(HIT_COST_POINTS),
      hitbound: 1,
    };
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
    if (squad.length !== SQUAD_SIZE) return null;

    // The solver's `feasible` flag is not trustworthy on larger models — it
    // has been observed returning a squad over budget and calling it optimal
    // (see the note in lib/optimizer.ts). Re-check the rules that matter
    // before handing a plan to the user, because an illegal plan is worse
    // than a missing one: FPL will simply refuse it at the deadline.
    const spend = squad.reduce((t, p) => t + (costM.get(p.element.id) ?? p.priceM), 0);
    if (spend > budgetM + 1e-6) return null;
    const perClub = new Map<number, number>();
    for (const p of squad) perClub.set(p.team.id, (perClub.get(p.team.id) ?? 0) + 1);
    if ([...perClub.values()].some((n) => n > 3)) return null;
    const perPos = new Map<number, number>();
    for (const p of squad) {
      perPos.set(p.element.element_type, (perPos.get(p.element.element_type) ?? 0) + 1);
    }
    if ([1, 2, 3, 4].some((t) => (perPos.get(t) ?? 0) !== NEED[t])) return null;

    return squad;
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
      outSellingPriceM: Math.round((costM.get(o.element.id) ?? o.priceM) * 10) / 10,
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
    netValue:
      Math.round(
        planObjective(
          squad,
          evaluated.xi,
          beta,
          hits,
          transfers,
          state.freeTransfers >= 5 ? 0 : FT_OPTION_VALUE
        ) * 10
      ) / 10,
    confidence: 1, // filled in below, once moves exist
    requiredEdge: 0,
    netGainVsHold: 0,
    gainCapped: false, // filled in by the caller once the hold plan exists
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
    /** The gameweek being planned for. Used to price the option value of
     * holding a chip — see the wildcard threshold below. */
    currentEvent?: number;
    /** Season calendar. An international break immediately ahead raises the
     * bar for a Wildcard: it commits fifteen picks exactly when the
     * information behind them is about to go stale. See lib/chipplan.ts. */
    calendar?: CalendarContext;
    /** Jogadores do plantel que o gestor quer manter nos cenários de
     * Wildcard e Free Hit. Ids que não são do plantel são ignorados. */
    keepIds?: number[];
    /** Jogadores que o gestor quer COMPRAR nos cenários de Wildcard e Free
     * Hit (por exemplo o Haaland). O plantel é montado à volta deles. */
    includeIds?: number[];
    /** Inclusões POR OMISSÃO no cenário de Wildcard quando o gestor não
     * escolheu nenhuma: o núcleo da elite (jogadores em ≥70% das 200 melhores
     * equipas) que ele não tem. Ordenados do mais para o menos possuído; os
     * que não couberem no orçamento ficam de fora, um a um. */
    defaultIncludeIds?: number[];
    /** Core players always required only in Wildcard, never Free Hit. */
    requiredWildcardIds?: number[];
    /** Um só cenário calculado por visita: evita 3 solves adicionais em SSR. */
    wildcardProfile?: WildcardProfile;
  } = {}
): TransferAdvice {
  const beta = opts.beta ?? 0;
  const risers = new Set(opts.likelyRisers ?? []);
  const fallers = new Set(opts.likelyFallers ?? []);
  const currentEvent = opts.currentEvent ?? 20;

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
      scenarios: [],
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
      scenarios: [],
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
  // Independent historical evidence: do not let a single weak projection
  // remove top season performers from the candidate pool altogether.
  for (const posId of [1,2,3,4]) {
    const proven=[...scored].filter(p=>p.element.element_type===posId &&
      p.element.minutes>=270 && Number(p.element.total_points)>0)
      .sort((a,b)=>Number(b.element.points_per_game)-Number(a.element.points_per_game))
      .slice(0,12);
    for(const p of proven)poolMap.set(p.element.id,p);
  }
  // Jogadores pedidos em "incluir" entram sempre no conjunto de candidatos,
  // mesmo que não estejam entre os melhores da posição — senão o solver não
  // os podia escolher.
  const includeIds = new Set(
    (opts.includeIds ?? []).filter((id) => byId.has(id) && !ownedIds.has(id))
  );
  for (const id of includeIds) poolMap.set(id, byId.get(id)!);
  const defaultIncludeIds = (opts.defaultIncludeIds ?? []).filter(
    (id) => byId.has(id) && !ownedIds.has(id) && !includeIds.has(id)
  );
  for (const id of defaultIncludeIds) poolMap.set(id, byId.get(id)!);
  const requiredWildcardIds = (opts.requiredWildcardIds ?? []).filter(id => byId.has(id));
  for (const id of requiredWildcardIds) poolMap.set(id,byId.get(id)!);
  const pool = [...poolMap.values()];

  // How much evidence the model actually has: gameweeks already played. This
  // sizes the retention threshold, and it is deliberately NOT `modelTrust` —
  // see the v1.38 note in lib/selection.ts for why minutes-based trust
  // switched every protection off after four games.
  //
  // It reads `currentEvent`, not `state.fromEvent`. They are different
  // things: `fromEvent` is the gameweek the SQUAD SNAPSHOT came from, and it
  // can lag or be a fixture default, while `currentEvent` is the gameweek
  // being planned for. The first draft used `fromEvent` and every test that
  // sets a gameweek was silently ignored.
  const gamesOfEvidence = Math.max(0, currentEvent - 1);
  const retention = retentionThreshold(gamesOfEvidence, WINDOW_GAMEWEEKS);

  const base = {
    pool,
    ownedIds,
    costM,
    budgetM: state.totalBudgetM,
    beta,
    retention,
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
    const label =
      state.freeTransfers === 1
        ? "Usar a transferência livre"
        : `Usar até ${state.freeTransfers} transferências livres`;
    const mkFree = (s: ScoredPlayer[]) =>
      makePlan("gratuitas", label, s, ownedSquad, state, costM, beta, risers, fallers, 0);

    let plan = squad ? mkFree(squad) : null;

    // SHOWING THE MOVE THAT WAS REFUSED, NOT JUST REFUSING IT.
    //
    // The retention threshold lives inside the solve, so a swap that fails it
    // does not merely lose — it never appears. That silently removed the one
    // thing the owner had repeatedly asked for: seeing WHAT the model
    // considered and WHY it said no. "No plan shown" is indistinguishable
    // from "the model had no idea", which is how this project got into
    // trouble in the first place.
    //
    // So when the guarded solve finds nothing, solve again with the guard
    // off. The result is never recommendable — `requiredEdge` below sees to
    // that — but it is visible, with its own reasoning attached.
    if (!plan || plan.transfers === 0) {
      const unguarded = solveSquad({
        ...base,
        retention: 0,
        maxTransfers: state.freeTransfers,
        freeTransfers: state.freeTransfers,
        allowHits: false,
      });
      const shown = unguarded ? mkFree(unguarded) : null;
      if (shown) shown.unguarded = true;
      if (shown && shown.transfers > 0) {
        shown.rationale = `Esta é a melhor troca que o modelo encontra se ignorar a margem de erro. Não é recomendada: a diferença entre estes dois jogadores é menor do que o erro com que o modelo os estima nesta altura da época, por isso agir sobre ela é perseguir ruído, não vantagem.`;
        plans.push(shown);
        plan = null;
      }
    }

    if (plan && plan.transfers > 0) {
      plan.rationale =
        "O melhor que consegues fazer sem pagar pontos. Como não há hit, qualquer ganho positivo já compensa — a única coisa que perdes é a flexibilidade de guardar a transferência.";
      plans.push(plan);
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
  // How different the "ideal" would be if the model ignored its own margin of
  // error. This is not used to decide anything — it exists so the app can say
  // WHY it is holding still, which is the difference between "you are close to
  // ideal" and "the gaps that exist are smaller than the error with which I
  // measure them". Those two sentences look identical on screen and mean
  // completely different things, and only the second one is true early in a
  // season.
  const unguardedIdeal = solveSquad({
    ...base,
    retention: 0,
    maxTransfers: SQUAD_SIZE,
    freeTransfers: SQUAD_SIZE,
    allowHits: false,
  });
  const unguardedDistance = unguardedIdeal
    ? unguardedIdeal.filter((p) => !ownedIds.has(p.element.id)).length
    : 0;

  let wildcard: WildcardSignal | null = null;
  let wildcardPlan: TransferPlan | null = null;
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
    // NOT the raw difference — see decisionGain in lib/selection.ts. The
    // ideal squad is selected from six hundred estimates and the current one
    // is not, so the raw difference carries the whole selection bias.
    const rawGain = Math.round((plan.xiWindowPoints - hold.xiWindowPoints) * 10) / 10;
    const { gain, capped: gainCapped } = decisionGain(
      plan.xiWindowPoints,
      hold.xiWindowPoints,
      5
    );
    // A wildcard is worth playing when the squad is far enough from where it
    // should be that free transfers cannot close the gap in reasonable time.
    // Five transfers is over a month of holding; below that the free
    // transfers get there on their own.
    //
    // But distance and points are not the whole price of the chip, and this
    // threshold used to behave as if they were. A wildcard held is worth more
    // than the points it would buy today, for two reasons that both bite
    // hardest early in the season:
    //
    //   1. INFORMATION. After one or two gameweeks the "ideal" squad is built
    //      almost entirely on FPL's own pre-season estimates and thin odds.
    //      Being six transfers from that ideal is mostly measuring noise. By
    //      October the same figure is measuring something real.
    //   2. OPTIONALITY. A chip spent in gameweek 2 cannot be spent on the
    //      injury crisis in gameweek 9, or on a double gameweek later. There
    //      are only two per season and one per half.
    //
    // So the points bar starts very high and decays to the structural figure
    // by around gameweek 10. At gameweek 2 it takes roughly 32 points over
    // the window to justify the chip; at gameweek 10 onwards, 12.
    const earlySeasonPremium = Math.max(0, WILDCARD_SETTLED_EVENT - currentEvent) * 2.5;

    // AN INTERNATIONAL BREAK IMMEDIATELY AHEAD.
    //
    // Rebuilding a squad the week before a break commits all fifteen picks at
    // the exact moment the information behind them goes stale: injuries on
    // national duty, new signings settling over two weeks of training,
    // managers changing shape. Waiting one gameweek costs almost nothing and
    // buys a whole break of news.
    const breakPremium = opts.calendar?.breakImminent ? WILDCARD_BREAK_PREMIUM : 0;

    // CONFIDENCE.
    //
    // The "ideal" squad is built from the same blended numbers as everything
    // else, and early in a season most of that blend is FPL's own flat
    // estimate. Spending the biggest one-shot chip in the game on a target
    // the model is 40% confident about is the most expensive way to act on
    // noise available. The bar scales inversely with confidence.
    const wcConfidence = Math.min(1, Math.max(0.05, planConfidence(plan)));
    const confidencePremium = Math.round((1 / wcConfidence - 1) * WILDCARD_MIN_GAIN);

    const requiredGain =
      WILDCARD_MIN_GAIN + earlySeasonPremium + breakPremium + confidencePremium;
    const advise = wildcardAvailable && distance >= 5 && gain >= requiredGain;
    const overreach = implausibleXiWarning(plan.xiWindowPoints, 5);
    wildcard = {
      requiredGain: Math.round(requiredGain * 10) / 10,
      distance,
      gain,
      available: wildcardAvailable,
      advise,
      overreach:
        overreach && gainCapped
          ? `${overreach} O ganho apresentado já foi limitado a esse teto (${rawGain} → ${gain} pts).`
          : overreach,
      text: !wildcardAvailable
        ? `O teu plantel está a ${distance} transferências do ideal (${gain >= 0 ? "+" : ""}${gain} pts em 5 jornadas), mas já não tens Wildcard disponível nesta metade da época — o caminho é por transferências livres, uma de cada vez.`
        : advise
          ? `Sinal de Wildcard: o teu plantel está a ${distance} transferências do ideal e a diferença vale ${gain} pontos em 5 jornadas. Fechar isso com transferências livres levaria cerca de ${distance} jornadas; com hits custaria ${(distance - state.freeTransfers) * HIT_COST_POINTS} pontos. O chip é o caminho mais barato.`
          : distance >= 5 && currentEvent < WILDCARD_SETTLED_EVENT
            ? `Plantel a ${distance} transferências do ideal (${gain >= 0 ? "+" : ""}${gain} pts em 5 jornadas), mas ainda é a jornada ${currentEvent}: o "ideal" nesta altura assenta quase todo em estimativas de pré-época e em poucas odds, por isso essa distância mede sobretudo ruído. Um chip guardado vale mais do que os pontos que compraria hoje — só há dois por época e a informação melhora todas as semanas. Precisaria de ${requiredGain.toFixed(0)} pontos para compensar agora.`
            : distance === 0 && unguardedDistance > 0
              ? `O modelo não encontra nenhuma mudança que valha a pena. Se ignorasse a sua própria margem de erro trocaria ${unguardedDistance} jogador${unguardedDistance === 1 ? "" : "es"} — mas nesta altura da época duas estimativas só são distinguíveis a partir de ${retention.toFixed(1)} pontos em 5 jornadas, e nenhuma dessas diferenças chega lá. Não é que estejas perto do ideal: é que a diferença que existe é menor do que o erro com que ela é medida.`
              : `Plantel a ${distance} transferências do ideal (${gain >= 0 ? "+" : ""}${gain} pts em 5 jornadas) — perto o suficiente para fechar com transferências livres. Guardar o Wildcard.`,
    };
    plan.rationale =
      "Com o Wildcard não pagas pontos por nenhuma transferência, por isso este é simplesmente o melhor plantel que o teu dinheiro compra hoje, otimizado para as próximas 5 jornadas.";
    wildcardPlan = plan;
    if (advise) {
      plan.rationale += " Aparece na lista de planos porque a distância ao ideal já justifica gastar o chip.";
      plans.push(plan);
    }
  }

  // --- ranking ----------------------------------------------------------
  for (const p of plans) {
    // CONVERTIDO PARA PONTOS-JANELA ANTES DE SER MOSTRADO OU COMPARADO.
    //
    // `netValue` é o objetivo do solver, não pontos. Era mostrado ao gestor
    // como "GANHO +59.4 pts" no cabeçalho e comparado contra `requiredEdge`,
    // que está em pontos-janela de verdade. Um ganho encolhido 2.5x medido
    // contra uma barra em escala real: o planeador era duas vezes e meia mais
    // conservador do que dizia ser, e o número no ecrã não era pontos.
    const raw = objectiveToWindowPoints(p.netValue - hold.netValue);

    // ═══ v1.46 — O TETO DE PLAUSIBILIDADE NÃO CHEGAVA AO NÚMERO MAIOR ═══
    //
    // A v1.35 construiu `decisionGain` precisamente para isto: escolher os
    // melhores de seiscentas estimativas escolhe também os erros mais
    // otimistas, e a diferença entre o plantel "ideal" e o teu herda essa
    // inflação toda. O teto foi aplicado ao SINAL de wildcard e a mais nada.
    //
    // `netGainVsHold` é o número em letra maior do cabeçalho — "GANHO +161.6
    // pts" — e nunca passou por lá. Enquanto vinha encolhido pelo erro de
    // unidades da v1.45 isso não se via; corrigidas as unidades, apareceu em
    // pontos reais e ficou evidente que seis trocas não rendem trinta e dois
    // pontos por jornada.
    //
    // O mesmo padrão de sempre: a defesa existe, está escrita, e não está
    // ligada ao sítio onde mais custa.
    const { gain: plausible, capped } = decisionGain(
      p.xiWindowPoints,
      hold.xiWindowPoints,
      WINDOW_GAMEWEEKS
    );
    const bounded = Math.min(raw, plausible);
    p.netGainVsHold = Math.round(bounded * 10) / 10;
    p.gainCapped = capped && bounded < raw - 1e-9;
  }
  for (const p of plans) {
    p.confidence = Math.round(planConfidence(p) * 1000) / 1000;
    // v1.62 — TESTADO E REJEITADO: tirar este piso aos planos que já
    // passaram a margem de retenção. Parecia contar a mesma incerteza duas
    // vezes, mas com ruído puro de 0,8 pts/jornada o planeador passava a
    // recomendar trocas que valem zero (teste testPureNoiseProducesNoTransfers).
    // A retenção sozinha não chega contra o efeito de seleção; fica o piso.
    // Maintain the previously regression-tested conservative effective
    // decision boundary while expressing it in five-GW point units.
    // The additional calibration safety multiplier must remain until a
    // prospective benchmark can prove a lower threshold is safe.
    p.requiredEdge = p.key === "manter" ? 0 :
      Math.round(objectiveToWindowPoints(
        noiseFloor(p.confidence, gamesOfEvidence, p.moves.length)
      ) * 100) / 100;
  }

  // THE NOISE FLOOR, APPLIED.
  //
  // Ranking by netValue alone recommends whatever edges ahead, however
  // slightly, and however little the model knows. A plan now has to clear
  // its own required edge over holding; the ones that do not are still
  // shown — the reasoning stays visible — but they cannot be the advice.
  const ranked = [...plans].sort((a, b) => b.netValue - a.netValue);
  const clears = (p: TransferPlan) =>
    p.key === "manter" ||
    (objectiveToWindowPoints(p.netValue - hold.netValue) >= p.requiredEdge &&
      costlyMoves(p).length === 0);
  const recommended = ranked.find(clears) ?? hold;
  for (const p of plans) {
    if (p.key === "manter") continue;
    const edge = Math.round(objectiveToWindowPoints(p.netValue - hold.netValue) * 10) / 10;
    const costly = costlyMoves(p);
    if (costly.length > 0) {
      p.rationale =
        `${p.rationale} ` +
        `NÃO recomendado: ${costly.length === 1 ? "esta troca deita fora" : "estas trocas deitam fora"} pontos esperados a sério — ` +
        costly
          .map(
            (m) =>
              `${m.out.element.web_name} → ${m.in.element.web_name} perde ${(m.out.expectedPoints - m.in.expectedPoints).toFixed(1)} pts em 5 jornadas`
          )
          .join("; ") +
        `. A postura de risco pode desempatar entre jogadores parecidos; não pode justificar perder pontos desta ordem.`;
    } else if (!clears(p)) {
      p.rationale =
        `${p.rationale} ` +
        `NÃO recomendado: ganha ${edge >= 0 ? "+" : ""}${edge} pts sobre não fazer nada, e nesta altura da época é preciso ganhar pelo menos ${p.requiredEdge.toFixed(1)} para valer a pena. ` +
        `Com ${Math.round(p.confidence * 100)}% de confiança, o resto vem da estimativa da própria FPL, que é quase igual para toda a gente no início da época — uma diferença desta dimensão é ruído, não vantagem.`;
    }
  }

  // --- horizons ---------------------------------------------------------
  // When holding is the advice BECAUSE the alternatives were inside the
  // noise, say so. "Do nothing" with no reason reads like the model had
  // nothing to say, when in fact it looked and decided the difference was
  // not real.
  const bestRefused = ranked.find((p) => p.key !== "manter" && !clears(p));
  const heldForNoise =
    recommended.key === "manter" && !!bestRefused && bestRefused.moves.length > 0;

  const shortTerm =
    recommended.key === "manter"
      ? (heldForNoise
          ? `Esta jornada: não faças nenhuma transferência. A melhor troca disponível (${bestRefused!.moves
              .map((m) => `${m.out.element.web_name} → ${m.in.element.web_name}`)
              .join("; ")}) só ganha ${(bestRefused!.netValue - hold.netValue).toFixed(1)} pts em 5 jornadas, e com ${Math.round(bestRefused!.confidence * 100)}% de confiança isso está dentro da margem de erro — o modelo ainda não sabe o suficiente para justificar gastar a transferência. Guarda-a. `
          : `Esta jornada: não faças nenhuma transferência. `) +
        `Alinha ${recommended.captain?.element.web_name ?? "o teu melhor jogador"} com a braçadeira e guarda a transferência (ficas com ${Math.min(5, state.freeTransfers + 1)} na próxima).`
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

  const scenarios = buildChipScenarios({
    base,
    state,
    costM,
    beta,
    risers,
    fallers,
    ownedSquad,
    hold,
    recommended,
    wildcard,
    wildcardPlan,
    retention,
    keepIds: new Set((opts.keepIds ?? []).filter((id) => ownedIds.has(id))),
    includeIds,
    defaultIncludeIds: includeIds.size > 0 ? [] : defaultIncludeIds,
    requiredWildcardIds,
    wildcardProfile: opts.wildcardProfile ?? "equilibrado",
    scored,
  });

  return {
    available: true,
    reason: null,
    hold,
    plans: ranked,
    recommended,
    wildcard,
    scenarios,
    shortTerm,
    mediumTerm,
    longTerm,
  };
}

// --------------------------------------------------------------------------
// Chip scenarios — "e se eu usasse o chip X esta semana?"
// --------------------------------------------------------------------------

const round1 = (x: number) => Math.round(x * 10) / 10;

function chipAvailable(state: SquadState, chip: ChipKey): boolean {
  return (state.chips.find((c) => c.name === chip)?.remaining ?? 0) > 0;
}

function buildChipScenarios(ctx: {
  base: Omit<SolveOptions, "maxTransfers" | "freeTransfers" | "allowHits">;
  state: SquadState;
  costM: Map<number, number>;
  beta: number;
  risers: Set<number>;
  fallers: Set<number>;
  ownedSquad: ScoredPlayer[];
  hold: TransferPlan;
  recommended: TransferPlan;
  wildcard: WildcardSignal | null;
  wildcardPlan: TransferPlan | null;
  retention: number;
  keepIds: Set<number>;
  includeIds: Set<number>;
  defaultIncludeIds: number[];
  requiredWildcardIds: number[];
  wildcardProfile: WildcardProfile;
  scored: ScoredPlayer[];
}): ChipScenario[] {
  const { base, state, costM, beta, risers, fallers, ownedSquad, hold, recommended } = ctx;
  const out: ChipScenario[] = [];
  // The baseline every chip is measured against: playing the gameweek with
  // the plan the app already recommends, no chip.
  const baseNext = recommended.xiNextPoints + (recommended.captain?.expectedPointsNext ?? 0);
  const withCaptain = (p: TransferPlan) => p.xiNextPoints + (p.captain?.expectedPointsNext ?? 0);

  // --- Wildcard -----------------------------------------------------------
  //
  // SEM O TRAVÃO DE RETENÇÃO. O plano de Wildcard do planeador é resolvido
  // com `retention`, que obriga um reforço a bater o titular por mais do que
  // a margem de erro antes de o substituir. Isso está certo para DECIDIR se
  // o chip compensa: trocar por ruído é gastar uma transferência a troco de
  // nada. Mas quando o gestor JÁ decidiu jogar o chip as trocas são grátis,
  // e o travão só o impede de ficar com o melhor plantel. Em produção, na
  // jornada 8, devolvia "0 trocas" — a resposta certa à pergunta errada.
  // O encolhimento da maldição do vencedor continua dentro do solver; só
  // sai a exigência de vantagem sobre quem já está no plantel.
  const wcAvailable = chipAvailable(state, "wildcard");
  const forced = new Set([...ctx.keepIds, ...ctx.includeIds]);
  const forceIds = forced.size > 0 ? forced : undefined;
  const wildcardForced = new Set([...forced, ...ctx.requiredWildcardIds]);
  const wildcardForceIds = wildcardForced.size > 0 ? wildcardForced : undefined;
  const includedIds = [...ctx.includeIds];
  const incumbentBonus = provenIncumbentBonus(ctx.ownedSquad, ctx.scored, ctx.retention);
  const incumbentBonusNext = new Map(
    [...incumbentBonus].map(([id, b]) => [id, b / WINDOW_GAMEWEEKS] as [number, number])
  );
  const keptIds = [...ctx.keepIds];
  // A troca é "clara" quando ganha mais do que o erro de comparação entre os
  // dois jogadores — o mesmo `retention` que o planeador normal usa para não
  // trocar por ruído. Aqui não impede a troca (as trocas são grátis), mas
  // diz ao gestor quais delas o modelo consegue mesmo defender.
  const classify = (moves: TransferMove[], horizon: "window" | "next"): MoveKind[] =>
    moves.map((m) => {
      const d =
        horizon === "window"
          ? m.in.expectedPoints - m.out.expectedPoints
          : m.in.expectedPointsNext - m.out.expectedPointsNext;
      const bar = horizon === "window" ? ctx.retention : ctx.retention / WINDOW_GAMEWEEKS;
      return d < 0 ? "financia" : d >= bar ? "clara" : "indiferente";
    });
  const describeKinds = (kinds: MoveKind[]): string => {
    const c = kinds.filter((k) => k === "clara").length;
    const i = kinds.filter((k) => k === "indiferente").length;
    const f = kinds.filter((k) => k === "financia").length;
    if (kinds.length === 0) return "";
    const parts = [
      `${c} ${c === 1 ? "troca clara" : "trocas claras"}`,
      i > 0 ? `${i} dentro da margem de erro (tanto faz)` : "",
      f > 0 ? `${f} que só ${f === 1 ? "serve" : "servem"} para libertar dinheiro` : "",
    ].filter(Boolean);
    return ` Das ${kinds.length} trocas: ${parts.join(", ")}. Fixa os jogadores que não queres perder e o plantel é refeito à volta deles.`;
  };
  const profile = ctx.wildcardProfile;
  const originalById = new Map(base.pool.map((p) => [p.element.id, p]));
  // The objective may change, but displayed points and costs must ALWAYS
  // come from the original model — never from temporary solver weights.
  // A forecast that persistently undervalues established high scorers
  // should be checked against recent on-pitch evidence. Blend across all
  // players, with a bounded prior; never force any player's identity.
  const profilePool = base.pool.map(p=>{
    const games=p.element.minutes/90;
    const ppg=Number(p.element.points_per_game);
    const hasHistory=games>=3 && Number.isFinite(ppg) && ppg>=0;
    const evidenceWeight=hasHistory?Math.min(.12,(games/12)*.12):0;
    const historicalWindow=ppg*WINDOW_GAMEWEEKS;
    const nextBaseline=profile==="imediato"
      ? p.expectedPointsNext*WINDOW_GAMEWEEKS : p.expectedPoints;
    const adjusted=nextBaseline*(1-evidenceWeight)+historicalWindow*evidenceWeight;
    return {...p,expectedPoints:adjusted,score:adjusted};
  });
  const solveWc = (ids: Set<number> | undefined) => {
    const solved = solveSquad({
      ...base,
      pool: profilePool,
      forceIds: ids,
      incumbentBonus,
      retention: 0,
      maxTransfers: SQUAD_SIZE,
      freeTransfers: SQUAD_SIZE,
      allowHits: false,
    });
    return solved?.map((p) => originalById.get(p.element.id) ?? p) ?? null;
  };
  const protectedByProfile: number[] = [];
  // Protect a *small*, clearly identified existing core. We only auto-fix
  // reliable and already productive starters. Always honour the user's
  // explicit constraints first; if an additional player makes the squad
  // impossible, drop that automatic protection, not the user's selection.
  const profileCore =
    profile === "continuidade"
      ? [...ownedSquad]
          .filter((p) => p.pPlay >= 0.8 && p.element.minutes >= 180)
          .sort((a, b) =>
            Number(b.element.points_per_game) - Number(a.element.points_per_game) ||
            b.expectedPointsNext - a.expectedPointsNext
          )
          .slice(0, 4)
          .map((p) => p.element.id)
      : [];
  // Núcleo da elite por omissão. O backtest mostra que o modelo não prevê
  // melhor do que a média de pontos por jogo; um jogador em 70%+ das 200
  // melhores equipas é um consenso que o modelo não tem base para contrariar.
  // Um Wildcard que não o traz não fecha a lacuna que justifica jogá-lo.
  // Entram do mais para o menos possuído; quem não couber fica de fora.
  let wcSolved = null as ReturnType<typeof solveSquad>;
  const defaultUsed: number[] = [];
  if (ctx.defaultIncludeIds.length > 0) {
    const all = new Set([...wildcardForced, ...ctx.defaultIncludeIds]);
    wcSolved = solveWc(all);
    if (wcSolved) defaultUsed.push(...ctx.defaultIncludeIds);
    else {
      for (const id of ctx.defaultIncludeIds) {
        const trial = solveWc(new Set([...wildcardForced, ...defaultUsed, id]));
        if (trial) {
          defaultUsed.push(id);
          wcSolved = trial;
        }
      }
    }
  }
  if (!wcSolved) wcSolved = solveWc(wildcardForceIds);
  if (wcSolved && profileCore.length > 0) {
    const mandatory = new Set([...wildcardForced, ...defaultUsed]);
    for (const id of profileCore) {
      if (mandatory.has(id)) continue;
      const trial = solveWc(new Set([...mandatory, ...protectedByProfile, id]));
      if (trial) {
        protectedByProfile.push(id);
        wcSolved = trial;
      }
    }
  }
  // The LP allocates budget to the XI, but it does not price the *extra*
  // captain copy. A premium with strong sustainable output can therefore
  // be omitted even when the full (XI + captain + bench) team scores higher.
  // Check the strongest historically established forwards under the same
  // FPL constraints. This is a counterfactual solve, NOT a forced-pick rule:
  // keep the unrestricted solution unless the constrained one scores better.
  let captainOpportunityNote = "";
  if (wcSolved && ctx.requiredWildcardIds.length === 0 && !ctx.includeIds.size &&
      !ctx.keepIds.size && profile === "equilibrado") {
    const score = (squad: ScoredPlayer[]) => {
      const byId = new Map(profilePool.map(p => [p.element.id, p]));
      const objectiveSquad = squad.map(p => byId.get(p.element.id) ?? p);
      const e = evaluate(objectiveSquad, beta);
      // Values below are on the same five-GW scale.
      return e.xi.reduce((sum,p)=>sum+p.expectedPoints,0) +
        (e.captain?.expectedPoints ?? 0) +
        e.bench.reduce((sum,p)=>sum+p.expectedPoints,0)*0.15;
    };
    let best = wcSolved;
    let bestScore = score(best);
    const eliteForwards = [...ctx.scored]
      .filter(p => p.element.element_type === 4 && p.element.minutes >= 270 &&
        Number(p.element.total_points) >= 30 &&
        !best.some(q => q.element.id === p.element.id))
      .sort((a,b) => Number(b.element.points_per_game)-Number(a.element.points_per_game))
      .slice(0, 2);
    for (const candidate of eliteForwards) {
      const trial = solveWc(new Set([...wildcardForced, ...defaultUsed, candidate.element.id]));
      if (!trial) continue;
      const trialScore = score(trial);
      if (trialScore > bestScore + 0.05) {
        best = trial;
        bestScore = trialScore;
        captainOpportunityNote = ` Ao contabilizar o valor adicional da capitania, o melhor plantel inclui ${candidate.element.web_name}; a alternativa sem ele ficou abaixo na avaliação completa.`;
      }
    }
    wcSolved = best;
  }
  const nameById = new Map(ctx.scored.map((p) => [p.element.id, p.element.web_name] as [number, string]));
  const defaultNote = defaultUsed.length > 0
    ? `Incluí por omissão ${defaultUsed.map((id) => nameById.get(id) ?? `#${id}`).join(", ")}: núcleo de referência do cenário. `
    : "";
  const wcPlanForScenario = wcSolved
    ? makePlan("wildcard", "Wildcard — reconstruir o plantel", wcSolved, ownedSquad, state, costM, beta, risers, fallers, 0)
    : wildcardForceIds
      ? null
      : ctx.wildcardPlan;
  if (wcPlanForScenario) {
    wcPlanForScenario.rationale =
      profile === "imediato"
        ? "Cenário de curto prazo: o solver prioriza a próxima jornada, mas os ganhos de 5 jornadas continuam medidos com as previsões originais. Não é necessariamente a melhor equipa para o mês."
        : profile === "continuidade"
          ? `Cenário de continuidade: preserva automaticamente ${protectedByProfile.length} titulares fiáveis (${protectedByProfile.map((id) => nameById.get(id) ?? "#" + id).join(", ") || "nenhum possível"}), além dos fixos escolhidos por ti. Só são preservados quando existe plantel legal.`
          : "Cenário equilibrado: o solver privilegia o conjunto das próximas cinco jornadas. Isto é uma opção de simulação, não uma ordem para gastar o Wildcard." + captainOpportunityNote;
  }
  if (wcPlanForScenario && ctx.wildcard) {
    const p = wcPlanForScenario;
    const wc = ctx.wildcard;
    const gainNext = round1(withCaptain(p) - baseNext);
    const { gain: scenarioGain } = decisionGain(p.xiWindowPoints, hold.xiWindowPoints, WINDOW_GAMEWEEKS);
    out.push({
      chip: "wildcard",
      label: "Wildcard",
      wildcardProfile: profile,
      available: wcAvailable,
      plan: p,
      gainNext,
      gainWindow: scenarioGain,
      advised: wc.advise,
      moveKinds: classify(p.moves, "window"),
      keptIds,
      includedIds: [...includedIds, ...defaultUsed],
      includedByDefault: defaultUsed,
      verdict: !wcAvailable
        ? `Já não tens Wildcard nesta metade da época. O plantel abaixo é só a referência do que o dinheiro compraria.`
        : wc.advise
          ? `O modelo também o jogaria: ${p.transfers} trocas valem ${wc.gain >= 0 ? "+" : ""}${wc.gain} pts nas próximas 5 jornadas, acima dos ${wc.requiredGain.toFixed(0)} que o chip tem de render para compensar guardá-lo.`
          : scenarioGain >= wc.requiredGain
            ? `O modelo guardava-o. No papel estas ${p.transfers} trocas valem +${scenarioGain} pts em 5 jornadas, acima dos ${wc.requiredGain.toFixed(0)} que o chip tem de render. Mas cada troca, sozinha, ganha menos do que o erro com que o modelo distingue os dois jogadores; contando só as diferenças que ele consegue mesmo medir, o ganho fica em ${wc.gain >= 0 ? "+" : ""}${wc.gain}. Se decidires usá-lo na mesma, este é o melhor plantel.`
            : `O modelo guardava-o: estas ${p.transfers} trocas valem ${scenarioGain >= 0 ? "+" : ""}${scenarioGain} pts em 5 jornadas, e o chip precisa de render pelo menos ${wc.requiredGain.toFixed(0)} agora para valer mais do que guardá-lo (só há um por metade da época). Se decidires usá-lo na mesma, este é o melhor plantel.`,
    });
    const last = out[out.length - 1];
    if (last.available) last.verdict = defaultNote + last.verdict + describeKinds(last.moveKinds);
  } else if (wildcardForceIds && ctx.wildcard) {
    out.push({
      chip: "wildcard",
      label: "Wildcard",
      available: wcAvailable,
      plan: null,
      gainNext: 0,
      gainWindow: null,
      advised: false,
      moveKinds: [],
      keptIds,
      includedIds,
      verdict:
        "Não há plantel possível com esses jogadores fixos e incluídos: ou não cabem no orçamento, ou ficam mais de 3 do mesmo clube ou de uma posição. Verifica as condições e tenta de novo.",
    });
  }
  // --- Free Hit -----------------------------------------------------------
  // One gameweek, and the squad comes back afterwards: solve on NEXT-gameweek
  // points only. Presenting next-gameweek points as the window value is the
  // same trick `evaluate` uses for the starting eleven.
  const fhAvailable = chipAvailable(state, "freehit");
  const nextOnly = (p: ScoredPlayer): ScoredPlayer => ({
    ...p,
    expectedPoints: p.expectedPointsNext,
    score: p.expectedPointsNext,
  });
  const fhSolved = solveSquad({
    ...base,
    forceIds,
    incumbentBonus: incumbentBonusNext,
    pool: base.pool.map(nextOnly),
    // Trocas grátis: o mesmo raciocínio do Wildcard, sem travão de retenção.
    retention: 0,
    maxTransfers: SQUAD_SIZE,
    freeTransfers: SQUAD_SIZE,
    allowHits: false,
  });
  if (fhSolved) {
    const byId = new Map(base.pool.map((p) => [p.element.id, p]));
    const squad = fhSolved.map((p) => byId.get(p.element.id) ?? p);
    const p = makePlan("wildcard", "Free Hit", squad, ownedSquad, state, costM, beta, risers, fallers, 0);
    // Free Hit is judged on one gameweek only.
    const fhEval = evaluate(squad.map(nextOnly), beta);
    const fhNext = fhEval.xiNextPoints + (fhEval.captain?.expectedPointsNext ?? 0);
    const gainNext = round1(fhNext - baseNext);
    p.rationale =
      "Plantel só para esta jornada: o Free Hit não paga transferências e na jornada seguinte voltas ao plantel que tinhas. Otimizado apenas para a próxima jornada.";
    // A Free Hit is a rescue chip. Without blanks or a double gameweek the
    // same 11-ish points are available every week, and spending it on an
    // ordinary week throws away its real use.
    const FREE_HIT_MIN_GAIN = 12;
    const advised = fhAvailable && gainNext >= FREE_HIT_MIN_GAIN;
    out.push({
      chip: "freehit",
      label: "Free Hit",
      available: fhAvailable,
      plan: p,
      gainNext,
      gainWindow: null,
      advised,
      moveKinds: classify(p.moves, "next"),
      keptIds,
      includedIds,
      verdict: !fhAvailable
        ? "Já não tens Free Hit nesta metade da época."
        : advised
          ? `Rende ${gainNext >= 0 ? "+" : ""}${gainNext} pts esta jornada face ao plano normal — acima do limiar de ${FREE_HIT_MIN_GAIN} a partir do qual vale gastar o chip de socorro.`
          : `Rende ${gainNext >= 0 ? "+" : ""}${gainNext} pts esta jornada face ao plano normal. Abaixo de ${FREE_HIT_MIN_GAIN} o modelo guarda-o para uma jornada em branco ou dupla, que é onde ele vale mesmo.`,
    });
  }

  const fhScenario = out.find((x) => x.chip === "freehit");
  if (fhScenario?.available) fhScenario.verdict += describeKinds(fhScenario.moveKinds);

  // --- Bench Boost ----------------------------------------------------------
  const bbAvailable = chipAvailable(state, "bboost");
  const benchNext = round1(recommended.bench.reduce((s, p) => s + p.expectedPointsNext, 0));
  const BENCH_BOOST_MIN = 10;
  out.push({
    chip: "bboost",
    label: "Bench Boost",
    available: bbAvailable,
    plan: recommended,
    gainNext: benchNext,
    gainWindow: null,
    advised: bbAvailable && benchNext >= BENCH_BOOST_MIN,
    moveKinds: [],
    keptIds: [],
    includedIds: [],
    verdict: !bbAvailable
      ? "Já não tens Bench Boost nesta metade da época."
      : `O teu banco vale ${benchNext} pts esperados esta jornada. ${
          benchNext >= BENCH_BOOST_MIN
            ? "Acima de " + BENCH_BOOST_MIN + ": é uma boa semana para o chip."
            : "Abaixo de " + BENCH_BOOST_MIN + ": guarda-o para uma jornada dupla ou para depois de um Wildcard, quando os 15 jogam."
        }`,
  });

  // --- Triple Captain -------------------------------------------------------
  const tcAvailable = chipAvailable(state, "3xc");
  const cap = recommended.captain;
  const capNext = round1(cap?.expectedPointsNext ?? 0);
  const TRIPLE_CAPTAIN_MIN = 9;
  out.push({
    chip: "3xc",
    label: "Triple Captain",
    available: tcAvailable,
    plan: recommended,
    gainNext: capNext,
    gainWindow: null,
    advised: tcAvailable && capNext >= TRIPLE_CAPTAIN_MIN,
    moveKinds: [],
    keptIds: [],
    includedIds: [],
    verdict: !tcAvailable
      ? "Já não tens Triple Captain nesta metade da época."
      : `${cap?.element.web_name ?? "O capitão"} com braçadeira tripla rende +${capNext} pts esperados. ${
          capNext >= TRIPLE_CAPTAIN_MIN
            ? "É uma previsão alta o suficiente para valer o chip."
            : "Previsões de uma só jornada falham muito; abaixo de " + TRIPLE_CAPTAIN_MIN + " o modelo guardava-o para uma jornada dupla."
        }`,
  });

  return out;
}

/**
 * QUANDO O MODELO NÃO SABE, DECIDE O QUE JÁ ACONTECEU EM CAMPO.
 *
 * Em produção, à GW8, o Wildcard vendia o João Pedro (47 pts em 7 jornadas)
 * pelo Barry (28 pts), porque o modelo dava ao Barry 24,3 pts nas próximas
 * 5 jornadas e ao João Pedro 22,4. Essa diferença está DENTRO da margem de
 * erro do próprio modelo — o backtest mostra que, entre titulares, ele não
 * distingue diferenças deste tamanho. Com as trocas grátis do Wildcard, o
 * solver usava esse ruído para libertar dinheiro para outra troca.
 *
 * A regra: um jogador do teu plantel que está a pontuar acima do normal na
 * posição só sai se o substituto for CLARAMENTE melhor — por mais do que a
 * margem de erro (`retention`). Quem está abaixo da média não tem proteção
 * nenhuma; entre os dois, proteção proporcional.
 *
 * Não é "nunca vender os melhores": um reforço claramente superior continua
 * a entrar. É pôr o ónus da prova em quem chega, quando a única prova que
 * existe — os pontos reais — está do lado de quem já cá está.
 */
export function provenIncumbentBonus(
  owned: ScoredPlayer[],
  scored: ScoredPlayer[],
  retention: number,
  minMinutes = 270
): Map<number, number> {
  const ppg = (p: ScoredPlayer) => Number(p.element.points_per_game) || 0;
  const regulars = (type: number) =>
    scored
      .filter((p) => p.element.element_type === type && (Number(p.element.minutes) || 0) >= minMinutes)
      .map(ppg)
      .sort((a, b) => a - b);
  const stats = new Map<number, { mean: number; top: number }>();
  for (const type of [1, 2, 3, 4]) {
    const xs = regulars(type);
    if (xs.length < 5) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const top = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
    stats.set(type, { mean, top });
  }
  const out = new Map<number, number>();
  for (const p of owned) {
    const st = stats.get(p.element.element_type);
    if (!st || (Number(p.element.minutes) || 0) < minMinutes || st.top <= st.mean) {
      out.set(p.element.id, 0);
      continue;
    }
    const strength = Math.min(1, Math.max(0, (ppg(p) - st.mean) / (st.top - st.mean)));
    out.set(p.element.id, Math.round(retention * strength * 100) / 100);
  }
  return out;
}
