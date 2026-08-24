import type {
  FplBootstrap,
  FplFixture,
  FplEntry,
  FplEntryHistoryEntry,
  FplLeagueStandings,
} from "./types";

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

const DEFAULT_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (compatible; FPL-Command-Center/0.1; personal fantasy manager tool)",
  Accept: "application/json",
};

async function fplFetch<T>(path: string, revalidateSeconds: number): Promise<T> {
  const res = await fetch(`${FPL_BASE}${path}`, {
    headers: DEFAULT_HEADERS,
    next: { revalidate: revalidateSeconds },
  });
  if (!res.ok) {
    throw new Error(`FPL API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Master data dump: all players, teams, gameweeks, positions. Changes
 * slowly outside matchdays, so cache for 5 minutes. */
export function getBootstrap() {
  return fplFetch<FplBootstrap>("/bootstrap-static/", 300);
}

/** All fixtures, optionally filtered. Cache for 5 minutes. */
export async function getFixtures(opts?: { event?: number; future?: boolean }) {
  const params = new URLSearchParams();
  if (opts?.event) params.set("event", String(opts.event));
  if (opts?.future) params.set("future", "1");
  const qs = params.toString() ? `?${params.toString()}` : "";
  return fplFetch<FplFixture[]>(`/fixtures/${qs}`, 300);
}

/** A manager's public profile. */
export function getEntry(teamId: number) {
  return fplFetch<FplEntry>(`/entry/${teamId}/`, 120);
}

/** A manager's season history (per-GW points/rank/bank/value + chips used). */
export function getEntryHistory(teamId: number) {
  return fplFetch<{
    current: FplEntryHistoryEntry[];
    past: unknown[];
    chips: { name: string; event: number }[];
  }>(`/entry/${teamId}/history/`, 120);
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
  }>(`/entry/${teamId}/event/${gw}/picks/`, 120);
}

/** Public classic-league standings (private league standings need an
 * authenticated session — not implemented in the read-only proxy layer). */
export function getLeagueStandings(leagueId: number, page = 1) {
  return fplFetch<FplLeagueStandings>(
    `/leagues-classic/${leagueId}/standings/?page_standings=${page}`,
    180
  );
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
