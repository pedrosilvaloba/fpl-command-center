import type { FplFixture, FplTeam } from "./types";
import type { OddsMatch } from "./oddsapi";
import { matchOddsTeam } from "./oddsapi";
import type { TeamFactor } from "./teamrating";

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
export const BASE_HOME_GOALS = 1.5;
export const BASE_AWAY_GOALS = 1.2;

/**
 * Has FPL actually published its team strength ratings yet?
 *
 * These are the input the whole Poisson model differentiates teams with.
 * FPL leaves them at 0 (and `strength` at null) at times — confirmed live
 * on 2026-08-21, hours before the GW1 deadline. When they are missing the
 * model still produces numbers, but every team gets the same neutral
 * baseline, so the output is a league-average placeholder rather than a
 * real read on each fixture. The UI should say so instead of presenting
 * identical numbers as if they were a genuine forecast.
 */
export function teamStrengthsUsable(teams: FplTeam[]): boolean {
  if (teams.length === 0) return false;
  return (
    average(teams, "strength_attack_home") > 0 &&
    average(teams, "strength_attack_away") > 0 &&
    average(teams, "strength_defence_home") > 0 &&
    average(teams, "strength_defence_away") > 0
  );
}

function poissonZeroProb(lambda: number): number {
  return Math.exp(-lambda);
}

function poissonPmf(k: number, lambda: number): number {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

/** Smallest k such that P(X <= k) >= p for X ~ Poisson(lambda) — turns a
 * single expected-value number into a rough outcome band (e.g. p=0.85
 * for a "ceiling", p=0.15 for a "floor") instead of only ever showing
 * the mean. Used to flag boom/bust players for captaincy/differential
 * decisions, where two players who share an expected value can have
 * very different real risk profiles. */
export function poissonQuantile(lambda: number, p: number, maxK = 40): number {
  // NaN fails every comparison, so `lambda <= 0` alone let a non-finite
  // lambda fall through the whole loop (cumulative stays NaN, the early
  // return never fires) and silently return maxK — i.e. a corrupt input
  // produced the model's maximum value rather than an obvious zero.
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  let cumulative = 0;
  for (let k = 0; k <= maxK; k++) {
    cumulative += poissonPmf(k, lambda);
    if (cumulative >= p) return k;
  }
  // maxK raised from 12 to 40 so this bound is not reachable for any
  // realistic lambda. At 12 the returned "85th percentile" for a high
  // expectation was just the loop bound reported as a statistic, which
  // also made ceiling-minus-floor SHRINK as expectation grew — turning the
  // boom/bust flag off for exactly the highest-upside players.
  return maxK;
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
  // Non-numeric / missing values contribute 0 rather than turning the whole
  // average into NaN — FPL leaves these fields null or absent at times (see
  // teamStrengthsUsable), and a NaN average would propagate into every
  // fixture's expected goals and out to the rendered page.
  const sum = teams.reduce((s, t) => {
    const v = t[key];
    return s + (typeof v === "number" && Number.isFinite(v) ? v : 0);
  }, 0);
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
 *
 * When `teamFactors` is supplied (from lib/teamrating.ts — an in-season,
 * self-updating attack/defence signal built from this season's actual
 * results), it's applied to the strength ratios FIRST, before the market
 * tilt: FPL's static baseline gets corrected by what's actually happened
 * this season, and then nudged again towards the latest market read.
 * Early season (no finished matches yet) every team factor is exactly
 * 1.0, so this is a no-op until there's real evidence to react to.
 */
export function buildFixtureExpectations(
  teams: FplTeam[],
  fixtures: FplFixture[],
  oddsMatches: OddsMatch[] | null = null,
  teamFactors: Map<number, TeamFactor> | null = null
): Map<number, FixtureExpectation[]> {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const avgAttackHome = average(teams, "strength_attack_home");
  const avgAttackAway = average(teams, "strength_attack_away");
  const avgDefenceHome = average(teams, "strength_defence_home");
  const avgDefenceAway = average(teams, "strength_defence_away");

  // FPL does not always publish its team strength ratings. Confirmed
  // against the live API on 2026-08-21, hours before the GW1 deadline:
  // every team had `strength: null` and all four strength_* fields at 0.
  //
  // The arithmetic below divides a team's rating by the league average of
  // that rating, so all-zero input produced `0 / 0`, guarded to `0 / 1`,
  // and the whole model collapsed silently: every fixture came out at
  // exactly 0.00 expected goals, and clean-sheet probability — which is
  // exp(-expectedGoalsAgainst) — came out at exp(0) = 100% for all twenty
  // teams. That is what the Calendário was showing.
  //
  // It looked like plausible output rather than an obvious failure, which
  // is why it survived: the panel only started displaying these numbers in
  // v1.10 (before that it showed FPL's own 1-5 digit, which hid it).
  //
  // The honest fallback is a NEUTRAL factor of 1: with no information
  // about relative team strength, every team is treated as league-average
  // and the model degrades to its base rates (1.5 home / 1.2 away) instead
  // of to zero. Callers can detect this state with `teamStrengthsUsable`
  // and tell the user the numbers are un-differentiated rather than
  // presenting them as a real read on each fixture.
  const ratingsUsable =
    avgAttackHome > 0 && avgAttackAway > 0 && avgDefenceHome > 0 && avgDefenceAway > 0;

  /** Team rating relative to the league, or a neutral 1 when the rating
   * is missing, zero or otherwise unusable. */
  const ratio = (value: number | undefined, avg: number): number => {
    if (!ratingsUsable) return 1;
    if (!Number.isFinite(value) || (value ?? 0) <= 0) return 1;
    return (value as number) / avg;
  };

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

    const homeDynamic = teamFactors?.get(home.id);
    const awayDynamic = teamFactors?.get(away.id);

    const attackFactorHome =
      ratio(home.strength_attack_home, avgAttackHome) * (homeDynamic?.attackFactor ?? 1);
    const defenceFactorAway =
      ratio(away.strength_defence_away, avgDefenceAway) * (awayDynamic?.defenceFactor ?? 1);
    let xgHome = (BASE_HOME_GOALS * attackFactorHome) / (defenceFactorAway || 1);

    const attackFactorAway =
      ratio(away.strength_attack_away, avgAttackAway) * (awayDynamic?.attackFactor ?? 1);
    const defenceFactorHome =
      ratio(home.strength_defence_home, avgDefenceHome) * (homeDynamic?.defenceFactor ?? 1);
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
  // Per-fixture averages — "how good is a typical game in this window",
  // for display (e.g. "~1.8 golos/jogo").
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  avgCleanSheetProbability: number;
  // Totals across every fixture in the window — "how much output is there
  // to get in this window, in total". A double gameweek inside the window
  // means MORE total fixtures than gameweeks, which correctly increases
  // these totals instead of just averaging in another data point — this
  // is what the scoring engine should actually optimize for, since a team
  // playing twice genuinely offers roughly double the opportunity that
  // gameweek, not the same opportunity as everyone else.
  totalGoalsFor: number;
  totalGoalsAgainst: number;
  totalCleanSheetProbability: number;
  fixtureCount: number;
  /** How many gameweeks this window ACTUALLY covers. Near the end of the
   * season fewer than `windowSize` gameweeks remain, so comparing the
   * fixture count against a fixed 5 flagged every team as blank from
   * GW35 onward — and could report a team with a genuine DOUBLE gameweek
   * as having a blank instead. Clamped to the last gameweek that exists. */
  gameweeksInWindow: number;
  hasDoubleGameweek: boolean; // fixtureCount > gameweeksInWindow
  // fixtureCount < gameweeksInWindow (this team missing at least one GW).
  // Simple count-based check — the rare case of a blank AND a double both
  // landing in the same window can net out to a "normal" fixtureCount and
  // hide both from this flag. lib/schedule.ts's findScheduleAnomalies
  // does an exact per-gameweek scan and is the source of truth for the
  // dedicated schedule section; this flag is a fast approximation used
  // only to nudge the scoring engine, not to render anything as fact.
  hasBlankGameweek: boolean;
  anyMarketAdjusted: boolean;
}

const EMPTY_WINDOW: WindowExpectation = {
  avgGoalsFor: 0,
  avgGoalsAgainst: 0,
  avgCleanSheetProbability: 0,
  totalGoalsFor: 0,
  totalGoalsAgainst: 0,
  totalCleanSheetProbability: 0,
  fixtureCount: 0,
  gameweeksInWindow: 0,
  hasDoubleGameweek: false,
  hasBlankGameweek: false,
  anyMarketAdjusted: false,
};

/** Aggregates a team's per-fixture expectations over an upcoming window —
 * same fromEvent/windowSize shape as lib/fdr.ts's ticker, but carrying
 * real numbers instead of FPL's 1-5 difficulty digit, and both an average
 * (per-fixture) and a total (window-wide, DGW-aware) view of each. */
export function windowExpectation(
  expectations: FixtureExpectation[] | undefined,
  fromEvent: number,
  windowSize: number,
  // The season's last gameweek, so the window can be clamped to the
  // gameweeks that actually exist. Defaults to 38 (a standard Premier
  // League season) rather than being required, so existing callers keep
  // working — but pass the real value when you have it.
  lastEvent = 38
): WindowExpectation {
  if (!expectations) return EMPTY_WINDOW;
  const inWindow = expectations.filter(
    (e) => e.event !== null && e.event >= fromEvent && e.event < fromEvent + windowSize
  );
  if (inWindow.length === 0) return EMPTY_WINDOW;
  const n = inWindow.length;
  // Real gameweeks covered, never more than remain in the season.
  const gameweeksInWindow = Math.max(
    1,
    Math.min(fromEvent + windowSize - 1, lastEvent) - fromEvent + 1
  );
  const totalGoalsFor = inWindow.reduce((s, e) => s + e.expectedGoalsFor, 0);
  const totalGoalsAgainst = inWindow.reduce((s, e) => s + e.expectedGoalsAgainst, 0);
  const totalCleanSheetProbability = inWindow.reduce(
    (s, e) => s + e.cleanSheetProbability,
    0
  );
  return {
    avgGoalsFor: totalGoalsFor / n,
    avgGoalsAgainst: totalGoalsAgainst / n,
    avgCleanSheetProbability: totalCleanSheetProbability / n,
    totalGoalsFor,
    totalGoalsAgainst,
    totalCleanSheetProbability,
    fixtureCount: n,
    gameweeksInWindow,
    hasDoubleGameweek: n > gameweeksInWindow,
    hasBlankGameweek: n < gameweeksInWindow,
    anyMarketAdjusted: inWindow.some((e) => e.marketAdjusted),
  };
}

export interface ModelFixtureRow {
  event: number | null;
  opponentShort: string;
  isHome: boolean;
  expectedGoalsFor: number;
  cleanSheetProbability: number;
  marketAdjusted: boolean;
}

/**
 * The Fixture Ticker (Calendário) panel used to show FPL's own 1-5
 * difficulty digit — the same coarse, opaque number this whole file
 * exists to move the SCORING away from. That left a confusing split: the
 * numbers actually driving recommendations were these real per-fixture
 * expected-goals/clean-sheet figures (optionally sharpened by market
 * odds and this season's own results), but the one section a manager
 * would naturally check for "is this a good run of fixtures" still only
 * showed the old crude digit. This builds the SAME shape the old ticker
 * did (per team, next N fixtures) but sourced from the real model
 * instead — one real number for attacking upside, one for defensive
 * solidity, shown separately rather than folded into a single score,
 * since a fixture can genuinely be great for one and poor for the other.
 */
export function buildModelTicker(
  teams: FplTeam[],
  expectationsByTeam: Map<number, FixtureExpectation[]>,
  fromEvent: number,
  count = 5
): Record<number, ModelFixtureRow[]> {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const result: Record<number, ModelFixtureRow[]> = {};
  for (const team of teams) {
    const rows = (expectationsByTeam.get(team.id) ?? [])
      .filter((e) => e.event !== null && e.event >= fromEvent)
      .slice(0, count)
      .map((e): ModelFixtureRow => {
        const opponent = teamById.get(e.opponentTeamId);
        return {
          event: e.event,
          opponentShort: opponent?.short_name ?? "???",
          isHome: e.isHome,
          expectedGoalsFor: e.expectedGoalsFor,
          cleanSheetProbability: e.cleanSheetProbability,
          marketAdjusted: e.marketAdjusted,
        };
      });
    result[team.id] = rows;
  }
  return result;
}

export function avgExpectedGoalsFor(rows: ModelFixtureRow[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r.expectedGoalsFor, 0) / rows.length;
}

export function avgCleanSheetProbability(rows: ModelFixtureRow[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r.cleanSheetProbability, 0) / rows.length;
}
