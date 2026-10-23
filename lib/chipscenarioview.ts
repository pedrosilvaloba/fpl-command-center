import type { ChipKey, ChipScenario, MoveKind } from "./transferplan";
import type { ScoredPlayer } from "./recommend";

/**
 * O que o painel de cenários precisa, e nada mais.
 *
 * O painel é um componente de cliente: tudo o que lhe for passado é
 * serializado para o browser. Um `ScoredPlayer` arrasta o elemento completo
 * da FPL, a equipa, as razões e as séries por jornada — passar quatro
 * planos de quinze jogadores assim seria enviar centenas de KB por visita
 * para mostrar meia dúzia de nomes. Isto reduz cada plano ao que se vê.
 */

export interface ScenarioPlayerView {
  id: number;
  name: string;
  team: string;
  pos: string;
  price: number;
  next: number;
  window: number;
  /** Pontos reais desta época e por jogo — o que o gestor usa para julgar
   * se uma troca faz sentido, e que o modelo não mostrava. */
  seasonPts: number;
  ppg: number;
  /** % de posse na elite, null quando os dados da elite não estão carregados */
  elite: number | null;
}

export interface ScenarioView {
  chip: ChipKey;
  label: string;
  available: boolean;
  advised: boolean;
  verdict: string;
  gainNext: number;
  gainWindow: number | null;
  transfers: number;
  bankAfterM: number | null;
  xiNextPoints: number | null;
  captainId: number | null;
  viceCaptainId: number | null;
  moves: { out: ScenarioPlayerView; in: ScenarioPlayerView; sellM: number; kind: MoveKind }[];
  keptIds: number[];
  includedIds: number[];
  /** Ids do plantel atual, para o painel saber quem pode ser fixado. */
  ownedIds: number[];
  xi: ScenarioPlayerView[];
  bench: ScenarioPlayerView[];
  rationale: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

let eliteLookup: (id: number) => number | null = () => null;

function player(p: ScoredPlayer): ScenarioPlayerView {
  return {
    id: p.element.id,
    name: p.element.web_name,
    team: p.team.short_name,
    pos: p.positionShort,
    price: p.priceM,
    next: r1(p.expectedPointsNext),
    window: r1(p.expectedPoints),
    seasonPts: Number(p.element.total_points) || 0,
    ppg: Number(p.element.points_per_game) || 0,
    elite: eliteLookup(p.element.id),
  };
}

export function toScenarioViews(
  scenarios: ChipScenario[],
  ownedIds: number[] = [],
  eliteOwn: (id: number) => number | null = () => null
): ScenarioView[] {
  eliteLookup = eliteOwn;
  return scenarios.map((s) => {
    const plan = s.plan;
    // Bench Boost e Triple Captain jogam-se sobre o plano normal: as trocas
    // desse plano já aparecem no painel de cima e não são do chip.
    const ownsSquad = s.chip === "wildcard" || s.chip === "freehit";
    return {
      chip: s.chip,
      label: s.label,
      available: s.available,
      advised: s.advised,
      verdict: s.verdict,
      gainNext: s.gainNext,
      gainWindow: s.gainWindow,
      transfers: ownsSquad && plan ? plan.transfers : 0,
      bankAfterM: ownsSquad && plan ? plan.bankAfterM : null,
      xiNextPoints: plan ? plan.xiNextPoints : null,
      captainId: plan?.captain?.element.id ?? null,
      viceCaptainId: plan?.viceCaptain?.element.id ?? null,
      moves:
        ownsSquad && plan
          ? plan.moves.map((m, i) => ({
              out: player(m.out),
              in: player(m.in),
              sellM: m.outSellingPriceM,
              kind: s.moveKinds[i] ?? "indiferente",
            }))
          : [],
      keptIds: s.keptIds,
      includedIds: s.includedIds,
      ownedIds,
      xi: plan ? plan.xi.map(player) : [],
      bench: plan ? plan.bench.map(player) : [],
      rationale: plan && ownsSquad ? plan.rationale : "",
    };
  });
}

/**
 * Lê uma pergunta escrita à mão e devolve o chip de que fala.
 *
 * Não é um modelo de linguagem, e de propósito: as perguntas possíveis são
 * quatro, a resposta tem de ser imediata e não pode custar nada nem falhar
 * por falta de rede. "gostava de usar wildcard esta semana", "e se fizer
 * free hit?", "vale a pena o bench boost", "triplo capitão no Haaland" —
 * todas caem no sítio certo com palavras-chave. Devolve null quando não
 * reconhece nada, e o painel diz isso em vez de adivinhar.
 */
export function parseChipQuestion(text: string): ChipKey | null {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (/\bwild\s*-?\s*card\b|\bwc\b|\bwildcard\b|reconstru|plantel novo|refazer (a |o )?(equipa|plantel)/.test(t))
    return "wildcard";
  if (/\bfree\s*-?\s*hit\b|\bfh\b|\bfreehit\b|so (para|por) (esta|uma) (semana|jornada)/.test(t))
    return "freehit";
  if (/\bbench\s*-?\s*boost\b|\bbb\b|\bbboost\b|banco a (jogar|pontuar)/.test(t)) return "bboost";
  if (/\btriple\b|\btriplo\b|\btripla\b|\btc\b|\b3xc\b|capitao triplo|bracadeira tripla/.test(t))
    return "3xc";
  return null;
}

/** Lê `?manter=1,2,3` do URL. Ignora o que não for um id inteiro positivo. */
export function parseKeepParam(raw: string | string[] | undefined): number[] {
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return [
    ...new Set(
      text
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ].slice(0, 15);
}

/** Um jogador que se pode pedir para "incluir": o mínimo para o escolher. */
export interface IncludeCandidate {
  id: number;
  name: string;
  team: string;
  pos: string;
  price: number;
  /** % de posse na elite, quando conhecida */
  elite: number | null;
}

/** Os candidatos a "incluir": os melhores por posição e todos os que a
 * elite tem a 20% ou mais, sem os que já estão no plantel. Cortado para o
 * painel não arrastar a base de dados inteira para o browser. */
export function includeCandidates(
  scored: ScoredPlayer[],
  ownedIds: Set<number>,
  eliteOwn: (id: number) => number | null,
  perPosition = 25
): IncludeCandidate[] {
  const out = new Map<number, IncludeCandidate>();
  const mk = (p: ScoredPlayer): IncludeCandidate => ({
    id: p.element.id,
    name: p.element.web_name,
    team: p.team.short_name,
    pos: p.positionShort,
    price: p.priceM,
    elite: eliteOwn(p.element.id),
  });
  for (const t of [1, 2, 3, 4]) {
    scored
      .filter((p) => p.element.element_type === t && !ownedIds.has(p.element.id))
      .sort((a, b) => b.expectedPoints - a.expectedPoints)
      .slice(0, perPosition)
      .forEach((p) => out.set(p.element.id, mk(p)));
  }
  for (const p of scored) {
    const e = eliteOwn(p.element.id);
    if (e !== null && e >= 20 && !ownedIds.has(p.element.id)) out.set(p.element.id, mk(p));
  }
  return [...out.values()].sort((a, b) => (b.elite ?? 0) - (a.elite ?? 0) || a.name.localeCompare(b.name));
}

const CHIP_KEYS: ChipKey[] = ["wildcard", "freehit", "bboost", "3xc"];
export function parseChipParam(raw: string | string[] | undefined): ChipKey | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return CHIP_KEYS.includes(v as ChipKey) ? (v as ChipKey) : null;
}
