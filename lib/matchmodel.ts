import type { FplFixture, FplTeam } from "./types";

export interface FixtureExpectation {
  fixtureId: number;
  event: number | null;
  opponentTeamId: number;
  isHome: boolean;
  expectedGoalsFor: number;
  expectedGoalsAgainst: number;
  cleanSheetProbability: number; // P(this team concedes 0 in this fixture)
}

// Long-run Premier League average goals per match by venue — a stable,
// widely-cited prior (home teams score somewhat more than away teams on
// average across a season). This is only the baseline the attack/defence
// factors below scale around; it does not need to be exact.
const BASE_HOME_GOALS = 1.5;
const BASE_AWAY_GOALS = 1.2;

function poissonZeroProb(lambda: number): number {
  return Math.exp(-lambda);
}

function average(teams: FplTeam[], key: keyof FplTeam): number {
  const sum = teams.reduce((s, t) => s + (t[key] as number), 0);
  return sum / (teams.length || 1);
}

/**
 * Converts FPL's own team-strength ratings (bootstrap.teams[].strength_*)
 * into per-fixture expected goals and clean-sheet probability, using the
 * standard multiplicative Poisson approach most public football
 * prediction models are built on (attack strength × 1/opponent defence
 * strength × a league-average baseline — the same family as Dixon-Coles).
 *
 * FPL doesn't publish expected goals, but it already publishes exactly
 * the calibrated attack/defence-by-venue ratings this model needs — the
 * app was only using them indirectly, through the single 1-5 FDR digit
 * FPL derives from them, which throws most of the signal away. This
 * recovers actual per-team, per-fixture numbers instead, with no new
 * external data source and no extra API calls: every player on the same
 * team no longer gets an identical, coarse "calendar is easy/hard" bump —
 * defenders get a real clean-sheet probability, attackers get a real
 * expected-goals-for number, both specific to that exact fixture.
 *
 * Caveat, stated plainly: these ratings are FPL's own (opaque, not
 * independently audited) assessment of each team's strength, refreshed
 * infrequently — a genuine step up from a single 1-5 digit, but not the
 * same as an xG-differential model built from this season's actual
 * results. That richer version is the natural next iteration once
 * enough of this season has been played to calibrate one.
 */
export function buildFixtureExpectations(
  teams: FplTeam[],
  fixtures: FplFixture[]
): Map<number, FixtureExpectation[]> {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const avgAttackHome = average(teams, "strength_attack_home");
  const avgAttackAway = average(teams, "strength_attack_away");
  const avgDefenceHome = average(teams, "strength_defence_home");
  const avgDefenceAway = average(teams, "strength_defence_away");

  const byTeam = new Map<number, FixtureExpectation[]>();
  const push = (teamId: number, exp: FixtureExpectation) => {
    if (!byTeam.has(teamId)) byTeam.set(teamId, []);
    byTeam.get(teamId)!.push(exp);
  };

  for (const f of fixtures) {
    const home = byId.get(f.team_h);
    const away = byId.get(f.team_a);
    if (!home || !away) continue;

    const attackFactorHome = home.strength_attack_home / (avgAttackHome || 1);
    const defenceFactorAway = away.strength_defence_away / (avgDefenceAway || 1);
    const xgHome = (BASE_HOME_GOALS * attackFactorHome) / (defenceFactorAway || 1);

    const attackFactorAway = away.strength_attack_away / (avgAttackAway || 1);
    const defenceFactorHome = home.strength_defence_home / (avgDefenceHome || 1);
    const xgAway = (BASE_AWAY_GOALS * attackFactorAway) / (defenceFactorHome || 1);

    push(home.id, {
      fixtureId: f.id,
      event: f.event,
      opponentTeamId: away.id,
      isHome: true,
      expectedGoalsFor: Math.round(xgHome * 100) / 100,
      expectedGoalsAgainst: Math.round(xgAway * 100) / 100,
      cleanSheetProbability: Math.round(poissonZeroProb(xgAway) * 1000) / 1000,
    });
    push(away.id, {
      fixtureId: f.id,
      event: f.event,
      opponentTeamId: home.id,
      isHome: false,
      expectedGoalsFor: Math.round(xgAway * 100) / 100,
      expectedGoalsAgainst: Math.round(xgHome * 100) / 100,
      cleanSheetProbability: Math.round(poissonZeroProb(xgHome) * 1000) / 1000,
    });
  }

  for (const list of byTeam.values()) {
    list.sort((a, b) => (a.event ?? 0) - (b.event ?? 0));
  }

  return byTeam;
}

export interface WindowExpectation {
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  avgCleanSheetProbability: number;
  fixtureCount: number;
}

const EMPTY_WINDOW: WindowExpectation = {
  avgGoalsFor: 0,
  avgGoalsAgainst: 0,
  avgCleanSheetProbability: 0,
  fixtureCount: 0,
};

/** Averages a team's per-fixture expectations over an upcoming window —
 * same fromEvent/windowSize shape as lib/fdr.ts's ticker, but carrying
 * real numbers instead of FPL's 1-5 difficulty digit. */
export function windowExpectation(
  expectations: FixtureExpectation[] | undefined,
  fromEvent: number,
  windowSize: number
): WindowExpectation {
  if (!expectations) return EMPTY_WINDOW;
  const inWindow = expectations.filter(
    (e) => e.event !== null && e.event >= fromEvent && e.event < fromEvent + windowSize
  );
  if (inWindow.length === 0) return EMPTY_WINDOW;
  const n = inWindow.length;
  return {
    avgGoalsFor: inWindow.reduce((s, e) => s + e.expectedGoalsFor, 0) / n,
    avgGoalsAgainst: inWindow.reduce((s, e) => s + e.expectedGoalsAgainst, 0) / n,
    avgCleanSheetProbability:
      inWindow.reduce((s, e) => s + e.cleanSheetProbability, 0) / n,
    fixtureCount: n,
  };
}
