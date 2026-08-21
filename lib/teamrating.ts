import type { FplFixture, FplTeam } from "./types";

/**
 * A lightweight, self-updating team-strength signal built from this
 * season's ACTUAL results — separate from FPL's own strength_* ratings
 * in bootstrap.teams, which are an opaque, infrequently-refreshed
 * internal number that can lag behind reality (a squad genuinely
 * upgraded over the summer, or hitting real current form, won't show up
 * there until FPL themselves decide to revise it).
 *
 * Two independent signals get folded through every finished fixture:
 *   1. An Elo-style rating (same family as the well-known "World
 *      Football Elo Ratings" method) — win/draw/loss plus margin of
 *      victory, with a ~100pt home-advantage adjustment baked into the
 *      expected-result calculation.
 *   2. Plain goals-for/against rate relative to the league average —
 *      because the Poisson model in lib/matchmodel.ts needs an
 *      attack/defence SPLIT, not just one overall "how good" number, and
 *      Elo alone can't provide that split.
 *
 * The returned attack/defence factors are driven by (2), damped by a
 * trust ramp on games played — at 0 finished matches every factor is
 * exactly 1.0 (no change at all from FPL's own ratings), and trust
 * builds up to a cap by ~8 matches played. This is deliberate: early in
 * the season there is no real "this season" signal yet, so the model
 * should keep relying on FPL's static ratings and the (already dynamic)
 * market-odds tilt; as results accumulate, this starts correcting the
 * Poisson inputs with genuinely-earned, this-season evidence instead of
 * waiting for FPL to eventually revise its own number.
 *
 * The Elo rating itself is also exposed per team (not currently wired
 * into the Poisson factors) — kept because it's the natural building
 * block for Camada 2 of the roadmap (simulating specific matches against
 * league rivals), so it doesn't need to be built twice.
 *
 * Recomputes the full rating history from the fixtures array on every
 * request rather than persisting state — a Premier League season is at
 * most a few hundred finished matches, sub-millisecond to fold through
 * in JS, and this avoids any stale-cache correctness risk.
 */

const BASELINE_ELO = 1500;
const HOME_ADVANTAGE_ELO = 100;
const K_BASE = 20;
// Clamp how far a team's in-season signal can pull the Poisson
// attack/defence factors away from 1.0 — same defensive philosophy as
// the market-odds tilt in matchmodel.ts: a small sample of results (one
// freak scoreline) shouldn't be allowed to dominate the model.
const MIN_FACTOR = 0.8;
const MAX_FACTOR = 1.25;
// Number of finished matches at which trust in the in-season signal
// reaches its cap.
const TRUST_RAMP_MATCHES = 8;

function expectedResult(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// The standard World-Football-Elo goal-difference multiplier: routine
// results (0 or 1 goal difference) get the base K-factor; bigger margins
// get progressively more weight, since a 4-0 is stronger evidence of a
// quality gap than a 1-0.
function goalDiffMultiplier(goalDiff: number): number {
  const n = Math.abs(goalDiff);
  if (n <= 1) return 1;
  if (n === 2) return 1.5;
  return (11 + n) / 8;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export interface TeamFactor {
  elo: number;
  attackFactor: number;
  defenceFactor: number;
  finishedMatches: number;
}

export function computeDynamicTeamFactors(
  teams: FplTeam[],
  fixtures: FplFixture[]
): Map<number, TeamFactor> {
  const elo = new Map<number, number>(teams.map((t) => [t.id, BASELINE_ELO]));
  const goalsFor = new Map<number, number>(teams.map((t) => [t.id, 0]));
  const goalsAgainst = new Map<number, number>(teams.map((t) => [t.id, 0]));
  const played = new Map<number, number>(teams.map((t) => [t.id, 0]));

  const finished = fixtures
    .filter(
      (f) =>
        f.finished &&
        f.team_h_score !== null &&
        f.team_a_score !== null &&
        elo.has(f.team_h) &&
        elo.has(f.team_a)
    )
    .sort((a, b) => (a.event ?? 0) - (b.event ?? 0));

  for (const f of finished) {
    const homeElo = elo.get(f.team_h)!;
    const awayElo = elo.get(f.team_a)!;
    const homeExpected = expectedResult(homeElo + HOME_ADVANTAGE_ELO, awayElo);
    const hs = f.team_h_score!;
    const as = f.team_a_score!;
    const homeActual = hs > as ? 1 : hs === as ? 0.5 : 0;
    const mult = goalDiffMultiplier(hs - as);
    const delta = K_BASE * mult * (homeActual - homeExpected);

    elo.set(f.team_h, homeElo + delta);
    elo.set(f.team_a, awayElo - delta);

    goalsFor.set(f.team_h, (goalsFor.get(f.team_h) ?? 0) + hs);
    goalsAgainst.set(f.team_h, (goalsAgainst.get(f.team_h) ?? 0) + as);
    goalsFor.set(f.team_a, (goalsFor.get(f.team_a) ?? 0) + as);
    goalsAgainst.set(f.team_a, (goalsAgainst.get(f.team_a) ?? 0) + hs);
    played.set(f.team_h, (played.get(f.team_h) ?? 0) + 1);
    played.set(f.team_a, (played.get(f.team_a) ?? 0) + 1);
  }

  const leagueAvgGoalsPerMatch =
    finished.length > 0
      ? finished.reduce((s, f) => s + (f.team_h_score ?? 0) + (f.team_a_score ?? 0), 0) /
        (finished.length * 2)
      : 1.35;

  const result = new Map<number, TeamFactor>();
  for (const team of teams) {
    const n = played.get(team.id) ?? 0;
    const eloRating = elo.get(team.id) ?? BASELINE_ELO;
    if (n === 0) {
      result.set(team.id, { elo: eloRating, attackFactor: 1, defenceFactor: 1, finishedMatches: 0 });
      continue;
    }
    const avgFor = (goalsFor.get(team.id) ?? 0) / n;
    const avgAgainst = (goalsAgainst.get(team.id) ?? 0) / n;
    const attackRate = avgFor / (leagueAvgGoalsPerMatch || 1);
    // Higher = fewer goals conceded than a league-average defence.
    const defenceRate = (leagueAvgGoalsPerMatch || 1) / (avgAgainst || leagueAvgGoalsPerMatch || 1);

    const trust = Math.min(1, n / TRUST_RAMP_MATCHES);
    const attackFactor = clamp(1 + (attackRate - 1) * trust, MIN_FACTOR, MAX_FACTOR);
    const defenceFactor = clamp(1 + (defenceRate - 1) * trust, MIN_FACTOR, MAX_FACTOR);

    result.set(team.id, { elo: eloRating, attackFactor, defenceFactor, finishedMatches: n });
  }
  return result;
}
