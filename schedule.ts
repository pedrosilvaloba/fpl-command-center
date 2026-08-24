import type { FplFixture, FplTeam } from "./types";

export interface ScheduleAnomaly {
  event: number;
  teamId: number;
  type: "double" | "blank";
  fixtureCount: number;
}

/**
 * Scans every team across a range of gameweeks and flags double gameweeks
 * (2+ fixtures in one event — usually from rearranged cup/European ties)
 * and blank gameweeks (0 fixtures in an event other teams do play). This
 * is arguably the single highest-leverage, least-automated decision in
 * FPL strategy: Bench Boost and Triple Captain are built around stacking
 * a squad into a double gameweek, and Free Hit exists specifically to
 * dodge a blank one. Derived entirely from the fixtures the app already
 * fetches — no new data source.
 *
 * Caveat, stated plainly: early in the season the fixture list is mostly
 * uniform (one match per team per gameweek) because reschedulings from
 * cup replays and European ties haven't happened yet — doubles/blanks
 * typically only get confirmed a few weeks out. An empty result here
 * early on is expected, not a bug; this section fills in on its own as
 * the FPL fixture list is updated through the season.
 */
export function findScheduleAnomalies(
  teams: FplTeam[],
  fixtures: FplFixture[],
  fromEvent: number,
  toEvent: number
): ScheduleAnomaly[] {
  const perTeamPerEvent = new Map<string, number>();
  const eventsWithAnyFixture = new Set<number>();

  for (const f of fixtures) {
    if (f.event === null || f.event < fromEvent || f.event > toEvent) continue;
    eventsWithAnyFixture.add(f.event);
    for (const teamId of [f.team_h, f.team_a]) {
      const key = `${teamId}:${f.event}`;
      perTeamPerEvent.set(key, (perTeamPerEvent.get(key) ?? 0) + 1);
    }
  }

  const anomalies: ScheduleAnomaly[] = [];
  for (let event = fromEvent; event <= toEvent; event++) {
    // Skip events with no fixtures for ANY team at all (a fully postponed
    // gameweek is not the per-team blank-gameweek signal we're after).
    if (!eventsWithAnyFixture.has(event)) continue;
    for (const team of teams) {
      const count = perTeamPerEvent.get(`${team.id}:${event}`) ?? 0;
      if (count >= 2) {
        anomalies.push({ event, teamId: team.id, type: "double", fixtureCount: count });
      } else if (count === 0) {
        anomalies.push({ event, teamId: team.id, type: "blank", fixtureCount: 0 });
      }
    }
  }

  return anomalies;
}
