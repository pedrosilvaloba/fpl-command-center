import type { FplBootstrap, FplElement, FplTeam } from "./types";

export interface PriceRiskEntry {
  element: FplElement;
  team: FplTeam;
  priceM: number;
  ownershipPct: number;
  netTransfers: number;
  ownersEstimate: number;
  momentum: number; // net transfers as a share of estimated current owners
}

/**
 * Estimates which players are close to a price change tonight. FPL's real
 * threshold is undocumented and this is a simplified version of the
 * heuristic community trackers (LiveFPL, FPL Statistics) use: today's net
 * transfers (in − out) relative to how many managers already own the
 * player. A cheap, low-owned player needs far fewer net transfers to move
 * its price than a template player owned by half the game — dividing by
 * estimated owners corrects for that. This is an ESTIMATE for planning,
 * not a guarantee — treat a top riser/faller as "worth deciding on today",
 * not as a certainty.
 */
export function buildPriceWatch(
  bootstrap: FplBootstrap,
  limit = 8
): { risers: PriceRiskEntry[]; fallers: PriceRiskEntry[] } {
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const totalPlayers = bootstrap.total_players || 1;

  const entries: PriceRiskEntry[] = [];
  for (const el of bootstrap.elements) {
    const team = teamById.get(el.team);
    if (!team) continue;
    const ownershipPct = parseFloat(el.selected_by_percent) || 0;
    const ownersEstimate = Math.max(1, Math.round((ownershipPct / 100) * totalPlayers));
    const netTransfers = (el.transfers_in_event ?? 0) - (el.transfers_out_event ?? 0);
    if (netTransfers === 0) continue;

    entries.push({
      element: el,
      team,
      priceM: el.now_cost / 10,
      ownershipPct,
      netTransfers,
      ownersEstimate,
      momentum: netTransfers / ownersEstimate,
    });
  }

  const risers = entries
    .filter((e) => e.netTransfers > 0)
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, limit);
  const fallers = entries
    .filter((e) => e.netTransfers < 0)
    .sort((a, b) => a.momentum - b.momentum)
    .slice(0, limit);

  return { risers, fallers };
}

export interface NewsEntry {
  element: FplElement;
  team: FplTeam;
  priceM: number;
  ownershipPct: number;
  chanceOfPlaying: number | null;
  news: string;
  isRecent: boolean;
}

/**
 * Surfaces every player with an active injury/rotation/suspension note,
 * ranked by ownership so the notes most likely to affect *your* squad or
 * transfer targets come first. `isRecent` flags news added in the last 48h
 * (freshly changed status), since that's usually the one worth acting on
 * before the deadline rather than old news everyone has already priced in.
 */
export function buildNewsWatch(bootstrap: FplBootstrap, limit = 15): NewsEntry[] {
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const now = new Date();

  return bootstrap.elements
    .filter((el) => el.news && el.news.trim().length > 0)
    .map((el) => {
      const team = teamById.get(el.team);
      if (!team) return null;
      const newsAdded = el.news_added ? new Date(el.news_added) : null;
      const isRecent =
        !!newsAdded && now.getTime() - newsAdded.getTime() < 48 * 60 * 60 * 1000;
      const entry: NewsEntry = {
        element: el,
        team,
        priceM: el.now_cost / 10,
        ownershipPct: parseFloat(el.selected_by_percent) || 0,
        chanceOfPlaying: el.chance_of_playing_next_round,
        news: el.news,
        isRecent,
      };
      return entry;
    })
    .filter((e): e is NewsEntry => e !== null)
    .sort((a, b) => b.ownershipPct - a.ownershipPct)
    .slice(0, limit);
}
