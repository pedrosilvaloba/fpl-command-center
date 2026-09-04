import type {
  FplBootstrap,
  FplLeagueStandingsEntry,
  FplFixture,
  FplEntry,
  FplEntryHistoryEntry,
  FplLeagueStandings,
} from "./types";
import { loadSnapshot, saveSnapshot } from "./snapshotcache";

// The official Fantasy Premier League API. It is public, unauthenticated
// for reads, and completely unofficial/undocumented — the Premier League
// has never published a spec and can change field names without notice.
// Everything here calls it server-side (Vercel functions have normal
// outbound internet access), which sidesteps two real limitations:
//   1. The FPL API sends no CORS headers, so a browser calling it directly
//      is blocked — a server-side proxy is required.
//   2. Large payloads (bootstrap-static is several MB, ~700 players) are
//      too big to summarize reliably through any text-in/text-out model —
//      they need to be parsed as JSON by real code, not "read" by an LLM.
const FPL_BASE = "https://fantasy.premierleague.com/api";

/**
 * O User-Agent anterior identificava-se como ferramenta:
 *
 *   "Mozilla/5.0 (compatible; FPL-Command-Center/0.1; personal fantasy
 *    manager tool)"
 *
 * A API do FPL está atrás de um filtro que classifica pedidos, e um
 * User-Agent que anuncia ser uma ferramenta automatizada, vindo de um IP
 * de datacenter da Vercel, é precisamente o padrão que esse filtro
 * bloqueia. A 4 de setembro devolveu 403 e a app foi abaixo.
 *
 * Isto não é contornar proteção nenhuma: os dados são públicos, sem
 * autenticação, e o volume é o de um único adepto a ver a sua equipa. É
 * apenas parar de disparar um sinalizador desnecessário — a honestidade
 * sobre a origem do pedido está no `From`, que aponta para o projeto.
 */
const DEFAULT_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-GB,en;q=0.9",
  Referer: "https://fantasy.premierleague.com/",
};

/** Estados que valem a pena repetir: nenhum deles significa "este pedido
 * está errado", todos significam "agora não". Um 404 não está aqui de
 * propósito — repeti-lo três vezes só atrasa a mesma resposta. */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
/** Espera antes da 2.ª e da 3.ª tentativa. No pior caso acrescenta ~1s a
 * um pedido, contra um `maxDuration` de 60s. */
const BACKOFF_MS = [250, 750];

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ESTADO DE SAÚDE DOS DADOS — porque servir dados antigos em silêncio é
 * pior do que não servir nada.
 *
 * Isto é estado de módulo, e estado de módulo entre pedidos costuma ser
 * um erro. Aqui não é, porque o que se guarda é MONOTÓNICO e não
 * específico de um pedido: "a que horas é que este caminho respondeu bem
 * pela última vez" e "estamos neste momento a servir um snapshot". Um
 * pedido bem-sucedido limpa a marca para todos; um falhado põe-na para
 * todos. Não há informação de um visitante a vazar para outro — só há um
 * visitante, e o facto descrito é sobre a API, não sobre ele.
 */
interface PathHealth {
  /** Hora do snapshot que está a ser servido, ou null se os dados são frescos. */
  servingSnapshotFrom: number | null;
  /** Última vez que a API respondeu bem a este caminho. */
  lastLiveOk: number | null;
  /** Descrição do último erro, para o painel de diagnóstico. */
  lastError: string | null;
}

const health = new Map<string, PathHealth>();

function markLive(path: string) {
  health.set(path, {
    servingSnapshotFrom: null,
    lastLiveOk: Date.now(),
    lastError: null,
  });
}

function markDegraded(path: string, snapshotAt: number | null, error: string) {
  const prev = health.get(path);
  health.set(path, {
    servingSnapshotFrom: snapshotAt,
    lastLiveOk: prev?.lastLiveOk ?? null,
    lastError: error,
  });
}

export interface FplDataHealth {
  /** Verdadeiro quando algum caminho está a ser servido a partir de snapshot. */
  degraded: boolean;
  /** O snapshot mais antigo em uso, em milissegundos epoch. */
  oldestSnapshotAt: number | null;
  /** Caminhos afetados, para o painel Sistema. */
  paths: { path: string; snapshotAt: number | null; error: string }[];
}

export function getFplDataHealth(): FplDataHealth {
  const paths: FplDataHealth["paths"] = [];
  let oldest: number | null = null;
  for (const [path, h] of health) {
    if (h.servingSnapshotFrom === null && h.lastError === null) continue;
    paths.push({
      path,
      snapshotAt: h.servingSnapshotFrom,
      error: h.lastError ?? "",
    });
    if (
      h.servingSnapshotFrom !== null &&
      (oldest === null || h.servingSnapshotFrom < oldest)
    ) {
      oldest = h.servingSnapshotFrom;
    }
  }
  return {
    degraded: paths.some((p) => p.snapshotAt !== null),
    oldestSnapshotAt: oldest,
    paths,
  };
}

/** Só para os testes: repor o estado entre cenários. */
export function resetFplDataHealth() {
  health.clear();
}

/** Um caminho vira um nome de chave estável e sem caracteres problemáticos. */
function snapshotName(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function fplFetch<T>(
  path: string,
  revalidateSeconds: number,
  opts?: {
    /** Guardar e reutilizar uma cópia deste caminho quando a API falhar.
     * Ligado só nos caminhos sem os quais não há página. */
    resilient?: boolean;
  }
): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${FPL_BASE}${path}`, {
        headers: DEFAULT_HEADERS,
        next: { revalidate: revalidateSeconds },
      });
      if (res.ok) {
        const data = (await res.json()) as T;
        markLive(path);
        if (opts?.resilient) {
          // ESPERAR AQUI É DE PROPÓSITO, e a tentação era não esperar.
          //
          // Numa função serverless o processo pode ser congelado assim
          // que a resposta sai. Uma escrita disparada e não esperada não
          // é "escrita em segundo plano" — é uma escrita que às vezes
          // simplesmente não acontece, sem erro nenhum. A cópia de
          // segurança estaria vazia precisamente no dia em que fizesse
          // falta, e nada o teria dito.
          //
          // O custo é uma ida ao Redis por caminho e por render (~20ms),
          // e só de 6 em 6 horas é que isso passa a ser uma escrita a
          // sério. Numa página que já faz um Monte Carlo e um solver
          // inteiro, não se nota. `saveSnapshot` nunca lança.
          await saveSnapshot(snapshotName(path), data);
        }
        return data;
      }
      lastError = `${res.status} ${res.statusText}`;
      if (!RETRYABLE_STATUS.has(res.status)) break;
    } catch (err) {
      // Falha de rede/DNS/TLS. Vale sempre a pena repetir.
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(BACKOFF_MS[attempt]);
  }

  if (opts?.resilient) {
    const snap = await loadSnapshot<T>(snapshotName(path));
    if (snap) {
      markDegraded(path, snap.at, lastError);
      return snap.value;
    }
  }
  markDegraded(path, null, lastError);
  throw new Error(`FPL API ${path} failed: ${lastError}`);
}

/** Master data dump: all players, teams, gameweeks, positions. Changes
 * slowly outside matchdays, so cache for 5 minutes. */
export function getBootstrap() {
  return fplFetch<FplBootstrap>("/bootstrap-static/", 300, {
    resilient: true,
  });
}

/** All fixtures, optionally filtered. Cache for 5 minutes. */
export async function getFixtures(opts?: { event?: number; future?: boolean }) {
  const params = new URLSearchParams();
  if (opts?.event) params.set("event", String(opts.event));
  if (opts?.future) params.set("future", "1");
  const qs = params.toString() ? `?${params.toString()}` : "";
  return fplFetch<FplFixture[]>(`/fixtures/${qs}`, 300, { resilient: true });
}

/** A manager's public profile. */
export function getEntry(teamId: number) {
  return fplFetch<FplEntry>(`/entry/${teamId}/`, 120, { resilient: true });
}

/** A manager's season history (per-GW points/rank/bank/value + chips used). */
export function getEntryHistory(teamId: number) {
  return fplFetch<{
    current: FplEntryHistoryEntry[];
    past: unknown[];
    chips: { name: string; event: number }[];
  }>(`/entry/${teamId}/history/`, 120, { resilient: true });
}

/** A manager's picked squad for a given gameweek. */
export function getEntryPicks(teamId: number, gw: number) {
  return fplFetch<{
    picks: {
      element: number;
      position: number;
      multiplier: number;
      is_captain: boolean;
      is_vice_captain: boolean;
    }[];
    entry_history: FplEntryHistoryEntry;
  }>(`/entry/${teamId}/event/${gw}/picks/`, 120, { resilient: true });
}

/** Public classic-league standings (private league standings need an
 * authenticated session — not implemented in the read-only proxy layer). */
export function getLeagueStandings(leagueId: number, page = 1) {
  return fplFetch<FplLeagueStandings>(
    `/leagues-classic/${leagueId}/standings/?page_standings=${page}`,
    180
  );
}

/**
 * A whole classic league, following FPL's pagination to the end.
 *
 * `getLeagueStandings` returns one page of 50. Reading only the first page
 * silently truncates every league bigger than that, and the truncation is
 * invisible — the table just stops, looking like the league is smaller than
 * it is.
 *
 * Capped at `maxPages`, because a public classic league can hold millions of
 * entries. When the cap bites, `complete` is false, so a caller can tell a
 * fully-loaded league from a truncated one instead of assuming.
 */
export async function getFullLeagueStandings(
  leagueId: number,
  maxPages = 20
): Promise<{
  league: { id: number; name: string };
  results: FplLeagueStandingsEntry[];
  complete: boolean;
}> {
  const first = await getLeagueStandings(leagueId, 1);
  const results = [...first.standings.results];
  let hasNext = first.standings.has_next;
  let page = 1;
  while (hasNext && page < maxPages) {
    page += 1;
    const next = await getLeagueStandings(leagueId, page);
    results.push(...next.standings.results);
    hasNext = next.standings.has_next;
  }
  return { league: first.league, results, complete: !hasNext };
}

/** Per-player fixture list + match-by-match history + prior seasons. */
export function getElementSummary(playerId: number) {
  return fplFetch<{
    fixtures: unknown[];
    history: unknown[];
    history_past: unknown[];
  }>(`/element-summary/${playerId}/`, 300);
}

/** Live, per-player stats for a single gameweek (updates during matches). */
export function getEventLive(gw: number) {
  return fplFetch<{ elements: { id: number; stats: Record<string, number> }[] }>(
    `/event/${gw}/live/`,
    60
  );
}
