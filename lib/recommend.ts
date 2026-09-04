import type { FplBootstrap, FplElement, FplTeam } from "./types";
import { averageDifficulty, buildFixtureTicker } from "./fdr";
import {
  buildFixtureExpectations,
  windowExpectation,
  poissonQuantile,
} from "./matchmodel";
import type { OddsMatch } from "./oddsapi";
import { computeDynamicTeamFactors } from "./teamrating";
import { teamFinishedFixtureCounts } from "./playerthreat";
import {
  computeMinutesModel,
  computePlayerRates,
  expectedPointsForFixture,
  scaleBreakdown,
  modelTrust,
  type ExpectedPointsBreakdown,
} from "./expectedpoints";
import {
  MANAGER_INSIGHTS,
  filterInsights,
  formatInsightReason,
  effectiveFactor,
  insightAppliesToEvent,
} from "./managerinsights";
import type { ManagerInsight } from "./managerinsights";
import type { ModelParams } from "./modelparams";
import { computeMomentum, momentumReason } from "./momentum";

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
  /**
   * Expected FPL points over the whole fixture window. THIS IS THE SCORE —
   * `score` is kept as an alias so nothing downstream breaks, but both are
   * now in real points rather than arbitrary units. That means they can be
   * compared across positions, and a -4 transfer hit can finally be priced
   * against them.
   */
  expectedPoints: number;
  /**
   * Expected FPL points for the NEXT GAMEWEEK ONLY. Captaincy and starting-XI
   * choices are single-gameweek decisions and must use this, not the window
   * total — a player with a poor next fixture and four great ones after it
   * should not get the armband.
   */
  expectedPointsNext: number;
  /**
   * Probability this player appears at all in the next gameweek.
   *
   * It was always computed — as the minutes model's `pAppear` times FPL's
   * published availability — and then multiplied into `expectedPointsNext`
   * and discarded. That made the joint captain/vice decision literally
   * uncomputable from this interface, because the value of the vice-captain
   * contingency is (1 - pPlay of the captain).
   */
  pPlay: number;
  /** How much of `expectedPointsNext` came from THIS MODEL rather than from
   * FPL's own `ep_next`. 0 = entirely FPL's flat league-wide estimate,
   * 1 = entirely this model's per-90 rates and fixture context.
   *
   * This was computed and then thrown away. Nothing downstream knew that in
   * gameweek 2 — where a full-90 player has 90 of the 360 minutes the blend
   * wants — three quarters of every number on the page is FPL's estimate,
   * which is deliberately flat early in a season. The decision layer was
   * making confident recommendations out of numbers the scoring layer had
   * explicitly told itself not to trust. See lib/transferplan.ts.
   *
   * Optional so hand-built objects in tests and older callers still compile;
   * every consumer treats a missing value as "fully trusted", which is the
   * assumption those callers were already making implicitly. */
  modelTrust?: number;
  /** Where ownership is HEADING, not where it is. The whole risk layer used
   * `ownershipPct`, which is a stock; the bandwagon is a flow. See
   * lib/momentum.ts — a player at 8% being bought by 400k managers is not an
   * 8% differential, and treating him as one is how you end up on the wrong
   * side of a bandwagon while the model reassures you. Optional so older
   * callers and hand-built test objects still compile; every consumer falls
   * back to `ownershipPct` when it is absent. */
  projectedOwnershipPct?: number;
  /** Change in ownership implied by this gameweek's net transfers. */
  ownershipTrendPct?: number;
  /** Where the window's expected points come from, for transparency. */
  breakdown: ExpectedPointsBreakdown;
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
 * The scoring engine no longer has "calibration constants".
 *
 * Until v1.11 this block held a set of hand-picked multipliers
 * (ATTACK_MULTIPLIER, DC_WEIGHT, and friends) that turned various signals
 * into an arbitrary score. An audit established that no setting of those
 * numbers could work, because the quantity they produced had no unit:
 * midfielders scored 22-64 and defenders 9-32 purely because the attacking
 * terms were larger, so every cross-position decision was really being
 * decided by position. Two successive attempts to retune them (v1.9 raised
 * one 6x; the audit found that overshot by ~1.8x) treated the symptom.
 *
 * lib/expectedpoints.ts replaces the whole approach: each real FPL scoring
 * mechanism is modelled as the points it actually pays, so the weights are
 * the game's own rules rather than anyone's guesses. What remains here is
 * fixture context and the qualitative layer.
 */

/** Bounds on the COMBINED effect of all qualitative notes on one player.
 * Each individual note is already validated into [0.8, 1.2] when it is
 * stored, but notes are applied multiplicatively and a player can match
 * both a player-scoped and a team-scoped note — so three notes at 0.8
 * compounded to 0.512, a 49% cut, while the app promised a 20% cap. The
 * cap is now enforced on the product, which is where it was always meant
 * to apply. */
const INSIGHT_MIN_COMBINED = 0.8;
const INSIGHT_MAX_COMBINED = 1.2;

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
 *
 * `managerInsights` (optional, see lib/managerinsights.ts) is the one
 * genuinely qualitative layer in this otherwise fully quantitative model
 * — a small, bounded multiplier applied per player/team for patterns no
 * stats API can express (a manager's substitution habits, a team's
 * tactical identity). Every applied insight still surfaces in that
 * player's `reasons[]`, same as everything else here.
 */
export function buildScoredPlayers(
  bootstrap: FplBootstrap,
  fixtures: Parameters<typeof buildFixtureTicker>[1],
  fromEvent: number,
  fixtureWindow = 5,
  oddsMatches: OddsMatch[] | null = null,
  // Static + Redis-backed dynamic qualitative adjustments (see
  // lib/managerinsights.ts). Defaults to just the static, hand-curated
  // list so any existing/test caller that doesn't pass this explicitly
  // still behaves the same as before this parameter existed — callers
  // that want the full auto-updating layer (i.e. the live dashboard) pass
  // the result of `loadActiveInsights()` here instead.
  managerInsights: ManagerInsight[] = MANAGER_INSIGHTS,
  /** Model constants. Omitted everywhere except the calibration sweep,
   * which is the whole reason they are injectable — see lib/modelparams.ts. */
  modelParams?: Partial<ModelParams>
): ScoredPlayer[] {
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  // The bandwagon, read straight from FPL's transfer counts.
  const momentum = computeMomentum(bootstrap);
  const ticker = buildFixtureTicker(bootstrap.teams, fixtures, fromEvent, fixtureWindow);
  const teamFactors = computeDynamicTeamFactors(bootstrap.teams, fixtures);
  const expectationsByTeam = buildFixtureExpectations(bootstrap.teams, fixtures, oddsMatches, teamFactors);
  const teamFinishedFixtures = teamFinishedFixtureCounts(bootstrap.teams.map((t) => t.id), fixtures);
  const currentEvent = bootstrap.events.find((e) => e.is_current);
  const isPreseason = !currentEvent;
  // The season's real last gameweek, so fixture windows can be clamped to
  // the gameweeks that actually exist instead of assuming 38.
  const lastEvent = bootstrap.events.reduce((max, e) => Math.max(max, e.id), 38);

  // Each team's own average expected goals per fixture this season — the
  // denominator for "is this run better than normal FOR THIS TEAM", which
  // is what avoids counting team quality twice (once inside the player's
  // per-90 rate, once again in the fixture adjustment).
  const teamSeasonAvgGoalsFor = new Map<number, number>();
  // The mirror of the above, for the defensive side. A keeper's save rate
  // was earned behind THIS defence, so scaling it by a fixture's expected
  // goals against has to be relative to his own team's normal level — not
  // to a league constant, which counts team quality twice.
  const teamSeasonAvgGoalsAgainst = new Map<number, number>();
  for (const team of bootstrap.teams) {
    const all = expectationsByTeam.get(team.id) ?? [];
    if (all.length === 0) {
      teamSeasonAvgGoalsFor.set(team.id, 0);
      teamSeasonAvgGoalsAgainst.set(team.id, 0);
      continue;
    }
    teamSeasonAvgGoalsFor.set(
      team.id,
      all.reduce((s, e) => s + e.expectedGoalsFor, 0) / all.length
    );
    teamSeasonAvgGoalsAgainst.set(
      team.id,
      all.reduce((s, e) => s + e.expectedGoalsAgainst, 0) / all.length
    );
  }

  const out: ScoredPlayer[] = [];

  for (const el of bootstrap.elements) {
    if (el.status === "u") continue;
    const team = teamById.get(el.team);
    if (!team) continue;

    // Guarded parse: a missing/renamed upstream field must degrade this
    // player's signal, never produce NaN that flows into a score, a sort
    // comparator (where it silently corrupts ordering) or rendered text.
    const priceM = Number.isFinite(el.now_cost) ? el.now_cost / 10 : 0;
    const ownershipPct = parseFloat(el.selected_by_percent) || 0;
    const formNum = parseFloat(el.form) || 0;
    const epNext = parseFloat(el.ep_next ?? "") || 0;

    const teamFixtures = ticker[team.id] ?? [];
    const fixtureAvgDifficulty = averageDifficulty(teamFixtures);
    const nextOpponents = teamFixtures
      .map((f) => `${f.opponentShort} (${f.isHome ? "C" : "F"})`)
      .join(", ");

    const window = windowExpectation(
      expectationsByTeam.get(team.id),
      fromEvent,
      fixtureWindow,
      lastEvent
    );
    // Single-gameweek view, for decisions that are genuinely about the
    // next gameweek alone (captaincy, who starts) rather than the run.
    const nextWindow = windowExpectation(
      expectationsByTeam.get(team.id),
      fromEvent,
      1,
      lastEvent
    );

    const { avgGoalsFor: expectedGoalsFor, avgCleanSheetProbability: cleanSheetProbability } = window;

    const isDefensive = DEFENSIVE_POSITIONS.has(el.element_type);
    const isAttacking = ATTACKING_POSITIONS.has(el.element_type);

    const reasons: string[] = [];

    // ---- expected points -------------------------------------------------
    const mins = computeMinutesModel(
      el,
      teamFinishedFixtures.get(team.id) ?? 0,
      isPreseason,
      modelParams
    );
    const rates = computePlayerRates(el, modelParams);
    const minutesPlayed = Number.isFinite(el.minutes) ? el.minutes : 0;

    // How good is this team's upcoming run RELATIVE TO ITS OWN normal
    // level? The player's per-90 rates were earned playing for this team,
    // so they already contain the team's standing quality — comparing to
    // the league baseline instead (as the old model did) counted strong
    // teams twice and inflated their players systematically.
    const teamBaselineGoals = teamSeasonAvgGoalsFor.get(team.id) ?? 0;
    const attackRatio = (perFixtureGoals: number) =>
      teamBaselineGoals > 0
        ? Math.min(1.6, Math.max(0.5, perFixtureGoals / teamBaselineGoals))
        : 1;

    const teamBaselineConceded = teamSeasonAvgGoalsAgainst.get(team.id) ?? 0;

    const perFixtureWindow = expectedPointsForFixture(el.element_type, rates, mins, {
      teamAttackRatio: attackRatio(window.avgGoalsFor),
      cleanSheetProbability: window.avgCleanSheetProbability,
      expectedGoalsAgainst: window.avgGoalsAgainst,
      teamSeasonGoalsAgainst: teamBaselineConceded,
    });
    const modelWindowPoints = scaleBreakdown(perFixtureWindow, window.fixtureCount);

    const perFixtureNext = expectedPointsForFixture(el.element_type, rates, mins, {
      teamAttackRatio: attackRatio(nextWindow.avgGoalsFor),
      cleanSheetProbability: nextWindow.avgCleanSheetProbability,
      expectedGoalsAgainst: nextWindow.avgGoalsAgainst,
      teamSeasonGoalsAgainst: teamBaselineConceded,
    });
    const modelNextPoints = perFixtureNext.total * nextWindow.fixtureCount;

    // Blend our structural model with FPL's own published projection,
    // weighted by how much evidence this season actually supports. With no
    // minutes played `ep_next` is strictly better information; by ~4 full
    // matches our model has real per-90 rates and fixture context that
    // `ep_next` does not expose. Using it as a blend partner rather than
    // as one more additive term is what stops it double-counting form,
    // fixtures and minutes, all of which it already contains.
    const trust = isPreseason ? 0 : modelTrust(minutesPlayed, modelParams);

    let expectedPoints: number;
    let expectedPointsNext: number;

    if (isPreseason) {
      // PRESEASON.
      //
      // With no minutes played, every per-player rate this model needs
      // (xG/90, xA/90, bonus/90, defensive actions) is legitimately zero,
      // so our structural model has nothing player-specific to say and
      // FPL's own `ep_next` is the only real per-player estimate that
      // exists. Deferring to it entirely was therefore the right instinct
      // — but it was implemented as `trust = 0`, which threw away TWO
      // things our model does know before a ball is kicked, and that was
      // enough to make the suggested squad a straight copy of FPL's own
      // ranking no matter what else got built:
      //
      //   1. `ep_next` is a NEXT-GAMEWEEK number. Multiplying it by the
      //      fixture count assumed gameweeks 2-5 would be exactly like
      //      gameweek 1, so a kind run and a brutal run scored the same.
      //      The market-derived fixture model knows the difference.
      //   2. Set-piece duty is a ROLE, known before kickoff. FPL's early
      //      -season `ep_next` is famously slow to reflect a newly
      //      appointed penalty taker.
      //
      // So: keep `ep_next` as the per-player base (it is the better
      // information, and re-deriving it would double-count), and modulate
      // it only by what it demonstrably does not contain. Gameweek 1 is
      // left exactly equal to `ep_next` — full deference where FPL is
      // strongest — while later gameweeks scale by how much better or
      // worse they look than gameweek 1.
      const inWindow = (expectationsByTeam.get(team.id) ?? []).filter(
        (e) => e.event !== null && e.event >= fromEvent && e.event < fromEvent + fixtureWindow
      );
      // Quality of a fixture for THIS position: defenders and keepers live
      // on clean sheets, attackers on their team's goals.
      const qualityOf = (e: { cleanSheetProbability: number; expectedGoalsFor: number }) =>
        isDefensive ? e.cleanSheetProbability : e.expectedGoalsFor;

      const first = inWindow[0];
      const baseQuality = first ? qualityOf(first) : 0;
      let windowMultiplier = window.fixtureCount;
      if (first && baseQuality > 0.01) {
        windowMultiplier = inWindow.reduce((sum, e) => {
          // Clamped per fixture so one extreme match cannot dominate the
          // run, and so a missing/degenerate value degrades to "same as
          // gameweek 1" rather than to zero.
          const ratio = qualityOf(e) / baseQuality;
          return sum + Math.min(1.6, Math.max(0.55, Number.isFinite(ratio) ? ratio : 1));
        }, 0);
      }

      // Set-piece duty: a genuine, knowable-now differentiator. Kept small
      // — this nudges players apart, it does not reorder the league.
      const penOrder = el.penalties_order ?? null;
      const setPieceAdj = penOrder === 1 ? 1.12 : penOrder === 2 ? 1.03 : 1;
      if (penOrder === 1) reasons.push("marcador de grandes penalidades designado");

      expectedPoints = epNext * windowMultiplier * setPieceAdj;
      // Gameweek 1 is FPL's own number, untouched apart from set-piece duty.
      expectedPointsNext = epNext * setPieceAdj;
    } else {
      const epNextWindow = epNext * window.fixtureCount;
      const epNextSingle = epNext * Math.min(1, nextWindow.fixtureCount);
      expectedPoints = modelWindowPoints.total * trust + epNextWindow * (1 - trust);
      expectedPointsNext = modelNextPoints * trust + epNextSingle * (1 - trust);
    }

    // Individual goal involvement, kept for display and the risk profile.
    const individualExpectedGI =
      (rates.xg90 + rates.xa90 + rates.setPieceXg90) *
      attackRatio(window.avgGoalsFor) *
      (mins.expectedMinutes / 90) *
      window.fixtureCount;
    const ceilingGI = poissonQuantile(individualExpectedGI, 0.85);
    const floorGI = poissonQuantile(individualExpectedGI, 0.15);

    reasons.push(...mins.reasons);
    reasons.push(...rates.reasons);
    if (!isPreseason && trust < 1) {
      reasons.push(
        `amostra ainda pequena (${minutesPlayed}min esta época) — a previsão ainda se apoia bastante na estimativa da própria FPL`
      );
    }
    if (isPreseason) {
      reasons.push(
        `pré-época: previsão baseada na estimativa da própria FPL (~${epNext.toFixed(1)}pts/jornada) e no calendário`
      );
      if (ownershipPct >= 25) reasons.push("escolha consensual do mercado (template)");
      if (ownershipPct < 10 && priceM >= 6) reasons.push("possível diferencial de qualidade");
    }
    if (formNum >= 5) reasons.push("em grande forma recente");
    // Momentum is about RANK, not points — see lib/momentum.ts. It never
    // touches expectedPoints; it changes how the risk posture reads him.
    const mom = momentum.get(el.id);
    const momText = mom ? momentumReason(mom) : null;
    if (momText) reasons.push(momText);

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
    if (window.anyMarketAdjusted) reasons.push("ajustado com odds de mercado");
    if (ceilingGI - floorGI >= 2 && individualExpectedGI > 0) {
      reasons.push("perfil de risco/recompensa: teto alto, mas resultado pode variar bastante");
    }

    // ---- qualitative layer ----------------------------------------------
    // Applied as a single COMBINED multiplier, clamped. Each note is
    // already individually bounded when stored, but they are applied
    // multiplicatively and one player can match both a player-scoped and a
    // team-scoped note, so the product could exceed the bound the app
    // promises. Clamping here is what makes "no more than +-20%" true.
    const insights = [
      ...filterInsights(managerInsights, "player", el.id),
      ...filterInsights(managerInsights, "team", team.id),
    ];
    if (insights.length > 0) {
      // Two multipliers, not one. A note can now be scoped to specific
      // gameweeks, and the two numbers this model produces answer different
      // questions: `expectedPointsNext` is about ONE gameweek, so a note
      // either applies to it or does not; `expectedPoints` is a five-week
      // total, so a note covering one of those weeks should move it by
      // roughly a fifth, not by the whole amount. Applying a one-week fact
      // at full strength to a five-week total — which is what a single
      // shared multiplier did — overstated it about five-fold.
      let combinedNext = 1;
      let combinedWindow = 1;
      for (const insight of insights) {
        const eff = effectiveFactor(insight);
        if (!insight.events || insight.events.length === 0) {
          combinedNext *= eff;
          combinedWindow *= eff;
          continue;
        }
        if (insightAppliesToEvent(insight, fromEvent)) combinedNext *= eff;
        const coveredInWindow = insight.events.filter(
          (e) => e >= fromEvent && e < fromEvent + fixtureWindow
        ).length;
        if (coveredInWindow > 0) {
          combinedWindow *= 1 + (eff - 1) * (coveredInWindow / Math.max(1, fixtureWindow));
        }
      }
      const clamp = (v: number) =>
        Math.min(INSIGHT_MAX_COMBINED, Math.max(INSIGHT_MIN_COMBINED, v));
      const clampedNext = clamp(combinedNext);
      const clampedWindow = clamp(combinedWindow);
      expectedPoints *= clampedWindow;
      expectedPointsNext *= clampedNext;
      for (const insight of insights) reasons.push(formatInsightReason(insight));
      if (insights.length > 1) {
        reasons.push(
          `efeito combinado das notas táticas limitado a ${Math.round((clampedNext - 1) * 100)}% nesta jornada`
        );
      }
    }

    // ---- availability ----------------------------------------------------
    // `chance_of_playing_next_round` describes the NEXT round specifically,
    // so it is applied at full strength to the single-gameweek number but
    // damped over a multi-gameweek window, where a one-week doubt costs at
    // most one of several fixtures. The old model applied the raw
    // percentage to the whole window, over-penalising a one-week knock by
    // roughly 3x on a five-gameweek horizon.
    const availability =
      el.chance_of_playing_next_round === null
        ? 1
        : Math.max(0, Math.min(1, el.chance_of_playing_next_round / 100));
    const windowAvailability =
      window.fixtureCount > 1
        ? 1 - (1 - availability) / window.fixtureCount
        : availability;

    expectedPointsNext *= availability;
    expectedPoints *= windowAvailability;

    // A player flagged as unavailable by status but with no percentage
    // published is still a real risk — treat an explicit non-available
    // status as a doubt rather than trusting the null.
    // `status === "u"` (removed from the game) is already filtered out at
    // the top of the loop, so anything non-"a" here is a doubt/injury/
    // suspension that FPL has not attached a percentage to.
    if (availability === 1 && el.status !== "a") {
      expectedPointsNext *= 0.5;
      expectedPoints *= 0.8;
      reasons.push(
        `estado "${el.status}" na FPL sem percentagem publicada — tratado como dúvida` +
          (el.news ? ` — ${el.news}` : "")
      );
    } else if (availability < 1) {
      reasons.push(
        `risco de utilização: ${el.chance_of_playing_next_round}% de hipótese de jogar` +
          (el.news ? ` — ${el.news}` : "")
      );
    }

    // Final guard: never let a non-finite value reach a score, a sort
    // comparator or the rendered page.
    if (!Number.isFinite(expectedPoints)) expectedPoints = 0;
    if (!Number.isFinite(expectedPointsNext)) expectedPointsNext = 0;

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
      expectedPoints: Math.round(expectedPoints * 100) / 100,
      expectedPointsNext: Math.round(expectedPointsNext * 100) / 100,
      modelTrust: Math.round(trust * 1000) / 1000,
      projectedOwnershipPct: momentum.get(el.id)?.projectedOwnershipPct ?? ownershipPct,
      ownershipTrendPct: momentum.get(el.id)?.trendPct ?? 0,
      pPlay: Math.round(Math.min(1, Math.max(0, mins.pAppear * availability)) * 1000) / 1000,
      breakdown: modelWindowPoints,
      // Alias, so nothing downstream had to change when the score became a
      // real quantity. Both are expected FPL points over the window.
      score: Math.round(expectedPoints * 100) / 100,
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
  const clubCount = new Map<number, number>();
  const squad: ScoredPlayer[] = [];
  let spent = 0;

  const clubN = (id: number) => clubCount.get(id) ?? 0;

  // ---- pass 1: a guaranteed-legal baseline -----------------------------
  //
  // Fill every slot with the CHEAPEST eligible player first. This is the
  // change that actually fixes the audit's C-05: the previous version
  // picked best-scoring-first and simply ran out of money before reaching
  // the forwards, returning a squad of twelve that the optimizer's
  // fallback then labelled valid. Buying the floor first means a legal
  // 2-5-5-3 exists from the very first step, and every later decision is
  // an upgrade that can only be applied if it still fits.
  for (const posId of [1, 2, 3, 4]) {
    const byPrice = scored
      .filter((p) => p.element.element_type === posId)
      .sort((a, b) => a.priceM - b.priceM);
    let picked = 0;
    for (const cand of byPrice) {
      if (picked >= need[posId]) break;
      if (clubN(cand.team.id) >= 3) continue;
      if (spent + cand.priceM > budgetM) continue;
      squad.push(cand);
      clubCount.set(cand.team.id, clubN(cand.team.id) + 1);
      spent += cand.priceM;
      picked++;
    }
  }

  // Genuinely infeasible (not enough players, or not enough money for even
  // the cheapest legal squad). Return what we have; callers check validity
  // with isValidSquad rather than trusting a hard-coded flag.
  if (squad.length !== 15) {
    return { squad, starters: pickBestXI(squad), totalCost: Math.round(spent * 10) / 10 };
  }

  // ---- pass 2: spend the remaining budget on the best upgrades ---------
  //
  // Repeatedly apply the single swap with the largest score gain that
  // still fits the budget and the three-per-club limit. Each iteration
  // strictly increases total score and the squad stays legal throughout,
  // so this can only improve on the baseline.
  const inSquad = new Set(squad.map((p) => p.element.id));
  const byPosition = new Map<number, ScoredPlayer[]>();
  for (const posId of [1, 2, 3, 4]) {
    byPosition.set(
      posId,
      scored
        .filter((p) => p.element.element_type === posId)
        .sort((a, b) => b.score - a.score)
    );
  }

  const MAX_UPGRADES = 60; // far above the 15 swaps a full rebuild needs
  for (let iteration = 0; iteration < MAX_UPGRADES; iteration++) {
    let best: { outIdx: number; incoming: ScoredPlayer; gain: number } | null = null;

    for (let i = 0; i < squad.length; i++) {
      const current = squad[i];
      const posId = current.element.element_type;
      const candidates = byPosition.get(posId) ?? [];

      for (const cand of candidates) {
        const gain = cand.score - current.score;
        // Sorted by score descending, so once the gain stops beating the
        // best swap found so far, nothing later in this list can win.
        if (best && gain <= best.gain) break;
        if (gain <= 0) break;
        if (inSquad.has(cand.element.id)) continue;
        if (spent - current.priceM + cand.priceM > budgetM) continue;
        // Club limit, accounting for the slot the outgoing player frees.
        const freed = cand.team.id === current.team.id ? 1 : 0;
        if (clubN(cand.team.id) - freed >= 3) continue;

        best = { outIdx: i, incoming: cand, gain };
        break; // best possible for this slot
      }
    }

    if (!best) break;

    const outgoing = squad[best.outIdx];
    clubCount.set(outgoing.team.id, clubN(outgoing.team.id) - 1);
    clubCount.set(best.incoming.team.id, clubN(best.incoming.team.id) + 1);
    inSquad.delete(outgoing.element.id);
    inSquad.add(best.incoming.element.id);
    spent = spent - outgoing.priceM + best.incoming.priceM;
    squad[best.outIdx] = best.incoming;
  }

  return { squad, starters: pickBestXI(squad), totalCost: Math.round(spent * 10) / 10 };
}

/** Does this squad satisfy every FPL constraint? Callers must check this
 * before telling a user the squad is valid — the previous code hard-coded
 * `feasible: true` on a path that demonstrably returned short squads. */
export function isValidSquad(squad: ScoredPlayer[], budgetM = 100): boolean {
  if (squad.length !== 15) return false;
  const need: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const clubs = new Map<number, number>();
  let cost = 0;
  for (const p of squad) {
    counts[p.element.element_type] = (counts[p.element.element_type] ?? 0) + 1;
    clubs.set(p.team.id, (clubs.get(p.team.id) ?? 0) + 1);
    cost += p.priceM;
  }
  for (const posId of [1, 2, 3, 4]) if (counts[posId] !== need[posId]) return false;
  for (const n of clubs.values()) if (n > 3) return false;
  return cost <= budgetM + 1e-9;
}

/**
 * Picks the best valid starting XI out of a 15-player squad — exactly 1 GK,
 * at least 3 DEF, 2 MID and 1 FWD, 11 players in total.
 *
 * Selection is driven by `expectedPointsNext`, NOT the multi-gameweek
 * score: who to start is a decision about the next gameweek alone. Using
 * the 5-gameweek total here meant a player with a poor next fixture but a
 * strong run after it displaced someone better for the only gameweek that
 * was actually being decided.
 *
 * Returns `{ xi, valid }` rather than a bare array so callers can tell a
 * legal XI from a best-effort one. The previous version silently returned
 * whatever it could assemble — 1 player from a squad of goalkeepers, or an
 * all-midfield XI — and callers had no way to know.
 */
export function pickBestXI(squad: ScoredPlayer[]): ScoredPlayer[] {
  return pickBestXIChecked(squad).xi;
}

export function pickBestXIChecked(squad: ScoredPlayer[]): {
  xi: ScoredPlayer[];
  valid: boolean;
} {
  const by = (id: number) =>
    squad
      .filter((p) => p.element.element_type === id)
      .sort((a, b) => b.expectedPointsNext - a.expectedPointsNext);

  const gk = by(1).slice(0, 1);
  const def = by(2).slice(0, 3);
  const mid = by(3).slice(0, 2);
  const fwd = by(4).slice(0, 1);
  const chosen = new Set([...gk, ...def, ...mid, ...fwd]);
  const remaining = squad
    .filter((p) => !chosen.has(p) && p.element.element_type !== 1)
    .sort((a, b) => b.expectedPointsNext - a.expectedPointsNext)
    .slice(0, 11 - chosen.size);

  const xi = [...gk, ...def, ...mid, ...fwd, ...remaining];
  const valid =
    xi.length === 11 && gk.length === 1 && def.length === 3 && mid.length === 2 && fwd.length === 1;
  return { xi, valid };
}

/**
 * Captain and vice-captain, chosen on NEXT-GAMEWEEK expected points.
 *
 * The armband doubles a player's score in one gameweek, so ranking by a
 * five-gameweek total — as this did until v1.11 — answers the wrong
 * question: a player with a poor next fixture and four excellent ones
 * afterwards would outrank the player who is actually best this week.
 *
 * Returns `undefined` for either slot when the XI is too short to fill it,
 * rather than claiming a `ScoredPlayer` that isn't there.
 */
/**
 * How much of a player's real expected points the risk posture may never
 * take away, however extreme the league situation.
 *
 * The posture exists to break ties toward divergence. It must not be able to
 * overrule the points model — and it did: at beta 0.90 a 60%-owned player
 * kept 46% of his value, which is how the app came to recommend selling the
 * highest-scoring midfielder in the game at a stated loss of 16.9 points.
 * A floor of 0.8 bounds the distortion structurally, so no future change to
 * the dial can reproduce that failure.
 */
export const MIN_STRATEGIC_RETENTION = 0.8;

/**
 * A probabilidade mínima de o capitão NÃO aparecer, por muito garantido que
 * pareça. Lesões no aquecimento, doenças, castigos tardios e decisões
 * táticas de última hora não são raras ao ponto de serem zero, e tratá-las
 * como zero foi o que tornou a escolha do vice arbitrária. Dois por cento é
 * deliberadamente conservador: chega para o vice ser escolhido por mérito e
 * é pequeno de mais para mudar quem leva a braçadeira.
 */
export const MIN_CAPTAIN_MISS_RISK = 0.02;

export function pickCaptain(
  starters: ScoredPlayer[],
  /**
   * Variance posture from lib/rivals.ts. Applied to the CAPTAIN only — the
   * vice is a contingency that fires in roughly one gameweek in twenty, and
   * discounting an insurance policy for being popular has no risk-posture
   * justification at all. It used to be applied to both, which could hand
   * the fallback armband to a materially worse player.
   */
  beta = 0
): {
  captain: ScoredPlayer | undefined;
  viceCaptain: ScoredPlayer | undefined;
} {
  if (starters.length === 0) return { captain: undefined, viceCaptain: undefined };
  if (starters.length === 1) return { captain: starters[0], viceCaptain: undefined };

  // THE ARMBAND IS A PAIR, NOT TWO RANKINGS.
  //
  // The vice is doubled exactly when the captain records zero minutes, so
  // the value of the pair is:
  //
  //     EP(captain) + (1 - P(captain plays)) x EP(vice)
  //
  // That second term is free insurance, and it has a consequence that runs
  // against intuition: a doubtful premium should NOT be further penalised
  // for the doubt when choosing the captain, because the vice refunds the
  // doubling in exactly the cases the doubt materialises. Ranking by
  // expected points alone — as this did until v1.28 — counts the doubt
  // twice and systematically UNDER-captains the doubtful premium.
  //
  // Eleven starters give 110 ordered pairs. Evaluating all of them costs
  // nothing and removes the approximation entirely.
  // ═══ v1.41 — O VICE ESTAVA A SER ESCOLHIDO AO ACASO ═══
  //
  // O modelo acima está certo. A sua implementação tinha um buraco que o
  // anulava no caso NORMAL.
  //
  // O termo do vice é `(1 - P(capitão joga)) x EP(vice)`. Quando o capitão é
  // um titular indiscutível, `pPlay` vale exatamente 1, esse termo vale
  // exatamente ZERO — e nessa altura TODOS os vices dão o mesmo valor. O
  // laço ficava com o primeiro que aparecesse na lista.
  //
  // Demonstrado: o mesmo onze, com a lista por outra ordem, produzia vices
  // diferentes. Com o Haaland (9.0) capitão, o vice saía "Fodder-A" (2.0) em
  // vez do Salah (7.5), só porque vinha antes no array.
  //
  // O comentário acima chama a este termo "seguro grátis" e o código estava
  // a atirá-lo fora. Quando a braçadeira passa mesmo para o vice — uma
  // jornada em cada vinte, e sempre no pior momento — a diferença entre o
  // segundo melhor do onze e um jogador de enchimento são vários pontos.
  //
  // DUAS CORREÇÕES, E A PRIMEIRA É DE MODELO, NÃO DE PROGRAMAÇÃO:
  //
  // 1. `pPlay = 1` é falso. Ninguém é literalmente certo: há lesões no
  //    aquecimento, doenças, decisões táticas de última hora e castigos
  //    tardios. Um piso de 2% na probabilidade de falhar é conservador e
  //    torna o objetivo não-degenerado — o vice passa a ser escolhido por
  //    mérito em vez de por posição no array.
  //
  // 2. Desempate explícito pelo EP do vice. Mesmo que o piso não existisse,
  //    o resultado deixa de depender da ordem de uma lista, que é uma coisa
  //    que nunca deve influenciar uma decisão.
  // ═══ v1.41, SEGUNDO ACHADO — A POSTURA PODIA ROUBAR A BRAÇADEIRA ═══
  //
  // O desconto de postura reduz o valor de um jogador muito escolhido, para
  // favorecer a divergência quando é preciso arriscar. Aqui não tinha teto.
  //
  // Medido com a postura no máximo permitido (beta = 0.35):
  //
  //     premium  9.0 pts, 70% de posse  →  9.0 x (1 - 0.35x0.70) = 6.79
  //     diferencial 7.2 pts, 5% de posse →  7.2 x (1 - 0.35x0.05) = 7.07
  //
  // A braçadeira ia para o jogador de 7.2. Isso são 1.8 pontos esperados
  // deitados fora — e a braçadeira DOBRA, por isso é 1.8 pontos reais por
  // semana, na decisão semanal de maior alavancagem que existe.
  //
  // Este projeto já tinha aprendido esta lição noutro sítio: o optimizer
  // tem `MIN_STRATEGIC_RETENTION = 0.8` precisamente porque a postura
  // "pode desempatar, não pode anular o modelo de pontos" — foi assim que a
  // app chegou a mandar vender o melhor médio do jogo com uma perda
  // declarada de 16.9 pontos. O mesmo teto nunca tinha sido aplicado ao
  // capitão. É o mesmo defeito, no sítio onde custa mais.
  const captainValue = (p: ScoredPlayer) =>
    beta
      ? p.expectedPointsNext *
        Math.max(
          MIN_STRATEGIC_RETENTION,
          1 - beta * Math.min(1, Math.max(0, p.ownershipPct / 100))
        )
      : p.expectedPointsNext;

  let best:
    | { captain: ScoredPlayer; vice: ScoredPlayer; value: number; viceEp: number }
    | null = null;
  for (const c of starters) {
    // `pPlay` may be absent on hand-built objects in older callers; a missing
    // value is treated as a nailed starter.
    const rawPlay = typeof c.pPlay === "number" ? c.pPlay : 1;
    const pPlayC = Math.min(1 - MIN_CAPTAIN_MISS_RISK, Math.max(0, rawPlay));
    for (const v of starters) {
      if (v.element.id === c.element.id) continue;
      const viceEp = Math.max(0, v.expectedPointsNext);
      const value = captainValue(c) + (1 - pPlayC) * viceEp;
      const better =
        !best ||
        value > best.value + 1e-9 ||
        // Empate no par: fica o vice que vale mais. Sem isto, a decisão
        // depende da ordem do array.
        (Math.abs(value - best.value) <= 1e-9 && viceEp > best.viceEp);
      if (better) best = { captain: c, vice: v, value, viceEp };
    }
  }

  return { captain: best?.captain, viceCaptain: best?.vice };
}

/**
 * The bench, in the order FPL will actually use it.
 *
 * Automatic substitutions fire in bench order whenever a starter records
 * zero minutes — roughly 0.4 to 0.5 times a gameweek across a season. Until
 * v1.28 there was no bench-ordering code anywhere in this project: the bench
 * was the residue of a filter, in whatever order the solver's variable map
 * happened to produce. Someone copying that order into FPL got an arbitrary
 * substitution priority, worth about 1.2 points every time a substitution
 * fired.
 *
 * Two rules, in order of precedence:
 *   1. The reserve goalkeeper occupies its own slot. FPL fixes this; it is
 *      not part of the decision.
 *   2. The outfield three are ranked by P(plays) x expected points — not by
 *      expected points alone, because a bench player who will not appear
 *      cannot be substituted in no matter how good he is.
 */
export function orderBench(bench: ScoredPlayer[]): ScoredPlayer[] {
  const keepers = bench.filter((p) => p.element.element_type === 1);
  const outfield = bench.filter((p) => p.element.element_type !== 1);
  const value = (p: ScoredPlayer) =>
    (typeof p.pPlay === "number" ? p.pPlay : 1) * Math.max(0, p.expectedPointsNext);
  return [...keepers, ...outfield.sort((a, b) => value(b) - value(a))];
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
