import type { FplElement, FplFixture } from "./types";

/**
 * Individual attacking-threat, reliability and set-piece-duty model.
 *
 * The team-level Poisson model in lib/matchmodel.ts answers "how many
 * goals is THIS TEAM expected to score in this fixture" — it says
 * nothing about WHICH players on that team are actually likely to be
 * involved. Before this file existed, every midfielder/forward on the
 * same team got exactly the same fixture-context number in the scoring
 * formula, and individual differentiation came almost entirely from
 * price/ownership/ICT — none of which directly measure "is this
 * specific player a goal threat". That is a real, structural weakness:
 * it systematically under-ranks good attacking players who haven't yet
 * accumulated market hype/price, even on a genuinely strong attacking
 * team (the trigger for building this: a title-contender squad was
 * showing only a single standout player in the recommendations).
 *
 * FPL's own bootstrap data already includes per-player expected-goals/
 * expected-assists (season-cumulative and per-90) and set-piece duty
 * order — this recovers that signal using only data the app already
 * fetches, no new integration required.
 *
 * Honesty note: these specific field names (expected_goals,
 * expected_goal_involvements_per_90, penalties_order, etc.) are inferred
 * from public documentation of the FPL API maintained by the wider
 * open-source FPL community — this sandbox cannot reach the live FPL API
 * to verify them directly before shipping. Every read here is
 * defensively parsed (missing/renamed field -> 0/null, never a crash) —
 * if a field turns out wrong or absent, that specific signal silently
 * contributes nothing rather than breaking the page. Worth an eyeball
 * check on the live app after this ships (e.g. a well-known penalty
 * taker should show the "marcador de grandes penalidades" reason).
 */

// Safely parses a value that might be a numeric string, a number, null,
// or missing entirely — the FPL API mixes string- and number-typed
// numeric fields across endpoints and has changed this before.
function toNum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface PlayerThreat {
  // Blended per-90 goal-involvement rate: underlying (xG+xA per 90) mixed
  // with actually-realised returns per 90, so neither a "the model says
  // so" number nor a small-sample scoring streak dominates alone.
  blendedGI90: number;
  // 0..1 — how much of this player's own team's matches they actually
  // start, estimated from FPL's `starts` count against the team's
  // finished-fixture count so far. 1 during preseason (no data to
  // penalise on yet) and floored so a genuine star doesn't get zeroed
  // out from a single early absence.
  reliability: number;
  // Small additive bonus (per-90 units) for holding a primary/backup
  // set-piece duty — penalties are worth the most, corners/free-kicks a
  // little less.
  setPieceBonus: number;
  reasons: string[];
}

const PENALTY_BONUS: Record<number, number> = { 1: 0.35, 2: 0.08 };
const FREEKICK_BONUS: Record<number, number> = { 1: 0.12, 2: 0.03 };

export function computePlayerThreat(
  el: FplElement,
  teamFinishedFixtures: number,
  isPreseason: boolean
): PlayerThreat {
  const reasons: string[] = [];

  const xgi90 = toNum(el.expected_goal_involvements_per_90);
  const minutes = toNum(el.minutes);
  const actualGI90 =
    minutes > 0 ? ((toNum(el.goals_scored) + toNum(el.assists)) / minutes) * 90 : 0;
  // 60/40 underlying/realised: underlying numbers are generally the
  // better forward-looking predictor (regression to the mean smooths out
  // finishing variance), but weighting them 100% would ignore a player's
  // own genuine edge over the model (elite finishers, players who
  // over-perform xG consistently, etc).
  const blendedGI90 = xgi90 > 0 || actualGI90 > 0 ? xgi90 * 0.6 + actualGI90 * 0.4 : 0;
  if (blendedGI90 >= 0.5) {
    reasons.push(`ameaça de golo/assistência acima da média (~${blendedGI90.toFixed(2)}/90min)`);
  }

  let reliability = 1;
  if (!isPreseason && teamFinishedFixtures > 0) {
    const starts = toNum(el.starts);
    reliability = Math.min(1, Math.max(0.2, starts / teamFinishedFixtures));
    if (reliability < 0.5) {
      reasons.push(
        `risco de rotação: titular em apenas ${Math.round(reliability * 100)}% dos jogos da equipa esta época`
      );
    }
  }

  let setPieceBonus = 0;
  const penOrder = el.penalties_order ?? null;
  if (penOrder && PENALTY_BONUS[penOrder]) {
    setPieceBonus += PENALTY_BONUS[penOrder];
    reasons.push(penOrder === 1 ? "marcador de grandes penalidades" : "marcador de penalidades suplente");
  }
  const fkOrder = el.direct_freekicks_order ?? el.corners_and_indirect_freekicks_order ?? null;
  if (fkOrder && FREEKICK_BONUS[fkOrder]) {
    setPieceBonus += FREEKICK_BONUS[fkOrder];
    if (fkOrder === 1) reasons.push("responsável por bolas paradas (cantos/livres)");
  }

  return { blendedGI90, reliability, setPieceBonus, reasons };
}

// 2025/26 introduced "defensive contribution" bonus points: +2pts for a
// defender who reaches 10 combined clearances/blocks/interceptions/
// tackles (CBIT) in a match, or 12 CBIRT (adds ball recoveries) for
// midfielders/forwards. `defensive_contribution` (season-cumulative) was
// already being fetched by this app but never used in scoring — a real,
// current points source the model was silently ignoring. Goalkeepers
// don't earn this bonus under the current rules, so they're excluded.
const DC_THRESHOLD: Record<number, number> = { 2: 10, 3: 12, 4: 12 }; // DEF / MID / FWD

export function defensiveContributionFactor(
  el: FplElement,
  elementType: number
): { factor: number; reason: string | null } {
  const threshold = DC_THRESHOLD[elementType];
  if (!threshold) return { factor: 0, reason: null };
  const minutes = toNum(el.minutes);
  if (minutes < 90) return { factor: 0, reason: null };
  const per90 = (toNum(el.defensive_contribution) / minutes) * 90;
  const factor = Math.min(1.3, per90 / threshold);
  const reason =
    factor >= 0.75
      ? `boa contribuição defensiva (~${per90.toFixed(1)}/jogo, limiar ${threshold} para bónus de +2pts)`
      : null;
  return { factor, reason };
}

/** How many of a team's fixtures-so-far have already finished, per team
 * — the denominator `computePlayerThreat` uses to turn a raw `starts`
 * count into a 0..1 reliability share. Needs the FULL fixtures list
 * (past + future), not just upcoming ones. */
export function teamFinishedFixtureCounts(
  teamIds: number[],
  fixtures: FplFixture[]
): Map<number, number> {
  const counts = new Map<number, number>(teamIds.map((id) => [id, 0]));
  for (const f of fixtures) {
    if (!f.finished) continue;
    if (counts.has(f.team_h)) counts.set(f.team_h, (counts.get(f.team_h) ?? 0) + 1);
    if (counts.has(f.team_a)) counts.set(f.team_a, (counts.get(f.team_a) ?? 0) + 1);
  }
  return counts;
}
