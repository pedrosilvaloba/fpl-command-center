import type { ScoredPlayer } from "./recommend";
import { effectiveOwnershipShare } from "./optimizer";

/**
 * Rank-relative value — the metric that actually decides mini-leagues.
 *
 * THE CONCEPTUAL ERROR THIS FIXES
 * ------------------------------
 * Every version of this model until now optimised TOTAL EXPECTED POINTS.
 * That is the right objective for exactly one goal: maximising your own
 * score in isolation. It is the wrong objective for the goal the owner of
 * this app actually has, which is finishing above specific people in a
 * specific league.
 *
 * FPL is a RANK game. What moves you up is not points — it is points your
 * rivals did not also get. Consider two players with identical expected
 * points:
 *
 *   - Owned by 65% of managers. If he hauls, almost everyone hauls with
 *     you: you gain nothing on the field. If he blanks, almost everyone
 *     blanks: you lose nothing. Owning him is close to rank-neutral. NOT
 *     owning him, though, is a large one-sided risk.
 *   - Owned by 4%. If he hauls, you gain on 96% of the field. If he
 *     blanks, you lose to the 96% who spent their money better.
 *
 * Identical expected points, completely different effects on rank. A model
 * that sums expected points cannot tell them apart, and will therefore
 * quietly build the template — the squad that guarantees you finish
 * exactly where everyone else does.
 *
 * WHAT THIS COMPUTES
 * ------------------
 * `rankValue` = expected points × (1 − ownership share).
 *
 * This is the expected gain ON THE FIELD from owning a player: his points,
 * minus the share of those points the average rival already banks by
 * owning him too. It is the standard "effective ownership" reasoning
 * expressed per player.
 *
 * WHY IT IS NOT SIMPLY BETTER
 * ---------------------------
 * Chasing rank value alone builds a squad of differentials, which is a
 * high-variance strategy — brilliant when it works, catastrophic when it
 * does not, and the wrong choice for a manager protecting a lead. Nor is
 * it symmetric: NOT owning a heavily-owned player who hauls costs you rank
 * even though the model never had to buy him, which is why template picks
 * are not simply avoidable.
 *
 * So this ships as a SECOND lens, shown alongside expected points rather
 * than replacing it. Which one to weight is a strategic choice that
 * depends on league position — the thing the rival-simulation layer is
 * meant to answer. Presenting both, and being explicit that they disagree,
 * is more honest than silently picking one.
 */

export interface RankValued {
  player: ScoredPlayer;
  /** Expected points for the next gameweek. */
  expectedPoints: number;
  /** Fraction of managers who own this player (0-1). */
  ownershipShare: number;
  /** expectedPoints × (1 − ownershipShare): expected gain on the field. */
  rankValue: number;
  /** What owning him costs you in rank if he blanks and the field owns
   * him — i.e. the one-sided risk of NOT owning a template pick. */
  templateRisk: number;
}

export function computeRankValue(player: ScoredPlayer): RankValued {
  // Projected, not current — see effectiveOwnershipShare in lib/optimizer.ts.
  const ownershipShare = effectiveOwnershipShare(player);
  const expectedPoints = player.expectedPointsNext;
  return {
    player,
    expectedPoints,
    ownershipShare,
    rankValue: Math.round(expectedPoints * (1 - ownershipShare) * 100) / 100,
    // The mirror image: what the field gains on YOU if you do not own him.
    templateRisk: Math.round(expectedPoints * ownershipShare * 100) / 100,
  };
}

export interface SquadRankProfile {
  /** Sum of the eleven's rank value — expected gain on the average rival. */
  totalRankValue: number;
  /** Sum of the eleven's raw expected points. */
  totalExpectedPoints: number;
  /** Average ownership of the eleven, weighted by expected points. Above
   * ~35% is a template squad; below ~15% is an aggressive differential
   * squad. */
  weightedOwnership: number;
  /** Players in the eleven owned by more than 40% — the picks that cannot
   * gain you rank, only protect it. */
  templatePicks: RankValued[];
  /** Players in the eleven owned by less than 10% — where any rank gain
   * has to come from. */
  differentials: RankValued[];
  /** The heavily-owned players NOT in the squad. Each is a standing,
   * one-sided risk: if they haul, the field gains on you and there is
   * nothing in your team that offsets it. */
  missingTemplate: RankValued[];
  verdict: string;
}

const TEMPLATE_THRESHOLD = 40;
const DIFFERENTIAL_THRESHOLD = 10;

export function computeSquadRankProfile(
  starters: ScoredPlayer[],
  allPlayers: ScoredPlayer[]
): SquadRankProfile {
  const valued = starters.map(computeRankValue);
  const totalRankValue =
    Math.round(valued.reduce((s, v) => s + v.rankValue, 0) * 100) / 100;
  const totalExpectedPoints =
    Math.round(valued.reduce((s, v) => s + v.expectedPoints, 0) * 100) / 100;

  const pointsSum = valued.reduce((s, v) => s + Math.max(0, v.expectedPoints), 0);
  const weightedOwnership =
    pointsSum > 0
      ? Math.round(
          (valued.reduce(
            (s, v) => s + v.ownershipShare * Math.max(0, v.expectedPoints),
            0
          ) /
            pointsSum) *
            1000
        ) / 10
      : 0;

  const templatePicks = valued
    .filter((v) => effectiveOwnershipShare(v.player) * 100 >= TEMPLATE_THRESHOLD)
    .sort((a, b) => b.player.ownershipPct - a.player.ownershipPct);
  const differentials = valued
    .filter((v) => effectiveOwnershipShare(v.player) * 100 < DIFFERENTIAL_THRESHOLD)
    .sort((a, b) => b.rankValue - a.rankValue);

  // Heavily-owned players you do NOT have. Ranked by how much damage they
  // do to your rank if they return.
  const ownedIds = new Set(starters.map((p) => p.element.id));
  const missingTemplate = allPlayers
    .filter(
      (p) => !ownedIds.has(p.element.id) && effectiveOwnershipShare(p) * 100 >= TEMPLATE_THRESHOLD
    )
    .map(computeRankValue)
    .sort((a, b) => b.templateRisk - a.templateRisk)
    .slice(0, 5);

  let verdict: string;
  if (weightedOwnership >= 35) {
    verdict =
      "Onze próximo do template. Protege o teu lugar mas dificilmente te faz subir — se estás atrás na liga, precisas de mais risco.";
  } else if (weightedOwnership <= 15) {
    verdict =
      "Onze muito diferencial. Alto potencial de subida e alto risco de queda — adequado se estás a recuperar terreno, arriscado se estás à frente.";
  } else {
    verdict =
      "Onze equilibrado entre template e diferenciais — nem se limita a acompanhar o pelotão, nem aposta tudo numa cartada.";
  }

  return {
    totalRankValue,
    totalExpectedPoints,
    weightedOwnership,
    templatePicks,
    differentials,
    missingTemplate,
    verdict,
  };
}
