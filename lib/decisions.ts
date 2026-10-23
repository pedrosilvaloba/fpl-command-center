import { getRedis } from "./kv";
import { simulateLineup, type SimulatedPlayer } from "./lineupsettlement";

/**
 * O REGISTO DE DECISÕES.
 *
 * Até aqui a app media se as PREVISÕES acertavam (backtest), mas não se os
 * CONSELHOS rendiam pontos. Ninguém sabia se seguir a app teria dado mais
 * pontos do que o que o Pedro fez — e sem isso nenhuma mudança ao modelo
 * pode ser julgada pelo que importa.
 *
 * Duas fases:
 *   1. ANTES DO DEADLINE (a página, a cada visita): guarda o que a app
 *      aconselha para a próxima jornada — capitão, vice, onze, banco,
 *      trocas e chip. Cada visita antes do deadline substitui a anterior,
 *      por isso fica o último conselho dado.
 *   2. DEPOIS DA JORNADA (o cron): lê o que o Pedro fez e os pontos de cada
 *      jogador, e calcula os pontos do onze da app com o capitão da app
 *      contra os do onze dele com o capitão dele, pela mesma regra.
 *
 * A comparação é simples de propósito: titulares × pontos, capitão a dobrar,
 * menos o custo dos hits. Não simula substituições automáticas — nos dois
 * lados — por isso é justa entre os dois, ainda que não seja a pontuação
 * oficial exata.
 */

export const ADVICE_KEY = (event: number) => `decision:advice:${event}`;
export const OUTCOME_KEY = (event: number) => `decision:outcome:${event}`;
export const DECISION_INDEX_KEY = "decision:index";

export interface AdviceRecord {
  event: number;
  at: string;
  captain: number | null;
  vice: number | null;
  xi: number[];
  bench: number[];
  transfers: { out: number; in: number }[];
  hitCost: number;
  chip: string | null;
  captainSource: string;
  predictedXi: number;
}

export interface OutcomeRecord {
  event: number;
  settledAt: string;
  app: { points: number; captain: number | null; captainPts: number };
  pedro: { points: number; captain: number | null; captainPts: number; official: number; chip: string | null };
  followedCaptain: boolean;
  followedTransfers: boolean;
  /** pontos do onze da app menos os do teu, pela mesma regra */
  diff: number;
  /** Only populated when all 15 FPL players have completed minute/points
   * data and the hypothetical squad has a valid formation. Older rows are
   * retained but never presented as exact verified superiority. */
  settlement?: {
    simulated: number;
    actualViaMultipliers: number;
    netDifference: number;
    subCount: number;
    officialReported: number;
    officialDelta: number;
    note: string;
  };
}

export function lineupPoints(
  xi: number[],
  captain: number | null,
  pts: (id: number) => number,
  opts: { tripleCaptain?: boolean; benchBoost?: number[]; hitCost?: number } = {}
): number {
  const mult = opts.tripleCaptain ? 3 : 2;
  let total = 0;
  for (const id of xi) total += pts(id) * (id === captain ? mult : 1);
  for (const id of opts.benchBoost ?? []) total += pts(id);
  return total - (opts.hitCost ?? 0);
}

export function settleOutcome(
  advice: AdviceRecord,
  actual: {
    picks: { element: number; position: number; is_captain: boolean; multiplier: number }[];
    activeChip: string | null;
    officialPoints: number;
    transfersCost: number;
    transfersIn: number[];
    minutesById?: Map<number, number>;
    positionById?: Map<number, number>;
  },
  pts: (id: number) => number
): OutcomeRecord {
  const myXi = actual.picks.filter((p) => p.position <= 11).map((p) => p.element);
  const myBench = actual.picks.filter((p) => p.position > 11).map((p) => p.element);
  const myCap = actual.picks.find((p) => p.is_captain)?.element ?? null;
  const pedroPts = lineupPoints(myXi, myCap, pts, {
    tripleCaptain: actual.activeChip === "3xc",
    benchBoost: actual.activeChip === "bboost" ? myBench : undefined,
    hitCost: actual.transfersCost,
  });
  const appPts = lineupPoints(advice.xi, advice.captain, pts, {
    tripleCaptain: advice.chip === "3xc",
    benchBoost: advice.chip === "bboost" ? advice.bench : undefined,
    hitCost: advice.hitCost,
  });
  const advisedIn = new Set(advice.transfers.map((t) => t.in));
  const madeIn = new Set(actual.transfersIn);
  const followedTransfers =
    advisedIn.size === madeIn.size && [...advisedIn].every((id) => madeIn.has(id));
  let settlement: OutcomeRecord["settlement"];
  if (actual.picks.length === 15 && actual.minutesById && actual.positionById) {
    const ids = [...new Set([...advice.xi, ...advice.bench, ...actual.picks.map((p) => p.element)])];
    const allComplete = ids.every((id) =>
      actual.minutesById!.has(id) &&
      actual.positionById!.has(id) &&
      Number.isFinite(actual.minutesById!.get(id)) &&
      Number.isFinite(pts(id))
    );
    if (allComplete) {
      const players = new Map<number, SimulatedPlayer>(ids.map((id) => [
        id,
        {
          id,
          position: actual.positionById!.get(id) as SimulatedPlayer["position"],
          minutes: actual.minutesById!.get(id)!,
          points: pts(id),
        },
      ]));
      const app = simulateLineup({
        xi: advice.xi,
        bench: advice.bench,
        captain: advice.captain,
        vice: advice.vice,
        chip: advice.chip,
        hitCost: advice.hitCost,
        players,
      });
      if (app.reliable) {
        // FPL returns final per-player multipliers once a GW is completed.
        // They encode captain doubling and substitutions. This is NOT
        // identical to the official GW score when adjusted hits/other
        // scoring rules differ; retain the official delta for transparency.
        const actualViaMultipliers = actual.picks.reduce(
          (total, pick) => total + (pick.multiplier ?? 0) * pts(pick.element),
          0
        ) - actual.transfersCost;
        const officialDelta = actualViaMultipliers - actual.officialPoints;
        settlement = {
          simulated: app.points,
          actualViaMultipliers,
          netDifference: app.points - actualViaMultipliers,
          subCount: app.subs.length,
          officialReported: actual.officialPoints,
          officialDelta,
          note: Math.abs(officialDelta) > 1
            ? "Pontos pela API divergem dos oficiais (possível ajuste de hits); diferença indicativa, não resultado validado."
            : "Simulação de auto-subs e capitania vs multiplicadores finais da API; não prova a exequibilidade das transferências.",
        };
      }
    }
  }
  return {
    event: advice.event,
    settledAt: new Date().toISOString(),
    app: { points: appPts, captain: advice.captain, captainPts: advice.captain ? pts(advice.captain) : 0 },
    pedro: {
      points: pedroPts,
      captain: myCap,
      captainPts: myCap ? pts(myCap) : 0,
      official: actual.officialPoints,
      chip: actual.activeChip,
    },
    followedCaptain: advice.captain !== null && advice.captain === myCap,
    followedTransfers,
    diff: appPts - pedroPts,
    ...(settlement ? { settlement } : {}),
  };
}

/** Guarda o conselho para a jornada. Só antes do deadline. Nunca lança. */
export async function recordAdvice(rec: AdviceRecord, deadlineIso: string | null): Promise<void> {
  const redis = getRedis();
  if (!redis || !deadlineIso) return;
  if (Date.now() >= Date.parse(deadlineIso)) return;
  try {
    await redis.set(ADVICE_KEY(rec.event), rec);
    await redis.sadd(DECISION_INDEX_KEY, String(rec.event));
  } catch {
    /* o registo é acessório; uma falha nunca deve partir a página */
  }
}

export interface DecisionHistory {
  configured: boolean;
  rows: { event: number; advice: AdviceRecord | null; outcome: OutcomeRecord | null }[];
  totalDiff: number;
  settled: number;
}

export async function getDecisionHistory(): Promise<DecisionHistory> {
  const redis = getRedis();
  if (!redis) return { configured: false, rows: [], totalDiff: 0, settled: 0 };
  try {
    const events = ((await redis.smembers(DECISION_INDEX_KEY)) ?? [])
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => b - a);
    const rows = await Promise.all(
      events.map(async (event) => ({
        event,
        advice: (await redis.get<AdviceRecord>(ADVICE_KEY(event))) ?? null,
        outcome: (await redis.get<OutcomeRecord>(OUTCOME_KEY(event))) ?? null,
      }))
    );
    const settled = rows.filter((r) =>
      r.outcome?.settlement && Math.abs(r.outcome.settlement.officialDelta) <= 1
    );
    return {
      configured: true,
      rows,
      totalDiff: settled.reduce((s, r) => s + (r.outcome?.settlement?.netDifference ?? 0), 0),
      settled: settled.length,
    };
  } catch {
    return { configured: true, rows: [], totalDiff: 0, settled: 0 };
  }
}
