import type { FplBootstrap, FplElement, FplTeam } from "./types";
import { averageDifficulty, buildFixtureTicker } from "./fdr";
import {
  buildFixtureExpectations,
  windowExpectation,
  poissonQuantile,
  BASE_HOME_GOALS,
  BASE_AWAY_GOALS,
} from "./matchmodel";
import type { OddsMatch } from "./oddsapi";
import { computeDynamicTeamFactors } from "./teamrating";
import {
  computePlayerThreat,
  defensiveContributionFactor,
  teamFinishedFixtureCounts,
} from "./playerthreat";

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
  individualExpectedGI: number; // this player's own expected goal involvements over the window
  ceilingGI: number; // rough 85th-percentile outcome for individualExpectedGI
  floorGI: number; // rough 15th-percentile outcome for individualExpectedGI
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

// Neutral per-fixture goal baseline — the average of the two home/away
// baselines the Poisson model itself is built on (lib/matchmodel.ts) —
// used only to express "is this team's window better/worse than a
// neutral fixture run", as a ratio. Re-derives from the same constants
// matchmodel.ts uses (rather than a second hand-picked number) so the two
// stay in sync if that model's baseline is ever retuned.
const NEUTRAL_PER_FIXTURE_GOALS = (BASE_HOME_GOALS + BASE_AWAY_GOALS) / 2;

// Score-formula calibration constants. These are a first pass, not a
// backtested optimum — lib/accuracy.ts is what lets that claim actually
// get checked against real results over the season, and these are the
// first numbers worth revisiting once it has enough data.
// v1.8 shipped individualExpectedGI with ATTACK_MULTIPLIER = 0.5, which
// LOOKED like a reasonable, proportionate number in isolation but turned
// out to be a mistake once actually checked against the OTHER terms in
// the same formula: for a real early-season top forward vs. a solid-but-
// less-hyped teammate, formNum*1.8 + ppg*1.4 alone accounted for roughly
// 8x more of the score gap between them than individualExpectedGI*0.5
// did. The new signal was real and correctly differentiated the two
// players — it just couldn't outweigh form/points-per-game, which (early
// in a season, on tiny sample sizes) are themselves largely driven by
// who has already had a big haul, i.e. close to the same "whoever got
// hot/hyped first wins" dynamic the individual-threat model was built to
// counteract. Net effect: a real fix that was mathematically too small
// to change any actual ranking, which is exactly what showed up as "the
// suggested squad hasn't changed." Raised roughly 6x here so the new
// signal is comparable in weight to form+ppg rather than a rounding
// error next to them — see the in-season formula below for how this
// plays out, and lib/accuracy.ts for how to check, with real results,
// whether this new weighting is actually better rather than just louder.
const ATTACK_MULTIPLIER = 3.0; // in-season: individualExpectedGI -> score
const ATTACK_MULTIPLIER_PRESEASON = 0.6;
const DEF_ATTACK_UPSIDE_MULTIPLIER = 1.8; // defenders' own attacking threat — same 6x correction as ATTACK_MULTIPLIER, still smaller than their clean-sheet term
const DC_WEIGHT = 1.0; // defensive-contribution-bonus proximity, DEF/MID
// "Form" (FPL's 30-day rolling metric) is at its most volatile/least
// trustworthy exactly when a player has the fewest minutes to back it up
// — a single big early haul can inflate it on a near-meaningless sample.
// This ramps form's weight from 40% up to 100% as a player accumulates
// their first ~3 full matches of minutes, rather than trusting it fully
// from minute one. Same "don't over-trust a small sample" principle
// lib/teamrating.ts already applies to team-level results.
const FORM_TRUST_MINUTES = 270; // ~3 full matches

/**
 * Scores every available (non-injured-out) player for a given upcoming
 * gameweek window. This is a transparent, tunable heuristic — not a
 * black box — designed to match the patterns the research turned up
 * from elite managers: weight underlying quality (price as the market's
 * own valuation, ownership, points-per-game) together with near-term
 * fixture context, and don't overreact to a single gameweek's form.
 *
 * Fixture context comes from lib/matchmodel.ts, not FPL's single 1-5
 * difficulty digit: every team's attack/defence strength ratings — now
 * additionally corrected by lib/teamrating.ts's in-season, self-updating
 * signal built from this season's actual results, on top of FPL's own
 * static ratings — are run through a Poisson goal-expectancy model.
 *
 * That team-level number alone isn't enough, though: it says how many
 * goals a TEAM is expected to score, not which of that team's players
 * are actually likely to be the ones scoring/assisting them. Every
 * attacker on the same team used to get exactly the same team-level
 * number here — the single biggest structural weakness identified in a
 * review of this model (a genuinely strong attacking team was showing
 * only one standout recommended player, because the "team goals" term
 * couldn't tell its players apart, leaving price/ownership — which move
 * slowly and unevenly across a squad — to do almost all the
 * differentiating). lib/playerthreat.ts fixes this using FPL's own
 * per-player expected-goals/expected-assists, starts (rotation
 * reliability) and set-piece duty data — already fetched, never
 * previously used — to give each attacker (and each attacking-minded
 * defender) their own fixture-and-role-aware expected goal involvement,
 * computed below as `individualExpectedGI`. Defenders/keepers are still
 * primarily weighted by their team's clean-sheet probability (a
 * genuinely team-shared outcome, unlike scoring), plus a smaller
 * individual-attacking-upside term and a defensive-contribution-bonus
 * proximity term (see lib/playerthreat.ts — a real 2025/26 scoring
 * mechanism this model was fetching data for but never using).
 *
 * Before a ball has been kicked this season (preseason / GW1), in-season
 * form and points are meaningless (everyone is 0), so the weights shift
 * towards price and ownership — the market's pre-season consensus on
 * quality — and fixture context. Once games have been played, form/
 * points-per-game/individual-threat take over as the primary signal.
 *
 * When betting-market odds are available (`oddsMatches`, optional —
 * requires an ODDS_API_KEY, see lib/oddsapi.ts), the match model above
 * additionally nudges each fixture towards what the market implies —
 * bookmakers price in team news, tactical changes and expert analysis
 * almost as soon as it's known, so this is how the app captures "the eye
 * test" and public expert opinion without any subjective judgment of our
 * own. Without a key configured, this runs on the statistical model
 * alone — a real, honest fallback, not a broken state.
 *
 * Simulating outcomes against specific rivals rather than in the
 * abstract (Camada 2 of the roadmap) is the next upgrade, now that this
 * gives it a gameweek-aware, individually-attributed foundation to build
 * on instead of a flat team-level average. Builds the fixture ticker and
 * match-model expectations once, then scores every player against them —
 * this is what the dashboard calls directly.
 */
export function buildScoredPlayers(
  bootstrap: FplBootstrap,
  fixtures: Parameters<typeof buildFixtureTicker>[1],
  fromEvent: number,
  fixtureWindow = 5,
  oddsMatches: OddsMatch[] | null = null
): ScoredPlayer[] {
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const ticker = buildFixtureTicker(bootstrap.teams, fixtures, fromEvent, fixtureWindow);
  const teamFactors = computeDynamicTeamFactors(bootstrap.teams, fixtures);
  const expectationsByTeam = buildFixtureExpectations(bootstrap.teams, fixtures, oddsMatches, teamFactors);
  const teamFinishedFixtures = teamFinishedFixtureCounts(bootstrap.teams.map((t) => t.id), fixtures);
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
    // Display fields stay per-fixture averages (readable as "~X/jogo");
    // the score itself is driven by the WINDOW TOTAL below, so a double
    // gameweek inside the window correctly counts as more opportunity
    // rather than being averaged away.
    const { avgGoalsFor: expectedGoalsFor, avgCleanSheetProbability: cleanSheetProbability } = window;
    const { totalCleanSheetProbability } = window;

    const isDefensive = DEFENSIVE_POSITIONS.has(el.element_type);
    const isAttacking = ATTACKING_POSITIONS.has(el.element_type);

    const threat = computePlayerThreat(el, teamFinishedFixtures.get(team.id) ?? 0, isPreseason);
    const dc = defensiveContributionFactor(el, el.element_type);
    const minutesPlayed = el.minutes ?? 0;
    // 0.4 at 0 minutes (never fully zeroed — even one big haul is *some*
    // evidence) ramping to 1.0 by FORM_TRUST_MINUTES.
    const formTrust = 0.4 + 0.6 * Math.min(1, minutesPlayed / FORM_TRUST_MINUTES);

    // This player's own expected goal involvement for the window: their
    // blended per-90 rate (+ set-piece duty), scaled by how much better/
    // worse than a neutral fixture run this team's window actually is,
    // by how many of those minutes this player is reliably on the pitch
    // for, and by how many fixtures are actually in the window (so a
    // double gameweek is worth roughly double for this player too, not
    // just for the team-level total).
    const fixtureRunFactor =
      window.fixtureCount > 0
        ? window.totalGoalsFor / (window.fixtureCount * NEUTRAL_PER_FIXTURE_GOALS)
        : 1;
    const individualExpectedGI = isPreseason
      ? 0
      : (threat.blendedGI90 + threat.setPieceBonus) *
        fixtureRunFactor *
        threat.reliability *
        window.fixtureCount;

    const ceilingGI = poissonQuantile(individualExpectedGI, 0.85);
    const floorGI = poissonQuantile(individualExpectedGI, 0.15);

    // Availability penalty: doubtful/injured players get scored down hard
    // even if their underlying numbers are great — a great player who
    // doesn't play is worth 0.
    const availability =
      el.chance_of_playing_next_round === null
        ? 1
        : el.chance_of_playing_next_round / 100;

    let raw: number;
    const reasons: string[] = [];

    if (isPreseason) {
      // Price is the market's own pre-season valuation of quality;
      // ownership is the collective wisdom of everyone else who has
      // already looked at press-conference/preseason signals. No
      // underlying-stats history exists yet this early, so
      // individualExpectedGI is 0 and the team-level window total is
      // used instead, same as before — multipliers below are calibrated
      // for the default 5-gameweek window (see lib/matchmodel.ts for how
      // these numbers are derived; re-tune if fixtureWindow changes
      // materially from 5).
      raw =
        priceM * 1.6 +
        Math.log10(ownershipPct + 1) * 6 +
        (isDefensive ? totalCleanSheetProbability * 2 : 0) +
        (isAttacking ? window.totalGoalsFor * ATTACK_MULTIPLIER_PRESEASON : 0) +
        ictNum * 0.02;
      if (ownershipPct >= 25) reasons.push("escolha consensual do mercado (template)");
      if (ownershipPct < 10 && priceM >= 6) reasons.push("possível diferencial de qualidade");
    } else {
      raw =
        formNum * 1.0 * formTrust +
        ppg * 1.4 +
        (isDefensive ? totalCleanSheetProbability * 1.6 : 0) +
        (isAttacking ? individualExpectedGI * ATTACK_MULTIPLIER : 0) +
        (isDefensive && el.element_type === 2
          ? individualExpectedGI * DEF_ATTACK_UPSIDE_MULTIPLIER
          : 0) +
        (isDefensive || isAttacking ? dc.factor * DC_WEIGHT : 0) +
        ictNum * 0.015 +
        Math.log10(ownershipPct + 1) * 1.5;
      if (formNum >= 5) reasons.push("em grande forma recente");
      if (minutesPlayed < FORM_TRUST_MINUTES) {
        reasons.push(
          `amostra ainda pequena (${minutesPlayed}min esta época) — forma/pontos por jogo pesam menos até acumular mais jogos`
        );
      }
      reasons.push(...threat.reasons);
      if (dc.reason) reasons.push(dc.reason);
      if (ceilingGI - floorGI >= 2 && individualExpectedGI > 0) {
        reasons.push("perfil de risco/recompensa: potencial de teto alto, mas resultado pode variar bastante");
      }
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
    if (window.hasDoubleGameweek) {
      reasons.push(`inclui jornada dupla nas próximas ${fixtureWindow} jornadas`);
    }
    if (window.hasBlankGameweek || window.fixtureCount === 0) {
      reasons.push(
        window.fixtureCount === 0
          ? "sem jogos previstos na janela considerada (semana em branco?)"
          : `inclui possível jornada em branco nas próximas ${fixtureWindow} jornadas`
      );
    }
    if (window.anyMarketAdjusted) {
      reasons.push("ajustado com odds de mercado");
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
      individualExpectedGI: Math.round(individualExpectedGI * 100) / 100,
      ceilingGI,
      floorGI,
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
