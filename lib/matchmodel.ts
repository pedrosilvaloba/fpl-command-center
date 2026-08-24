import type { FplFixture, FplTeam } from "./types";
import type { OddsMatch } from "./oddsapi";
import {
  expectedGoalsFromMarket,
  deriveTeamRatingsFromMarket,
  type FixtureSource,
  type MarketTeamRating,
} from "./oddsmodel";
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
  /** Where these numbers actually came from — see lib/oddsmodel.ts.
   * Surfaced in the UI so a neutral placeholder is never mistaken for a
   * real per-fixture forecast. */
  source: FixtureSource;
}

// Long-run Premier League average goals per match by venue — a stable,
// widely-cited prior (home teams score somewhat more than away teams on
// average across a season). This is only the baseline the attack/defence
// factors below scale around; it does not need to be exact.
/**
 * League baseline goals per team per match, home and away.
 *
 * These are the PRESEASON fallback only. Once matches have been played the
 * model derives them from this season's own results (see
 * `deriveLeagueBaselines` below) rather than trusting a constant.
 *
 * The old values were 1.5 and 1.2 — a total of 2.70 and a home advantage of
 * 0.30. The current Premier League runs at 2.95-3.28 goals a match with a
 * home advantage of 0.20-0.25, which has not recovered to its pre-2020
 * level. Too few goals inflates every clean-sheet probability by around
 * three percentage points, which biases the split of the budget between
 * defence and attack rather than the ranking within either.
 */
/**
 * How many matches of evidence FPL's own calibrated ratings are worth in the
 * blend. They are a real 20-team prior built before a ball is kicked; they
 * should not be erased by one played match, and should not survive a full
 * season of contrary evidence either.
 */
export const FPL_PRIOR_PSEUDO_MATCHES = 5;

/** Gameweeks over which a fixture's weight in the window decays by 1/e.
 * Market forecast accuracy falls from roughly 0.75 correlation at one week
 * out to 0.55 at four, so the far end of a five-gameweek window carries
 * about 70% of the near end's weight. */
const HORIZON_DECAY_EVENTS = 4;

/** How much of the true spread between teams each source retains. Measured
 * on synthetic leagues: a priced fixture is close to exact, ratings derived
 * from one priced gameweek retain about half, and a neutral placeholder
 * retains nothing at all and should barely count. */
const SOURCE_PRECISION: Record<FixtureSource, number> = {
  market: 1,
  "market-1x2": 0.8,
  "market-ratings": 0.6,
  results: 0.7,
  fpl: 0.5,
  neutral: 0.15,
};

export const BASE_HOME_GOALS = 1.62;
export const BASE_AWAY_GOALS = 1.41;

/**
 * League baselines measured from this season's finished matches, falling
 * back to the constants above until there is enough of a sample.
 *
 * A constant that is a decade out of date is a silent, league-wide level
 * error. The data to replace it is already fetched on every page load.
 */
export function deriveLeagueBaselines(fixtures: FplFixture[]): {
  home: number;
  away: number;
  matches: number;
} {
  const finished = fixtures.filter(
    (f) => f.finished && f.team_h_score !== null && f.team_a_score !== null
  );
  // Below about thirty matches the split is noisier than the prior it would
  // replace, so blend rather than switch.
  const n = finished.length;
  if (n === 0) return { home: BASE_HOME_GOALS, away: BASE_AWAY_GOALS, matches: 0 };
  const home = finished.reduce((s, f) => s + (f.team_h_score ?? 0), 0) / n;
  const away = finished.reduce((s, f) => s + (f.team_a_score ?? 0), 0) / n;
  const trust = Math.min(1, n / 60);
  return {
    home: BASE_HOME_GOALS * (1 - trust) + home * trust,
    away: BASE_AWAY_GOALS * (1 - trust) + away * trust,
    matches: n,
  };
}

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
  // every team had `strength: null` and all four strength_* fields at 0,
  // which made the old arithmetic collapse every fixture to exactly 0.00
  // expected goals and 100% clean-sheet probability. These ratings are now
  // only ONE rung of a hierarchy (see below) rather than its foundation.
  const fplRatingsUsable =
    avgAttackHome > 0 && avgAttackAway > 0 && avgDefenceHome > 0 && avgDefenceAway > 0;

  // REST DAYS.
  //
  // `kickoff_time` was in the type and read by nothing. It is the only thing
  // needed to price two effects the model had no term for at all: the second
  // leg of a double gameweek, played three days after the first and heavily
  // rotated at exactly the clubs that get doubles; and the Saturday fixture
  // that follows a Wednesday in Europe, which costs on the order of 0.05 to
  // 0.10 goals for the six or seven clubs whose players dominate FPL squads.
  const kickoffByTeam = new Map<number, number[]>();
  for (const f of fixtures) {
    if (!f.kickoff_time) continue;
    const t = new Date(f.kickoff_time).getTime();
    if (!Number.isFinite(t)) continue;
    for (const id of [f.team_h, f.team_a]) {
      if (!kickoffByTeam.has(id)) kickoffByTeam.set(id, []);
      kickoffByTeam.get(id)!.push(t);
    }
  }
  for (const list of kickoffByTeam.values()) list.sort((a, b) => a - b);

  /** Multiplier on a team's attacking output for a fixture, given how long
   * they have had to recover. Only short rest is penalised; extra rest
   * beyond a normal week is not a measurable advantage. */
  const restFactor = (teamId: number, kickoff: string | null): number => {
    if (!kickoff) return 1;
    const t = new Date(kickoff).getTime();
    if (!Number.isFinite(t)) return 1;
    const list = kickoffByTeam.get(teamId);
    if (!list) return 1;
    let previous: number | null = null;
    for (const other of list) {
      if (other < t) previous = other;
      else break;
    }
    if (previous === null) return 1;
    const days = (t - previous) / 86_400_000;
    if (days >= 5) return 1;
    if (days <= 2.5) return 0.90;
    // Linear between the two, which is as much shape as the evidence
    // supports.
    return 0.90 + ((days - 2.5) / 2.5) * 0.10;
  };

  // League baselines from this season's own results, not from a constant.
  const baselines = deriveLeagueBaselines(fixtures);
  const baseHome = baselines.home;
  const baseAway = baselines.away;

  const ratio = (value: number | undefined, avg: number): number => {
    if (!fplRatingsUsable) return 1;
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

  // Reverse lookup: odds-provider name -> FPL team id. Exact matches only
  // (matchOddsTeam refuses to guess), because attributing one club's
  // market to another would be worse than having no market at all.
  const teamIdByOddsName = new Map<string, number>();
  for (const team of teams) {
    const name = oddsNameFor(team);
    if (name) teamIdByOddsName.set(name, team.id);
  }

  // Team ratings inferred from whichever fixtures the market HAS priced.
  // This is what lets fixtures the bookmakers have not reached yet still
  // be projected from market information rather than from FPL's ratings.
  const marketRatings: Map<number, MarketTeamRating> | null =
    oddsMatches && oddsMatches.length > 0
      ? deriveTeamRatingsFromMarket(teams, oddsMatches, (n) => teamIdByOddsName.get(n) ?? null)
      : null;

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

    let xgHome: number;
    let xgAway: number;
    let source: FixtureSource;
    let marketAdjusted = false;

    // ---- rung 1: the market priced THIS fixture -------------------------
    const homeOddsName = oddsNameFor(home);
    const awayOddsName = oddsNameFor(away);
    const market =
      oddsMatches && homeOddsName && awayOddsName
        ? oddsMatches.find((m) => m.homeTeam === homeOddsName && m.awayTeam === awayOddsName)
        : undefined;

    if (market) {
      // When the bookmakers priced no totals market, fall back to the total
      // these two teams' own ratings imply rather than to a league constant.
      const priorH = teamFactors?.get(home.id);
      const priorA = teamFactors?.get(away.id);
      const fallbackTotal =
        baseHome * (priorH?.attackFactor ?? 1) / (priorA?.defenceFactor || 1) +
        baseAway * (priorA?.attackFactor ?? 1) / (priorH?.defenceFactor || 1);
      const derived = expectedGoalsFromMarket(market, fallbackTotal);
      xgHome = derived.xgHome;
      xgAway = derived.xgAway;
      // A fixture priced on 1X2 alone has an INVENTED total (the split moves,
      // the total does not), so it must not carry the same label as one whose
      // total was actually priced. See lib/oddsmodel.ts.
      source = derived.totalWasPriced ? "market" : "market-1x2";
      marketAdjusted = true;
    } else {
      // ---- rungs 2-4: combine every source that has something to say -----
      //
      // This used to be an if/else ladder where the first applicable rung
      // won outright. That had two consequences, both bad. From gameweek 2
      // onwards a single finished match made `resultsInformed` true for
      // every fixture, so FPL's calibrated 20-team prior became unreachable
      // code — the model threw away a full prior and replaced it with one
      // match shrunk 87% toward neutral, leaving it LESS differentiated in
      // gameweek 2 than it had been in gameweek 1. In the other direction,
      // one gameweek of market-derived ratings preempted nineteen gameweeks
      // of results.
      //
      // Neither source dominates the other: market ratings are sharper per
      // observation, results have far more observations. The right estimator
      // is the precision-weighted combination, so the factors are now blended
      // in log space with weights proportional to how much evidence each one
      // rests on. The `source` label reports which contributor dominates,
      // which is what it was always really being used for.
      const mktH = marketRatings?.get(home.id);
      const mktA = marketRatings?.get(away.id);
      const marketSample = Math.max(mktH?.sample ?? 0, mktA?.sample ?? 0);
      const resultsSample = Math.max(
        homeDynamic?.finishedMatches ?? 0,
        awayDynamic?.finishedMatches ?? 0
      );

      // Weights. The FPL prior is worth a few matches of evidence and never
      // disappears entirely; each priced fixture counts double a played one
      // because the market embeds team news the results cannot.
      const wFpl = fplRatingsUsable ? FPL_PRIOR_PSEUDO_MATCHES : 0;
      const wMarket = marketSample * 2;
      const wResults = resultsSample;
      const wTotal = wFpl + wMarket + wResults;

      if (wTotal <= 0) {
        // ---- nothing at all: home advantage and nothing else.
        xgHome = baseHome;
        xgAway = baseAway;
        source = "neutral";
      } else {
        // Each contributor supplies a multiplicative attack/defence factor.
        // Blending them in log space keeps a factor of 2 and a factor of 0.5
        // symmetric, which an arithmetic mean does not.
        const blend = (
          fplF: number,
          marketF: number,
          resultsF: number
        ): number => {
          const logSum =
            wFpl * Math.log(Math.max(0.2, fplF)) +
            wMarket * Math.log(Math.max(0.2, marketF)) +
            wResults * Math.log(Math.max(0.2, resultsF));
          return Math.exp(logSum / wTotal);
        };

        const attackHome = blend(
          fplRatingsUsable ? ratio(home.strength_attack_home, avgAttackHome) : 1,
          mktH?.attack ?? 1,
          homeDynamic?.attackFactor ?? 1
        );
        const defenceAway = blend(
          fplRatingsUsable ? ratio(away.strength_defence_away, avgDefenceAway) : 1,
          // A market DEFENCE rating above 1 means "concedes more"; the
          // results-side factor is inverted (above 1 means "concedes less"),
          // so the two are put on the same footing here.
          mktA?.defence ?? 1,
          1 / (awayDynamic?.defenceFactor || 1)
        );
        const attackAway = blend(
          fplRatingsUsable ? ratio(away.strength_attack_away, avgAttackAway) : 1,
          mktA?.attack ?? 1,
          awayDynamic?.attackFactor ?? 1
        );
        const defenceHome = blend(
          fplRatingsUsable ? ratio(home.strength_defence_home, avgDefenceHome) : 1,
          mktH?.defence ?? 1,
          1 / (homeDynamic?.defenceFactor || 1)
        );

        xgHome = baseHome * attackHome * defenceAway;
        xgAway = baseAway * attackAway * defenceHome;

        // Report the dominant contributor rather than the first one that
        // happened to apply.
        source =
          wMarket >= wResults && wMarket >= wFpl
            ? "market-ratings"
            : wResults >= wFpl
              ? "results"
              : "fpl";
        marketAdjusted = wMarket > 0;
      }
    }

    // Congestion. Applied after the source blend so it modifies whatever
    // estimate won — including a market-priced one, where the bookmakers
    // have usually priced the schedule but not the rotation that follows it.
    const restHome = restFactor(home.id, f.kickoff_time);
    const restAway = restFactor(away.id, f.kickoff_time);
    xgHome *= restHome;
    xgAway *= restAway;
    // A tired opponent concedes more, so the other side's attack is helped
    // by the same amount its own is hurt.
    xgHome /= restAway;
    xgAway /= restHome;

    // Guard against a degenerate blend producing an implausible fixture.
    xgHome = Math.min(4.5, Math.max(0.15, xgHome));
    xgAway = Math.min(4.5, Math.max(0.15, xgAway));

    push(home.id, {
      fixtureId: f.id,
      event: f.event,
      opponentTeamId: away.id,
      isHome: true,
      expectedGoalsFor: Math.round(xgHome * 100) / 100,
      expectedGoalsAgainst: Math.round(xgAway * 100) / 100,
      cleanSheetProbability: Math.round(poissonZeroProb(xgAway) * 1000) / 1000,
      marketAdjusted,
      source,
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
      source,
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

  // WEIGHTED, NOT FLAT.
  //
  // A flat mean treats gameweek n+4 exactly like gameweek n. It should not:
  // the near fixture is usually priced by the market, the far one is not,
  // and a rating-derived estimate retains far less of the true spread
  // between teams than a priced one. Averaging them flat drags one sharp
  // number toward four blurred ones, which is why good fixture runs read
  // flatter in this model than they are.
  //
  // Two weights multiply. Horizon decay reflects that a forecast four weeks
  // out is genuinely less informative — and that you will very likely have
  // transferred again by then. Source precision reflects how much of the
  // real spread each estimate retains.
  const horizonWeight = (event: number | null) =>
    Math.exp(-Math.max(0, (event ?? fromEvent) - fromEvent) / HORIZON_DECAY_EVENTS);
  const totalWeight = inWindow.reduce(
    (t, e) => t + horizonWeight(e.event) * SOURCE_PRECISION[e.source],
    0
  );
  const weightedMean = (pick: (e: FixtureExpectation) => number) =>
    totalWeight > 0
      ? inWindow.reduce(
          (t, e) => t + pick(e) * horizonWeight(e.event) * SOURCE_PRECISION[e.source],
          0
        ) / totalWeight
      : inWindow.reduce((t, e) => t + pick(e), 0) / n;
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
    // Averages are weighted (they drive per-fixture scoring); totals stay
    // unweighted, because "how many fixtures are there" is a count and a
    // double gameweek really is two chances to score.
    avgGoalsFor: weightedMean((e) => e.expectedGoalsFor),
    avgGoalsAgainst: weightedMean((e) => e.expectedGoalsAgainst),
    avgCleanSheetProbability: weightedMean((e) => e.cleanSheetProbability),
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
  source: FixtureSource;
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
          source: e.source,
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
