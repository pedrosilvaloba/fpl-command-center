import type { FplBootstrap, FplElement, FplTeam } from "./types";
import { averageDifficulty, buildFixtureTicker } from "./fdr";
import { buildFixtureExpectations, windowExpectation } from "./matchmodel";

export interface ScoredPlayer {
  element: FplElement;
  team: FplTeam;
  positionShort: string;
  priceM: number;
  ownershipPct: number;
  formNum: number;
  fixtureAvgDifficulty: number;
  nextOpponents: string; // e.g. "BOU (H), MCI (A), ..."
  expectedGoalsFor: number; // team's avg expected goals over the fixture window
  cleanSheetProbability: number; // team's avg clean-sheet probability over the window
  score: number;
  isDifferential: boolean;
  isPreseason: boolean;
  reasons: string[];
}

const ATTACKING_POSITIONS = new Set([3, 4]); // MID, FWD
const DEFENSIVE_POSITIONS = new Set([1, 2]); // GK, DEF

const POSITION_SHORT: Record<number, string> = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

/**
 * Scores every available (non-injured-out) player for a given upcoming
 * gameweek window. This is a transparent, tunable heuristic — not a
 * black box — designed to match the patterns the research turned up
 * from elite managers: weight underlying quality (price as the market's
 * own valuation, ownership, points-per-game) together with near-term
 * fixture context, and don't overreact to a single gameweek's form.
 *
 * Fixture context comes from lib/matchmodel.ts, not FPL's single 1-5
 * difficulty digit: every team's attack/defence strength ratings are run
 * through a Poisson goal-expectancy model, giving each player a signal
 * specific to their own team's role in that fixture — defenders/keepers
 * are weighted by their team's clean-sheet probability, midfielders/
 * forwards by their team's expected goals-for — instead of every player
 * on a team getting the same generic "easy/hard calendar" bump.
 *
 * Before a ball has been kicked this season (preseason / GW1), in-season
 * form and points are meaningless (everyone is 0), so the weights shift
 * towards price and ownership — the market's pre-season consensus on
 * quality — and fixture context. Once games have been played, form/
 * points-per-game take over as the primary signal.
 *
 * A full xG-differential model built from this season's actual results
 * (once enough of it exists to calibrate one), and simulating outcomes
 * against specific rivals rather than in the abstract, are the next
 * upgrades noted in the README — this is the honest v1.1 baseline.
 * Builds the fixture ticker and match-model expectations once, then
 * scores every player against them — this is what the dashboard calls
 * directly.
 */
export function buildScoredPlayers(
  bootstrap: FplBootstrap,
  fixtures: Parameters<typeof buildFixtureTicker>[1],
  fromEvent: number,
  fixtureWindow = 5
): ScoredPlayer[] {
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const ticker = buildFixtureTicker(bootstrap.teams, fixtures, fromEvent, fixtureWindow);
  const expectationsByTeam = buildFixtureExpectations(bootstrap.teams, fixtures);
  const currentEvent = bootstrap.events.find((e) => e.is_current);
  const isPreseason = !currentEvent;

  const out: ScoredPlayer[] = [];

  for (const el of bootstrap.elements) {
    if (el.status === "u") continue;
    const team = teamById.get(el.team);
    if (!team) continue;

    const priceM = el.now_cost / 10;
    const ownershipPct = parseFloat(el.selected_by_percent) || 0;
    const formNum = parseFloat(el.form) || 0;
    const ppg = parseFloat(el.points_per_game) || 0;
    const ictNum = parseFloat(el.ict_index) || 0;

    const teamFixtures = ticker[team.id] ?? [];
    const fixtureAvgDifficulty = averageDifficulty(teamFixtures);
    const nextOpponents = teamFixtures
      .map((f) => `${f.opponentShort} (${f.isHome ? "C" : "F"})`)
      .join(", ");

    const window = windowExpectation(
      expectationsByTeam.get(team.id),
      fromEvent,
      fixtureWindow
    );
    const { avgGoalsFor: expectedGoalsFor, avgCleanSheetProbability: cleanSheetProbability } = window;

    // Availability penalty: doubtful/injured players get scored down hard
    // even if their underlying numbers are great — a great player who
    // doesn't play is worth 0.
    const availability =
      el.chance_of_playing_next_round === null
        ? 1
        : el.chance_of_playing_next_round / 100;

    let raw: number;
    const reasons: string[] = [];
    const isDefensive = DEFENSIVE_POSITIONS.has(el.element_type);
    const isAttacking = ATTACKING_POSITIONS.has(el.element_type);

    if (isPreseason) {
      // Price is the market's own pre-season valuation of quality;
      // ownership is the collective wisdom of everyone else who has
      // already looked at press-conference/preseason signals. Weights
      // below are tuned so the fixture-context term contributes roughly
      // the same magnitude the old single-digit FDR bump used to — see
      // lib/matchmodel.ts for how these probabilities/goals are derived.
      raw =
        priceM * 1.6 +
        Math.log10(ownershipPct + 1) * 6 +
        (isDefensive ? cleanSheetProbability * 10 : 0) +
        (isAttacking ? expectedGoalsFor * 2 : 0) +
        ictNum * 0.02;
      if (ownershipPct >= 25) reasons.push("escolha consensual do mercado (template)");
      if (ownershipPct < 10 && priceM >= 6) reasons.push("possível diferencial de qualidade");
    } else {
      raw =
        formNum * 2.2 +
        ppg * 1.4 +
        (isDefensive ? cleanSheetProbability * 8 : 0) +
        (isAttacking ? expectedGoalsFor * 1.6 : 0) +
        ictNum * 0.015 +
        Math.log10(ownershipPct + 1) * 1.5;
      if (formNum >= 5) reasons.push("em grande forma recente");
    }

    if (isDefensive && cleanSheetProbability >= 0.35) {
      reasons.push(
        `boa probabilidade de clean sheet nas próximas ${fixtureWindow} jornadas (~${Math.round(cleanSheetProbability * 100)}%)`
      );
    }
    if (isAttacking && expectedGoalsFor >= 1.6) {
      reasons.push(
        `equipa com golos esperados altos nas próximas ${fixtureWindow} jornadas (~${expectedGoalsFor.toFixed(2)}/jogo)`
      );
    }
    if (window.fixtureCount === 0) {
      reasons.push("sem jogos previstos na janela considerada (semana em branco?)");
    }

    raw *= availability;
    if (availability < 1) {
      reasons.push(
        `risco de utilização: ${el.chance_of_playing_next_round}% de hipótese de jogar` +
          (el.news ? ` — ${el.news}` : "")
      );
    }

    out.push({
      element: el,
      team,
      positionShort: POSITION_SHORT[el.element_type] ?? "?",
      priceM,
      ownershipPct,
      formNum,
      fixtureAvgDifficulty,
      nextOpponents,
      expectedGoalsFor: Math.round(expectedGoalsFor * 100) / 100,
      cleanSheetProbability: Math.round(cleanSheetProbability * 1000) / 1000,
      score: Math.round(raw * 100) / 100,
      isDifferential: ownershipPct < 10,
      isPreseason,
      reasons,
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

export interface SquadSlot {
  player: ScoredPlayer;
  isStarter: boolean;
}

/**
 * Greedy, budget- and rule-respecting squad builder (2 GK / 5 DEF / 5 MID
 * / 3 FWD, £100m, max 3 per club). This is a v1 heuristic, not a true
 * optimizer — it allocates a soft per-position budget share drawn from
 * how top-50 finishers actually spend (see lib/strategy.ts), then greedily
 * takes the best-scoring affordable player per position within that
 * sub-budget and club limits. A real linear-programming solver (the
 * approach FPL Review and most open-source FPL optimizers use) is the
 * phase-2 upgrade — flagged in the README roadmap.
 */
export function buildSuggestedSquad(
  scored: ScoredPlayer[],
  budgetM = 100
): { squad: ScoredPlayer[]; starters: ScoredPlayer[]; totalCost: number } {
  const need: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const budgetShare: Record<number, number> = { 1: 0.08, 2: 0.24, 3: 0.4, 4: 0.28 };
  const clubCount = new Map<number, number>();
  const squad: ScoredPlayer[] = [];
  let spent = 0;

  for (const posId of [1, 2, 3, 4]) {
    const posBudget = budgetM * budgetShare[posId];
    const candidates = scored
      .filter((p) => p.element.element_type === posId)
      .sort((a, b) => b.score - a.score);

    let picked = 0;
    let posSpent = 0;
    for (const cand of candidates) {
      if (picked >= need[posId]) break;
      const club = cand.team.id;
      const clubN = clubCount.get(club) ?? 0;
      if (clubN >= 3) continue;
      // Prefer to stay within this position's soft budget, but never
      // block filling the squad — fall back to cheapest remaining need
      // once the window is nearly out on later picks.
      const remainingSlots = need[posId] - picked;
      const affordableGuard =
        posSpent + cand.priceM <= posBudget + 8 || remainingSlots <= 1;
      if (!affordableGuard) continue;
      if (spent + cand.priceM > budgetM) continue;

      squad.push(cand);
      clubCount.set(club, clubN + 1);
      spent += cand.priceM;
      posSpent += cand.priceM;
      picked++;
    }
    // If we still couldn't fill the position (budget too tight), take
    // cheapest remaining eligible candidates regardless of score.
    if (picked < need[posId]) {
      const byPrice = candidates
        .filter((c) => !squad.includes(c))
        .sort((a, b) => a.priceM - b.priceM);
      for (const cand of byPrice) {
        if (picked >= need[posId]) break;
        const club = cand.team.id;
        const clubN = clubCount.get(club) ?? 0;
        if (clubN >= 3) continue;
        if (spent + cand.priceM > budgetM) continue;
        squad.push(cand);
        clubCount.set(club, clubN + 1);
        spent += cand.priceM;
        picked++;
      }
    }
  }

  return { squad, starters: pickBestXI(squad), totalCost: Math.round(spent * 10) / 10 };
}

/**
 * Picks the best-scoring valid starting XI out of an arbitrary 15-player
 * squad (min 3 DEF, 2 MID, 1 FWD, always exactly 1 GK) — shared by the
 * auto-suggested squad and the Shadow Team simulator, so both apply the
 * exact same "who should actually start" logic to whatever 15 players
 * they're given.
 */
export function pickBestXI(squad: ScoredPlayer[]): ScoredPlayer[] {
  const byPos = (id: number) =>
    squad.filter((p) => p.element.element_type === id).sort((a, b) => b.score - a.score);
  const gk = byPos(1).slice(0, 1);
  const def = byPos(2).slice(0, 3);
  const mid = byPos(3).slice(0, 2);
  const fwd = byPos(4).slice(0, 1);
  const chosen = new Set([...gk, ...def, ...mid, ...fwd]);
  const remaining = squad
    .filter((p) => !chosen.has(p) && p.element.element_type !== 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 11 - chosen.size);

  return [...gk, ...def, ...mid, ...fwd, ...remaining];
}

export function pickCaptain(starters: ScoredPlayer[]): {
  captain: ScoredPlayer;
  viceCaptain: ScoredPlayer;
} {
  const ranked = [...starters].sort((a, b) => b.score - a.score);
  return { captain: ranked[0], viceCaptain: ranked[1] };
}

export interface TransferSuggestion {
  out: ScoredPlayer;
  in: ScoredPlayer;
  scoreGain: number;
  priceDeltaM: number; // positive = the incoming player costs more
}

/**
 * Compares an owned squad against the full scored player pool and
 * proposes swaps: for each position, pairs the worst-scoring owned
 * player against the best-scoring unowned alternative. This is a
 * starting point for a decision, not an instruction to execute blindly —
 * it ignores the price-for-price affordability of the swap (shown as
 * priceDeltaM so the manager can judge fit against their own bank) and
 * doesn't yet account for how many free transfers are available or
 * whether a hit would be needed. That planning layer belongs to the
 * automation engine, once it exists.
 */
export function suggestTransfers(
  ownedElementIds: number[],
  scored: ScoredPlayer[],
  perPosition = 2
): TransferSuggestion[] {
  const owned = new Set(ownedElementIds);
  const suggestions: TransferSuggestion[] = [];

  for (const posId of [1, 2, 3, 4]) {
    const ownedInPos = scored
      .filter((p) => p.element.element_type === posId && owned.has(p.element.id))
      .sort((a, b) => a.score - b.score); // worst first

    const bestUnowned = scored
      .filter((p) => p.element.element_type === posId && !owned.has(p.element.id))
      .sort((a, b) => b.score - a.score); // best first

    let inIdx = 0;
    for (const worst of ownedInPos.slice(0, perPosition)) {
      // Skip incoming candidates already used in another suggestion this position.
      while (
        inIdx < bestUnowned.length &&
        suggestions.some((s) => s.in.element.id === bestUnowned[inIdx].element.id)
      ) {
        inIdx++;
      }
      const candidate = bestUnowned[inIdx];
      if (!candidate) continue;
      const scoreGain = candidate.score - worst.score;
      if (scoreGain <= 0) continue; // don't suggest sideways/downgrade swaps
      suggestions.push({
        out: worst,
        in: candidate,
        scoreGain: Math.round(scoreGain * 100) / 100,
        priceDeltaM: Math.round((candidate.priceM - worst.priceM) * 10) / 10,
      });
    }
  }

  return suggestions.sort((a, b) => b.scoreGain - a.scoreGain);
}

export function findDifferentials(
  scored: ScoredPlayer[],
  maxOwnership = 10,
  limit = 8
): ScoredPlayer[] {
  return scored
    .filter((p) => p.ownershipPct < maxOwnership && p.ownershipPct > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
