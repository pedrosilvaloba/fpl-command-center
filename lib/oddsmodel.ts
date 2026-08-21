import type { FplTeam } from "./types";
import type { OddsMatch } from "./oddsapi";
import { matchOutcomeProbabilities, BASE_HOME_GOALS, BASE_AWAY_GOALS } from "./matchmodel";

/**
 * Turns betting-market prices into expected goals, and betting-market
 * prices into TEAM RATINGS.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every version of this app until now derived fixture difficulty from
 * FPL's own `strength_attack_*` / `strength_defence_*` ratings, and used
 * market odds only as a small correction on top ("the tilt"). Two things
 * make that the wrong way round:
 *
 *  1. FPL's ratings are opaque, coarse, updated on no published schedule —
 *     and sometimes simply absent. Confirmed against the live API on
 *     2026-08-21: all twenty teams had every strength field at 0. A model
 *     built on top of them inherits every one of those weaknesses, and
 *     when they are missing it has nothing at all to say.
 *  2. The tilt could not express what matters most anyway. It scaled the
 *     two expected-goal numbers in opposite directions, which by
 *     construction leaves their PRODUCT unchanged — so it carried
 *     information about who would win, and none whatsoever about how many
 *     goals would be scored. Clean-sheet probability depends almost
 *     entirely on the latter.
 *
 * Bookmakers, by contrast, price in team news, tactical shifts, injuries
 * and expert opinion within minutes, and are among the best publicly
 * available predictors of football outcomes. Treating them as the primary
 * source rather than a garnish is the single biggest available upgrade to
 * this model's real-world accuracy.
 *
 * WHAT THIS DOES
 * --------------
 *  - `expectedGoalsFromMarket` inverts a market price into the pair of
 *    expected-goal values that reproduces it, using the same independent-
 *    Poisson model the rest of the app already uses. With the totals
 *    market it recovers both the total and the split; with only 1X2 it
 *    recovers the split and keeps a sensible total.
 *  - `deriveTeamRatingsFromMarket` goes one step further: it uses the
 *    fixtures the market HAS priced to estimate each team's attacking and
 *    defensive strength, so that fixtures the market has NOT yet priced
 *    (bookmakers rarely post lines five gameweeks ahead) can still be
 *    projected from market-derived information rather than from FPL's.
 *
 * HONEST LIMITS
 * -------------
 * Independent Poisson slightly understates draws in real football, so the
 * inversion is approximate rather than exact. The derived team ratings
 * come from however many fixtures the market has priced — typically one
 * or two gameweeks — so they are a real but thin sample, and they are
 * shrunk toward the league average accordingly. Neither of these is a
 * reason to prefer FPL's numbers; they are reasons to label how each
 * fixture was derived, which `FixtureSource` does.
 */

/** Where a fixture's expected goals actually came from, most to least
 * trustworthy. Surfaced in the UI so a number is never mistaken for a
 * better-founded number than it is. */
export type FixtureSource =
  | "market" // bookmakers priced this exact fixture
  | "market-ratings" // no line for this fixture; team ratings derived from the market
  | "results" // this season's actual results (Elo + goal rates)
  | "fpl" // FPL's own published strength ratings
  | "neutral"; // nothing available — every team treated as league-average

export const SOURCE_LABEL: Record<FixtureSource, string> = {
  market: "odds de mercado",
  "market-ratings": "força derivada das odds",
  results: "resultados desta época",
  fpl: "ratings da FPL",
  neutral: "sem dados — valor neutro",
};

const MIN_GOALS = 0.15;
const MAX_GOALS = 4.5;

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * P(total goals > 2.5) for two independent Poisson scorelines — i.e.
 * 1 - P(0) - P(1) - P(2) on the sum, which is itself Poisson with mean
 * xgHome + xgAway.
 */
export function overTwoPointFiveProbability(xgHome: number, xgAway: number): number {
  const total = xgHome + xgAway;
  const under = poissonPmf(0, total) + poissonPmf(1, total) + poissonPmf(2, total);
  return 1 - under;
}

/** Solves for the total expected goals that reproduces a market's
 * P(over 2.5). Monotonic in the total, so a bisection is exact enough and
 * cannot fail to converge. */
export function totalGoalsFromOverProb(overProb: number): number {
  let lo = 0.3;
  let hi = 7;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = overTwoPointFiveProbability(mid / 2, mid / 2);
    if (p < overProb) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface MarketExpectedGoals {
  xgHome: number;
  xgAway: number;
  /** True when the totals market was available, so the TOTAL is market-
   * derived rather than assumed. */
  totalFromMarket: boolean;
}

/**
 * Inverts a market price into expected goals.
 *
 * Step 1 fixes the total: from the over/under 2.5 line when present,
 * otherwise from the model's own neutral baseline.
 * Step 2 fixes the split: bisect on the share of that total assigned to
 * the home side until the resulting home-win probability matches the
 * market's. P(home win) increases monotonically with the home share, so
 * again bisection is safe.
 */
export function expectedGoalsFromMarket(match: OddsMatch): MarketExpectedGoals {
  const totalFromMarket = match.overProb !== null && Number.isFinite(match.overProb);
  const total = totalFromMarket
    ? totalGoalsFromOverProb(match.overProb as number)
    : BASE_HOME_GOALS + BASE_AWAY_GOALS;

  const targetHomeWin = match.homeWinProb;
  let lo = 0.05; // home share of the total
  let hi = 0.95;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const xgHome = total * mid;
    const xgAway = total * (1 - mid);
    const { pHome } = matchOutcomeProbabilities(xgHome, xgAway);
    if (pHome < targetHomeWin) lo = mid;
    else hi = mid;
  }
  const share = (lo + hi) / 2;

  return {
    xgHome: clamp(total * share, MIN_GOALS, MAX_GOALS),
    xgAway: clamp(total * (1 - share), MIN_GOALS, MAX_GOALS),
    totalFromMarket,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface MarketTeamRating {
  /** Multiplier on baseline goals scored — 1 is league average. */
  attack: number;
  /** Multiplier on baseline goals conceded — BELOW 1 is a good defence. */
  defence: number;
  /** How many market-priced fixtures this rating is based on. */
  sample: number;
}

const RATING_MIN = 0.55;
const RATING_MAX = 1.75;
/** Fixtures needed before a market-derived rating is trusted at full
 * strength; below this it is shrunk toward league average. Bookmakers
 * usually price one or two gameweeks ahead, so this is deliberately low —
 * but the shrinkage means a single fixture never produces an extreme. */
const RATING_FULL_TRUST_SAMPLE = 3;

/**
 * Estimates each team's attacking and defensive strength from whichever
 * fixtures the market has priced.
 *
 * This is what lets the app stop depending on FPL's ratings entirely: the
 * market tells us what it expects Arsenal to score against Coventry this
 * weekend, and from a handful of such statements we can back out how
 * strong the market thinks each team is — then use that to project the
 * fixtures nobody has priced yet.
 *
 * `resolveTeam` maps the odds provider's team name to an FPL team id, and
 * must be an exact-match resolver: guessing here would silently attribute
 * one club's market to another, which is worse than having no rating.
 */
export function deriveTeamRatingsFromMarket(
  teams: FplTeam[],
  matches: OddsMatch[],
  resolveTeam: (oddsName: string) => number | null
): Map<number, MarketTeamRating> {
  const scored = new Map<number, number[]>();
  const conceded = new Map<number, number[]>();

  const push = (map: Map<number, number[]>, id: number, value: number) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(value);
  };

  for (const m of matches) {
    const homeId = resolveTeam(m.homeTeam);
    const awayId = resolveTeam(m.awayTeam);
    if (homeId === null || awayId === null) continue;

    const { xgHome, xgAway } = expectedGoalsFromMarket(m);
    // Normalise out home advantage before treating these as team traits,
    // so a team that happened to be drawn at home is not credited with a
    // better attack than it has.
    push(scored, homeId, xgHome / BASE_HOME_GOALS);
    push(conceded, homeId, xgAway / BASE_AWAY_GOALS);
    push(scored, awayId, xgAway / BASE_AWAY_GOALS);
    push(conceded, awayId, xgHome / BASE_HOME_GOALS);
  }

  const out = new Map<number, MarketTeamRating>();
  for (const team of teams) {
    const s = scored.get(team.id) ?? [];
    const c = conceded.get(team.id) ?? [];
    const sample = s.length;
    if (sample === 0) {
      out.set(team.id, { attack: 1, defence: 1, sample: 0 });
      continue;
    }
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    // Shrink toward 1 (league average) on a thin sample.
    const trust = Math.min(1, sample / RATING_FULL_TRUST_SAMPLE);
    const attack = clamp(1 + (mean(s) - 1) * trust, RATING_MIN, RATING_MAX);
    const defence = clamp(1 + (mean(c) - 1) * trust, RATING_MIN, RATING_MAX);
    out.set(team.id, { attack, defence, sample });
  }
  return out;
}
