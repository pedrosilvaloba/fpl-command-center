import type { FplFixture, FplTeam } from "./types";

export interface UpcomingFixture {
  event: number | null;
  opponentShort: string;
  isHome: boolean;
  difficulty: number; // 1 (easiest) - 5 (hardest), FPL's own scale
}

/** Builds, for every team, its next `count` fixtures with difficulty —
 * the basis of the Fixture Ticker panel. FPL's own difficulty rating is
 * a coarse, infrequently-updated, largely league-position-based score
 * (a known, widely-criticised limitation — see the strategy notes in
 * lib/strategy.ts). It's still the only difficulty signal the official
 * API exposes, so v1 uses it directly and flags the limitation in the UI;
 * a proper Elo/xG-differential-based FDR is on the roadmap. */
export function buildFixtureTicker(
  teams: FplTeam[],
  fixtures: FplFixture[],
  fromEvent: number,
  count = 5
): Record<number, UpcomingFixture[]> {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const result: Record<number, UpcomingFixture[]> = {};

  for (const team of teams) {
    const upcoming = fixtures
      .filter(
        (f) =>
          (f.team_h === team.id || f.team_a === team.id) &&
          f.event !== null &&
          f.event >= fromEvent
      )
      .sort((a, b) => (a.event ?? 0) - (b.event ?? 0))
      .slice(0, count)
      .map((f): UpcomingFixture => {
        const isHome = f.team_h === team.id;
        const oppId = isHome ? f.team_a : f.team_h;
        const opponent = teamById.get(oppId);
        return {
          event: f.event,
          opponentShort: opponent?.short_name ?? "???",
          isHome,
          difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
        };
      });
    result[team.id] = upcoming;
  }

  return result;
}

export function averageDifficulty(fixtures: UpcomingFixture[]): number {
  if (fixtures.length === 0) return 3;
  return (
    fixtures.reduce((sum, f) => sum + f.difficulty, 0) / fixtures.length
  );
}

export function difficultyLabel(avg: number): "easy" | "medium" | "hard" {
  if (avg <= 2.4) return "easy";
  if (avg <= 3.4) return "medium";
  return "hard";
}
