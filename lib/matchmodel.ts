import type { FplFixture, FplTeam } from "./types";
import type { OddsMatch } from "./oddsapi";
import { matchOddsTeam } from "./oddsapi";

export interface FixtureExpectation {
  fixtureId: number;
  event: number | null;
  opponentTeamId: number;
  isHome: boolean;
  expectedGoalsFor: number;
  expectedGoalsAgainst: number;
  cleanSheetProbability: number; // P(this team concedes 0 in this fixture)
  marketAdjusted: boolean; // true when betting-market odds nudged this fixture's numbers
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

function poissonPmf(k: number, lambda: number): number {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

/** P(home win) / P(draw) / P(away win) implied by two independent
 * Poisson goal distributions — the standard way to turn a pair of
 * expected-goals numbers into match-outcome probabilities. Summed over
 * scorelines up to 9-9 each way; probability mass beyond that is
 * negligible for realistic Premier League expected-goals values. */
export function matchOutcomeProbabilities(
  xgHome: number,
  xgAway: number,
  maxGoals = 9
) {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, xgHome);
    for (let a = 0; a <= maxGoals; a++) {
      const p = ph * poissonPmf(a, xgAway);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
    }
  }
  return { pHome, pDraw, pAway };
}

const MIN_TILT = 0.7;
const MAX_TILT = 1.4;

/**
 * Nudges a fixture's expected-goals pair towards what the betting market
 * implies, without fully replacing our own model. Rather than fitting a
 * fresh Poisson pair to match market odds exactly (a heavier numerical
 * problem — a real future refinement), this computes how much more/less
 * the market favours the home side than our own strength-rating model
 * does, and scales both teams' expected goals by that ratio (square-
 * rooted, and clamped to ±40%, so a single thin/noisy match-winner market
 * can't swing a fixture wildly). This is deliberately an approximation,
 * documented as such — the point is to let market information (team
 * news, tactical changes, expert analysis, all priced in almost
 * immediately) pull the numbers in the right direction, not to claim
 * odds-derived precision we haven't actually built.
 */
export function applyMarketTilt(
  xgHome: number,
  xgAway: number,
  marketHomeWinProb: number,
  marketAwayWinProb: number
): { xgHome: number; xgAway: number } {
  const { pHome: modelHome, pAway: modelAway } = matchOutcomeProbabilities(xgHome, xgAway);
  const modelShare = modelHome / (modelHome + modelAway || 1);
  const marketShare = marketHomeWinProb / (marketHomeWinProb + marketAwayWinProb || 1);
  if (modelShare <= 0 || marketShare <= 0) return { xgHome, xgAway };

  const tilt = Math.min(MAX_TILT, Math.max(MIN_TILT, marketShare / modelShare));
  const sqrtTilt = Math.sqrt(tilt);

  return {
    xgHome: Math.round(xgHome * sqrtTilt * 100) / 100,
    xgAway: Math.round((xgAway / sqrtTilt) * 100) / 100,
  };
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
 * results.
 *
 * When betting-market odds are available (`oddsMatches`, from
 * lib/oddsapi.ts — optional, requires ODDS_API_KEY), each fixture's
 * numbers are additionally nudged towards what the market implies via
 * applyMarketTilt above, so team news, tactical changes and expert
 * analysis the static preseason ratings can't see get folded in. Without
 * odds configured, this runs on the strength-rating model alone — a
 * real, honest fallback, not a broken state.
 */
export function buildFixtureExpectations(
  teams: FplTeam[],
  fixtures: FplFixture[],
  oddsMatches: OddsMatch[] | null = null
): Map<number, FixtureExpectation[]> {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const avgAttackHome = average(teams, "strength_attack_home");
  const avgAttackAway = average(teams, "strength_attack_away");
  const avgDefenceHome = average(teams, "strength_defence_home");
  const avgDefenceAway = average(teams, "strength_defence_away");

  const oddsTeamNames = oddsMatches
    ? Array.from(new Set(oddsMatches.flatMap((m) => [m.homeTeam, m.awayTeam])))
    : [];
  const oddsNameCache = new Map<number, string | null>();
  const oddsNameFor = (team: FplTeam): string | null => {
    if (!oddsMatches) return null;
    if (!oddsNameCache.has(team.id)) {
      oddsNameCache.set(team.id, matchOddsTeam(team, oddsTeamNames));
    }
    return oddsNameCache.get(team.id) ?? null;
  };

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
    let xgHome = (BASE_HOME_GOALS * attackFactorHome) / (defenceFactorAway || 1);

    const attackFactorAway = away.strength_attack_away / (avgAttackAway || 1);
    const defenceFactorHome = home.strength_defence_home / (avgDefenceHome || 1);
    let xgAway = (BASE_AWAY_GOALS * attackFactorAway) / (defenceFactorHome || 1);

    let marketAdjusted = false;
    if (oddsMatches) {
      const homeOddsName = oddsNameFor(home);
      const awayOddsName = oddsNameFor(away);
      const market = homeOddsName && awayOddsName
        ? oddsMatches.find((m) => m.homeTeam === homeOddsName && m.awayTeam === awayOddsName)
        : undefined;
      if (market) {
        const tilted = applyMarketTilt(xgHome, xgAway, market.homeWinProb, market.awayWinProb);
        xgHome = tilted.xgHome;
        xgAway = tilted.xgAway;
        marketAdjusted = true;
      }
    }

    push(home.id, {
      fixtureId: f.id,
      event: f.event,
      opponentTeamId: away.id,
      isHome: true,
      expectedGoalsFor: Math.round(xgHome * 100) / 100,
      expectedGoalsAgainst: Math.round(xgAway * 100) / 100,
      cleanSheetProbability: Math.round(poissonZeroProb(xgAway) * 1000) / 1000,
      marketAdjusted,
    });
    push(away.id, {
      fixtureId: f.id,
      event: f.event,
      opponentTeamId: home.id,
      isHome: false,
      expectedGoalsFor: Math.round(xgAway * 100) / 100,
      expectedGoalsAgainst: Math.round(xgHome * 100) / 100,
      cleanSheetProbability: Math.round(poissonZeroProb(xgHome) * 1000) / 1000,
      marketAdjusted,
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
  anyMarketAdjusted: boolean;
}

const EMPTY_WINDOW: WindowExpectation = {
  avgGoalsFor: 0,
  avgGoalsAgainst: 0,
  avgCleanSheetProbability: 0,
  fixtureCount: 0,
  anyMarketAdjusted: false,
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
    anyMarketAdjusted: inWindow.some((e) => e.marketAdjusted),
  };
}
