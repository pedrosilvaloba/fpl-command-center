import type { RatePrior } from "./rateprior";

/**
 * A ÉPOCA PASSADA COMO PONTO DE PARTIDA.
 *
 * Até aqui as taxas de cada jogador (golos, assistências, bónus, ações
 * defensivas, defesas por 90 minutos) vinham SÓ desta época e eram
 * encolhidas em direção a ZERO enquanto a amostra é pequena. À jornada 7
 * isso cortava 30% ao xG e 46% ao bónus de toda a gente. O backtest mostrou
 * o resultado: quem o modelo dava para 0-2 pontos fazia 2,5, e quem dava
 * para 8+ fazia 4,3.
 *
 * O melhor ponto de partida para o que um jogador vai fazer é o que ele fez
 * numa época inteira. A FPL publica-o em `element-summary/{id}` →
 * `history_past`, uma linha por época. Este módulo reduz essa linha às
 * mesmas taxas por 90 minutos que o modelo usa, para servir de prior.
 *
 * Só conta uma época com minutos suficientes (`MIN_MINUTES`): um jogador
 * que fez 200 minutos o ano passado não tem uma taxa, tem um acaso.
 */

export interface LastSeasonRates extends RatePrior {
  /** Minutos jogados nessa época — mede quanto pesar o prior. */
  minutes: number;
  season: string;
}

export type LastSeasonTable = Map<number, LastSeasonRates>;

export const MIN_MINUTES = 900;

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Peso do realizado face ao esperado nas taxas de golo e assistência —
 * igual ao `underlyingBlend` por omissão do modelo, para o prior falar a
 * mesma língua que as taxas que vai ancorar. */
const UNDERLYING_SHARE = 0.65;

/**
 * Reduz as linhas `history_past` de um jogador às taxas da época mais
 * recente com minutos suficientes. Devolve null quando não há nenhuma.
 */
export function ratesFromHistoryPast(
  rows: unknown[],
  elementType: number
): LastSeasonRates | null {
  const seasons = (rows ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => num(r.minutes) >= MIN_MINUTES)
    .sort((a, b) => String(b.season_name ?? "").localeCompare(String(a.season_name ?? "")));
  const r = seasons[0];
  if (!r) return null;
  const minutes = num(r.minutes);
  const per90 = (v: unknown) => (num(v) / minutes) * 90;
  const blend = (expected: unknown, actual: unknown) => {
    const e = per90(expected);
    const a = per90(actual);
    return e > 0 ? e * UNDERLYING_SHARE + a * (1 - UNDERLYING_SHARE) : a;
  };
  // A contribuição defensiva só existe a partir de 2025/26. Antes disso
  // reconstrói-se das componentes que a FPL publica; sem nenhuma, fica 0.
  const dcDirect = num(r.defensive_contribution);
  const cbi = num(r.clearances_blocks_interceptions);
  const tackles = num(r.tackles);
  const recoveries = num(r.recoveries);
  const dcBuilt = cbi + tackles + (elementType >= 3 ? recoveries : 0);
  const dcTotal = dcDirect > 0 ? dcDirect : dcBuilt;
  return {
    xg90: blend(r.expected_goals, r.goals_scored),
    xa90: blend(r.expected_assists, r.assists),
    bonus90: per90(r.bonus),
    dc90: dcTotal > 0 ? (dcTotal / minutes) * 90 : 0,
    saves90: per90(r.saves),
    minutes,
    season: String(r.season_name ?? ""),
  };
}

/** Forma serializável, para guardar no Redis. */
export type LastSeasonRecord = Record<string, LastSeasonRates>;

export function tableFromRecord(rec: unknown): LastSeasonTable {
  const out: LastSeasonTable = new Map();
  if (!rec || typeof rec !== "object") return out;
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    const id = Number(k);
    const r = v as Partial<LastSeasonRates> | null;
    if (!Number.isInteger(id) || !r || typeof r !== "object") continue;
    if (!(num(r.minutes) >= MIN_MINUTES)) continue;
    out.set(id, {
      xg90: num(r.xg90),
      xa90: num(r.xa90),
      bonus90: num(r.bonus90),
      dc90: num(r.dc90),
      saves90: num(r.saves90),
      minutes: num(r.minutes),
      season: String(r.season ?? ""),
    });
  }
  return out;
}

export function recordFromTable(t: LastSeasonTable): LastSeasonRecord {
  const out: LastSeasonRecord = {};
  for (const [id, r] of t) out[String(id)] = r;
  return out;
}

export const LAST_SEASON_KEY = "priors:lastseason:v1";
