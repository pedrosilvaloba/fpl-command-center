import type { ChipKey, ChipScenario } from "./transferplan";
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
  moves: { out: ScenarioPlayerView; in: ScenarioPlayerView; sellM: number }[];
  xi: ScenarioPlayerView[];
  bench: ScenarioPlayerView[];
  rationale: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function player(p: ScoredPlayer): ScenarioPlayerView {
  return {
    id: p.element.id,
    name: p.element.web_name,
    team: p.team.short_name,
    pos: p.positionShort,
    price: p.priceM,
    next: r1(p.expectedPointsNext),
    window: r1(p.expectedPoints),
  };
}

export function toScenarioViews(scenarios: ChipScenario[]): ScenarioView[] {
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
          ? plan.moves.map((m) => ({ out: player(m.out), in: player(m.in), sellM: m.outSellingPriceM }))
          : [],
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
