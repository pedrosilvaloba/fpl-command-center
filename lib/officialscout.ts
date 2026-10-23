import { getBootstrap } from "./fpl-client";
import { getRedis } from "./kv";
import type { FplBootstrap } from "./types";

/** Deterministic official-FPL fact collection. Not external expert research,
 * and NEVER applied as an unvalidated player-scoring multiplier. */
export const SCOUT_KEY = "fpl-command-center:official-scout:v1";
const MAX_ITEMS = 24;
export interface ScoutFact {
  playerId: number;
  name: string;
  club: string;
  category: "availability" | "minutes" | "market";
  detail: string;
  officialUrl: string;
}
export interface ScoutReport {
  at: string;
  event: number;
  source: "official-fpl";
  items: ScoutFact[];
  checkedPlayers: number;
  /** Never pretend the separate qualitative Claude researcher ran. */
  analystResearchCompleted: false;
}
function number(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
export function buildScoutReport(data: FplBootstrap, at = new Date().toISOString()): ScoutReport {
  const event = data.events.find(e => e.is_next)?.id ??
    data.events.find(e => e.is_current)?.id ?? 1;
  const teams = new Map(data.teams.map(t => [t.id, t.short_name]));
  const ranked: { weight: number; item: ScoutFact }[] = [];
  for (const e of data.elements) {
    const club = teams.get(e.team) ?? "?";
    const base = {
      playerId: e.id, name: e.web_name, club,
      officialUrl: `https://fantasy.premierleague.com/statistics?element=${e.id}`,
    };
    const ownership = number(e.selected_by_percent);
    const chance = e.chance_of_playing_next_round;
    if ((e.status !== "a" || (chance !== null && chance < 100)) && (ownership >= 1 || number(e.minutes) >= 90)) {
      ranked.push({
        weight: 100 + ownership,
        item: {
          ...base, category: "availability",
          detail: `FPL assinala estado ${e.status}, possibilidade de jogar ${chance ?? "não publicada"}%. ${(e.news ?? "").slice(0,130)}`.trim(),
        },
      });
    }
    // Minutes signal is DESCRIPTIVE, not a claim about a new tactical role.
    if (number(e.minutes) > 0 && number(e.starts) > 0 && ownership >= 5 &&
      number(e.minutes) / number(e.starts) < 68) {
      ranked.push({
        weight: 20 + ownership / 3,
        item: {
          ...base, category: "minutes",
          detail: `Média de ${Math.round(number(e.minutes) / number(e.starts))} minutos por titularidade na época; não prova minutos da próxima jornada.`,
        },
      });
    }
    if (ownership >= 3 && Math.abs(number(e.transfers_in_event) - number(e.transfers_out_event)) >= 50000) {
      const net = number(e.transfers_in_event) - number(e.transfers_out_event);
      ranked.push({
        weight: Math.min(45, Math.abs(net) / 10000),
        item: {
          ...base, category: "market",
          detail: `Saldo de transferências na jornada: ${net > 0 ? "+" : ""}${net.toLocaleString("en-GB")}. Popularidade não implica qualidade.`,
        },
      });
    }
  }
  ranked.sort((a,b) => b.weight - a.weight || a.item.playerId - b.item.playerId);
  return {
    at, event, source: "official-fpl", checkedPlayers: data.elements.length,
    analystResearchCompleted: false,
    items: ranked.slice(0, MAX_ITEMS).map(x => x.item),
  };
}
export type ScoutJobOutcome =
  | { ok: true; productive: boolean; summary: string; detail: Record<string, unknown> }
  | { ok: false; retryable: boolean; error: string; productive: false; summary: string; detail: Record<string, unknown> };
export async function runOfficialScout(): Promise<ScoutJobOutcome> {
  const redis = getRedis();
  if (!redis) return { ok: false, retryable: false, productive: false, error: "Redis não configurado", summary: "Sem armazenamento", detail: {} };
  try {
    const bootstrap = await getBootstrap();
    const report = buildScoutReport(bootstrap);
    if (!report.checkedPlayers) return { ok: false, retryable: true, productive: false, error: "API FPL sem jogadores", summary: "API FPL devolveu zero jogadores", detail: {} };
    await redis.set(SCOUT_KEY, report);
    return {
      ok: true, productive: true,
      summary: `Fontes oficiais verificadas: ${report.checkedPlayers} jogadores; ${report.items.length} sinais da GW${report.event}`,
      detail: { checkedPlayers: report.checkedPlayers, findings: report.items.length, event: report.event },
    };
  } catch (error) {
    return { ok: false, retryable: true, productive: false, summary: "Falha a recolher dados oficiais", error: String(error), detail: {} };
  }
}
export async function readOfficialScout(): Promise<ScoutReport | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get<ScoutReport>(SCOUT_KEY);
    if (!data || data.source !== "official-fpl" || !Array.isArray(data.items)) return null;
    return data;
  } catch { return null; }
}
