import { getEntryHistory } from "./fpl-client";
import { selectRivals } from "./rivals";
import { FIRST_SET_LAST_EVENT } from "./chipoption";
import type { FplLeagueStandingsEntry } from "./types";

/**
 * O QUE A LIGA ESTÁ A FAZER COM OS CHIPS.
 *
 * ═══ PORQUE É QUE ISTO EXISTE ═══
 *
 * O Pedro reparou, sozinho, que vários rivais tinham gasto chips — incluindo
 * um Triple Captain — numa jornada em que o modelo não tinha opinião
 * nenhuma sobre chips. A observação estava certa e o modelo era CEGO: a API
 * do FPL publica, para cada gestor, exatamente que chips usou e em que
 * jornada, e nada nesta app alguma vez foi ler esse campo. A camada dos
 * rivais já ia buscar os onzes deles; passava ao lado da única coisa que o
 * Pedro tinha notado.
 *
 * Foi confirmado com dados reais da liga "Haal of Fame": dos seis
 * primeiros, quatro já gastaram pelo menos um chip. O 1.º e o 3.º jogaram
 * Bench Boost logo na GW1. O 4.º jogou Triple Captain na GW3.
 *
 * ═══ O QUE ISTO NÃO É ═══
 *
 * NÃO é um sinal de que a multidão tem razão. Numa liga privada de 48
 * amigos, o consenso não é a sabedoria do mercado — é o que os amigos do
 * Pedro decidiram. Tratar isso como informação sobre o jogo seria vestir
 * prova social de análise, que é precisamente o erro que uma app destas
 * deve evitar.
 *
 * ═══ ENTÃO PORQUE É QUE MEXE NA DECISÃO ═══
 *
 * Por uma razão relativa, não informativa. Numa liga, o que conta é a
 * posição, e o maior erro possível com um chip não é jogá-lo cedo demais —
 * é chegar à GW19 com ele por usar. Um chip que expira vale zero.
 *
 * O custo desse desperdício depende inteiramente do que os outros fizeram:
 *
 *   · Se a liga inteira também deixar os chips expirar, desperdiçar não
 *     custa posição nenhuma. Toda a gente perde o mesmo.
 *   · Se a liga estiver a gastá-los, cada chip que o Pedro deixa morrer é
 *     uma perda LÍQUIDA de posição, contra pessoas que já cobraram os seus.
 *
 * Portanto a pressão da liga não diz "joga porque eles jogaram". Diz
 * "guardar custa mais do que custaria se eles também estivessem a guardar".
 * É um ajuste pequeno e limitado, e é um PRIOR declarado — não uma medição.
 */

/** Nomes dos chips como a API do FPL os devolve. */
export type RivalChipName = "wildcard" | "bboost" | "3xc" | "freehit";

export interface RivalChipUse {
  name: string;
  event: number;
}

export interface RivalChipRecord {
  entry: number;
  entryName: string;
  playerName: string;
  rank: number;
  isMe: boolean;
  chips: RivalChipUse[];
}

export interface ChipUsageSummary {
  chip: RivalChipName;
  label: string;
  /** Quantos rivais amostrados já gastaram este chip do PRIMEIRO conjunto. */
  used: number;
  /** Sobre quantos rivais amostrados. */
  of: number;
  /** Fração — 0 a 1. É isto que alimenta o ajuste. */
  share: number;
  /** A jornada mais cedo em que alguém o usou, se houver. */
  firstEvent: number | null;
  /** Nomes de quem o usou, os primeiros da tabela. */
  who: { name: string; rank: number; event: number }[];
  /** O próprio Pedro já o gastou? */
  mineUsed: boolean;
}

export interface LeagueChipState {
  available: boolean;
  reason: string | null;
  sampled: number;
  records: RivalChipRecord[];
  summaries: ChipUsageSummary[];
  myRank: number | null;
  fieldSize: number;
}

const CHIP_LABELS: Record<RivalChipName, string> = {
  wildcard: "Wildcard",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
  freehit: "Free Hit",
};

const CHIP_ORDER: RivalChipName[] = ["wildcard", "bboost", "3xc", "freehit"];

/** Quantos rivais ler. Cada um é um pedido à API do FPL; ler a liga toda
 * seria dezenas de pedidos por render, contra uma API gratuita e sem
 * garantias. A amostra é escolhida por `selectRivals`, que já inclui os da
 * frente e os vizinhos imediatos — as pessoas que uma jornada pode
 * ultrapassar. */
const CHIP_SAMPLE = 24;
const FETCH_CONCURRENCY = 6;

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Lê os chips gastos por uma amostra da liga.
 *
 * Um gestor inacessível não pode derrubar a camada — devolve null e é
 * contado como não-amostrado, em vez de ser contado como "não gastou
 * nada", que enviesaria a pressão para baixo em silêncio.
 */
export async function fetchLeagueChipState(
  standings: FplLeagueStandingsEntry[],
  myEntryId: number
): Promise<LeagueChipState> {
  const empty: LeagueChipState = {
    available: false,
    reason: null,
    sampled: 0,
    records: [],
    summaries: [],
    myRank: null,
    fieldSize: standings.length,
  };
  if (standings.length === 0) {
    return { ...empty, reason: "A classificação da liga ainda não está disponível." };
  }

  const targets = selectRivals(standings, myEntryId, CHIP_SAMPLE);
  const fetched = await mapWithLimit(
    targets,
    FETCH_CONCURRENCY,
    async (entry): Promise<RivalChipRecord | null> => {
      try {
        const history = await getEntryHistory(entry.entry);
        const chips = Array.isArray(history.chips) ? history.chips : [];
        return {
          entry: entry.entry,
          entryName: entry.entry_name,
          playerName: entry.player_name,
          rank: entry.rank,
          isMe: entry.entry === myEntryId,
          chips: chips
            .filter(
              (c) =>
                c &&
                typeof c.name === "string" &&
                Number.isFinite(Number(c.event))
            )
            .map((c) => ({ name: c.name, event: Number(c.event) })),
        };
      } catch {
        return null;
      }
    }
  );

  const records = fetched.filter((r): r is RivalChipRecord => r !== null);
  if (records.length === 0) {
    return {
      ...empty,
      reason: "Não foi possível ler o histórico de nenhum rival.",
    };
  }

  const me = records.find((r) => r.isMe) ?? null;
  const others = records.filter((r) => !r.isMe);

  const summaries: ChipUsageSummary[] = CHIP_ORDER.map((chip) => {
    // Só conta o PRIMEIRO conjunto. Um chip gasto na GW25 não diz nada
    // sobre a pressão de prazo que existe hoje, antes da GW19.
    const usedBy = others
      .map((r) => {
        const use = r.chips.find(
          (c) => c.name === chip && c.event <= FIRST_SET_LAST_EVENT
        );
        return use ? { name: r.entryName, rank: r.rank, event: use.event } : null;
      })
      .filter((x): x is { name: string; rank: number; event: number } => x !== null)
      .sort((a, b) => a.rank - b.rank);

    const of = others.length;
    return {
      chip,
      label: CHIP_LABELS[chip],
      used: usedBy.length,
      of,
      share: of > 0 ? usedBy.length / of : 0,
      firstEvent:
        usedBy.length > 0 ? Math.min(...usedBy.map((u) => u.event)) : null,
      who: usedBy,
      mineUsed:
        me !== null &&
        me.chips.some((c) => c.name === chip && c.event <= FIRST_SET_LAST_EVENT),
    };
  });

  return {
    available: true,
    reason: null,
    sampled: records.length,
    records: records.sort((a, b) => a.rank - b.rank),
    summaries,
    myRank: me?.rank ?? null,
    fieldSize: standings.length,
  };
}

/**
 * Quanto é que a pressão da liga desconta o valor de guardar um chip.
 *
 * LIMITADO DE PROPÓSITO A 25%. Se metade da liga já gastou o Triple
 * Captain, guardar vale 12,5% menos — o suficiente para desempatar uma
 * decisão apertada, longe do suficiente para mandar queimar um chip só
 * porque os outros queimaram os deles. Um ajuste que pudesse dominar a
 * decisão transformaria o modelo num seguidor de multidões, que é
 * exatamente o que ele não deve ser.
 *
 * É um PRIOR declarado. Não há forma de o medir sem épocas de dados sobre
 * esta liga em concreto, e inventar uma medição seria pior do que assumir
 * o palpite.
 */
export const LEAGUE_PRESSURE_MAX_DISCOUNT = 0.25;

export function leaguePressureDiscount(share: number): number {
  const s = Math.min(1, Math.max(0, share));
  return 1 - LEAGUE_PRESSURE_MAX_DISCOUNT * s;
}

/** Uma frase para o ecrã, porque um ajuste invisível é um ajuste em que
 * ninguém pode discordar. */
export function pressureNote(s: ChipUsageSummary): string {
  if (s.of === 0) return "";
  if (s.used === 0) {
    return `Nenhum dos ${s.of} rivais lidos gastou o ${s.label} — guardar é o que toda a gente está a fazer.`;
  }
  const leaders = s.who.slice(0, 3).map((w) => `${w.name} (${w.rank}.º, GW${w.event})`);
  return (
    `${s.used} de ${s.of} rivais lidos já gastaram o ${s.label}` +
    (s.firstEvent !== null ? `, o primeiro na GW${s.firstEvent}` : "") +
    `: ${leaders.join(", ")}${s.who.length > 3 ? ", e outros" : ""}. ` +
    "Isto não é prova de que tenham razão — numa liga de amigos o consenso não é sabedoria de mercado. " +
    "Conta porque cada chip que deixares expirar é uma perda de posição contra quem já cobrou o seu."
  );
}

/** Estado neutro: sem dados, e explicitamente marcado como tal para que
 * ninguém o confunda com "a liga não gastou nada". */
export const EMPTY_LEAGUE_CHIP_STATE: LeagueChipState = {
  available: false,
  reason: null,
  sampled: 0,
  records: [],
  summaries: [],
  myRank: null,
  fieldSize: 0,
};
