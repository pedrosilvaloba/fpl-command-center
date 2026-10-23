import type { ScoredPlayer } from "./recommend";

/**
 * O QUE OS MELHORES DO MUNDO TÊM, E QUEM CAPITANEIAM.
 *
 * O relatório do consultor (23 out 2026) mostrou que o top 50 da
 * classificação geral tinha 594,5 pontos à GW7 contra 387 do Pedro, e que a
 * diferença vinha sobretudo de jogadores que TODOS eles tinham (Haaland e
 * João Pedro a 100%, Calafiori e Groß a 96%) e do capitão óbvio. O modelo
 * da app não prevê melhor do que a média de pontos por jogo; a posse da
 * elite é o consenso de quem tem acertado, e é um sinal que o modelo não vê.
 *
 * Este módulo é só aritmética sobre dados já recolhidos: a recolha (que
 * fala com a FPL) está em lib/jobs.ts → runEliteJob, e o resultado vive no
 * Redis em `ELITE_KEY`.
 */

export const ELITE_KEY = "elite:v1";
/** Quantos gestores do topo da classificação geral entram na amostra. */
export const ELITE_SIZE = 200;
/** Posse na elite a partir da qual um jogador que não tens gera alerta. */
export const ELITE_CORE_PCT = 70;

export interface EliteSnapshot {
  /** Jornada cujas escolhas foram lidas (a última com deadline passado). */
  event: number;
  at: string;
  managers: number;
  /** id do jogador → % dos gestores da elite que o têm no plantel. */
  own: Record<string, number>;
  /** id do jogador → % que o tiveram como capitão nessa jornada. */
  cap: Record<string, number>;
}

export interface ElitePick {
  /** Escolhas de um gestor: ids do plantel e o capitão. */
  picks: number[];
  captain: number | null;
}

export function summariseElite(event: number, managers: ElitePick[]): EliteSnapshot {
  const own: Record<string, number> = {};
  const cap: Record<string, number> = {};
  const n = managers.length;
  for (const m of managers) {
    for (const id of new Set(m.picks)) own[String(id)] = (own[String(id)] ?? 0) + 1;
    if (m.captain !== null) cap[String(m.captain)] = (cap[String(m.captain)] ?? 0) + 1;
  }
  const pct = (rec: Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = n > 0 ? Math.round((v / n) * 1000) / 10 : 0;
    return out;
  };
  return { event, at: new Date().toISOString(), managers: n, own: pct(own), cap: pct(cap) };
}

export function normalizeElite(raw: unknown): EliteSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<EliteSnapshot>;
  if (typeof r.event !== "number" || typeof r.managers !== "number" || r.managers <= 0) return null;
  if (!r.own || typeof r.own !== "object" || !r.cap || typeof r.cap !== "object") return null;
  return {
    event: r.event,
    at: String(r.at ?? ""),
    managers: r.managers,
    own: r.own as Record<string, number>,
    cap: r.cap as Record<string, number>,
  };
}

export const eliteOwn = (e: EliteSnapshot | null, id: number) => (e ? (e.own[String(id)] ?? 0) : 0);
export const eliteCap = (e: EliteSnapshot | null, id: number) => (e ? (e.cap[String(id)] ?? 0) : 0);

export interface EliteGap {
  player: ScoredPlayer;
  ownPct: number;
}

/** Jogadores que a elite tem a pelo menos `ELITE_CORE_PCT` e tu não. */
export function eliteGaps(
  elite: EliteSnapshot | null,
  scored: ScoredPlayer[],
  ownedIds: Set<number>,
  threshold = ELITE_CORE_PCT
): EliteGap[] {
  if (!elite) return [];
  return scored
    .filter((p) => !ownedIds.has(p.element.id))
    .map((p) => ({ player: p, ownPct: eliteOwn(elite, p.element.id) }))
    .filter((g) => g.ownPct >= threshold)
    .sort((a, b) => b.ownPct - a.ownPct);
}

/**
 * Quanto o modelo tem de prever A MAIS para contrariar o capitão da elite.
 *
 * O backtest mostra que, entre titulares, o modelo não distingue diferenças
 * de um ou dois pontos (e que o seu nº 1 nunca acabou no top 10 real em 6
 * jornadas). Contrariar o consenso exige uma vantagem maior do que o erro
 * médio do próprio modelo por jogador e por jornada — o MAE do backtest,
 * com um mínimo de 2 pontos.
 */
export function captainOverrideMargin(backtestMae: number | null | undefined): number {
  const m = typeof backtestMae === "number" && Number.isFinite(backtestMae) ? backtestMae : 0;
  return Math.round(Math.max(2, m) * 10) / 10;
}

export interface CaptainDecision {
  captain: ScoredPlayer | undefined;
  /** O capitão que a elite mais escolheu entre os teus titulares. */
  eliteChoice: ScoredPlayer | undefined;
  eliteCapPct: number;
  /** O que o modelo, sozinho, escolheria. */
  modelChoice: ScoredPlayer | undefined;
  source: "elite" | "modelo" | "modelo-sem-elite";
  margin: number;
  reason: string;
}

/**
 * Capitão por omissão = o mais capitaneado pela elite entre os teus
 * titulares. O modelo só o contraria quando prevê mais do que `margin`
 * pontos acima dele para a próxima jornada.
 */
export function chooseCaptainWithElite(
  starters: ScoredPlayer[],
  modelChoice: ScoredPlayer | undefined,
  elite: EliteSnapshot | null,
  margin: number
): CaptainDecision {
  const base = { modelChoice, margin };
  if (!elite || starters.length === 0) {
    return {
      ...base,
      captain: modelChoice,
      eliteChoice: undefined,
      eliteCapPct: 0,
      source: "modelo-sem-elite",
      reason: "Sem dados da elite carregados: capitão escolhido só pelo modelo.",
    };
  }
  // A elite escolhe capitão entre os jogadores DELA. Entre os teus
  // titulares, o melhor proxy é: quem ela mais capitaneou; empatado ou
  // ninguém capitaneado, quem ela mais tem.
  const ranked = [...starters].sort(
    (a, b) =>
      eliteCap(elite, b.element.id) - eliteCap(elite, a.element.id) ||
      eliteOwn(elite, b.element.id) - eliteOwn(elite, a.element.id) ||
      b.expectedPointsNext - a.expectedPointsNext
  );
  const eliteChoice = ranked[0];
  const eliteCapPct = eliteCap(elite, eliteChoice.element.id);
  if (!modelChoice || modelChoice.element.id === eliteChoice.element.id) {
    return {
      ...base,
      captain: eliteChoice,
      eliteChoice,
      eliteCapPct,
      source: "elite",
      reason:
        eliteCapPct > 0
          ? `${eliteChoice.element.web_name}: o capitão de ${eliteCapPct}% da elite na GW${elite.event}${modelChoice ? ", e também o do modelo" : ""}.`
          : `${eliteChoice.element.web_name}: o teu titular mais presente nas equipas da elite.`,
    };
  }
  const edge = modelChoice.expectedPointsNext - eliteChoice.expectedPointsNext;
  if (edge > margin) {
    return {
      ...base,
      captain: modelChoice,
      eliteChoice,
      eliteCapPct,
      source: "modelo",
      reason: `${modelChoice.element.web_name} em vez de ${eliteChoice.element.web_name} (capitão da elite): o modelo prevê +${edge.toFixed(1)} pts, acima da margem de ${margin.toFixed(1)} que o seu erro medido exige.`,
    };
  }
  return {
    ...base,
    captain: eliteChoice,
    eliteChoice,
    eliteCapPct,
    source: "elite",
    reason: `${eliteChoice.element.web_name}, o capitão de ${eliteCapPct}% da elite. O modelo preferia ${modelChoice.element.web_name} por ${edge.toFixed(1)} pts, menos do que a margem de ${margin.toFixed(1)} a partir da qual a previsão dele vale mais do que o consenso.`,
  };
}
