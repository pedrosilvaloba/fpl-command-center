import { DEFAULT_TEAM_ID } from "./constants";

/** One authoritative team ID for every server-side decision. Browser-saved
 * preferences must navigate to ?team= rather than updating only a widget. */
export function parseTeamId(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const fallback = Number(DEFAULT_TEAM_ID);
  if (!s || !/^[1-9]\d{0,8}$/.test(s)) return fallback;
  const id = Number(s);
  return Number.isSafeInteger(id) && id > 0 ? id : fallback;
}

export type AppView = "hoje" | "simular" | "analisar" | "sistema";
export function parseAppView(raw: string | string[] | undefined): AppView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "simular" || value === "analisar" || value === "sistema" ? value : "hoje";
}

export function viewHref(teamId: number, view: AppView, extras: Record<string, string> = {}): string {
  const p = new URLSearchParams({ team: String(teamId), view, ...extras });
  return "/?" + p.toString();
}
