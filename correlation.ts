import type { ScoredPlayer } from "./recommend";

/**
 * Correlation risk — the variance a squad carries because FPL points are
 * NOT independent between team-mates.
 *
 * WHY THIS MATTERS, AND WHY EXPECTED POINTS ALONE CANNOT SEE IT
 * ------------------------------------------------------------
 * A clean sheet is a single event. If you start a goalkeeper and two
 * defenders from the same club, those three players do not have three
 * independent chances of returning — they have ONE. The team either keeps
 * the clean sheet and all three collect, or concedes and all three get
 * nothing (and start losing a point for every second goal). The expected
 * value of that block is exactly the same as three defenders from three
 * different clubs. The VARIANCE is roughly three times larger.
 *
 * The same logic applies, more weakly, at the other end: a team's
 * attackers are competing for and sharing the same goals, so their returns
 * are positively correlated with team goals scored and with each other.
 *
 * A model that sums expected points is blind to all of this. It will
 * happily concentrate a squad into one club's defence and report the same
 * number it would report for a diversified squad, because on average they
 * ARE the same. What differs is the distribution.
 *
 * IMPORTANT: STACKING IS NOT A MISTAKE
 * ------------------------------------
 * This module deliberately does NOT treat concentration as something to be
 * eliminated. Loading up on one strong defence before a run of favourable
 * fixtures is a well-established, often correct play. Whether you WANT
 * variance depends on something this model does not know: your position in
 * the league you actually care about. A manager chasing the leader needs
 * variance; a manager protecting a lead needs to suppress it.
 *
 * So the job here is to measure the exposure and make it visible, and to
 * make the optimizer pay a small, explicit price for concentration rather
 * than stumbling into it blindly — not to forbid it.
 */

/** Positions whose return depends on the team's clean sheet. */
const CLEAN_SHEET_DEPENDENT = new Set([1, 2]); // GK, DEF
/** Positions whose return depends on the team scoring. */
const GOAL_DEPENDENT = new Set([3, 4]); // MID, FWD

/** FPL clean-sheet points by position. */
const CLEAN_SHEET_POINTS: Record<number, number> = { 1: 4, 2: 4, 3: 1, 4: 0 };

/**
 * How strongly two attackers from the same club move together. Less than
 * 1 because they share the team's goals rather than a single shared event
 * — one can blank while the other hauls. A rough, deliberately
 * conservative figure; the clean-sheet side is where the real
 * concentration risk lives, and that one is exact rather than estimated.
 */
const ATTACK_CORRELATION = 0.35;

export interface TeamExposure {
  teamId: number;
  teamShort: string;
  /** Starters whose points depend on this team's clean sheet. */
  cleanSheetPlayers: ScoredPlayer[];
  /** Starters whose points depend on this team scoring. */
  goalPlayers: ScoredPlayer[];
  /** This team's clean-sheet probability for the next gameweek. */
  cleanSheetProbability: number;
  /** Points riding on a single clean-sheet outcome. */
  pointsOnCleanSheet: number;
}

export interface SquadRisk {
  expectedPoints: number;
  /** Standard deviation of the XI's points, accounting for within-club
   * correlation. Compare against `independentStdDev` to see the cost of
   * concentration. */
  stdDev: number;
  /** What the standard deviation would be if every player were
   * independent — i.e. the same squad spread across different clubs. */
  independentStdDev: number;
  /** stdDev / independentStdDev. 1.0 = fully diversified. */
  concentrationRatio: number;
  /**
   * The same ratio computed over the CLEAN-SHEET block alone.
   *
   * The overall ratio is diluted by the attacking half of the eleven,
   * which is far less correlated — so a squad with a genuinely extreme
   * defensive stack can still show an unalarming overall figure. This
   * isolates the concentration that actually behaves as one bet.
   */
  defensiveConcentrationRatio: number;
  exposures: TeamExposure[];
  warnings: string[];
}

function toShort(p: ScoredPlayer): string {
  return p.team?.short_name ?? "?";
}

/** Groups the starting eleven by club and by what each player's points
 * actually depend on. */
export function computeTeamExposures(starters: ScoredPlayer[]): TeamExposure[] {
  const byTeam = new Map<number, TeamExposure>();
  for (const p of starters) {
    const teamId = p.team?.id;
    if (teamId === undefined) continue;
    if (!byTeam.has(teamId)) {
      byTeam.set(teamId, {
        teamId,
        teamShort: toShort(p),
        cleanSheetPlayers: [],
        goalPlayers: [],
        cleanSheetProbability: p.cleanSheetProbability,
        pointsOnCleanSheet: 0,
      });
    }
    const exposure = byTeam.get(teamId)!;
    if (CLEAN_SHEET_DEPENDENT.has(p.element.element_type)) {
      exposure.cleanSheetPlayers.push(p);
      exposure.pointsOnCleanSheet += CLEAN_SHEET_POINTS[p.element.element_type] ?? 0;
    } else if (GOAL_DEPENDENT.has(p.element.element_type)) {
      exposure.goalPlayers.push(p);
      exposure.pointsOnCleanSheet += CLEAN_SHEET_POINTS[p.element.element_type] ?? 0;
    }
  }
  return [...byTeam.values()].sort(
    (a, b) => b.pointsOnCleanSheet - a.pointsOnCleanSheet
  );
}

/**
 * Variance of the starting eleven's next-gameweek points, modelling the
 * clean sheet as a single shared Bernoulli event per club (which is
 * exactly what it is) and attacking returns as positively but imperfectly
 * correlated within a club.
 *
 * This is an approximation of the true distribution — it ignores bonus
 * points, cards, and the correlation between a team keeping a clean sheet
 * and its own attackers scoring. It is built to answer one question
 * honestly: how much more exposed is THIS squad than the same players
 * spread across different clubs.
 */
export function computeSquadRisk(starters: ScoredPlayer[]): SquadRisk {
  const exposures = computeTeamExposures(starters);
  const expectedPoints = starters.reduce((s, p) => s + p.expectedPointsNext, 0);

  let correlatedVariance = 0;
  let independentVariance = 0;
  let defensiveCorrelated = 0;
  let defensiveIndependent = 0;

  for (const exposure of exposures) {
    const p = Math.min(0.95, Math.max(0.02, exposure.cleanSheetProbability));

    // --- clean-sheet block: ONE Bernoulli event shared by every
    // clean-sheet-dependent starter from this club.
    const csPointsPerPlayer = exposure.cleanSheetPlayers.map(
      (pl) => CLEAN_SHEET_POINTS[pl.element.element_type] ?? 0
    );
    const csTotal = csPointsPerPlayer.reduce((s, v) => s + v, 0);
    // Perfectly correlated: the whole block's payout is csTotal or nothing.
    const csCorrelated = csTotal * csTotal * p * (1 - p);
    // Independent counterfactual: each player's own Bernoulli.
    const csIndependent = csPointsPerPlayer.reduce(
      (s, v) => s + v * v * p * (1 - p),
      0
    );
    correlatedVariance += csCorrelated;
    independentVariance += csIndependent;
    defensiveCorrelated += csCorrelated;
    defensiveIndependent += csIndependent;

    // --- attacking block: partially correlated. Uses each player's own
    // expected points as a scale for how much is at stake.
    const attackScales = exposure.goalPlayers.map((pl) =>
      Math.max(0, pl.expectedPointsNext)
    );
    // Var(sum) = sum(var) + 2*rho*sum over pairs(sd_i * sd_j).
    // Treats each attacker's points as having sd roughly equal to their
    // mean, which is about right for a low-count, spiky distribution.
    const attackIndependent = attackScales.reduce((s, v) => s + v * v, 0);
    let pairCovariance = 0;
    for (let i = 0; i < attackScales.length; i++) {
      for (let j = i + 1; j < attackScales.length; j++) {
        pairCovariance += 2 * ATTACK_CORRELATION * attackScales[i] * attackScales[j];
      }
    }
    correlatedVariance += attackIndependent + pairCovariance;
    independentVariance += attackIndependent;
  }

  const stdDev = Math.sqrt(correlatedVariance);
  const independentStdDev = Math.sqrt(independentVariance);
  const concentrationRatio = independentStdDev > 0 ? stdDev / independentStdDev : 1;
  const defensiveConcentrationRatio =
    defensiveIndependent > 0
      ? Math.sqrt(defensiveCorrelated) / Math.sqrt(defensiveIndependent)
      : 1;

  const warnings: string[] = [];
  for (const e of exposures) {
    if (e.cleanSheetPlayers.length >= 3) {
      warnings.push(
        `${e.cleanSheetPlayers.length} jogadores defensivos do ${e.teamShort} no onze — ${Math.round(
          (1 - e.cleanSheetProbability) * 100
        )}% de probabilidade de todos falharem o clean sheet no mesmo jogo`
      );
    }
    if (e.goalPlayers.length >= 3) {
      warnings.push(
        `${e.goalPlayers.length} jogadores ofensivos do ${e.teamShort} no onze — dependem todos dos mesmos golos`
      );
    }
  }

  return {
    expectedPoints: Math.round(expectedPoints * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    independentStdDev: Math.round(independentStdDev * 100) / 100,
    concentrationRatio: Math.round(concentrationRatio * 1000) / 1000,
    defensiveConcentrationRatio: Math.round(defensiveConcentrationRatio * 1000) / 1000,
    exposures,
    warnings,
  };
}
