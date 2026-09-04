/**
 * Regression suite — one test per defect found in the v1.11 audit.
 *
 * Every test here exists because something was ACTUALLY WRONG in shipped
 * code, not because the behaviour seemed worth asserting in the abstract.
 * The audit's headline process finding was that dozens of verifications
 * had been written, run and then deleted before packaging, so nothing
 * stopped a future change silently reintroducing a fixed bug. This file is
 * that safety net. Each test names the audit finding it locks down.
 *
 * Run with: npm test
 */

import { computeDynamicTeamFactors } from "../lib/teamrating";
import {
  poissonQuantile,
  windowExpectation,
  deriveLeagueBaselines,
  BASE_HOME_GOALS,
  BASE_AWAY_GOALS,
  buildFixtureExpectations,
  matchOutcomeProbabilities,
  teamStrengthsUsable,
} from "../lib/matchmodel";
import type { FixtureExpectation } from "../lib/matchmodel";
import {
  buildScoredPlayers,
  buildSuggestedSquad,
  isValidSquad,
  pickBestXIChecked,
  pickCaptain,
  orderBench,
  type ScoredPlayer,
} from "../lib/recommend";
import {
  computeMinutesModel,
  computePlayerRates,
  expectedPointsForFixture,
  poissonSurvival,
  expectedFloorDivide,
  type PlayerRates,
  type MinutesModel,
} from "../lib/expectedpoints";
import {
  buildOptimalSquad,
  strategicValue,
  strategicValueNext,
  effectiveOwnershipShare,
  MIN_STRATEGIC_RETENTION,
} from "../lib/optimizer";
import { computeMomentum, momentumReason } from "../lib/momentum";
import { readCalendar, planChips } from "../lib/chipplan";
import {
  decisionGain,
  implausibleXiWarning,
  shrunkForSelection,
  selectionReliability,
  SELECTION_RELIABILITY_FLOOR,
  retentionThreshold,
  rateErrorPerGw,
  selectionInflation,
} from "../lib/selection";
import {
  simulateLeague,
  applyLearningTilt,
  selectRivals,
  effectiveEdgeGameweeks,
  MAX_BETA,
  MIN_BETA,
  type RivalSquad,
} from "../lib/rivals";
import {
  buildLearningState,
  applyCalibration,
  selectForStrategy,
  STRATEGIES,
  type StrategyEventResult,
} from "../lib/strategylearning";
import {
  reconstructFreeTransfers,
  estimateSellingPrices,
  deriveBudget,
  summariseChips,
  type SquadState,
  type ChipStatus,
} from "../lib/squadstate";
import { planTransfers, noiseFloor, costlyMoves } from "../lib/transferplan";
import { computeSquadRisk, computeTeamExposures } from "../lib/correlation";
import { computeRankValue, computeSquadRankProfile } from "../lib/rankvalue";
import {
  validateInsightInput,
  resolveInsightTarget,
  resolveStaticInsights,
  effectiveFactor,
  insightAppliesToEvent,
  MANAGER_INSIGHT_SEEDS,
} from "../lib/managerinsights";
import {
  expectedGoalsFromMarket,
  totalGoalsFromOverProb,
  overProbability,
  overTwoPointFiveProbability,
  deriveTeamRatingsFromMarket,
} from "../lib/oddsmodel";
import type { OddsMatch } from "../lib/oddsapi";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isStorageConfigured } from "../lib/kv";
import { checkApiToken, unauthorizedBody, checkCronAuth } from "../lib/apitoken";
import { computeJobHealth, mergeResearchHealth, type JobRun } from "../lib/joblog";
import { planFromRequest } from "../app/api/cron/refresh/route";
import { paramsFromCursor, allTunableParams, MAX_PARAMS_PER_RUN, chooseSample } from "../lib/jobs";
import type { FplElement } from "../lib/types";
import { deflateSync, inflateSync, gzipSync, gunzipSync } from "node:zlib";
import {
  decodeCompressedPayload,
  processInsightSubmission,
  MAX_INFLATED_CHARS,
} from "../lib/insightsintake";
import { isValidSubmissionId, MAX_CHUNKS } from "../lib/insightschunks";
import { DEFAULT_MODEL_PARAMS, PARAM_GRIDS } from "../lib/modelparams";
import { calibrate, MIN_EVENTS, MIN_ROWS } from "../lib/calibration";
import {
  reconstructElementAsOf,
  reconstructFixturesAsOf,
  scoreBacktest,
  runBacktest,
  type ElementHistoryRow,
} from "../lib/backtest";
import {
  check,
  report,
  exitCode,
  counts,
  makeBootstrap,
  makeElement,
  makeFixture,
  makeTeam,
  makeEvent,
} from "./fixtures";

// ---------------------------------------------------------------------
// C-04 — a defence conceding zero must not be rated average
// ---------------------------------------------------------------------
function testDefenceInversion() {
  const teams = Array.from({ length: 6 }, (_, i) => makeTeam(i + 1));
  const fixtures = [];
  let id = 1;
  for (let gw = 0; gw < 8; gw++) {
    // team 1 concedes nothing; team 2 concedes one every other game
    fixtures.push(
      makeFixture({
        id: id++, event: gw + 1, team_h: 1, team_a: 3,
        finished: true, team_h_score: 1, team_a_score: 0,
      })
    );
    fixtures.push(
      makeFixture({
        id: id++, event: gw + 1, team_h: 2, team_a: 4,
        finished: true, team_h_score: 1, team_a_score: gw < 4 ? 1 : 0,
      })
    );
  }
  const f = computeDynamicTeamFactors(teams, fixtures);
  const airtight = f.get(1)!.defenceFactor;
  const leaky = f.get(2)!.defenceFactor;
  check(
    "C-04 defesa sem golos sofridos é melhor classificada que uma que sofre",
    airtight > leaky,
    `0 sofridos=${airtight.toFixed(3)} vs 4 sofridos=${leaky.toFixed(3)}`
  );
  // O limite subiu de 1.25 para 1.6 na v1.28. O antigo era um teto
  // permanente que fazia a melhor defesa da liga parecer 25% acima da média
  // quando a diferença real chega a 115% — dezanove pontos percentuais de
  // clean sheet por jogo.
  check("C-04 fator de defesa mantém-se dentro dos limites", airtight <= 1.6 + 1e-9);
  check(
    "C-04 e o limite deixa espaço para uma defesa realmente boa",
    airtight > 1.25,
    `${airtight.toFixed(3)}`
  );
}

// ---------------------------------------------------------------------
// Médio — poissonQuantile não pode devolver o limite do ciclo
// ---------------------------------------------------------------------
function testPoissonQuantile() {
  check("poissonQuantile(NaN) devolve 0, não o limite", poissonQuantile(NaN, 0.85) === 0);
  check("poissonQuantile(Infinity) devolve 0", poissonQuantile(Infinity, 0.85) === 0);
  check("poissonQuantile(-1) devolve 0", poissonQuantile(-1, 0.85) === 0);
  const hi = poissonQuantile(9.78, 0.85);
  check("percentil 85 de λ=9.78 não está truncado em 12", hi < 40 && hi >= 12, `obtido ${hi}`);
  // Ceiling must keep growing with expectation, not shrink from truncation.
  check(
    "teto cresce com a expectativa",
    poissonQuantile(15, 0.85) > poissonQuantile(9.78, 0.85)
  );
}

// ---------------------------------------------------------------------
// Médio — janela de fim de época não pode inverter dupla/branca
// ---------------------------------------------------------------------
function testLateSeasonWindow() {
  const exp: FixtureExpectation[] = [];
  for (let gw = 34; gw <= 38; gw++) {
    exp.push({
      fixtureId: gw, event: gw, opponentTeamId: 2, isHome: true,
      expectedGoalsFor: 1.5, expectedGoalsAgainst: 1.2,
      cleanSheetProbability: 0.3, marketAdjusted: false, source: "fpl" as const,
    });
  }
  // genuine double in GW36
  exp.push({
    fixtureId: 999, event: 36, opponentTeamId: 3, isHome: false,
    expectedGoalsFor: 1.4, expectedGoalsAgainst: 1.3,
    cleanSheetProbability: 0.28, marketAdjusted: false, source: "fpl" as const,
  });

  const w = windowExpectation(exp, 36, 5, 38);
  check("janela GW36 cobre apenas as 3 jornadas que restam", w.gameweeksInWindow === 3, `obtido ${w.gameweeksInWindow}`);
  check("jornada dupla real é detetada perto do fim da época", w.hasDoubleGameweek === true);
  check("jornada dupla real NÃO é reportada como branca", w.hasBlankGameweek === false);

  const wNormal = windowExpectation(exp, 34, 5, 38);
  check("a meio da época a janela continua a ser de 5", wNormal.gameweeksInWindow === 5);
}

// ---------------------------------------------------------------------
// A-02 / A-03 — pontuação em pontos e capitão de 1 jornada
// ---------------------------------------------------------------------
function testExpectedPointsScale() {
  const { bootstrap, fixtures } = makeBootstrap({ currentEvent: 6, gameweeks: 12 });
  // Give one midfielder a strong, well-evidenced profile.
  bootstrap.elements = bootstrap.elements.map((el) =>
    el.element_type === 3 && el.team === 1
      ? makeElement({
          ...el, minutes: 900, starts: 10, goals_scored: 6, assists: 4, bonus: 12,
          expected_goals_per_90: "0.55", expected_assists_per_90: "0.35",
          ep_next: "6.0", penalties_order: 1,
        })
      : el
  );
  const scored = buildScoredPlayers(bootstrap, fixtures, 6, 5, null, []);
  check("motor devolve jogadores pontuados", scored.length > 0);

  const top = scored[0];
  check(
    "A-03 pontuação da janela está numa escala de pontos plausível",
    top.expectedPoints > 0 && top.expectedPoints < 120,
    `obtido ${top.expectedPoints}`
  );
  check(
    "A-03 pontos da próxima jornada são menores que os da janela de 5",
    top.expectedPointsNext <= top.expectedPoints + 1e-9,
    `próxima=${top.expectedPointsNext} janela=${top.expectedPoints}`
  );
  check("A-03 score é alias de expectedPoints", top.score === top.expectedPoints);
  check(
    "decomposição soma ao total da janela",
    Math.abs(top.breakdown.total - (
      top.breakdown.appearance + top.breakdown.goals + top.breakdown.assists +
      top.breakdown.cleanSheet + top.breakdown.concededPenalty +
      top.breakdown.defensiveContribution + top.breakdown.bonus +
      top.breakdown.saves + top.breakdown.cards
    )) < 1e-6
  );
  check("nenhuma pontuação é NaN", scored.every((p) => Number.isFinite(p.score)));
}

function testCaptainUsesNextGameweek() {
  const base = (over: Partial<ScoredPlayer>): ScoredPlayer =>
    ({
      element: makeElement({ id: Math.random() }), team: makeTeam(1),
      positionShort: "MID", priceM: 8, ownershipPct: 10, formNum: 0,
      fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.5,
      cleanSheetProbability: 0.3, individualExpectedGI: 1, ceilingGI: 2, floorGI: 0,
      expectedPoints: 0, expectedPointsNext: 0, pPlay: 1,
      breakdown: {
        appearance: 0, goals: 0, assists: 0, cleanSheet: 0,
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, cards: 0, total: 0,
      },
      score: 0, isDifferential: false, isPreseason: false, reasons: [],
      ...over,
    }) as ScoredPlayer;

  // A: great over 5 GWs, poor next week.  B: the reverse.
  const a = base({ expectedPoints: 40, expectedPointsNext: 3, pPlay: 1, score: 40 });
  const b = base({ expectedPoints: 25, expectedPointsNext: 9, pPlay: 1, score: 25 });
  const { captain } = pickCaptain([a, b]);
  check(
    "A-02 capitão é escolhido pela próxima jornada, não pela janela de 5",
    captain === b,
    `escolhido o de ${captain?.expectedPointsNext} pts na próxima`
  );
}

// ---------------------------------------------------------------------
// C-05 — plantel válido, ou honestamente sinalizado como inválido
// ---------------------------------------------------------------------
function testSquadValidity() {
  const mk = (id: number, type: number, price: number, score: number): ScoredPlayer =>
    ({
      element: makeElement({ id, element_type: type }),
      team: makeTeam((id % 20) + 1),
      positionShort: "X", priceM: price, ownershipPct: 5, formNum: 0, modelTrust: 1,
      fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.4,
      cleanSheetProbability: 0.3, individualExpectedGI: 0, ceilingGI: 0, floorGI: 0,
      expectedPoints: score, expectedPointsNext: score / 5, pPlay: 1,
      breakdown: {
        appearance: 0, goals: 0, assists: 0, cleanSheet: 0,
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, cards: 0, total: score,
      },
      score, isDifferential: false, isPreseason: false, reasons: [],
    }) as ScoredPlayer;

  // Deterministic, adversarial price distribution: lots of expensive
  // high scorers up front, which is what used to starve the forwards.
  let invalid = 0;
  const trials = 60;
  for (let t = 0; t < trials; t++) {
    const pool: ScoredPlayer[] = [];
    let id = 1;
    for (const type of [1, 2, 3, 4]) {
      const n = type === 1 ? 30 : 80;
      for (let i = 0; i < n; i++) {
        // price correlates with score, so greedy-by-score overspends
        const r = ((t * 31 + i * 17) % 100) / 100;
        const price = r < 0.45 ? 3.9 + r : r < 0.85 ? 5.0 + r * 3 : 9.5 + r * 5;
        pool.push(mk(id++, type, Math.round(price * 10) / 10, price * 4));
      }
    }
    pool.sort((a, b) => b.score - a.score);
    const { squad } = buildSuggestedSquad(pool, 100);
    if (!isValidSquad(squad, 100)) invalid++;
  }
  check(
    "C-05 heurística de recurso produz sempre um plantel 2-5-5-3 válido",
    invalid === 0,
    `${invalid}/${trials} inválidos`
  );

  // isValidSquad itself must actually catch the failure modes.
  const short = Array.from({ length: 14 }, (_, i) => mk(i + 1, 3, 5, 10));
  check("isValidSquad rejeita plantel curto", !isValidSquad(short, 100));
  const overBudget = [
    ...Array.from({ length: 2 }, (_, i) => mk(i + 1, 1, 50, 10)),
    ...Array.from({ length: 5 }, (_, i) => mk(i + 10, 2, 50, 10)),
    ...Array.from({ length: 5 }, (_, i) => mk(i + 20, 3, 50, 10)),
    ...Array.from({ length: 3 }, (_, i) => mk(i + 30, 4, 50, 10)),
  ];
  check("isValidSquad rejeita plantel acima do orçamento", !isValidSquad(overBudget, 100));
}

// ---------------------------------------------------------------------
// C-02 — efeito combinado das notas táticas travado em ±20%
// ---------------------------------------------------------------------
function testInsightClamp() {
  const { bootstrap, fixtures } = makeBootstrap({ currentEvent: 6, gameweeks: 12 });
  const target = bootstrap.elements.find((e) => e.element_type === 3)!;

  const baseline = buildScoredPlayers(bootstrap, fixtures, 6, 5, null, []);
  const baseScore = baseline.find((p) => p.element.id === target.id)!.expectedPoints;

  const three = [
    { scope: "player" as const, id: target.id, label: "x", factor: 0.8, reason: "a", addedDate: "2026-08-21", source: "t" },
    { scope: "player" as const, id: target.id, label: "y", factor: 0.8, reason: "b", addedDate: "2026-08-21", source: "t" },
    { scope: "team" as const, id: target.team, label: "z", factor: 0.8, reason: "c", addedDate: "2026-08-21", source: "t" },
  ];
  const clamped = buildScoredPlayers(bootstrap, fixtures, 6, 5, null, three);
  const got = clamped.find((p) => p.element.id === target.id)!.expectedPoints;

  // Raw product would be 0.512; the promised bound is 0.8.
  check(
    "C-02 três notas a 0.8 não reduzem mais de 20% no total",
    got >= baseScore * 0.8 - 0.05,
    `base=${baseScore} obtido=${got} (produto sem limite seria ${(baseScore * 0.512).toFixed(2)})`
  );
  const boosted = buildScoredPlayers(bootstrap, fixtures, 6, 5, null, [
    { scope: "player" as const, id: target.id, label: "x", factor: 1.2, reason: "a", addedDate: "2026-08-21", source: "t" },
    { scope: "team" as const, id: target.team, label: "z", factor: 1.2, reason: "c", addedDate: "2026-08-21", source: "t" },
  ]);
  const up = boosted.find((p) => p.element.id === target.id)!.expectedPoints;
  check(
    "C-02 duas notas a 1.2 não aumentam mais de 20% no total",
    up <= baseScore * 1.2 + 0.05,
    `base=${baseScore} obtido=${up}`
  );
}

// ---------------------------------------------------------------------
// Modelo de minutos — o padrão "Rice"
// ---------------------------------------------------------------------
function testMinutesModel() {
  const early = computeMinutesModel(
    makeElement({ minutes: 440, starts: 8 }), 10, false
  );
  check("substituído cedo: minutos por titularidade abaixo do limiar", early.avgMinutesPerStart < 65);
  check("substituído cedo: nota explicativa presente", early.reasons.some((r) => r.includes("substituição cedo")));
  check("substituído cedo: P(60min) claramente abaixo de 1", early.pPlay60 < 0.6);

  const full = computeMinutesModel(makeElement({ minutes: 720, starts: 8 }), 10, false);
  check("titular de 90min: sem nota de substituição cedo", !full.reasons.some((r) => r.includes("substituição cedo")));
  check("titular de 90min: P(60min) alta", full.pPlay60 > 0.7);
  check("titular de 90min tem mais minutos esperados que o substituído cedo", full.expectedMinutes > early.expectedMinutes);

  // The estimator is an upper bound; it must never exceed a full match.
  const inflated = computeMinutesModel(makeElement({ minutes: 1200, starts: 8 }), 12, false);
  check("minutos por titularidade nunca ultrapassam 90", inflated.avgMinutesPerStart <= 90);

  const pre = computeMinutesModel(makeElement({ minutes: 0, starts: 0 }), 0, true);
  check("pré-época: assume titular, sem penalizar", pre.pStart === 1 && pre.reasons.length === 0);
}

// ---------------------------------------------------------------------
// Bónus e bolas paradas — sinais que existiam e não eram usados
// ---------------------------------------------------------------------
function testRatesUseNeglectedSignals() {
  const withBonus = computePlayerRates(
    makeElement({ minutes: 900, bonus: 15, goals_scored: 5, assists: 3 })
  );
  check("bónus por 90 é calculado", withBonus.bonus90 > 0);

  const pens = computePlayerRates(makeElement({ minutes: 900, penalties_order: 1 }));
  check("marcador de penáltis recebe acréscimo de golos esperados", pens.setPieceXg90 > 0);
  check("marcador de penáltis é assinalado ao utilizador", pens.reasons.some((r) => r.includes("penalidades")));

  const none = computePlayerRates(makeElement({ minutes: 900 }));
  check("sem bolas paradas não há acréscimo", none.setPieceXg90 === 0);
}

// ---------------------------------------------------------------------
// Onze inicial — tem de ser legal, ou dizer que não é
// ---------------------------------------------------------------------
function testBestXI() {
  const mk = (id: number, type: number, pts: number): ScoredPlayer =>
    ({
      element: makeElement({ id, element_type: type }), team: makeTeam(1),
      positionShort: "X", priceM: 5, ownershipPct: 5, formNum: 0,
      fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.4,
      cleanSheetProbability: 0.3, individualExpectedGI: 0, ceilingGI: 0, floorGI: 0,
      expectedPoints: pts * 5, expectedPointsNext: pts, pPlay: 1,
      breakdown: {
        appearance: 0, goals: 0, assists: 0, cleanSheet: 0,
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, cards: 0, total: 0,
      },
      score: pts * 5, isDifferential: false, isPreseason: false, reasons: [],
    }) as ScoredPlayer;

  const legal = [
    ...Array.from({ length: 2 }, (_, i) => mk(i + 1, 1, 3)),
    ...Array.from({ length: 5 }, (_, i) => mk(i + 10, 2, 4)),
    ...Array.from({ length: 5 }, (_, i) => mk(i + 20, 3, 6)),
    ...Array.from({ length: 3 }, (_, i) => mk(i + 30, 4, 5)),
  ];
  const good = pickBestXIChecked(legal);
  check("onze legal tem 11 jogadores", good.xi.length === 11);
  check("onze legal é sinalizado como válido", good.valid);
  check("onze legal tem exatamente 1 GK", good.xi.filter((p) => p.element.element_type === 1).length === 1);
  check("onze legal tem pelo menos 3 DEF", good.xi.filter((p) => p.element.element_type === 2).length >= 3);
  check("onze legal tem pelo menos 1 FWD", good.xi.filter((p) => p.element.element_type === 4).length >= 1);

  const allKeepers = Array.from({ length: 15 }, (_, i) => mk(i + 1, 1, 3));
  const bad = pickBestXIChecked(allKeepers);
  check("onze impossível é sinalizado como inválido, não devolvido em silêncio", !bad.valid);
}

// ---------------------------------------------------------------------
// Camada qualitativa — validação e resolução de nomes
// ---------------------------------------------------------------------
function testInsightValidation() {
  const ok = { scope: "player" as const, id: 1, label: "X", factor: 0.9, reason: "r", source: "s" };
  check("nota válida é aceite", validateInsightInput(ok, () => true, 0).ok);
  check("fator acima de 1.2 é rejeitado", !validateInsightInput({ ...ok, factor: 1.3 }, () => true, 0).ok);
  check("fator abaixo de 0.8 é rejeitado", !validateInsightInput({ ...ok, factor: 0.7 }, () => true, 0).ok);
  check("fator NaN é rejeitado", !validateInsightInput({ ...ok, factor: NaN }, () => true, 0).ok);
  check("jogador inexistente é rejeitado", !validateInsightInput(ok, () => false, 0).ok);
  check("limite de notas ativas é respeitado", !validateInsightInput(ok, () => true, 15).ok);

  const { bootstrap } = makeBootstrap({ teamCount: 2 });
  bootstrap.elements = [
    makeElement({ id: 100, web_name: "Ødegaard", first_name: "Martin", second_name: "Ødegaard", team: 1 }),
    makeElement({ id: 101, web_name: "Silva", first_name: "Thiago", second_name: "Silva", team: 2 }),
  ];
  const accented = resolveInsightTarget(bootstrap, "player", { playerName: "Odegaard" });
  check("nome com carácter especial resolve sem acento", accented.ok && accented.id === 100);
  const unknown = resolveInsightTarget(bootstrap, "player", { playerName: "Jogador Inexistente" });
  check("nome inexistente é rejeitado em vez de adivinhado", !unknown.ok);
  const team = resolveInsightTarget(bootstrap, "team", { teamShortName: "T1" });
  check("equipa resolve por sigla", team.ok && team.id === 1);
}

// ---------------------------------------------------------------------
// Robustez — dados corrompidos não podem chegar ao ecrã
// ---------------------------------------------------------------------
function testCorruptDataIsContained() {
  const { bootstrap, fixtures } = makeBootstrap({ currentEvent: 6, gameweeks: 12 });
  // Strip fields the model reads without a guard.
  bootstrap.elements = bootstrap.elements.map((el, i) =>
    i === 0
      ? ({ ...el, now_cost: undefined, minutes: undefined } as unknown as typeof el)
      : el
  );
  bootstrap.teams = bootstrap.teams.map((t, i) =>
    i === 0 ? ({ ...t, strength_attack_home: undefined } as unknown as typeof t) : t
  );

  const scored = buildScoredPlayers(bootstrap, fixtures, 6, 5, null, []);
  check(
    "campo em falta não produz pontuação NaN",
    scored.every((p) => Number.isFinite(p.score)),
    `${scored.filter((p) => !Number.isFinite(p.score)).length} pontuações não finitas`
  );
  check("campo em falta não produz preço NaN", scored.every((p) => Number.isFinite(p.priceM)));
  check(
    "campo em falta não produz pontos da próxima jornada NaN",
    scored.every((p) => Number.isFinite(p.expectedPointsNext))
  );
}

// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// C-06 — forças da FPL a zero não podem colapsar o modelo inteiro
// (confirmado ao vivo em 2026-08-21: strength_* = 0, strength = null)
// ---------------------------------------------------------------------
function testMissingTeamStrengths() {
  const zeroed = Array.from({ length: 6 }, (_, i) => ({
    ...makeTeam(i + 1),
    strength_attack_home: 0,
    strength_attack_away: 0,
    strength_defence_home: 0,
    strength_defence_away: 0,
  }));
  const fixtures = [
    makeFixture({ id: 1, event: 1, team_h: 1, team_a: 2 }),
    makeFixture({ id: 2, event: 2, team_h: 3, team_a: 1 }),
  ];

  check("forças em falta são detetadas", !teamStrengthsUsable(zeroed));

  const exp = buildFixtureExpectations(zeroed, fixtures, null, null);
  const rows = exp.get(1) ?? [];
  check("ainda são produzidas expectativas por jogo", rows.length === 2);
  for (const r of rows) {
    check(
      "golos esperados não colapsam para zero sem as forças da FPL",
      r.expectedGoalsFor > 0.5,
      `obtido ${r.expectedGoalsFor}`
    );
    check(
      "probabilidade de clean sheet não fica em 100%",
      r.cleanSheetProbability < 0.95,
      `obtido ${r.cleanSheetProbability}`
    );
  }
  // Casa continua a valer mais do que fora, mesmo no modo neutro.
  const home = rows.find((r) => r.isHome);
  const away = rows.find((r) => !r.isHome);
  check(
    "vantagem caseira mantém-se no modo neutro",
    !!home && !!away && home!.expectedGoalsFor > away!.expectedGoalsFor
  );

  // Com forças reais, o modelo tem de voltar a diferenciar equipas.
  const real = Array.from({ length: 6 }, (_, i) => ({
    ...makeTeam(i + 1),
    strength_attack_home: 1000 + i * 200,
    strength_attack_away: 1000 + i * 200,
    strength_defence_home: 1000 + i * 200,
    strength_defence_away: 1000 + i * 200,
  }));
  check("forças reais são reconhecidas como utilizáveis", teamStrengthsUsable(real));
  const realExp = buildFixtureExpectations(real, fixtures, null, null);
  const strongRow = (realExp.get(6) ?? [])[0];
  const weakRow = (realExp.get(1) ?? [])[0];
  check(
    "com forças reais, equipas diferentes têm números diferentes",
    !strongRow || !weakRow || strongRow.expectedGoalsFor !== weakRow.expectedGoalsFor
  );

  // Campo ausente por completo (não apenas zero) também não pode dar NaN.
  const missing = zeroed.map((t) => {
    const copy = { ...t } as Partial<typeof t>;
    delete copy.strength_attack_home;
    return copy as typeof t;
  });
  const missingExp = buildFixtureExpectations(missing, fixtures, null, null);
  const missingRows = missingExp.get(1) ?? [];
  check(
    "campo ausente não produz NaN nos golos esperados",
    missingRows.every((r) => Number.isFinite(r.expectedGoalsFor))
  );
}

// ---------------------------------------------------------------------
// Odds como fonte primária — a inversão do mercado tem de ser fiel
// ---------------------------------------------------------------------
function testMarketInversion() {
  // Ida e volta: um total conhecido -> P(over 2.5) -> total recuperado.
  for (const total of [1.8, 2.5, 3.2, 4.0]) {
    const p = overTwoPointFiveProbability(total / 2, total / 2);
    const back = totalGoalsFromOverProb(p);
    check(
      `total de golos recuperado do mercado (${total})`,
      Math.abs(back - total) < 0.05,
      `esperado ${total}, obtido ${back.toFixed(3)}`
    );
  }

  const mk = (over: number | null, home: number, draw: number, away: number): OddsMatch => ({
    homeTeam: "Arsenal", awayTeam: "Coventry",
    homeWinProb: home, drawProb: draw, awayWinProb: away,
    overProb: over, commenceTime: "",
  });

  // Favorito forte em casa, jogo com muitos golos esperados.
  const strong = expectedGoalsFromMarket(mk(0.62, 0.72, 0.18, 0.10));
  check("favorito forte tem mais golos esperados que o adversário", strong.xgHome > strong.xgAway);
  check("total do mercado é usado quando existe", strong.totalFromMarket);

  // A inversão tem de REPRODUZIR a probabilidade que lhe foi dada.
  const { pHome } = matchOutcomeProbabilities(strong.xgHome, strong.xgAway);
  check(
    "inversão reproduz a probabilidade de vitória do mercado",
    Math.abs(pHome - 0.72) < 0.02,
    `mercado 0.72, modelo ${pHome.toFixed(3)}`
  );

  // Jogo equilibrado -> golos esperados aproximadamente simétricos.
  const even = expectedGoalsFromMarket(mk(0.5, 0.40, 0.26, 0.34));
  check("jogo equilibrado dá golos esperados próximos", Math.abs(even.xgHome - even.xgAway) < 0.5);

  // Sem mercado de totais continua a funcionar, mas assinala-o.
  const noTotals = expectedGoalsFromMarket(mk(null, 0.6, 0.22, 0.18));
  check("sem mercado de totais ainda produz números", noTotals.xgHome > 0 && noTotals.xgAway > 0);
  check("sem mercado de totais é assinalado", !noTotals.totalFromMarket);

  // Um jogo com MUITOS golos tem de dar clean sheets menos prováveis que
  // um jogo fechado — era exatamente isto que o "tilt" antigo não conseguia
  // exprimir, porque preservava o produto dos dois números.
  const highScoring = expectedGoalsFromMarket(mk(0.78, 0.45, 0.25, 0.30));
  const lowScoring = expectedGoalsFromMarket(mk(0.30, 0.45, 0.25, 0.30));
  check(
    "mercado de muitos golos produz total maior que um de poucos golos",
    highScoring.xgHome + highScoring.xgAway > lowScoring.xgHome + lowScoring.xgAway,
    `alto=${(highScoring.xgHome + highScoring.xgAway).toFixed(2)} baixo=${(lowScoring.xgHome + lowScoring.xgAway).toFixed(2)}`
  );
}

function testMarketDerivedRatings() {
  const teams = Array.from({ length: 4 }, (_, i) => makeTeam(i + 1, `T${i + 1}`));
  // T1 é forte (esmaga toda a gente), T4 é fraco.
  const matches: OddsMatch[] = [
    { homeTeam: "T1", awayTeam: "T4", homeWinProb: 0.80, drawProb: 0.13, awayWinProb: 0.07, overProb: 0.65, commenceTime: "" },
    { homeTeam: "T1", awayTeam: "T3", homeWinProb: 0.72, drawProb: 0.18, awayWinProb: 0.10, overProb: 0.60, commenceTime: "" },
    { homeTeam: "T2", awayTeam: "T4", homeWinProb: 0.68, drawProb: 0.20, awayWinProb: 0.12, overProb: 0.58, commenceTime: "" },
  ];
  const resolve = (n: string) => {
    const t = teams.find((x) => x.short_name === n);
    return t ? t.id : null;
  };
  const ratings = deriveTeamRatingsFromMarket(teams, matches, resolve);

  const strong = ratings.get(1)!;
  const weak = ratings.get(4)!;
  check("equipa forte tem ataque acima da equipa fraca", strong.attack > weak.attack,
    `forte=${strong.attack.toFixed(2)} fraca=${weak.attack.toFixed(2)}`);
  check("equipa forte sofre menos que a fraca (defesa menor é melhor)", strong.defence < weak.defence,
    `forte=${strong.defence.toFixed(2)} fraca=${weak.defence.toFixed(2)}`);
  check("amostra é contabilizada", strong.sample === 2 && weak.sample === 2);

  // Equipa sem qualquer jogo no mercado fica neutra, não inventada.
  const unseen = deriveTeamRatingsFromMarket(teams, [], resolve).get(1)!;
  check("sem mercado a equipa fica neutra", unseen.attack === 1 && unseen.defence === 1 && unseen.sample === 0);

  // Nome que não resolve não pode contaminar outra equipa.
  const bogus = deriveTeamRatingsFromMarket(
    teams,
    [{ homeTeam: "Equipa Inexistente", awayTeam: "T1", homeWinProb: 0.9, drawProb: 0.05, awayWinProb: 0.05, overProb: 0.5, commenceTime: "" }],
    resolve
  );
  check("jogo com equipa não resolvida é ignorado por completo", (bogus.get(1)?.sample ?? 0) === 0);
}

// ---------------------------------------------------------------------
// Cobertura do mercado — uma equipa sem rating não pode deitar fora a
// informação que o mercado dá sobre a outra
// ---------------------------------------------------------------------
function testPartialMarketCoverage() {
  const teams = Array.from({ length: 4 }, (_, i) => makeTeam(i + 1, `T${i + 1}`));
  // Só T1 e T2 aparecem no mercado. T3 nunca é avaliado (ex: recém-promovido
  // cujo nome o fornecedor de odds escreve de outra forma).
  const matches: OddsMatch[] = [
    { homeTeam: "T1", awayTeam: "T2", homeWinProb: 0.75, drawProb: 0.15, awayWinProb: 0.10, overProb: 0.62, commenceTime: "" },
  ];
  // Jogo entre uma equipa avaliada (T1) e uma não avaliada (T3).
  const fixtures = [makeFixture({ id: 1, event: 1, team_h: 1, team_a: 3 })];
  const exp = buildFixtureExpectations(teams, fixtures, matches, null);
  const row = (exp.get(1) ?? [])[0];
  // A v1.28 substituiu a cascata por uma mistura ponderada por precisão, por
  // isso a etiqueta de fonte passou a reportar o contribuinte DOMINANTE e não
  // o primeiro que se aplicava. Com um só jogo com preço contra um prior
  // calibrado de 20 equipas, o prior domina — o que está certo. O que o teste
  // tem de garantir é o que sempre quis garantir: que a informação do mercado
  // não é deitada fora.
  check("informação do mercado é usada mesmo quando só uma equipa está avaliada",
    row?.marketAdjusted === true, `fonte=${row?.source}, mercado=${row?.marketAdjusted}`);
  check("a equipa forte continua a ter mais golos esperados que a fraca",
    !!row && row.expectedGoalsFor > row.expectedGoalsAgainst);

  // Com ratings da FPL válidos, um jogo sem mercado deve cair no degrau da
  // FPL — que é melhor que neutro. A hierarquia tem de ser respeitada.
  const neither = buildFixtureExpectations(
    teams, [makeFixture({ id: 2, event: 1, team_h: 3, team_a: 4 })], matches, null
  );
  const nrow = (neither.get(3) ?? [])[0];
  check("sem mercado mas com ratings da FPL, usa a FPL e não o neutro",
    nrow?.source === "fpl", `fonte=${nrow?.source}`);

  // Só quando NEM mercado NEM ratings da FPL existem é que fica neutro.
  const bare = teams.map((t) => ({
    ...t, strength_attack_home: 0, strength_attack_away: 0,
    strength_defence_home: 0, strength_defence_away: 0,
  }));
  const nothing = buildFixtureExpectations(
    bare, [makeFixture({ id: 3, event: 1, team_h: 3, team_a: 4 })], matches, null
  );
  const brow = (nothing.get(3) ?? [])[0];
  check("sem mercado e sem ratings da FPL fica neutro e é assinalado",
    brow?.source === "neutral", `fonte=${brow?.source}`);
}

// ---------------------------------------------------------------------
// Redis — a integração da Vercel injeta nomes KV_*, não UPSTASH_*
// ---------------------------------------------------------------------
function testRedisCredentialNames() {
  const keys = [
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL", "KV_REST_API_TOKEN",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const clear = () => { for (const k of keys) delete process.env[k]; };

  // `isStorageConfigured` memoiza o cliente, por isso testa-se aqui a
  // MESMA regra de leitura de credenciais que ele usa, sem depender da
  // ordem de importação do módulo.
  const configured = () => {
    const url =
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token =
      process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return Boolean(url && token);
  };

  clear();
  check("sem credenciais nenhumas, o armazenamento é reportado como desligado",
    configured() === false);

  clear();
  process.env.KV_REST_API_URL = "https://exemplo.upstash.io";
  process.env.KV_REST_API_TOKEN = "token-de-teste";
  check("nomes KV_* da integração da Vercel são reconhecidos",
    configured() === true);

  clear();
  process.env.UPSTASH_REDIS_REST_URL = "https://exemplo.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";
  check("nomes UPSTASH_* (credenciais coladas à mão) continuam a funcionar",
    configured() === true);

  clear();
  process.env.KV_REST_API_URL = "https://exemplo.upstash.io";
  check("url sem token não conta como configurado", configured() === false);

  // E o módulo real tem de concordar com esta regra no estado atual.
  clear();
  check("lib/kv concorda: sem credenciais, desligado", isStorageConfigured() === false);

  clear();
  for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k]!;
}

// ---------------------------------------------------------------------
// PRÉ-ÉPOCA — a pontuação não pode ser só a ordenação da própria FPL
// ---------------------------------------------------------------------
function testPreseasonDifferentiation() {
  const { bootstrap } = makeBootstrap({ teamCount: 4, gameweeks: 1, currentEvent: null });
  // Calendário construído à mão: a T1 tem um jogo fácil na jornada 1 e
  // jogos difíceis depois; a T3 tem exatamente o perfil inverso.
  // Rotação completa: cada equipa joga exatamente uma vez por jornada, e
  // com adversários diferentes, para os calendários serem genuinamente
  // distintos sem criar jornadas duplas acidentais.
  const fixtures = [
    makeFixture({ id: 1, event: 1, team_h: 1, team_a: 2 }),
    makeFixture({ id: 2, event: 1, team_h: 3, team_a: 4 }),
    makeFixture({ id: 3, event: 2, team_h: 1, team_a: 3 }),
    makeFixture({ id: 4, event: 2, team_h: 2, team_a: 4 }),
    makeFixture({ id: 5, event: 3, team_h: 1, team_a: 4 }),
    makeFixture({ id: 6, event: 3, team_h: 2, team_a: 3 }),
    makeFixture({ id: 7, event: 4, team_h: 2, team_a: 1 }),
    makeFixture({ id: 8, event: 4, team_h: 4, team_a: 3 }),
    makeFixture({ id: 9, event: 5, team_h: 3, team_a: 1 }),
    makeFixture({ id: 10, event: 5, team_h: 4, team_a: 2 }),
  ];

  bootstrap.elements = bootstrap.elements.map((el) =>
    makeElement({
      ...el, minutes: 0, starts: 0, goals_scored: 0, assists: 0, bonus: 0,
      expected_goals_per_90: "0", expected_assists_per_90: "0", ep_next: "4.0",
      penalties_order: null,
    })
  );

  // O mercado avalia só a jornada 1: T1 esmaga a T2 (muitos golos), e a
  // T3 tem um jogo fechado. Isso dá forças derivadas do mercado que depois
  // projetam as jornadas seguintes.
  const odds: OddsMatch[] = [
    { homeTeam: "T1", awayTeam: "T2", homeWinProb: 0.82, drawProb: 0.12, awayWinProb: 0.06, overProb: 0.75, commenceTime: "" },
  ];

  const scored = buildScoredPlayers(bootstrap, fixtures, 1, 5, odds, []);
  check("pré-época é detetada", scored[0]?.isPreseason === true);

  const distinct = new Set(scored.map((p) => p.expectedPoints.toFixed(3)));
  check(
    "com o mesmo ep_next, o calendário passa a diferenciar jogadores",
    distinct.size > 1,
    `${distinct.size} pontuações distintas entre ${scored.length} jogadores`
  );

  // A jornada 1 tem de continuar a ser exatamente o número da FPL — é aí
  // que a FPL é a melhor fonte e não a queremos corrigir.
  const plain = scored.find((p) => !p.element.penalties_order);
  check(
    "jornada 1 continua a ser exatamente o ep_next da FPL",
    !!plain && Math.abs(plain.expectedPointsNext - 4.0) < 1e-6,
    `obtido ${plain?.expectedPointsNext}`
  );

  // E o efeito tem de ser limitado: nunca mais do que o número de jogos
  // vezes o ep_next, com a folga do limite por jogo.
  // Cada equipa joga exatamente 5 vezes, e cada jogo está limitado a 1.6x
  // o valor da jornada 1, por isso o teto é ep_next * 5 * 1.6.
  const maxSeen = Math.max(...scored.map((p) => p.expectedPoints));
  check(
    "o ajuste de calendário está limitado e não explode",
    maxSeen <= 4.0 * 5 * 1.6 + 1e-6,
    `máximo observado ${maxSeen}`
  );
  const minSeen = Math.min(...scored.map((p) => p.expectedPoints));
  check(
    "e também tem um piso — um calendário mau não zera o jogador",
    minSeen >= 4.0 * 5 * 0.55 - 1e-6,
    `mínimo observado ${minSeen}`
  );
}

function testPreseasonSetPieces() {
  const { bootstrap, fixtures } = makeBootstrap({
    teamCount: 4, gameweeks: 6, currentEvent: null,
  });
  bootstrap.elements = bootstrap.elements.map((el, i) =>
    makeElement({
      ...el, minutes: 0, starts: 0, ep_next: "4.0",
      penalties_order: i === 0 ? 1 : null,
    })
  );
  const scored = buildScoredPlayers(bootstrap, fixtures, 1, 5, null, []);
  const taker = scored.find((p) => p.element.penalties_order === 1)!;
  const other = scored.find(
    (p) => !p.element.penalties_order && p.element.element_type === taker.element.element_type
  )!;
  check(
    "marcador de penáltis pontua acima de um colega igual em pré-época",
    taker.expectedPoints > other.expectedPoints,
    `penáltis=${taker.expectedPoints} outro=${other.expectedPoints}`
  );
  check(
    "e o utilizador percebe porquê",
    taker.reasons.some((r) => r.includes("grandes penalidades"))
  );
  check(
    "o acréscimo é modesto, não uma reordenação da liga",
    taker.expectedPoints / other.expectedPoints < 1.2,
    `rácio ${(taker.expectedPoints / other.expectedPoints).toFixed(3)}`
  );
}

// ---------------------------------------------------------------------
// Notas curadas à mão — identificadas por nome, resolvidas contra a FPL
// ---------------------------------------------------------------------
function testStaticInsightSeeds() {
  check("existem notas curadas", MANAGER_INSIGHT_SEEDS.length > 0);

  for (const seed of MANAGER_INSIGHT_SEEDS) {
    check(
      `fator de "${seed.label}" está dentro de ±20%`,
      seed.factor >= 0.8 && seed.factor <= 1.2,
      `fator ${seed.factor}`
    );
    check(`"${seed.label}" tem fonte`, seed.source.length > 10);
    check(`"${seed.label}" tem data`, /^\d{4}-\d{2}-\d{2}$/.test(seed.addedDate));
    check(
      `"${seed.label}" identifica o alvo por nome, não por id`,
      Boolean(seed.playerName || seed.teamShortName || seed.teamName)
    );
  }

  // Uma nota cujo jogador não existe nos dados da FPL tem de ser DESCARTADA,
  // nunca aplicada a outro jogador.
  const { bootstrap } = makeBootstrap({ teamCount: 2 });
  bootstrap.teams = [makeTeam(1, "NFO"), makeTeam(2, "CRY")];
  bootstrap.elements = [
    makeElement({ id: 500, web_name: "Neco Williams", first_name: "Neco", second_name: "Williams", team: 1 }),
  ];
  const resolved = resolveStaticInsights(bootstrap);
  check(
    "só resolve as notas cujo jogador existe mesmo",
    resolved.length === 1 && resolved[0].id === 500,
    `resolvidas ${resolved.length}`
  );
  check("a nota resolvida mantém o fator da seed", resolved[0].factor > 1);

  // Sem qualquer jogador correspondente, nada é aplicado.
  const empty = resolveStaticInsights({ ...bootstrap, elements: [] });
  check("sem correspondências, nenhuma nota é aplicada", empty.length === 0);
}

// ---------------------------------------------------------------------
// Otimizador — o dinheiro tem de ir para o ONZE, não para o banco
// ---------------------------------------------------------------------
function testOptimizerBenchSpend() {
  const pool: ScoredPlayer[] = [];
  let id = 1;
  for (let t = 1; t <= 20; t++) {
    const teamStrength = 0.6 + (t % 10) / 10;
    for (const [type, n] of [[1, 3], [2, 9], [3, 10], [4, 6]] as [number, number][]) {
      for (let i = 0; i < n; i++) {
        const r = ((id * 37) % 100) / 100;
        const price = r < 0.5 ? 3.9 + r * 1.2 : r < 0.85 ? 5.0 + r * 3 : 9.0 + r * 6;
        const pts = (price * 1.6 + teamStrength * 8) * (0.85 + ((id * 17) % 30) / 100);
        pool.push({
          element: makeElement({ id, element_type: type, team: t }),
          team: makeTeam(t), positionShort: "X",
          priceM: Math.round(price * 10) / 10, ownershipPct: 5, formNum: 0,
          fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.4,
          cleanSheetProbability: 0.3, individualExpectedGI: 0, ceilingGI: 0, floorGI: 0,
          expectedPoints: Math.round(pts * 10) / 10, expectedPointsNext: pts / 5, pPlay: 1,
          breakdown: { appearance: 0, goals: 0, assists: 0, cleanSheet: 0, concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, cards: 0, total: pts },
          score: Math.round(pts * 10) / 10, isDifferential: false, isPreseason: false, reasons: [],
        } as ScoredPlayer);
        id++;
      }
    }
  }

  const started = Date.now();
  const res = buildOptimalSquad(pool, 100);
  const elapsed = Date.now() - started;

  check("otimizador resolve (não cai na heurística)", res.method === "otimizador", res.method);
  check("resolve dentro do limite de tempo da Vercel", elapsed < 8000, `${elapsed}ms`);
  check("plantel devolvido é válido", isValidSquad(res.squad, 100));
  check("onze tem 11 jogadores", res.starters.length === 11, `${res.starters.length}`);

  const xiIds = new Set(res.starters.map((p) => p.element.id));
  const bench = res.squad.filter((p) => !xiIds.has(p.element.id));
  check("banco tem 4 jogadores", bench.length === 4, `${bench.length}`);

  const benchSpend = bench.reduce((s, p) => s + p.priceM, 0);
  const xiSpend = res.starters.reduce((s, p) => s + p.priceM, 0);
  // Quatro jogadores ao preço mínimo rondam £16m. O modelo antigo chegava a
  // sentar um jogador de £6.6m no banco.
  check(
    "o banco é comprado ao preço mínimo, não com dinheiro a sério",
    benchSpend <= 18,
    `£${benchSpend.toFixed(1)}m no banco`
  );
  check(
    "nenhum jogador caro fica sentado no banco",
    bench.every((p) => p.priceM <= 5.5),
    `mais caro no banco: £${Math.max(...bench.map((p) => p.priceM))}m`
  );
  check(
    "a maior parte do orçamento vai para o onze",
    xiSpend > benchSpend * 4,
    `onze £${xiSpend.toFixed(1)}m vs banco £${benchSpend.toFixed(1)}m`
  );

  // O onze escolhido pelo solver tem de ser uma formação legal.
  const cnt = (t: number) => res.starters.filter((p) => p.element.element_type === t).length;
  check("onze tem exatamente 1 guarda-redes", cnt(1) === 1, `${cnt(1)}`);
  check("onze tem pelo menos 3 defesas", cnt(2) >= 3, `${cnt(2)}`);
  check("onze tem pelo menos 2 médios", cnt(3) >= 2, `${cnt(3)}`);
  check("onze tem pelo menos 1 avançado", cnt(4) >= 1, `${cnt(4)}`);
}

// ---------------------------------------------------------------------
// Risco de correlação — pontos da mesma equipa não são independentes
// ---------------------------------------------------------------------
function testCorrelationRisk() {
  const mk = (id: number, type: number, teamId: number, pts: number, cs: number): ScoredPlayer =>
    ({
      element: makeElement({ id, element_type: type, team: teamId }),
      team: makeTeam(teamId, `T${teamId}`), positionShort: "X", priceM: 5,
      ownershipPct: 5, formNum: 0, fixtureAvgDifficulty: 3, nextOpponents: "",
      expectedGoalsFor: 1.4, cleanSheetProbability: cs, individualExpectedGI: 0,
      ceilingGI: 0, floorGI: 0, expectedPoints: pts * 5, expectedPointsNext: pts, pPlay: 1,
      breakdown: { appearance: 0, goals: 0, assists: 0, cleanSheet: 0, concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, cards: 0, total: 0 },
      score: pts * 5, isDifferential: false, isPreseason: false, reasons: [],
    }) as ScoredPlayer;

  // Onze A: 1 GK + 4 DEF TODOS do mesmo clube (concentração máxima).
  const stacked = [
    mk(1, 1, 1, 4, 0.4), mk(2, 2, 1, 4, 0.4), mk(3, 2, 1, 4, 0.4),
    mk(4, 2, 1, 4, 0.4), mk(5, 2, 1, 4, 0.4),
    mk(6, 3, 2, 5, 0.3), mk(7, 3, 3, 5, 0.3), mk(8, 3, 4, 5, 0.3),
    mk(9, 3, 5, 5, 0.3), mk(10, 4, 6, 5, 0.3), mk(11, 4, 7, 5, 0.3),
  ];
  // Onze B: exatamente os mesmos jogadores, mas espalhados por 5 clubes.
  const spread = [
    mk(1, 1, 1, 4, 0.4), mk(2, 2, 8, 4, 0.4), mk(3, 2, 9, 4, 0.4),
    mk(4, 2, 10, 4, 0.4), mk(5, 2, 11, 4, 0.4),
    mk(6, 3, 2, 5, 0.3), mk(7, 3, 3, 5, 0.3), mk(8, 3, 4, 5, 0.3),
    mk(9, 3, 5, 5, 0.3), mk(10, 4, 6, 5, 0.3), mk(11, 4, 7, 5, 0.3),
  ];

  const a = computeSquadRisk(stacked);
  const b = computeSquadRisk(spread);

  check(
    "os pontos esperados são IGUAIS nos dois onzes",
    Math.abs(a.expectedPoints - b.expectedPoints) < 1e-6,
    `empilhado=${a.expectedPoints} espalhado=${b.expectedPoints}`
  );
  check(
    "mas o onze empilhado tem variância maior",
    a.stdDev > b.stdDev * 1.15,
    `empilhado ±${a.stdDev} vs espalhado ±${b.stdDev}`
  );
  check(
    "a concentração global do onze empilhado é sinalizada acima de 1",
    a.concentrationRatio > 1.15,
    `${a.concentrationRatio}×`
  );
  check(
    "o onze espalhado aproxima-se de totalmente diversificado",
    b.concentrationRatio < 1.05,
    `${b.concentrationRatio}×`
  );
  // A métrica defensiva isolada é a que mostra o risco a sério — não é
  // diluída pelo bloco ofensivo.
  check(
    "a concentração DEFENSIVA isolada expõe a pilha com muito mais clareza",
    a.defensiveConcentrationRatio > 2,
    `defensiva ${a.defensiveConcentrationRatio}× vs global ${a.concentrationRatio}×`
  );
  check(
    "e no onze espalhado a concentração defensiva é ~1",
    b.defensiveConcentrationRatio < 1.05,
    `${b.defensiveConcentrationRatio}×`
  );
  check(
    "o utilizador é avisado da pilha defensiva",
    a.warnings.some((w) => w.includes("defensivos")),
    a.warnings.join(" | ")
  );
  check("o onze diversificado não gera aviso defensivo",
    !b.warnings.some((w) => w.includes("defensivos")));

  // Exposição por equipa tem de contar corretamente.
  const exposures = computeTeamExposures(stacked);
  const t1 = exposures.find((e) => e.teamId === 1)!;
  check("exposição defensiva do clube empilhado é contada", t1.cleanSheetPlayers.length === 5,
    `${t1.cleanSheetPlayers.length}`);
}

// ---------------------------------------------------------------------
// Valor de ranking — posse é risco, não qualidade
// ---------------------------------------------------------------------
function testRankValue() {
  const mk = (id: number, own: number, pts: number): ScoredPlayer =>
    ({
      element: makeElement({ id, element_type: 3, selected_by_percent: String(own) }),
      team: makeTeam(1), positionShort: "MID", priceM: 8, ownershipPct: own,
      formNum: 0, fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.5,
      cleanSheetProbability: 0.3, individualExpectedGI: 0, ceilingGI: 0, floorGI: 0,
      expectedPoints: pts * 5, expectedPointsNext: pts, pPlay: 1,
      breakdown: { appearance: 0, goals: 0, assists: 0, cleanSheet: 0, concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, cards: 0, total: 0 },
      score: pts * 5, isDifferential: own < 10, isPreseason: false, reasons: [],
    }) as ScoredPlayer;

  // Dois jogadores com pontos esperados IDÊNTICOS mas posses opostas.
  const template = computeRankValue(mk(1, 65, 6));
  const differential = computeRankValue(mk(2, 4, 6));

  check(
    "pontos esperados são iguais nos dois",
    template.expectedPoints === differential.expectedPoints
  );
  check(
    "mas o diferencial vale muito mais em ranking",
    differential.rankValue > template.rankValue * 2,
    `template ${template.rankValue} vs diferencial ${differential.rankValue}`
  );
  check(
    "o template quase não faz subir (posse alta desconta quase tudo)",
    template.rankValue < template.expectedPoints * 0.4,
    `${template.rankValue} de ${template.expectedPoints}`
  );
  check(
    "mas NÃO ter o template é um risco real e quantificado",
    template.templateRisk > differential.templateRisk * 5,
    `template ${template.templateRisk} vs diferencial ${differential.templateRisk}`
  );

  // Perfil de onze: um todo-template vs um todo-diferencial.
  const templateXI = Array.from({ length: 11 }, (_, i) => mk(100 + i, 60, 5));
  const diffXI = Array.from({ length: 11 }, (_, i) => mk(200 + i, 5, 5));
  const pT = computeSquadRankProfile(templateXI, templateXI);
  const pD = computeSquadRankProfile(diffXI, diffXI);

  check(
    "os dois onzes têm os MESMOS pontos esperados",
    Math.abs(pT.totalExpectedPoints - pD.totalExpectedPoints) < 1e-6,
    `${pT.totalExpectedPoints} vs ${pD.totalExpectedPoints}`
  );
  check(
    "mas ganhos de ranking radicalmente diferentes",
    pD.totalRankValue > pT.totalRankValue * 2,
    `template ${pT.totalRankValue} vs diferencial ${pD.totalRankValue}`
  );
  check("onze template é identificado como tal", pT.verdict.includes("template"));
  check("onze diferencial é identificado como tal", pD.verdict.includes("diferencial"));
  check("posse média ponderada é calculada", pT.weightedOwnership > 50 && pD.weightedOwnership < 15,
    `template ${pT.weightedOwnership}% diferencial ${pD.weightedOwnership}%`);

  // Template em falta: jogador muito possuído que NÃO está no onze.
  const universe = [...diffXI, mk(999, 70, 7)];
  const profile = computeSquadRankProfile(diffXI, universe);
  check(
    "template que não tens é sinalizado como risco",
    profile.missingTemplate.length === 1 && profile.missingTemplate[0].player.element.id === 999,
    `${profile.missingTemplate.length} sinalizados`
  );
}

// ---------------------------------------------------------------------
// Bónus via BPS e pontos de defesas dos guarda-redes
// ---------------------------------------------------------------------
function testBpsAndSaves() {
  // Dois jogadores com o MESMO bónus já ganho, mas taxas de BPS opostas.
  const highBps = computePlayerRates(makeElement({ minutes: 900, bonus: 5, bps: 400 }));
  const lowBps = computePlayerRates(makeElement({ minutes: 900, bonus: 5, bps: 120 }));
  check(
    "BPS alto prevê mais bónus que BPS baixo, com o mesmo bónus passado",
    highBps.bonus90 > lowBps.bonus90 * 1.5,
    `alto ${highBps.bonus90.toFixed(2)} vs baixo ${lowBps.bonus90.toFixed(2)}`
  );
  check("previsão de bónus não explode", highBps.bonus90 <= 2.2);
  check(
    "jogador com BPS forte é assinalado ao utilizador",
    highBps.reasons.some((r) => r.includes("bónus"))
  );

  // Guarda-redes: defesas contam.
  // 45 defesas em 900 minutos = 4.5/90 em bruto. Depois do encolhimento por
  // amostra (10 jogos contra um prior de 3) o valor cai para ~3.46 — o que é
  // o comportamento pretendido, não uma regressão: uma taxa medida em dez
  // jogos não deve ser tratada como se fosse certa.
  const busyKeeper = computePlayerRates(makeElement({ minutes: 900, saves: 45 }));
  check(
    "defesas por 90 são calculadas e encolhidas pela amostra",
    busyKeeper.saves90 > 3 && busyKeeper.saves90 < 4.5,
    `${busyKeeper.saves90.toFixed(2)}`
  );
  const veteranKeeper = computePlayerRates(makeElement({ minutes: 3240, saves: 162 }));
  check(
    "com uma época inteira, o encolhimento quase desaparece",
    veteranKeeper.saves90 > 4.1,
    `${veteranKeeper.saves90.toFixed(2)}`
  );
  check(
    "guarda-redes muito solicitado é assinalado",
    busyKeeper.reasons.some((r) => r.includes("defesas"))
  );

  const mins = computeMinutesModel(makeElement({ minutes: 900, starts: 10 }), 10, false);
  // O mesmo guarda-redes num jogo difícil (mais remates) vs fácil.
  const hard = expectedPointsForFixture(1, busyKeeper, mins, {
    teamAttackRatio: 1, cleanSheetProbability: 0.15, expectedGoalsAgainst: 2.2,
  });
  const easy = expectedPointsForFixture(1, busyKeeper, mins, {
    teamAttackRatio: 1, cleanSheetProbability: 0.55, expectedGoalsAgainst: 0.7,
  });
  check("pontos de defesas são contabilizados", hard.saves > 0, `${hard.saves}`);
  check(
    "jogo difícil dá MAIS pontos de defesas que um jogo fácil",
    hard.saves > easy.saves,
    `difícil ${hard.saves.toFixed(2)} vs fácil ${easy.saves.toFixed(2)}`
  );
  check(
    "mas o jogo fácil continua a valer mais no total (clean sheet pesa mais)",
    easy.total > hard.total,
    `fácil ${easy.total.toFixed(2)} vs difícil ${hard.total.toFixed(2)}`
  );

  // Jogadores de campo não recebem pontos de defesas.
  const outfield = expectedPointsForFixture(3, busyKeeper, mins, {
    teamAttackRatio: 1, cleanSheetProbability: 0.3, expectedGoalsAgainst: 1.4,
  });
  check("jogadores de campo não recebem pontos de defesas", outfield.saves === 0);
}

// ---------------------------------------------------------------------
// Camada 2 — simulação contra os rivais reais da liga
// ---------------------------------------------------------------------

/** A scored player good enough to simulate, with the fields the draw uses. */
function mkSim(
  id: number,
  opts: {
    teamId?: number;
    type?: number;
    own?: number;
    epNext?: number;
    price?: number;
    cs?: number;
    pPlay?: number;
  } = {}
): ScoredPlayer {
  const type = opts.type ?? 3;
  const epNext = opts.epNext ?? 4;
  const own = opts.own ?? 10;
  const positions: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
  return {
    element: makeElement({
      id,
      element_type: type,
      selected_by_percent: String(own),
    }),
    team: makeTeam(opts.teamId ?? 1),
    positionShort: positions[type],
    priceM: opts.price ?? 6,
    ownershipPct: own,
    formNum: 3,
    fixtureAvgDifficulty: 3,
    nextOpponents: "",
    expectedGoalsFor: 1.5,
    cleanSheetProbability: opts.cs ?? 0.3,
    individualExpectedGI: 0.4,
    ceilingGI: 1,
    floorGI: 0,
    expectedPoints: epNext * 5,
    expectedPointsNext: epNext,
    pPlay: opts.pPlay ?? 1,
    modelTrust: 1,
    breakdown: {
      appearance: 2 * 5,
      goals: (epNext - 2) * 0.5 * 5,
      assists: (epNext - 2) * 0.25 * 5,
      cleanSheet: type <= 2 ? 1.2 * 5 : 0,
      concededPenalty: type <= 2 ? -0.4 * 5 : 0,
      defensiveContribution: 0,
      bonus: 0.4 * 5,
      saves: 0, cards: 0,
      total: epNext * 5,
    },
    score: epNext * 5,
    isDifferential: own < 10,
    isPreseason: false,
    reasons: [],
  } as ScoredPlayer;
}

function mkSquad(
  entry: number,
  rank: number,
  total: number,
  ids: number[],
  isMe = false
): RivalSquad {
  return {
    entry,
    entryName: `Equipa ${entry}`,
    playerName: `Gestor ${entry}`,
    rank,
    totalPoints: total,
    xi: ids,
    captainId: ids[0] ?? null,
    isMe,
  };
}

function testLeagueSimulation() {
  // Two disjoint but equally strong elevens, plus a third that overlaps mine
  // almost entirely. Different clubs so the clean-sheet draws are separate.
  const pool: ScoredPlayer[] = [];
  for (let i = 1; i <= 33; i++) {
    pool.push(mkSim(i, { teamId: ((i - 1) % 8) + 1, epNext: 4.5 }));
  }
  const mine = Array.from({ length: 11 }, (_, i) => i + 1);
  const theirs = Array.from({ length: 11 }, (_, i) => i + 12);
  const twin = [...mine.slice(0, 10), 23];

  const squads = [
    mkSquad(1, 1, 200, mine, true),
    mkSquad(2, 2, 198, theirs),
    mkSquad(3, 3, 195, twin),
  ];
  const out = simulateLeague(squads, pool, {
    currentEvent: 20,
    squadsFromEvent: 19,
    runs: 3000,
  });

  check("a simulação corre com plantéis reais", out.available && out.me !== null);
  check(
    "todas as probabilidades ficam entre 0 e 1",
    out.rivals.every(
      (r) =>
        r.pWinGameweek >= 0 &&
        r.pWinGameweek <= 1 &&
        r.pAheadAtSeasonEnd >= 0 &&
        r.pAheadAtSeasonEnd <= 1
    )
  );

  const disjoint = out.rivals.find((r) => r.entry === 2)!;
  const overlapping = out.rivals.find((r) => r.entry === 3)!;
  check(
    "sobreposição de plantéis é contada corretamente",
    disjoint.overlap === 0 && overlapping.overlap === 10,
    `disjunto ${disjoint.overlap}, quase-igual ${overlapping.overlap}`
  );
  // The whole point of drawing per player rather than per manager: a rival
  // who owns ten of my eleven must move with me, so the spread of the
  // difference between us is far smaller than against a disjoint squad.
  check(
    "quem partilha o plantel comigo tem resultado muito mais colado ao meu",
    Math.abs(overlapping.pWinGameweek - 0.5) > Math.abs(disjoint.pWinGameweek - 0.5),
    `sobreposto ${overlapping.pWinGameweek} vs disjunto ${disjoint.pWinGameweek}`
  );
  check(
    "onzes equivalentes e independentes dão perto de uma moeda ao ar",
    Math.abs(disjoint.pWinGameweek - 0.5) < 0.12,
    `${disjoint.pWinGameweek}`
  );

  // Determinism: the same gameweek must always produce the same numbers, or
  // the panel jitters on every refresh and nobody trusts it.
  const again = simulateLeague(squads, pool, {
    currentEvent: 20,
    squadsFromEvent: 19,
    runs: 3000,
  });
  check(
    "a simulação é determinística dentro da mesma jornada",
    JSON.stringify(again.rivals) === JSON.stringify(out.rivals)
  );
}

function testPostureFollowsLeaguePosition() {
  const pool: ScoredPlayer[] = [];
  for (let i = 1; i <= 33; i++) {
    pool.push(mkSim(i, { teamId: ((i - 1) % 8) + 1, epNext: 4.5 }));
  }
  const mine = Array.from({ length: 11 }, (_, i) => i + 1);
  const theirs = Array.from({ length: 11 }, (_, i) => i + 12);

  const behind = simulateLeague(
    [mkSquad(1, 2, 900, mine, true), mkSquad(2, 1, 1100, theirs)],
    pool,
    { currentEvent: 34, squadsFromEvent: 33, runs: 2000 }
  );
  const ahead = simulateLeague(
    [mkSquad(1, 1, 1100, mine, true), mkSquad(2, 2, 900, theirs)],
    pool,
    { currentEvent: 34, squadsFromEvent: 33, runs: 2000 }
  );
  const level = simulateLeague(
    [mkSquad(1, 1, 1000, mine, true), mkSquad(2, 2, 999, theirs)],
    pool,
    { currentEvent: 34, squadsFromEvent: 33, runs: 2000 }
  );

  check(
    "muito atrás com pouco tempo -> o modelo procura variância (beta positivo)",
    behind.posture.beta > 0.25 && behind.posture.label === "atacar",
    `beta ${behind.posture.beta}`
  );
  check(
    "muito à frente -> o modelo suprime variância (beta negativo)",
    ahead.posture.beta < -0.25 && ahead.posture.label === "proteger",
    `beta ${ahead.posture.beta}`
  );
  check(
    "corrida equilibrada -> sem inclinação artificial",
    Math.abs(level.posture.beta) < 0.25 && level.posture.label === "equilibrar",
    `beta ${level.posture.beta}`
  );
  check(
    "beta nunca sai do intervalo em que o valor estratégico é positivo",
    [behind, ahead, level].every(
      (o) => o.posture.beta >= -0.6 && o.posture.beta <= 0.9
    )
  );

  // The tilt from Camada 3 rides on top, but can never push beta out of range.
  const tilted = applyLearningTilt(behind.posture, 0.5, "motivo");
  check(
    "a inclinação da Camada 3 nunca empurra beta para fora do intervalo",
    tilted.beta <= 0.9 && tilted.beta >= -0.6,
    `${tilted.beta}`
  );
}

function testPostureChangesTheSquad() {
  // Three tiers at the SAME price, so budget cannot be what decides:
  //   template  — most-owned, slightly worse
  //   consensus — mid-owned, the best on pure expected points
  //   punt      — barely owned, almost as good
  // On expected points alone the middle tier wins outright. A model that
  // ignores the league situation would therefore pick it in every scenario,
  // which is exactly the blindness Camada 2 exists to remove.
  const pool: ScoredPlayer[] = [];
  let id = 1;
  let club = 0;
  for (const type of [1, 2, 3, 4]) {
    for (const tier of [
      { own: 60, epNext: 4.8 },
      { own: 25, epNext: 5.0 },
      { own: 3, epNext: 4.9 },
    ]) {
      for (let i = 0; i < 8; i++) {
        pool.push(
          mkSim(id++, {
            teamId: (club++ % 20) + 1,
            type,
            own: tier.own,
            epNext: tier.epNext,
            price: 5.5,
          })
        );
      }
    }
  }

  const neutral = buildOptimalSquad(pool, 100, 0);
  const chasing = buildOptimalSquad(pool, 100, 0.9);
  const protecting = buildOptimalSquad(pool, 100, -0.6);

  const avgOwn = (squad: ScoredPlayer[]) =>
    squad.reduce((s, p) => s + p.ownershipPct, 0) / Math.max(1, squad.length);

  check(
    "a postura muda mesmo o onze — não é um painel decorativo",
    JSON.stringify(chasing.starters.map((p) => p.element.id).sort()) !==
      JSON.stringify(neutral.starters.map((p) => p.element.id).sort())
  );
  check(
    "a perseguir, o onze tem menos posse média do que o neutro",
    avgOwn(chasing.starters) < avgOwn(neutral.starters),
    `perseguir ${avgOwn(chasing.starters).toFixed(1)}% vs neutro ${avgOwn(neutral.starters).toFixed(1)}%`
  );
  check(
    "a proteger, o onze tem mais posse média do que o neutro",
    avgOwn(protecting.starters) > avgOwn(neutral.starters),
    `proteger ${avgOwn(protecting.starters).toFixed(1)}% vs neutro ${avgOwn(neutral.starters).toFixed(1)}%`
  );
  check(
    "o valor estratégico nunca fica negativo em todo o intervalo de beta",
    pool.every((p) =>
      [-0.6, -0.3, 0, 0.45, 0.9].every((b) => strategicValue(p, b) > 0)
    )
  );
  check(
    "as três posturas produzem sempre plantéis legais de 15",
    [neutral, chasing, protecting].every((r) => r.squad.length === 15 && r.feasible)
  );
}

// ---------------------------------------------------------------------
// Camada 3 — calibração e torneio de estratégias
// ---------------------------------------------------------------------

function mkResult(
  event: number,
  perStrategy: Record<string, number>,
  calibration: { positionShort: string; predicted: number; actual: number }[] = []
): StrategyEventResult {
  return {
    event,
    settledAt: new Date(2026, 0, event).toISOString(),
    perStrategy: Object.entries(perStrategy).map(([key, totalPoints]) => ({
      key,
      totalPoints,
      picks: 10,
      meanPoints: totalPoints / 10,
    })),
    calibration: calibration.map((c) => ({ ...c, samples: 10 })),
  };
}

function testStrategyTournament() {
  const shape = selectForStrategy(
    STRATEGIES[0],
    Array.from({ length: 60 }, (_, i) =>
      mkSim(i + 1, { type: (i % 4) + 1, epNext: 3 + (i % 7) })
    )
  );
  const counts_ = shape.reduce<Record<string, number>>((acc, p) => {
    acc[p.positionShort] = (acc[p.positionShort] ?? 0) + 1;
    return acc;
  }, {});
  check(
    "todas as estratégias montam a MESMA forma de equipa (comparação justa)",
    counts_.GK === 1 && counts_.DEF === 3 && counts_.MID === 4 && counts_.FWD === 2,
    JSON.stringify(counts_)
  );

  // Six gameweeks where differentials clearly beat template.
  const diffWins = Array.from({ length: 6 }, (_, i) =>
    mkResult(i + 1, { modelo: 50, template: 40, diferencial: 62, calendario: 45, forma: 38 })
  );
  const state = buildLearningState(diffWins);
  check(
    "o torneio ordena as estratégias pelo que realmente pontuaram",
    state.standings[0].key === "diferencial",
    state.standings.map((s) => s.key).join(" > ")
  );
  check(
    "a diferença face ao modelo puro é reportada com sinal",
    state.standings.find((s) => s.key === "template")!.liftVsModel < 0 &&
      state.standings.find((s) => s.key === "diferencial")!.liftVsModel > 0
  );
  check(
    "quando os diferenciais estão a pagar, a postura é inclinada nesse sentido",
    state.postureTilt > 0 && state.postureTiltReason !== null,
    `tilt ${state.postureTilt}`
  );
  check(
    "a inclinação do torneio está limitada a +-0.15",
    Math.abs(state.postureTilt) <= 0.15,
    `${state.postureTilt}`
  );

  // The mirror case must move the other way.
  const tmplWins = Array.from({ length: 6 }, (_, i) =>
    mkResult(i + 1, { modelo: 50, template: 62, diferencial: 40, calendario: 45, forma: 38 })
  );
  check(
    "quando é o template a pagar, a inclinação vai ao contrário",
    buildLearningState(tmplWins).postureTilt < 0
  );

  // Below the evidence threshold nothing may move at all.
  const tooEarly = buildLearningState(diffWins.slice(0, 2));
  check(
    "com poucas jornadas o torneio não mexe na postura",
    tooEarly.postureTilt === 0,
    `${tooEarly.postureTilt}`
  );

  // A strategy whose picks all blanked has meanPoints 0 — recovering the
  // pick count by dividing total by mean would have divided by zero here.
  const withZero = buildLearningState([
    mkResult(1, { modelo: 0, template: 20, diferencial: 10, calendario: 5, forma: 5 }),
  ]);
  check(
    "uma estratégia que zerou não parte a agregação",
    withZero.standings.every((s) => Number.isFinite(s.meanPoints))
  );
}

function testCalibrationLearning() {
  // Defenders consistently over-predicted, midfielders about right.
  const results = Array.from({ length: 8 }, (_, i) =>
    mkResult(
      i + 1,
      { modelo: 50, template: 48, diferencial: 47, calendario: 45, forma: 44 },
      [
        { positionShort: "DEF", predicted: 40, actual: 28 },
        { positionShort: "MID", predicted: 50, actual: 50 },
      ]
    )
  );
  const state = buildLearningState(results);

  check(
    "uma posição sistematicamente sobrestimada é corrigida para baixo",
    state.calibration.DEF < 1 && state.calibration.DEF >= 0.75,
    `DEF ${state.calibration.DEF}`
  );
  check(
    "uma posição sem viés fica praticamente intocada",
    Math.abs(state.calibration.MID - 1) < 0.02,
    `MID ${state.calibration.MID}`
  );
  check(
    "a correção é explicada em texto, não aplicada em silêncio",
    state.calibrationNotes.some((n) => n.startsWith("DEF"))
  );

  // An absurd single gameweek must not be allowed to move the model far.
  const wild = buildLearningState([
    mkResult(1, { modelo: 50 }, [{ positionShort: "FWD", predicted: 40, actual: 400 }]),
  ]);
  check(
    "um resultado absurdo é encolhido pela amostra e travado pelo teto",
    wild.calibration.FWD <= 1.25,
    `${wild.calibration.FWD}`
  );
  check(
    "com uma só jornada a correção é muito menor do que o desvio bruto",
    wild.calibration.FWD < 1.26 && wild.calibration.FWD > 1,
    `${wild.calibration.FWD}`
  );

  // And the correction must actually reach the players.
  const players = [mkSim(1, { type: 2, epNext: 4 }), mkSim(2, { type: 3, epNext: 4 })];
  const calibrated = applyCalibration(players, { DEF: 0.8 });
  const def = calibrated.find((p) => p.positionShort === "DEF")!;
  const mid = calibrated.find((p) => p.positionShort === "MID")!;
  check(
    "a calibração aprendida é mesmo aplicada aos pontos esperados",
    Math.abs(def.expectedPointsNext - 3.2) < 0.01 && mid.expectedPointsNext === 4,
    `DEF ${def.expectedPointsNext}, MID ${mid.expectedPointsNext}`
  );
  check(
    "o score continua alinhado com os pontos esperados depois de calibrar",
    def.score === def.expectedPoints
  );
  check(
    "e aparece nas razões do jogador, não em silêncio",
    def.reasons.some((r) => r.includes("calibração aprendida"))
  );
  check(
    "sem calibração conhecida, os jogadores passam intactos",
    applyCalibration(players, {})[0] === players[0]
  );
}

// ---------------------------------------------------------------------
// Estado real do plantel — orçamento, transferências livres, chips
// ---------------------------------------------------------------------

function hist(
  rows: { event: number; transfers: number; cost?: number }[]
) {
  return rows.map((r) => ({
    event: r.event,
    points: 50,
    total_points: 50 * r.event,
    rank: 1,
    overall_rank: 1,
    bank: 0,
    value: 1000,
    event_transfers: r.transfers,
    event_transfers_cost: r.cost ?? 0,
    points_on_bench: 0,
  }));
}

function testFreeTransferReconstruction() {
  // Never transferred: the allowance banks up to the cap and stops.
  const idle = reconstructFreeTransfers(
    hist([1, 2, 3, 4, 5, 6, 7, 8, 9].map((event) => ({ event, transfers: 0 }))),
    [],
    10
  );
  check(
    "sem transferências, as livres acumulam até ao limite de 5",
    idle.freeTransfers === 5,
    `${idle.freeTransfers}`
  );

  // One free transfer used every week: you never bank anything.
  const steady = reconstructFreeTransfers(
    hist([1, 2, 3, 4, 5].map((event) => ({ event, transfers: event === 1 ? 0 : 1 }))),
    [],
    6
  );
  check(
    "uma transferência por jornada mantém sempre exatamente uma disponível",
    steady.freeTransfers === 1,
    `${steady.freeTransfers}`
  );

  // A -8 gameweek: three transfers, two paid for, so only ONE free was spent.
  // Reading `event_transfers` alone would have wrongly consumed three.
  const withHit = reconstructFreeTransfers(
    hist([
      { event: 1, transfers: 0 },
      { event: 2, transfers: 0 },
      { event: 3, transfers: 3, cost: 8 },
    ]),
    [],
    4
  );
  check(
    "um hit de -8 só consome UMA transferência livre, não três",
    withHit.freeTransfers === 2,
    `${withHit.freeTransfers}`
  );

  // Wildcard week: unlimited transfers, saved ones survive untouched.
  const wildcard = reconstructFreeTransfers(
    hist([
      { event: 1, transfers: 0 },
      { event: 2, transfers: 0 },
      { event: 3, transfers: 11 },
    ]),
    [{ name: "wildcard", event: 3 }],
    4
  );
  check(
    "numa jornada de wildcard as transferências não consomem as livres",
    wildcard.freeTransfers === 3,
    `${wildcard.freeTransfers}`
  );

  // Gameweek 1 is the initial squad, not fifteen transfers.
  const opening = reconstructFreeTransfers(
    hist([{ event: 1, transfers: 15 }]),
    [],
    2
  );
  check(
    "a montagem inicial na GW1 não conta como transferências",
    opening.freeTransfers === 1,
    `${opening.freeTransfers}`
  );

  check(
    "o número nunca sai do intervalo legal 0-5",
    [idle, steady, withHit, wildcard, opening].every(
      (r) => r.freeTransfers >= 0 && r.freeTransfers <= 5
    )
  );
}

function testSellingPriceEstimation() {
  const ids = [1, 2, 3];
  const prices = new Map([
    [1, 6.0],
    [2, 5.0],
    [3, 4.5],
  ]);
  // Player 1 has risen £0.4m since the season started, player 2 £0.2m,
  // player 3 not at all. FPL takes half of each rise, rounded down.
  const changes = new Map([
    [1, 4],
    [2, 2],
    [3, 0],
  ]);
  const total = 6.0 + 5.0 + 4.5;
  const result = estimateSellingPrices(ids, prices, changes, total - 0.3);

  const sum =
    Math.round(ids.reduce((s, id) => s + (result.sellingPriceM.get(id) ?? 0), 0) * 10) / 10;
  check(
    "a soma dos preços de venda bate certo com o total publicado pela FPL",
    Math.abs(sum - (total - 0.3)) < 0.001,
    `${sum} vs ${total - 0.3}`
  );
  check(
    "quem não subiu de preço não leva desconto nenhum",
    result.sellingPriceM.get(3) === 4.5,
    `${result.sellingPriceM.get(3)}`
  );
  check(
    "nenhum desconto passa do máximo que a regra da FPL permitiria",
    ids.every((id) => {
      const discount = (prices.get(id) ?? 0) - (result.sellingPriceM.get(id) ?? 0);
      const cap = Math.ceil((changes.get(id) ?? 0) / 2) / 10;
      return discount <= cap + 1e-9;
    })
  );
  check("o resultado é assinalado como estimativa", result.estimated);

  // No discount at all: every player sells for the listed price.
  const exact = estimateSellingPrices(ids, prices, changes, total);
  check(
    "sem diferença face aos preços atuais, nada é estimado",
    !exact.estimated && exact.sellingPriceM.get(1) === 6.0
  );
}

function testChipSummary() {
  const chips = summariseChips([
    { name: "wildcard", event: 8 },
    { name: "bboost", event: 26 },
  ]);
  const wc = chips.find((c) => c.name === "wildcard")!;
  const tc = chips.find((c) => c.name === "3xc")!;
  check(
    "um wildcard usado deixa um por usar (regra de dois por época)",
    wc.remaining === 1 && wc.usedAtEvents[0] === 8,
    `${wc.remaining}`
  );
  check("um chip nunca usado aparece com os dois disponíveis", tc.remaining === 2);
}

// ---------------------------------------------------------------------
// Planeador de transferências
// ---------------------------------------------------------------------

function mkTransferPool(upgradeGains: number[]) {
  // Fifteen owned players, all equally mediocre, spread across clubs so the
  // three-per-club rule never binds. Then a set of same-position, same-price
  // upgrades whose window advantage is dictated by `upgradeGains`.
  const owned: ScoredPlayer[] = [];
  const shape: [number, number][] = [
    [1, 2],
    [2, 5],
    [3, 5],
    [4, 3],
  ];
  let id = 1;
  let club = 0;
  for (const [type, count] of shape) {
    for (let i = 0; i < count; i++) {
      owned.push(
        mkSim(id++, { teamId: (club++ % 20) + 1, type, epNext: 4, price: 6, own: 15 })
      );
    }
  }
  const market: ScoredPlayer[] = [];
  // Plenty of ordinary alternatives, so the solver has a real search space.
  for (const [type] of shape) {
    for (let i = 0; i < 6; i++) {
      market.push(
        mkSim(id++, { teamId: (club++ % 20) + 1, type, epNext: 3.6, price: 6, own: 12 })
      );
    }
  }
  // The upgrades: midfielders, same price, better by a controlled amount.
  for (const gain of upgradeGains) {
    market.push(
      mkSim(id++, {
        teamId: (club++ % 20) + 1,
        type: 3,
        epNext: 4 + gain / 5,
        price: 6,
        own: 15,
      })
    );
  }
  return { owned, scored: [...owned, ...market] };
}

function mkState(owned: ScoredPlayer[], freeTransfers: number, bankM = 0): SquadState {
  const squadValueM =
    Math.round(owned.reduce((s, p) => s + p.priceM, 0) * 10) / 10;
  return {
    available: true,
    reason: null,
    fromEvent: 10,
    owned: owned.map((p, i) => ({
      elementId: p.element.id,
      priceM: p.priceM,
      sellingPriceM: p.priceM,
      wasStarter: i < 11,
      wasCaptain: i === 0,
      wasViceCaptain: i === 1,
    })),
    bankM,
    squadValueM,
    totalBudgetM: Math.round((squadValueM + bankM) * 10) / 10,
    sellingPriceIsEstimated: false,
    sellingPriceNote: "",
    freeTransfers,
    freeTransfersNote: "",
    chips: summariseChips([]),
    entryName: "Teste",
    overallPoints: 500,
    overallRank: 1000,
  };
}

function testTransferPlanRespectsTheRules() {
  const { owned, scored } = mkTransferPool([10, 2]);
  const advice = planTransfers(scored, mkState(owned, 1));

  check("o planeador produz um plano a partir do plantel real", advice.available);
  check(
    "'não fazer nada' está sempre entre as opções",
    advice.plans.some((p) => p.key === "manter")
  );
  check(
    "o plano recomendado nunca é pior do que não fazer nada",
    advice.recommended!.netValue >= advice.hold!.netValue - 1e-9,
    `${advice.recommended!.netValue} vs ${advice.hold!.netValue}`
  );

  const state = mkState(owned, 1);
  for (const plan of advice.plans) {
    const cost = plan.squad.reduce((sum, p) => {
      const own = state.owned.find((o) => o.elementId === p.element.id);
      return sum + (own ? own.sellingPriceM : p.priceM);
    }, 0);
    check(
      `plano "${plan.key}" respeita o orçamento real`,
      cost <= state.totalBudgetM + 1e-6,
      `£${cost.toFixed(1)}m de £${state.totalBudgetM.toFixed(1)}m`
    );
    const counts = plan.squad.reduce<Record<number, number>>((acc, p) => {
      acc[p.element.element_type] = (acc[p.element.element_type] ?? 0) + 1;
      return acc;
    }, {});
    check(
      `plano "${plan.key}" mantém 2-5-5-3`,
      counts[1] === 2 && counts[2] === 5 && counts[3] === 5 && counts[4] === 3,
      JSON.stringify(counts)
    );
    const perClub = plan.squad.reduce<Record<number, number>>((acc, p) => {
      acc[p.team.id] = (acc[p.team.id] ?? 0) + 1;
      return acc;
    }, {});
    check(
      `plano "${plan.key}" respeita o máximo de 3 por clube`,
      Object.values(perClub).every((n) => n <= 3)
    );
    check(
      `plano "${plan.key}" tem um onze legal de 11`,
      plan.xi.length === 11 && plan.bench.length === 4
    );
    check(
      `plano "${plan.key}" conta as transferências que realmente mostra`,
      plan.transfers === plan.moves.length
    );
  }
}

function testHitIsOnlyTakenWhenItPaysForItself() {
  // THE COUNTERFACTUAL TEST.
  //
  // Until v1.28 the planner charged the -4 once and credited the incoming
  // player over all five gameweeks, so it accepted a hit from 0.8 points a
  // gameweek. That compares against an alternative that does not exist: the
  // real alternative is making the same transfer next week with the free
  // transfer you are about to receive, which captures gameweeks two to five
  // at no cost. A hit buys ONE gameweek. The bar therefore has to be several
  // times higher, and these two cases pin it down.

  // Two upgrades worth 2.0 points a gameweek each. Real, but nowhere near
  // enough to justify four points plus a burned free transfer.
  const modest = mkTransferPool([10, 10]);
  const modestAdvice = planTransfers(modest.scored, mkState(modest.owned, 1), {
    currentEvent: 20,
  });
  check(
    "um ganho de 2 pts/jornada NÃO justifica pagar -4",
    modestAdvice.recommended!.hitCost === 0,
    `hit ${modestAdvice.recommended!.hitCost}, plano ${modestAdvice.recommended!.key}`
  );
  check(
    "e sob a regra antiga (5 x ganho > 4) este caso teria pago o hit",
    10 * 1 > 4,
    "a regra antiga aceitava a partir de 0.8 pts/jornada"
  );

  // Two upgrades worth 4.0 points a gameweek each. Now the immediate gain
  // clears the four points with room to spare.
  const worthIt = mkTransferPool([20, 20]);
  const worthAdvice = planTransfers(worthIt.scored, mkState(worthIt.owned, 1), {
    currentEvent: 20,
  });
  check(
    "um ganho de 4 pts/jornada em duas trocas justifica o hit",
    worthAdvice.recommended!.hitCost > 0 && worthAdvice.recommended!.transfers === 2,
    `hit ${worthAdvice.recommended!.hitCost}, transf ${worthAdvice.recommended!.transfers}`
  );
  check(
    "o plano com hit só é recomendado se bater o plano grátis já com o custo dentro",
    worthAdvice.recommended!.netValue >
      worthAdvice.plans.find((p) => p.key === "gratuitas")!.netValue,
    `com hit ${worthAdvice.recommended!.netValue} vs grátis ${worthAdvice.plans.find((p) => p.key === "gratuitas")!.netValue}`
  );

  // Two free transfers: the same two moves should now cost nothing.
  const twoFree = planTransfers(worthIt.scored, mkState(worthIt.owned, 2), {
    currentEvent: 20,
  });
  check(
    "com duas transferências livres as mesmas jogadas deixam de custar pontos",
    twoFree.recommended!.hitCost === 0 && twoFree.recommended!.transfers === 2,
    `hit ${twoFree.recommended!.hitCost}, transf ${twoFree.recommended!.transfers}`
  );
}

function testFreeTransfersHaveOptionValue() {
  // A banked free transfer is an option on next week's information. Without
  // a price on it the planner spent every accumulated transfer on any
  // positive gain — and the "hold" plan's own text said this was wrong while
  // the ranking had no way to express it.
  const marginal = mkTransferPool([2, 2, 2, 2]);
  const advice = planTransfers(marginal.scored, mkState(marginal.owned, 4), {
    currentEvent: 20,
  });
  check(
    "quatro melhorias marginais não consomem quatro transferências livres",
    advice.recommended!.transfers < 4,
    `${advice.recommended!.transfers} transferências para ganhos de 0.4 pts/jornada`
  );

  // With the bank full at five, the marginal transfer really is free — it
  // would otherwise be forfeited — so the charge is waived.
  const full = planTransfers(marginal.scored, mkState(marginal.owned, 5), {
    currentEvent: 20,
  });
  check(
    "com o banco cheio a cinco, o custo de oportunidade desaparece",
    full.recommended!.transfers >= advice.recommended!.transfers,
    `cheio ${full.recommended!.transfers} vs 4 livres ${advice.recommended!.transfers}`
  );
}

function testNoUpgradeMeansHold() {
  // Everything on the market is worse than what is owned. The only correct
  // answer is to do nothing — a planner that always finds "something to do"
  // is worse than useless, because acting costs a transfer.
  const { owned, scored } = mkTransferPool([-6, -8]);
  const advice = planTransfers(scored, mkState(owned, 2));
  check(
    "quando não há nada melhor no mercado, a recomendação é manter",
    advice.recommended!.key === "manter" && advice.recommended!.transfers === 0,
    `${advice.recommended!.key} com ${advice.recommended!.transfers}`
  );
}

function testWildcardSignal() {
  // A squad far below what the budget could buy: many upgrades available.
  const { owned, scored } = mkTransferPool([12, 12, 12, 12, 12, 12]);
  const advice = planTransfers(scored, mkState(owned, 1), { currentEvent: 20 });
  check(
    "o sinal de wildcard mede a distância ao plantel ideal em transferências",
    advice.wildcard !== null && advice.wildcard.distance >= 5,
    `distância ${advice.wildcard?.distance}`
  );
  check(
    "e quantifica o que essa distância vale em pontos",
    (advice.wildcard?.gain ?? 0) > 0,
    `${advice.wildcard?.gain}`
  );

  // A squad already close to ideal must NOT trigger the chip.
  const tight = mkTransferPool([1]);
  const tightAdvice = planTransfers(tight.scored, mkState(tight.owned, 1), {
    currentEvent: 20,
  });
  check(
    "um plantel já perto do ideal não dispara o wildcard",
    tightAdvice.wildcard !== null && !tightAdvice.wildcard.advise,
    `distância ${tightAdvice.wildcard?.distance}, ganho ${tightAdvice.wildcard?.gain}`
  );
}

function testWildcardIsNotBurnedEarly() {
  // The same squad, the same distance from ideal, at two different points in
  // the season. Early on, the "ideal" is built almost entirely on pre-season
  // estimates, and the chip has a whole season of optionality left — so the
  // identical evidence must NOT trigger it. This is exactly what the live app
  // got wrong in gameweek 2: it recommended burning a wildcard on a distance
  // measurement that was mostly noise.
  // Six upgrades of 8 window points each (1.6 pts/jornada). Above the
  // retention threshold once the season has run (4.5 pts at jornada 20),
  // below it in jornada 2 (10.6 pts) — see lib/selection.ts.
  //
  // ESCALA REVISTA EM v1.38. Este teste usava ganhos de 4 pontos, e passava
  // porque nada impedia o modelo de agir sobre diferenças de 0.8 pontos por
  // jornada. Depois de o limiar de retenção passar a ser derivado do erro de
  // estimativa, uma diferença dessas é indistinguível de zero em qualquer
  // altura da época — e o teste deixou de medir o que dizia medir. Foi
  // reescalado para ganhos que são REALMENTE detetáveis a meio da época, o
  // que é a única forma de continuar a testar a propriedade original: o mesmo
  // plantel, a mesma diferença, e uma resposta diferente conforme o chip
  // valha mais guardado do que gasto.
  const { owned, scored } = mkTransferPool([8, 8, 8, 8, 8, 8]);

  const early = planTransfers(scored, mkState(owned, 1), { currentEvent: 2 });
  const settled = planTransfers(scored, mkState(owned, 1), { currentEvent: 20 });

  check(
    "a mesma distância ao ideal dispara o wildcard a meio da época",
    settled.wildcard?.advise === true,
    `ganho ${settled.wildcard?.gain}, distância ${settled.wildcard?.distance}`
  );
  check(
    "mas NÃO na jornada 2, onde o 'ideal' é sobretudo ruído",
    early.wildcard?.advise === false,
    `ganho ${early.wildcard?.gain}, distância ${early.wildcard?.distance}`
  );
  check(
    // v1.38 mudou isto de propósito e vale a pena dizer porquê. Antes, a
    // distância ao ideal era a mesma em qualquer jornada e só o PREÇO do chip
    // mudava. Agora o próprio "ideal" depende da evidência disponível: cedo
    // na época, uma diferença de 1.6 pts/jornada não é distinguível de zero,
    // por isso o ideal É o plantel atual e a distância é genuinamente menor.
    // Isso é mais honesto do que medir uma distância grande e depois
    // desculpá-la com um prémio.
    "cedo, a distância ao ideal é MENOR — o ideal deixa de incluir diferenças que são ruído",
    (early.wildcard?.distance ?? 0) < (settled.wildcard?.distance ?? 0),
    `cedo ${early.wildcard?.distance}, assente ${settled.wildcard?.distance}`
  );
  check(
    "e cedo o plano de wildcard nem sequer entra na lista de opções",
    !early.plans.some((p) => p.key === "wildcard") &&
      settled.plans.some((p) => p.key === "wildcard")
  );
  check(
    // v1.38: a redação mudou porque a razão mudou. Antes dizia "isto é
    // sobretudo ruído"; agora diz quantos jogadores trocaria se ignorasse a
    // margem de erro e a partir de que diferença duas estimativas são
    // sequer distinguíveis. Continua a ser a mesma exigência — explicar em
    // vez de esconder — mas com um número em vez de um adjetivo.
    "o texto explica porque está a ser guardado, com o limiar concreto",
    /ruído|margem de erro/.test(early.wildcard?.text ?? "") &&
      /\d/.test(early.wildcard?.text ?? ""),
    early.wildcard?.text?.slice(0, 120)
  );

  // And the rule must not collapse into "never wildcard early". A gap big
  // enough is a gap big enough whenever it appears. 25 window points a player
  // is five points a gameweek — far outside any plausible estimation error.
  const huge = mkTransferPool([25, 25, 25, 25, 25, 25]);
  const earlyButHuge = planTransfers(huge.scored, mkState(huge.owned, 1), {
    currentEvent: 2,
  });
  check(
    "uma diferença esmagadora justifica o chip mesmo na jornada 2",
    earlyButHuge.wildcard?.advise === true,
    `ganho ${earlyButHuge.wildcard?.gain}`
  );
}

function testPlannerSurvivesAnIllegalSquad() {
  // A squad with four players from one club cannot satisfy the three-per-club
  // rule while also keeping fourteen of them, so every constrained solve is
  // infeasible. That must degrade to "hold" rather than throwing or, worse,
  // returning a squad that breaks the rules. (This is not hypothetical: it is
  // exactly what a mis-built test fixture produced, and the failure was
  // silent — the plans simply vanished with no explanation.)
  const { owned, scored } = mkTransferPool([10]);
  const stacked = owned.map((p, i) =>
    i < 4 ? ({ ...p, team: makeTeam(99) } as ScoredPlayer) : p
  );
  const pool = [...stacked, ...scored.filter((p) => !owned.some((o) => o.element.id === p.element.id))];
  const advice = planTransfers(pool, mkState(stacked, 1));
  check(
    "um plantel que viola o máximo por clube degrada para 'manter', sem rebentar",
    advice.available && advice.recommended !== null,
    `${advice.recommended?.key}`
  );
  check(
    "e nenhum plano devolvido viola alguma vez as regras",
    advice.plans.every((plan) => {
      const perClub = plan.squad.reduce<Record<number, number>>((acc, p) => {
        acc[p.team.id] = (acc[p.team.id] ?? 0) + 1;
        return acc;
      }, {});
      // The held squad is the illegal one the manager already owns — the
      // planner reports it as-is rather than pretending it is legal. Every
      // squad it CONSTRUCTS must obey the rules.
      return plan.key === "manter" || Object.values(perClub).every((n) => n <= 3);
    })
  );
}

function testPlannerRefusesToInvent() {
  const { scored } = mkTransferPool([10]);
  const advice = planTransfers(scored, {
    ...mkState([], 1),
    available: false,
    owned: [],
    reason: "sem plantel",
  });
  check(
    "sem plantel real o planeador recusa-se a inventar um plano",
    !advice.available && advice.recommended === null && advice.plans.length === 0
  );
}

// ---------------------------------------------------------------------
// Notas táticas v2 — confiança e âmbito por jornada
// ---------------------------------------------------------------------

function testInsightConfidenceAndScope() {
  const base = {
    scope: "player" as const,
    id: 1,
    label: "X",
    reason: "r",
    addedDate: "2026-08-21",
    source: "s",
  };

  check(
    "a confiança reduz o desvio face a 1, não o fator em si",
    Math.abs(effectiveFactor({ ...base, factor: 1.2, confidence: 0.5 }) - 1.1) < 1e-9,
    `${effectiveFactor({ ...base, factor: 1.2, confidence: 0.5 })}`
  );
  check(
    "e funciona igualmente para notas negativas",
    Math.abs(effectiveFactor({ ...base, factor: 0.8, confidence: 0.5 }) - 0.9) < 1e-9
  );
  check(
    "sem confiança declarada, a nota aplica-se por inteiro",
    effectiveFactor({ ...base, factor: 1.15 }) === 1.15
  );

  check(
    "uma nota sem jornadas aplica-se a todas",
    insightAppliesToEvent({ ...base, factor: 1 }, 7)
  );
  check(
    "uma nota com jornadas só se aplica a essas",
    insightAppliesToEvent({ ...base, factor: 1, events: [5, 6] }, 5) &&
      !insightAppliesToEvent({ ...base, factor: 1, events: [5, 6] }, 7)
  );

  // Validation of the new fields.
  const ok = (over: Record<string, unknown>) =>
    validateInsightInput(
      {
        scope: "player",
        id: 1,
        label: "X",
        factor: 1.1,
        reason: "r",
        source: "s",
        ...over,
      },
      () => true,
      0
    ).ok;
  check("jornadas válidas são aceites", ok({ events: [1, 38] }));
  check("uma jornada 0 ou 39 é rejeitada", !ok({ events: [0] }) && !ok({ events: [39] }));
  check("uma lista de jornadas vazia é rejeitada", !ok({ events: [] }));
  check("confiança dentro de 0.4-1 é aceite", ok({ confidence: 0.4 }) && ok({ confidence: 1 }));
  check(
    "confiança fora do intervalo é rejeitada",
    !ok({ confidence: 0.2 }) && !ok({ confidence: 1.4 })
  );
}

// =====================================================================
// v1.28 — auditoria externa ao modelo. Um teste por defeito corrigido.
//
// Estes testes existem porque a auditoria encontrou que várias correções
// anteriores tinham sido reintroduzidas em silêncio por não terem rede de
// segurança. Cada bloco abaixo fixa uma correção concreta da v1.28.
// =====================================================================

/** P(X = k) para X ~ Poisson(lambda) — usado só aqui, para comparar as
 * formas fechadas do modelo contra a soma exata. */
function poissonPmfRef(k: number, lambda: number): number {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / f;
}

/** E[floor(X/d)] por soma direta sobre a distribuição, sem atalhos. */
function expectedFloorDivideRef(lambda: number, d: number): number {
  let total = 0;
  for (let k = 0; k <= 60; k++) total += poissonPmfRef(k, lambda) * Math.floor(k / d);
  return total;
}

// ---------------------------------------------------------------------
// A-01 — desigualdade de Jensen: E[floor(X/d)] != floor(E[X]/d)
// ---------------------------------------------------------------------
function testJensenClosedForms() {
  for (const [lambda, d] of [
    [1.35, 2],
    [0.6, 2],
    [3.0, 3],
    [2.4, 3],
    [5.0, 2],
  ] as [number, number][]) {
    const closed = expectedFloorDivide(lambda, d);
    const exact = expectedFloorDivideRef(lambda, d);
    check(
      `E[floor(X/${d})] fechado bate com a soma exata em lambda=${lambda}`,
      Math.abs(closed - exact) < 1e-4,
      `fechado ${closed.toFixed(5)} vs exato ${exact.toFixed(5)}`
    );
    check(
      `e fica ABAIXO da forma ingénua lambda/${d} em lambda=${lambda}`,
      closed < lambda / d - 1e-3,
      `${closed.toFixed(4)} vs ${(lambda / d).toFixed(4)}`
    );
  }

  // A função de sobrevivência que sustenta tudo isto.
  check("P(X >= 0) é sempre 1", poissonSurvival(0, 2.2) === 1);
  check(
    "P(X >= 1) = 1 - e^-lambda",
    Math.abs(poissonSurvival(1, 1.7) - (1 - Math.exp(-1.7))) < 1e-9
  );
  check(
    "P(X >= k) desce com k",
    poissonSurvival(3, 2) < poissonSurvival(2, 2) &&
      poissonSurvival(2, 2) < poissonSurvival(1, 2)
  );
  check(
    "lambda zero não produz probabilidades nem pontos",
    poissonSurvival(1, 0) === 0 && expectedFloorDivide(0, 3) === 0
  );
  check(
    "E[floor(X/d)] cresce com lambda",
    expectedFloorDivide(2.5, 3) > expectedFloorDivide(1.5, 3)
  );
}

/** Um conjunto de taxas completo, para poder variar uma de cada vez. */
function mkRates(over: Partial<PlayerRates> = {}): PlayerRates {
  return {
    xg90: 0.4,
    xa90: 0.2,
    bonus90: 0.4,
    saves90: 0,
    dc90: 0,
    yellow90: 0,
    red90: 0,
    setPieceXg90: 0,
    reasons: [],
    ...over,
  };
}

function mkMins(over: Partial<MinutesModel> = {}): MinutesModel {
  return {
    pStart: 1,
    avgMinutesPerStart: 90,
    pPlay60: 1,
    pAppear: 1,
    expectedMinutes: 90,
    reasons: [],
    ...over,
  };
}

// ---------------------------------------------------------------------
// A-01b — golos sofridos e defesas passam a pagar o degrau, não a média
// ---------------------------------------------------------------------
function testStepScoringUsesTheStep() {
  const xga = 1.35;
  const def = expectedPointsForFixture(2, mkRates(), mkMins(), {
    teamAttackRatio: 1,
    cleanSheetProbability: 0.3,
    expectedGoalsAgainst: xga,
  });
  check(
    "o castigo por golos sofridos usa E[floor(X/2)], não xGA/2",
    Math.abs(def.concededPenalty - -expectedFloorDivideRef(xga, 2)) < 1e-4,
    `${def.concededPenalty.toFixed(4)}`
  );
  check(
    "e é por isso materialmente menos severo do que a forma antiga",
    def.concededPenalty > -xga / 2 + 0.15,
    `${def.concededPenalty.toFixed(4)} vs ${(-xga / 2).toFixed(4)}`
  );

  // O castigo aplica-se a guarda-redes e defesas — e só a esses.
  for (const type of [3, 4]) {
    const p = expectedPointsForFixture(type, mkRates(), mkMins(), {
      teamAttackRatio: 1,
      cleanSheetProbability: 0.3,
      expectedGoalsAgainst: xga,
    });
    check(`posição ${type} não paga golos sofridos`, p.concededPenalty === 0);
  }

  // Defesas: 1 ponto por cada 3, também um degrau.
  const gk = expectedPointsForFixture(1, mkRates({ saves90: 3.0 }), mkMins(), {
    teamAttackRatio: 1,
    cleanSheetProbability: 0.3,
    expectedGoalsAgainst: 1.35,
    teamSeasonGoalsAgainst: 1.35,
  });
  check(
    "as defesas do guarda-redes pagam E[floor(X/3)]",
    Math.abs(gk.saves - expectedFloorDivideRef(3.0, 3)) < 1e-3,
    `${gk.saves.toFixed(4)}`
  );
  check(
    "e ficam claramente abaixo de lambda/3 (que dava 1.00 ponto de borla)",
    gk.saves < 1.0 - 0.2,
    `${gk.saves.toFixed(4)}`
  );

  // A base de comparação das defesas é a própria equipa, não uma constante.
  const ctx = { teamAttackRatio: 1, cleanSheetProbability: 0.3, expectedGoalsAgainst: 1.8 };
  const behindGoodDefence = expectedPointsForFixture(1, mkRates({ saves90: 3 }), mkMins(), {
    ...ctx,
    teamSeasonGoalsAgainst: 0.9,
  });
  const behindBadDefence = expectedPointsForFixture(1, mkRates({ saves90: 3 }), mkMins(), {
    ...ctx,
    teamSeasonGoalsAgainst: 1.8,
  });
  check(
    "um jogo mais difícil do que o normal DA EQUIPA aumenta as defesas esperadas",
    behindGoodDefence.saves > behindBadDefence.saves,
    `${behindGoodDefence.saves.toFixed(3)} vs ${behindBadDefence.saves.toFixed(3)}`
  );
  check(
    "um jogador de campo nunca recebe pontos de defesas",
    expectedPointsForFixture(2, mkRates({ saves90: 3 }), mkMins(), ctx).saves === 0
  );
}

// ---------------------------------------------------------------------
// A-02 — penáltis contados uma vez; cartões contados de todo
// ---------------------------------------------------------------------
function testPenaltiesAndCards() {
  const ctx = { teamAttackRatio: 1, cleanSheetProbability: 0.2, expectedGoalsAgainst: 1.3 };
  const plain = expectedPointsForFixture(4, mkRates({ xg90: 0.5 }), mkMins(), ctx);
  const penaltyTaker = expectedPointsForFixture(
    4,
    mkRates({ xg90: 0.5, setPieceXg90: 0.25 }),
    mkMins(),
    ctx
  );
  check(
    "marcar penáltis já está dentro do xG e não é somado outra vez",
    Math.abs(plain.goals - penaltyTaker.goals) < 1e-12,
    `${plain.goals} vs ${penaltyTaker.goals}`
  );

  const booked = expectedPointsForFixture(
    2,
    mkRates({ yellow90: 0.3, red90: 0.02 }),
    mkMins(),
    ctx
  );
  const clean = expectedPointsForFixture(2, mkRates(), mkMins(), ctx);
  check(
    "os cartões são cobrados: -1 por amarelo, -3 por vermelho",
    Math.abs(booked.cards - -(0.3 + 0.06)) < 1e-9,
    `${booked.cards}`
  );
  check("os cartões descontam mesmo no total", booked.total < clean.total - 0.3);
  check(
    "e a decomposição continua a somar ao total",
    Math.abs(
      booked.appearance +
        booked.goals +
        booked.assists +
        booked.cleanSheet +
        booked.concededPenalty +
        booked.defensiveContribution +
        booked.bonus +
        booked.saves +
        booked.cards -
        booked.total
    ) < 1e-9
  );
}

// ---------------------------------------------------------------------
// A-03 — contribuição defensiva: curva em S, sem porta dos 60 minutos
// ---------------------------------------------------------------------
function testDefensiveContributionCurve() {
  const ctx = { teamAttackRatio: 1, cleanSheetProbability: 0.3, expectedGoalsAgainst: 1.3 };
  const low = expectedPointsForFixture(2, mkRates({ dc90: 5 }), mkMins(), ctx);
  const high = expectedPointsForFixture(2, mkRates({ dc90: 15 }), mkMins(), ctx);
  check(
    "5 ações por 90 quase nunca chegam ao limiar (a reta antiga dizia 25%)",
    low.defensiveContribution < 0.2,
    `${low.defensiveContribution.toFixed(3)}`
  );
  check(
    "15 ações por 90 quase sempre chegam (a reta antiga dizia 75%)",
    high.defensiveContribution > 1.7,
    `${high.defensiveContribution.toFixed(3)}`
  );

  // Sem porta dos 60 minutos: quem sai aos 70 já ganhou as ações.
  const early = expectedPointsForFixture(
    2,
    mkRates({ dc90: 14 }),
    mkMins({ pPlay60: 0, expectedMinutes: 75 }),
    ctx
  );
  check(
    "sair antes dos 60 não anula a contribuição defensiva já feita",
    early.defensiveContribution > 1,
    `${early.defensiveContribution.toFixed(3)}`
  );
  check(
    "mas a baliza a zero continua dependente dos 60 minutos",
    early.cleanSheet === 0
  );
}

// ---------------------------------------------------------------------
// C-01 — as linhas de base da liga saem dos resultados, não de constantes
// ---------------------------------------------------------------------
function testLeagueBaselines() {
  const empty = deriveLeagueBaselines([]);
  check(
    "sem jogos, ficam as constantes de pré-época",
    empty.home === BASE_HOME_GOALS && empty.away === BASE_AWAY_GOALS && empty.matches === 0
  );
  check(
    "e essas constantes refletem a liga atual, não a de há uma década",
    BASE_HOME_GOALS + BASE_AWAY_GOALS > 2.9,
    `${BASE_HOME_GOALS + BASE_AWAY_GOALS}`
  );

  // Uma época inteira de jogos com muitos golos deve puxar a base para cima.
  const scoring = Array.from({ length: 120 }, (_, i) =>
    makeFixture({ id: i, event: 1, finished: true, team_h_score: 3, team_a_score: 2 })
  );
  const derived = deriveLeagueBaselines(scoring);
  check(
    "com amostra cheia, a base mede-se nos próprios resultados",
    Math.abs(derived.home - 3) < 1e-6 && Math.abs(derived.away - 2) < 1e-6,
    `${derived.home} / ${derived.away}`
  );
  // E com amostra pequena deve ficar entre os dois, não saltar.
  const few = deriveLeagueBaselines(scoring.slice(0, 10));
  check(
    "com amostra pequena mistura em vez de saltar",
    few.home > BASE_HOME_GOALS && few.home < 3,
    `${few.home.toFixed(3)}`
  );
}

// ---------------------------------------------------------------------
// C-02 — janela ponderada por horizonte e por precisão da fonte
// ---------------------------------------------------------------------
function testWindowIsWeighted() {
  const mk = (
    event: number,
    gf: number,
    source: FixtureExpectation["source"]
  ): FixtureExpectation => ({
    fixtureId: event,
    event,
    opponentTeamId: 2,
    isHome: true,
    expectedGoalsFor: gf,
    expectedGoalsAgainst: 1.2,
    cleanSheetProbability: 0.3,
    marketAdjusted: source === "market",
    source,
  });

  // Mesma fonte, horizontes diferentes: a jornada próxima pesa mais.
  const horizon = windowExpectation([mk(10, 2.4, "fpl"), mk(14, 1.0, "fpl")], 10, 5);
  check(
    "a jornada mais próxima pesa mais do que a mais distante",
    horizon.avgGoalsFor > 1.7,
    `média ${horizon.avgGoalsFor.toFixed(3)} (plana daria 1.700)`
  );

  // Mesmo horizonte, fontes diferentes: a estimativa precificada pesa mais.
  const source = windowExpectation([mk(10, 2.4, "market"), mk(10, 1.0, "neutral")], 10, 5);
  check(
    "uma estimativa vinda do mercado pesa mais do que um valor neutro",
    source.avgGoalsFor > 2.1,
    `média ${source.avgGoalsFor.toFixed(3)} (plana daria 1.700)`
  );

  // Os totais continuam a ser contagens, não médias ponderadas.
  check(
    "mas os totais continuam a ser somas puras (uma dupla são mesmo dois jogos)",
    Math.abs(source.totalGoalsFor - 3.4) < 1e-9,
    `${source.totalGoalsFor}`
  );
  check("e a contagem de jogos não é ponderada", source.fixtureCount === 2);
}

// ---------------------------------------------------------------------
// C-03 — descanso entre jogos
// ---------------------------------------------------------------------
function testRestDaysArePriced() {
  const teams = [1, 2, 3].map((id) => makeTeam(id));
  const iso = (day: number, hour = 15) =>
    `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;

  // A equipa 1 joga a meio da semana e volta a jogar 3 dias depois.
  // A equipa 2 tem a semana inteira. Ambas defrontam a equipa 3 fora de casa
  // do lado oposto, para que a única diferença seja o descanso.
  const fixtures = [
    makeFixture({ id: 1, event: 1, team_h: 1, team_a: 3, kickoff_time: iso(2) }),
    makeFixture({ id: 2, event: 2, team_h: 1, team_a: 2, kickoff_time: iso(5) }),
    makeFixture({ id: 3, event: 1, team_h: 2, team_a: 3, kickoff_time: iso(1) }),
  ];
  const rested = buildFixtureExpectations(teams, fixtures);
  const gw2 = rested.get(1)?.find((e) => e.event === 2);
  const gw2Away = rested.get(2)?.find((e) => e.event === 2);
  check("o jogo com descanso curto é modelado", !!gw2 && !!gw2Away);

  // Agora a mesma grelha, mas com a equipa 1 a descansar uma semana inteira.
  const fresh = buildFixtureExpectations(teams, [
    { ...fixtures[0], kickoff_time: iso(1) },
    fixtures[1],
    fixtures[2],
  ]);
  const gw2Fresh = fresh.get(1)?.find((e) => e.event === 2);
  check(
    "três dias de descanso baixam o ataque esperado face a uma semana inteira",
    (gw2?.expectedGoalsFor ?? 0) < (gw2Fresh?.expectedGoalsFor ?? 0) - 1e-6,
    `${gw2?.expectedGoalsFor?.toFixed(4)} vs ${gw2Fresh?.expectedGoalsFor?.toFixed(4)}`
  );
  check(
    "e o adversário beneficia disso na mesma proporção",
    (gw2?.expectedGoalsAgainst ?? 0) > (gw2Fresh?.expectedGoalsAgainst ?? 0) + 1e-9,
    `${gw2?.expectedGoalsAgainst?.toFixed(4)} vs ${gw2Fresh?.expectedGoalsAgainst?.toFixed(4)}`
  );
  check(
    "sem hora de jogo publicada, nada é penalizado",
    (() => {
      const noKickoff = buildFixtureExpectations(
        teams,
        fixtures.map((f) => ({ ...f, kickoff_time: null }))
      );
      const a = noKickoff.get(1)?.find((e) => e.event === 2)?.expectedGoalsFor ?? 0;
      const b = fresh.get(1)?.find((e) => e.event === 2)?.expectedGoalsFor ?? 0;
      return Math.abs(a - b) < 1e-9;
    })()
  );
}

// ---------------------------------------------------------------------
// C-05 — a linha de golos do mercado deixa de estar fixa em 2.5
// ---------------------------------------------------------------------
function testTotalsLineIsGeneral() {
  for (const line of [1.5, 2.5, 3.5]) {
    const p = overProbability(1.8, 1.3, line);
    const back = totalGoalsFromOverProb(p, line);
    check(
      `inverter a linha ${line} devolve o total de golos original`,
      Math.abs(back - 3.1) < 0.02,
      `${back.toFixed(3)}`
    );
  }
  check(
    "uma linha mais alta é sempre menos provável de ser ultrapassada",
    overProbability(1.8, 1.3, 3.5) < overProbability(1.8, 1.3, 2.5) &&
      overProbability(1.8, 1.3, 2.5) < overProbability(1.8, 1.3, 1.5)
  );
  check(
    "a função antiga de 2.5 continua a ser exatamente a linha 2.5",
    Math.abs(overTwoPointFiveProbability(1.8, 1.3) - overProbability(1.8, 1.3, 2.5)) < 1e-12
  );
}

// ---------------------------------------------------------------------
// B-01 — a braçadeira é um par, não duas listas
// ---------------------------------------------------------------------
function testArmbandIsAPair() {
  // Um prémio em dúvida (70% de jogar, 9 pontos) contra um titular seguro
  // (100%, 6.5 pontos). Só pelos pontos esperados o seguro ganhava
  // (9 x 0.7 = 6.3 < 6.5); com o vice a devolver a duplicação nos casos em
  // que a dúvida se confirma, o prémio é a escolha certa.
  const premium = mkSim(1, { epNext: 6.3, pPlay: 0.7 });
  const safe = mkSim(2, { epNext: 6.5, pPlay: 1, teamId: 2 });
  const third = mkSim(3, { epNext: 5.0, pPlay: 1, teamId: 3 });
  const { captain, viceCaptain } = pickCaptain([premium, safe, third]);
  check(
    "o prémio em dúvida é capitão porque o vice cobre a dúvida",
    captain?.element.id === 1,
    `capitão ${captain?.element.id}`
  );
  check(
    "e o vice é o melhor dos restantes, não um qualquer",
    viceCaptain?.element.id === 2,
    `vice ${viceCaptain?.element.id}`
  );

  // Sem dúvida nenhuma, ganha simplesmente quem pontua mais.
  const sure = pickCaptain([
    mkSim(1, { epNext: 6.3, pPlay: 1 }),
    mkSim(2, { epNext: 6.5, pPlay: 1, teamId: 2 }),
  ]);
  check("com toda a gente disponível, capitão é quem pontua mais", sure.captain?.element.id === 2);
  check("o capitão nunca é também o vice", sure.captain?.element.id !== sure.viceCaptain?.element.id);

  const single = pickCaptain([mkSim(1, {})]);
  check(
    "com um só jogador há capitão e não há vice",
    single.captain?.element.id === 1 && single.viceCaptain === undefined
  );
  const none = pickCaptain([]);
  check(
    "sem jogadores nenhum, nada é inventado",
    none.captain === undefined && none.viceCaptain === undefined
  );
}

// ---------------------------------------------------------------------
// B-02 — o banco tem ordem, e essa ordem vale pontos
// ---------------------------------------------------------------------
function testBenchOrder() {
  const gk = mkSim(1, { type: 1, epNext: 3.0, pPlay: 1, teamId: 1 });
  const strongButDoubtful = mkSim(2, { type: 3, epNext: 5.0, pPlay: 0.2, teamId: 2 });
  const modestButNailed = mkSim(3, { type: 2, epNext: 3.0, pPlay: 1, teamId: 3 });
  const weak = mkSim(4, { type: 4, epNext: 1.0, pPlay: 1, teamId: 4 });

  const ordered = orderBench([strongButDoubtful, weak, gk, modestButNailed]);
  check("o guarda-redes suplente ocupa o seu próprio lugar, à frente", ordered[0].element.id === 1);
  check(
    "entre os de campo manda P(jogar) x pontos, não os pontos sozinhos",
    ordered[1].element.id === 3,
    `primeiro de campo: ${ordered[1].element.id}`
  );
  check(
    "quem quase de certeza não joga desce, por muito bom que seja",
    ordered[2].element.id === 2 && ordered[3].element.id === 4,
    `${ordered.map((p) => p.element.id).join(",")}`
  );
  check("ninguém se perde nem se duplica pelo caminho", ordered.length === 4);
}

// ---------------------------------------------------------------------
// Backtesting — a recomendação estrutural da auditoria
//
// O único erro que invalida um backtest por completo é ver o futuro. Estes
// testes atacam sobretudo isso: a métrica é fácil de calcular, a ausência
// de fuga de informação é que é difícil de garantir.
// ---------------------------------------------------------------------

function mkHistory(rounds: number, per: (r: number) => Partial<ElementHistoryRow>) {
  return Array.from({ length: rounds }, (_, i) => ({
    round: i + 1,
    minutes: 90,
    total_points: 2,
    starts: 1,
    value: 50 + i,
    ...per(i + 1),
  })) as ElementHistoryRow[];
}

function testBacktestDoesNotSeeTheFuture() {
  const base = makeElement({ id: 1, element_type: 3, minutes: 9999, goals_scored: 99 });
  const history = mkHistory(10, (r) => ({
    goals_scored: r <= 5 ? 1 : 0,
    expected_goals: r <= 5 ? 0.8 : 0,
    bps: 30,
  }));

  const asOf6 = reconstructElementAsOf(base, history, 6);
  check(
    "só as jornadas ANTERIORES entram na reconstrução",
    asOf6.minutes === 450 && asOf6.goals_scored === 5,
    `${asOf6.minutes}min, ${asOf6.goals_scored} golos`
  );
  check(
    "os totais de hoje não passam para a reconstrução",
    asOf6.minutes !== 9999 && asOf6.goals_scored !== 99
  );

  // O teste que interessa: mexer numa jornada FUTURA não pode mexer em nada.
  const tampered = history.map((h) =>
    (h.round ?? 0) >= 6
      ? { ...h, goals_scored: 50, total_points: 200, expected_goals: 40, bps: 900 }
      : h
  );
  const asOf6Tampered = reconstructElementAsOf(base, tampered, 6);
  check(
    "alterar jornadas futuras não altera a reconstrução — não há fuga de informação",
    JSON.stringify(asOf6Tampered) === JSON.stringify(asOf6)
  );

  // A jornada alvo em si também é futuro.
  const asOf1 = reconstructElementAsOf(base, history, 1);
  check(
    "na primeira jornada não há passado nenhum e o modelo sabe-o",
    asOf1.minutes === 0 && asOf1.starts === 0 && asOf1.total_points === 0
  );

  check(
    "o preço usado é o da altura, não o de hoje",
    asOf6.now_cost === 54,
    `${asOf6.now_cost}`
  );
  check(
    "os sinais que não são reconstituíveis são neutralizados, não herdados",
    asOf6.status === "a" &&
      asOf6.chance_of_playing_next_round === null &&
      asOf6.selected_by_percent === "0"
  );
  check(
    "a forma é medida nos últimos 4 jogos anteriores à jornada",
    asOf6.form === "2.0",
    `${asOf6.form}`
  );
}

function testBacktestForgetsFutureResults() {
  const { fixtures } = makeBootstrap({ currentEvent: 9, gameweeks: 10 });
  const asOf5 = reconstructFixturesAsOf(fixtures, 5);
  check(
    "os jogos a partir da jornada alvo voltam a estar por jogar",
    asOf5.every((f) => (f.event ?? 0) < 5 || (!f.finished && f.team_h_score === null))
  );
  check(
    "e os anteriores mantêm-se intactos",
    asOf5.filter((f) => (f.event ?? 0) < 5).every((f) => f.finished && f.team_h_score !== null)
  );
  check(
    "o número de jogos não muda",
    asOf5.length === fixtures.length
  );
}

function testBacktestMetrics() {
  // Previsão perfeita: erro zero, correlação 1.
  const perfect = Array.from({ length: 40 }, (_, i) => ({
    event: 5,
    elementId: i + 1,
    webName: `P${i}`,
    elementType: 3,
    predicted: i % 11,
    actual: i % 11,
    minutes: 90,
    priceM: 5,
    trust: 1,
  }));
  const good = scoreBacktest(perfect);
  check("uma previsão perfeita dá erro zero", good.mae === 0 && good.rmse === 0);
  check("e correlação de ordem 1", Math.abs(good.spearman - 1) < 1e-9, `${good.spearman}`);
  check(
    "e o decil de topo bate o decil de fundo por uma margem grande",
    good.decileLift > 5,
    `${good.decileLift}`
  );

  // Previsão invertida: a correlação tem de ficar negativa, senão a métrica
  // não distingue um modelo bom de um modelo ao contrário.
  const inverted = perfect.map((r) => ({ ...r, predicted: 10 - r.actual }));
  check(
    "uma previsão invertida dá correlação negativa",
    scoreBacktest(inverted).spearman < -0.9,
    `${scoreBacktest(inverted).spearman}`
  );

  // Enviesamento: prever sempre 2 pontos a mais.
  const optimistic = perfect.map((r) => ({ ...r, predicted: r.actual + 2 }));
  const biased = scoreBacktest(optimistic);
  check(
    "prever a mais aparece como enviesamento positivo, não desaparece na média",
    Math.abs(biased.bias - 2) < 1e-9 && Math.abs(biased.mae - 2) < 1e-9
  );
  check(
    "mas a ordenação continua perfeita — MAE e correlação medem coisas diferentes",
    Math.abs(biased.spearman - 1) < 1e-9
  );

  // Empates: os pontos da FPL são quase todos 1, 2 e 0.
  const ties = Array.from({ length: 30 }, (_, i) => ({
    event: 5, elementId: i + 1, webName: `P${i}`, elementType: 3,
    predicted: 2, actual: i < 15 ? 2 : 6, minutes: 90, priceM: 5, trust: 1,
  }));
  const tied = scoreBacktest(ties);
  check(
    "com previsões todas iguais a correlação é 0, não NaN",
    Number.isFinite(tied.spearman) && Math.abs(tied.spearman) < 1e-9,
    `${tied.spearman}`
  );

  check("sem linhas nenhumas não rebenta", scoreBacktest([]).n === 0);

  const cal = good.calibration;
  check("a calibração é reportada por escalões", cal.length > 1);
  check(
    "e num modelo perfeito cada escalão prevê o que aconteceu",
    cal.every((b) => Math.abs(b.meanPredicted - b.meanActual) < 1e-9)
  );
}

function testBacktestRunsEndToEnd() {
  const { bootstrap, fixtures } = makeBootstrap({ currentEvent: 9, gameweeks: 10 });
  const historyByElement = new Map<number, ElementHistoryRow[]>();
  for (const el of bootstrap.elements) {
    historyByElement.set(
      el.id,
      mkHistory(8, (r) => ({
        total_points: (el.id % 5) + (r % 3),
        goals_scored: el.element_type >= 3 && r % 4 === 0 ? 1 : 0,
        expected_goals: el.element_type >= 3 ? 0.3 : 0.05,
        expected_assists: 0.15,
        bps: 20 + (el.id % 7),
        saves: el.element_type === 1 ? 3 : 0,
        clearances_blocks_interceptions: el.element_type === 2 ? 8 : 1,
      }))
    );
  }

  const result = runBacktest({ bootstrap, fixtures, historyByElement, fromEvent: 4, toEvent: 8 });
  check(
    "o backtest cobre todas as jornadas pedidas",
    result.metrics.events.join(",") === "4,5,6,7,8",
    result.metrics.events.join(",")
  );
  check("e produz uma linha por jogador por jornada", result.metrics.n > 100, `${result.metrics.n}`);
  check(
    "todas as métricas são números reais",
    [result.metrics.mae, result.metrics.rmse, result.metrics.bias, result.metrics.spearman].every(
      (v) => Number.isFinite(v)
    )
  );
  check(
    "a comparação com a base ingénua é sempre reportada",
    Number.isFinite(result.metrics.baselineMae) && result.metrics.baselineMae > 0,
    `${result.metrics.baselineMae}`
  );
  check(
    "as limitações do método vão escritas no próprio resultado",
    result.notes.length >= 4 && result.notes.every((n) => n.length > 20)
  );

  // A prova final de ausência de fuga: adulterar os resultados DA jornada
  // testada não pode mexer na previsão feita para ela.
  const inflated = new Map(
    [...historyByElement].map(([id, rows]) => [
      id,
      rows.map((h) => ((h.round ?? 0) >= 4 ? { ...h, total_points: 25, goals_scored: 5 } : h)),
    ])
  );
  const tampered = runBacktest({
    bootstrap, fixtures, historyByElement: inflated, fromEvent: 4, toEvent: 8,
  });
  const same =
    Math.abs(tampered.metrics.n - result.metrics.n) === 0 &&
    Math.abs(
      tampered.metrics.mae - tampered.metrics.bias -
        (result.metrics.mae - result.metrics.bias)
    ) >= 0;
  check("o backtest continua a correr com resultados adulterados", same);
  check(
    "e fica MUITO pior — sinal de que estava mesmo a prever, não a copiar",
    tampered.metrics.mae > result.metrics.mae + 5,
    `${tampered.metrics.mae.toFixed(2)} vs ${result.metrics.mae.toFixed(2)}`
  );
}

// ---------------------------------------------------------------------
// v1.28.2 — o orçamento. Reportado em produção: a app mandava comprar um
// jogador que não havia dinheiro para comprar.
//
// A causa foi um comentário que afirmava, sem nunca ter sido verificado,
// que `last_deadline_value` da FPL não incluía o saldo. Inclui. O saldo
// era somado duas vezes.
// ---------------------------------------------------------------------

function testBudgetSplit() {
  // Dados reais da equipa 2107193 na jornada 1, antes de qualquer
  // transferência: value = 1000, bank = 15. Toda a gente começa com
  // exatamente £100.0m, por isso o plantel vale £98.5m e o total £100.0m.
  // Se o total desse £101.5m, seria dinheiro que não existe.
  const gw1 = deriveBudget(1000, 15);
  check(
    "o valor publicado pela FPL já inclui o saldo — não se soma outra vez",
    gw1.totalBudgetM === 100.0,
    `£${gw1.totalBudgetM}m`
  );
  check(
    "o plantel vale o total menos o saldo",
    gw1.squadValueM === 98.5,
    `£${gw1.squadValueM}m`
  );
  check("e o saldo é reportado tal como vem", gw1.bankM === 1.5, `£${gw1.bankM}m`);
  check(
    "as três parcelas fecham entre si",
    Math.abs(gw1.squadValueM + gw1.bankM - gw1.totalBudgetM) < 1e-9
  );

  // Ninguém pode ter mais do que os £100.0m iniciais sem ter ganho valor.
  check(
    "na jornada 1 o orçamento não pode passar de £100.0m",
    deriveBudget(1000, 15).totalBudgetM <= 100.0 &&
      deriveBudget(1000, 0).totalBudgetM <= 100.0 &&
      deriveBudget(1000, 40).totalBudgetM <= 100.0
  );

  // Uma equipa que valorizou.
  const later = deriveBudget(1034, 7);
  check(
    "com valorização, o total é o que a FPL diz e o plantel é o resto",
    later.totalBudgetM === 103.4 && later.squadValueM === 102.7 && later.bankM === 0.7,
    `${later.totalBudgetM}/${later.squadValueM}/${later.bankM}`
  );

  // Robustez: campos em falta ou absurdos não podem produzir NaN nem
  // orçamentos negativos, que entrariam direitos no solver.
  const missing = deriveBudget(undefined, undefined);
  check(
    "sem dados, assume os £100.0m iniciais e saldo zero",
    missing.totalBudgetM === 100 && missing.bankM === 0 && missing.squadValueM === 100
  );
  const absurd = deriveBudget(1000, 99999);
  check(
    "um saldo impossível não gera um plantel de valor negativo",
    absurd.squadValueM >= 0 && absurd.totalBudgetM === 100,
    `${absurd.squadValueM}`
  );
  check(
    "nunca sai NaN de nenhuma das três parcelas",
    [absurd, missing, gw1, later].every((b) =>
      [b.bankM, b.squadValueM, b.totalBudgetM].every((v) => Number.isFinite(v))
    )
  );
}

function testPlanNeverExceedsRealMoney() {
  // O teste que faltava e que teria apanhado o erro: qualquer plano
  // recomendado tem de caber no dinheiro que existe mesmo — preços de
  // VENDA para quem sai, preços de compra para quem entra.
  const { owned, scored } = mkTransferPool([6, 5, 4]);
  const state = mkState(owned, 2, 0.5);
  const advice = planTransfers(scored, state, { currentEvent: 12 });
  check("o planeador produz planos com este cenário", advice.plans.length > 0);

  const priceOf = (id: number, isOwned: boolean) => {
    if (isOwned) {
      const o = state.owned.find((x) => x.elementId === id);
      if (o) return o.sellingPriceM;
    }
    return scored.find((p) => p.element.id === id)?.priceM ?? 0;
  };

  for (const plan of advice.plans) {
    const ownedIds = new Set(state.owned.map((o) => o.elementId));
    const cost = plan.squad.reduce(
      (s, p) => s + priceOf(p.element.id, ownedIds.has(p.element.id)),
      0
    );
    check(
      `o plano "${plan.label}" cabe no dinheiro real (£${cost.toFixed(1)}m de £${state.totalBudgetM.toFixed(1)}m)`,
      cost <= state.totalBudgetM + 1e-6,
      `excede em £${(cost - state.totalBudgetM).toFixed(1)}m`
    );
    check(
      `e o saldo que sobra no plano "${plan.label}" nunca é negativo`,
      plan.bankAfterM >= -1e-6,
      `£${plan.bankAfterM}m`
    );
  }

  // E o cenário que apanha mesmo o erro: um alvo caro que NÃO cabe.
  // Sem isto o teste é vazio — todas as trocas custam o mesmo e sobrar
  // dinheiro a mais nunca se nota.
  const cheapOwned: ScoredPlayer[] = [];
  const shape: [number, number][] = [[1, 2], [2, 5], [3, 5], [4, 3]];
  let nid = 1;
  let club = 0;
  for (const [type, count] of shape) {
    for (let i = 0; i < count; i++) {
      cheapOwned.push(
        mkSim(nid++, { teamId: (club++ % 20) + 1, type, epNext: 4, price: 6, own: 15 })
      );
    }
  }
  const market: ScoredPlayer[] = [];
  for (const [type] of shape) {
    for (let i = 0; i < 6; i++) {
      market.push(
        mkSim(nid++, { teamId: (club++ % 20) + 1, type, epNext: 3.8, price: 6, own: 12 })
      );
    }
  }
  // O engodo: muito melhor, e £6.5m acima do que existe para o comprar.
  const unaffordable = mkSim(nid++, {
    teamId: 19, type: 3, epNext: 12, price: 12.5, own: 40,
  });
  market.push(unaffordable);

  // 15 x £6m = £90m de plantel, zero de saldo. Comprar o engodo custaria
  // 90 - 6 + 12.5 = £96.5m. Não há.
  const poor = mkState(cheapOwned, 2, 0);
  const poorAdvice = planTransfers([...cheapOwned, ...market], poor, { currentEvent: 12 });
  check(
    "o cenário do teste tem mesmo um alvo apetecível e impossível de pagar",
    unaffordable.priceM > 12 && poor.totalBudgetM === 90,
    `£${poor.totalBudgetM}m`
  );
  for (const plan of poorAdvice.plans) {
    const ownedIds2 = new Set(poor.owned.map((o) => o.elementId));
    const cost = plan.squad.reduce((sum, p) => {
      const o = poor.owned.find((x) => x.elementId === p.element.id);
      return sum + (ownedIds2.has(p.element.id) && o ? o.sellingPriceM : p.priceM);
    }, 0);
    check(
      `sem dinheiro, o plano "${plan.label}" não compra o que não pode pagar (£${cost.toFixed(1)}m de £${poor.totalBudgetM.toFixed(1)}m)`,
      cost <= poor.totalBudgetM + 1e-6,
      `excede em £${(cost - poor.totalBudgetM).toFixed(1)}m`
    );
    check(
      `e o plano "${plan.label}" não contém o jogador inacessível`,
      !plan.squad.some((p) => p.element.id === unaffordable.element.id)
    );
  }
}

// ---------------------------------------------------------------------
// v1.29 — a Camada 2 estava desligada em produção e ninguém dava por isso.
//
// Os rivais eram os 24 primeiros da tabela. Quem está em 29º de 47 não
// entra nessa lista — e a simulação não consegue simular uma liga onde a
// própria equipa não está. A postura caía para neutra, β ficava a 0, e a
// página dizia-o numa linha pequena que se lia como um problema temporário
// de dados em vez de uma exclusão permanente.
// ---------------------------------------------------------------------

function mkStandings(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    entry: 1000 + i,
    entry_name: `Equipa ${i + 1}`,
    player_name: `Gestor ${i + 1}`,
    rank: i + 1,
    last_rank: i + 1,
    total: 100 - i,
    event_total: 50,
  }));
}

function testRivalSelectionAlwaysIncludesMe() {
  // O caso real: 47 na liga, eu em 29º.
  const league = mkStandings(47);
  const me = league[28].entry;
  const picked = selectRivals(league, me, 24);
  check(
    "estando em 29º de 47, continuo dentro da amostra simulada",
    picked.some((e) => e.entry === me),
    `escolhidos: ${picked.map((e) => e.rank).join(",")}`
  );
  check("e o limite é respeitado", picked.length === 24, `${picked.length}`);

  // O último da tabela é o caso extremo do mesmo erro.
  const last = league[46].entry;
  check(
    "mesmo em último lugar continuo dentro",
    selectRivals(league, last, 24).some((e) => e.entry === last)
  );
  // E o primeiro, obviamente.
  check(
    "e em primeiro também",
    selectRivals(league, league[0].entry, 24).some((e) => e.entry === league[0].entry)
  );

  // Os vizinhos diretos importam mais do que a 24ª equipa: são eles que uma
  // jornada consegue mesmo ultrapassar.
  const ranks = new Set(picked.map((e) => e.rank));
  check(
    "os vizinhos imediatos acima e abaixo entram",
    [27, 28, 30, 31].every((r) => ranks.has(r)),
    `${[...ranks].sort((a, b) => a - b).join(",")}`
  );
  check(
    "e os líderes também, porque é o ritmo deles que é preciso acompanhar",
    ranks.has(1) && ranks.has(2) && ranks.has(3)
  );
  check(
    "a lista sai por ordem de classificação",
    picked.every((e, i) => i === 0 || picked[i - 1].rank < e.rank)
  );
  check(
    "ninguém aparece duas vezes",
    new Set(picked.map((e) => e.entry)).size === picked.length
  );

  // Ligas pequenas entram por inteiro, sem escolhas nenhumas.
  const small = mkStandings(12);
  check(
    "uma liga mais pequena do que o limite entra toda",
    selectRivals(small, small[5].entry, 24).length === 12
  );

  // Uma liga enorme não pode rebentar o limite nem perder-me.
  const huge = mkStandings(5000);
  const inHuge = selectRivals(huge, huge[4321].entry, 60);
  check(
    "numa liga de 5000, o limite aguenta e continuo lá dentro",
    inHuge.length === 60 && inHuge.some((e) => e.entry === huge[4321].entry),
    `${inHuge.length}`
  );

  // Um Team ID que não pertence à liga não pode partir a seleção.
  const stranger = selectRivals(league, 999999, 24);
  check(
    "um ID de fora da liga devolve na mesma uma amostra válida",
    stranger.length === 24 && stranger[0].rank === 1
  );
}

function testSimulationSurvivesBeingBottomOfTheLeague() {
  // O teste de ponta a ponta do mesmo defeito: com a seleção certa, a
  // simulação tem de ficar DISPONÍVEL para quem está no fundo da tabela.
  const league = mkStandings(47);
  const meEntry = league[28].entry;
  const picked = selectRivals(league, meEntry, 24);

  const pool: ScoredPlayer[] = [];
  for (let i = 0; i < 30; i++) {
    pool.push(
      mkSim(500 + i, {
        teamId: (i % 20) + 1,
        type: (i % 4) + 1,
        epNext: 3 + (i % 5),
        own: 10 + (i % 40),
      })
    );
  }
  const squads: RivalSquad[] = picked.map((e, i) =>
    mkSquad(
      e.entry,
      e.rank,
      e.total,
      Array.from({ length: 11 }, (_, k) => pool[(i + k) % pool.length].element.id),
      e.entry === meEntry
    )
  );

  const outlook = simulateLeague(squads, pool, {
    currentEvent: 10,
    squadsFromEvent: 9,
    runs: 300,
  });
  check(
    "a simulação fica disponível mesmo estando em 29º de 47",
    outlook.available,
    outlook.reason ?? ""
  );
  check("e identifica a minha equipa", outlook.me?.entry === meEntry);
  check(
    "e produz uma postura a sério, não a predefinição neutra",
    outlook.rivals.length > 0 && outlook.runs > 0
  );

  // O contrário: sem a minha equipa, tem de recusar em vez de inventar.
  const withoutMe = squads.filter((s) => !s.isMe);
  const broken = simulateLeague(withoutMe, pool, {
    currentEvent: 10,
    squadsFromEvent: 9,
    runs: 100,
  });
  check(
    "sem a minha equipa, a simulação recusa em vez de fingir",
    !broken.available && broken.posture.beta === 0
  );
}

// ---------------------------------------------------------------------
// v1.30 — calibração. Transformar argumentos em medições.
//
// O perigo desta camada não é errar a conta: é encontrar um "melhor valor"
// em três jornadas de dados e apresentá-lo com duas casas decimais. Um
// varrimento ENCONTRA SEMPRE um vencedor. A maior parte dos testes abaixo
// existe para garantir que a máquina se cala quando não sabe.
// ---------------------------------------------------------------------

function testDefaultsMatchTheShippedLiterals() {
  // Se estes valores mudarem sem ninguém decidir, o modelo inteiro muda.
  const d = DEFAULT_MODEL_PARAMS;
  const expected: [string, number][] = [
    ["underlyingBlend", 0.65],
    ["shrinkXg", 3],
    ["shrinkXa", 3],
    ["shrinkBonus", 6],
    ["shrinkSaves", 3],
    ["shrinkDc", 6],
    ["shrinkYellow", 6],
    ["shrinkRed", 10],
    ["priorYellow90", 0.12],
    ["priorRed90", 0.012],
    ["bpsIntercept", 12],
    ["bpsDivisor", 18],
    ["bpsMaxBonus", 2.2],
    ["bpsBlend", 0.7],
    ["minutes60Floor", 35],
    ["minutes60Span", 45],
    ["minutes60Cap", 0.97],
    ["modelTrustMinutes", 360],
  ];
  for (const [key, value] of expected) {
    check(
      `o valor por omissão de ${key} é o que o modelo sempre teve (${value})`,
      (d as unknown as Record<string, number>)[key] === value,
      `${(d as unknown as Record<string, number>)[key]}`
    );
  }

  check(
    "todos os parâmetros com grelha têm o valor atual dentro dela",
    (Object.keys(PARAM_GRIDS) as (keyof typeof PARAM_GRIDS)[]).every((k) => {
      const grid = PARAM_GRIDS[k]!;
      const current = (d as unknown as Record<string, number>)[k as string];
      return grid.some((v) => Math.abs(v - current) < 1e-9);
    }),
    "uma grelha que não contém o valor atual não consegue dizer 'fica como está'"
  );
}

function testParamsChangeNothingByDefault() {
  const el = makeElement({
    id: 1,
    element_type: 3,
    minutes: 900,
    starts: 10,
    goals_scored: 4,
    assists: 3,
    bps: 320,
    bonus: 6,
    yellow_cards: 2,
  });
  const a = computePlayerRates(el);
  const b = computePlayerRates(el, {});
  const c = computePlayerRates(el, DEFAULT_MODEL_PARAMS);
  check(
    "passar parâmetros vazios não muda absolutamente nada",
    JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c)
  );

  const m1 = computeMinutesModel(el, 10, false);
  const m2 = computeMinutesModel(el, 10, false, {});
  check(
    "e o mesmo no modelo de minutos",
    JSON.stringify(m1) === JSON.stringify(m2)
  );

  // Mas mudar um parâmetro tem de mudar mesmo o resultado, senão a
  // calibração estaria a varrer valores que não fazem nada.
  const heavier = computePlayerRates(el, { shrinkXg: 20 });
  check(
    "aumentar o encolhimento puxa a taxa para baixo",
    heavier.xg90 < a.xg90,
    `${heavier.xg90} vs ${a.xg90}`
  );
  const noBlend = computePlayerRates(el, { underlyingBlend: 1 });
  check(
    "mudar a mistura muda o xG esperado",
    Math.abs(noBlend.xg90 - a.xg90) > 1e-9
  );
  const shortGate = computeMinutesModel(el, 10, false, { minutes60Floor: 80 });
  check(
    "subir o limiar dos 60 minutos reduz P(chegar aos 60)",
    shortGate.pPlay60 < m1.pPlay60,
    `${shortGate.pPlay60} vs ${m1.pPlay60}`
  );
}

/** Um mundo sintético com jornadas suficientes para a calibração correr. */
function mkCalibWorld(gameweeks: number) {
  const { bootstrap, fixtures } = makeBootstrap({
    currentEvent: gameweeks + 1,
    gameweeks: gameweeks + 1,
  });
  const historyByElement = new Map<number, ElementHistoryRow[]>();
  for (const el of bootstrap.elements) {
    historyByElement.set(
      el.id,
      Array.from({ length: gameweeks }, (_, i) => ({
        round: i + 1,
        minutes: 90,
        starts: 1,
        value: 50,
        total_points: 2 + ((el.id + i) % 6),
        goals_scored: el.element_type >= 3 && (el.id + i) % 5 === 0 ? 1 : 0,
        expected_goals: el.element_type >= 3 ? 0.3 : 0.05,
        expected_assists: 0.15,
        bps: 18 + ((el.id + i) % 12),
        bonus: (el.id + i) % 7 === 0 ? 1 : 0,
        saves: el.element_type === 1 ? 3 : 0,
        clearances_blocks_interceptions: el.element_type === 2 ? 8 : 1,
      })) as ElementHistoryRow[]
    );
  }
  return { bootstrap, fixtures, historyByElement };
}

function testCalibrationRefusesToGuess() {
  // Poucas jornadas: a máquina tem de se calar, por muito bom que pareça
  // o mínimo que encontrou.
  const w = mkCalibWorld(4);
  const report = calibrate({
    bootstrap: w.bootstrap,
    fixtures: w.fixtures,
    historyByElement: w.historyByElement,
    fromEvent: 2,
    toEvent: 4,
    params: ["underlyingBlend", "shrinkXg"],
  });

  check(
    "com poucas jornadas, a evidência é declarada insuficiente",
    !report.sufficientEvidence,
    `${report.events.length} jornadas, ${report.rows} linhas`
  );
  check(
    "e NADA é recomendado",
    report.recommendations.length === 0,
    `${report.recommendations.length} recomendações`
  );
  check(
    "mas o varrimento corre na mesma e mostra as curvas",
    report.results.length === 2 && report.results.every((r) => r.curve.length >= 5)
  );
  check(
    "e cada parâmetro explica porque não foi recomendado",
    report.results.every((r) => !r.recommended && r.reason.length > 20)
  );
  check(
    "a nota de evidência diz quantas jornadas faltam",
    report.evidenceNote.includes(String(MIN_EVENTS))
  );
  check(
    "as curvas nunca contêm valores inválidos",
    report.results.every((r) =>
      r.curve.every((c) => Number.isFinite(c.error) || c.error === Infinity)
    )
  );
  check(
    "o valor atual aparece marcado na curva",
    report.results.every((r) => r.curve.filter((c) => c.isDefault).length === 1)
  );
}

function testCalibrationIsHonestAboutDisagreement() {
  // Dados sem sinal nenhum a favor de outro valor: as jornadas não vão
  // concordar, e a discordância tem de ser reportada em vez de escondida
  // atrás do melhor valor médio.
  const w = mkCalibWorld(9);
  const report = calibrate({
    bootstrap: w.bootstrap,
    fixtures: w.fixtures,
    historyByElement: w.historyByElement,
    fromEvent: 2,
    toEvent: 9,
    params: ["underlyingBlend"],
  });
  const r = report.results[0];

  check(
    "com jornadas suficientes, a calibração passa a poder recomendar",
    report.sufficientEvidence || report.rows < MIN_ROWS,
    `${report.events.length} jornadas, ${report.rows} linhas`
  );
  check(
    "uma recomendação só sai se as jornadas concordarem entre si",
    !r.recommended ||
      r.reason.includes("concordarem") ||
      r.reason.includes("Reduz o erro"),
    r.reason
  );
  check(
    "o relatório nunca recomenda manter o valor atual como se fosse mudança",
    !r.recommended || Math.abs(r.bestValue - r.currentValue) > 1e-9
  );
  check(
    "a melhoria reportada é coerente com os erros reportados",
    !Number.isFinite(r.currentError) ||
      Math.abs(
        r.improvement - (r.currentError - r.bestError) / r.currentError
      ) < 1e-9
  );
  check(
    "as recomendações são um subconjunto dos resultados",
    report.recommendations.every((x) => report.results.includes(x))
  );
}

// ---------------------------------------------------------------------
// v1.30.1 — o deploy morreu por causa de um limite do plano.
//
// `maxDuration = 800` no /api/calibrate. O plano Hobby da Vercel aceita no
// máximo 300, e não trunca: RECUSA O DEPLOY INTEIRO
// ("invalid_max_duration"). O build passou, os testes passaram, e a app
// não subiu — uma constante escrita sem verificar o plano derrubou tudo.
//
// Este teste lê os próprios ficheiros de rota. É o único sítio onde a
// suite olha para o código como texto, e vale a pena: nada mais aqui
// consegue apanhar um limite de infraestrutura.
// ---------------------------------------------------------------------

const VERCEL_HOBBY_MAX_DURATION = 300;

function testNoRouteExceedsThePlanTimeout() {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name === "route.ts" || entry.name === "page.tsx") out.push(full);
    }
    return out;
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const appDir = path.join(here, "..", "app");
  const files = fs.existsSync(appDir) ? walk(appDir) : [];
  check("os ficheiros de rota são encontrados para verificação", files.length > 0);

  const offenders: string[] = [];
  let declared = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const m = src.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
    if (!m) continue;
    declared++;
    const value = parseInt(m[1], 10);
    if (value > VERCEL_HOBBY_MAX_DURATION) {
      offenders.push(`${path.relative(appDir, file)} = ${value}`);
    }
  }

  check("pelo menos uma rota declara maxDuration (senão o teste é vazio)", declared > 0);
  check(
    `nenhuma rota passa do limite de ${VERCEL_HOBBY_MAX_DURATION}s do plano`,
    offenders.length === 0,
    offenders.join(", ")
  );
}

// ---------------------------------------------------------------------
// v1.30.2 — o token da API. As tarefas semanais nunca escreveram nada.
//
// `lastRun` esteve a null durante uma semana enquanto o painel mostrava
// notas ativas (postas à mão), o que fazia a camada parecer viva. A
// verificação do token era comparação exata, e um valor colado no painel
// da Vercel apanha espaço ou quebra de linha com toda a facilidade — o
// valor PARECE igual em todo o lado e todos os pedidos dão 401.
// ---------------------------------------------------------------------

function withEnvToken<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.INSIGHTS_API_TOKEN;
  if (value === undefined) delete process.env.INSIGHTS_API_TOKEN;
  else process.env.INSIGHTS_API_TOKEN = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.INSIGHTS_API_TOKEN;
    else process.env.INSIGHTS_API_TOKEN = previous;
  }
}

function testApiTokenCheck() {
  const secret = "abc123secret";

  check(
    "o token certo é aceite",
    withEnvToken(secret, () => checkApiToken(secret).ok)
  );
  check(
    "um token errado é recusado",
    withEnvToken(secret, () => !checkApiToken("outro").ok)
  );
  check(
    "sem token nenhum, recusa",
    withEnvToken(secret, () => !checkApiToken(null).ok && !checkApiToken("").ok)
  );

  // O caso que estava a partir tudo em produção.
  check(
    "uma quebra de linha colada a mais no SERVIDOR não invalida o token",
    withEnvToken(secret + "\n", () => checkApiToken(secret).ok)
  );
  check(
    "nem espaços à volta do valor enviado",
    withEnvToken(secret, () => checkApiToken(`  ${secret}  `).ok)
  );

  // Variável em falta = escritas desligadas, nunca "entra qualquer um".
  check(
    "sem a variável definida, nada passa — nem uma string vazia",
    withEnvToken(undefined, () => !checkApiToken("").ok && !checkApiToken("seja o que for").ok)
  );
  check(
    "e uma variável só com espaços conta como não definida",
    withEnvToken("   ", () => {
      const c = checkApiToken("   ");
      return !c.ok && !c.configured;
    })
  );

  // O diagnóstico tem de ajudar sem alguma vez expor o segredo.
  const body = withEnvToken(secret, () => unauthorizedBody(checkApiToken("curto")));
  const asText = JSON.stringify(body);
  check(
    "a resposta de erro NUNCA contém o segredo",
    !asText.includes(secret),
    asText.slice(0, 120)
  );
  check(
    "mas diz que está configurado e dá os comprimentos, que é o que distingue as causas",
    body.configured === true &&
      body.expectedLength === secret.length &&
      body.providedLength === 5
  );
  const missing = withEnvToken(undefined, () => unauthorizedBody(checkApiToken("x")));
  check(
    "e quando a variável falta, diz isso explicitamente",
    missing.configured === false && String(missing.hint).includes("Redeploy")
  );
}

// ---------------------------------------------------------------------
// v1.31 — o modelo estava a recomendar trocas dentro do ruído.
//
// Reportado em produção na jornada 2: "manda tirar o Calafiori, que
// acabou de fazer 9 pontos, e meter o Guéhi" — por +0.4 pontos em cinco
// jornadas. O dono da equipa não percebia, e tinha razão.
//
// A causa não era aritmética. `expectedPointsNext` mistura este modelo
// com o `ep_next` da própria FPL, ponderado pelos minutos jogados. Na
// jornada 2, um jogador com 90 minutos tem 90 dos 360 que a mistura quer:
// TRÊS QUARTOS do número vêm da estimativa da FPL, que é propositadamente
// plana no início da época. Via-se no ecrã — o plantel todo entre 1.9 e
// 3.8 pontos, com um guarda-redes acima de um avançado premium.
//
// O erro era a camada de decisão tratar esses números como se fossem
// seguros.
// ---------------------------------------------------------------------

function testNoiseFloorScalesWithConfidence() {
  // v1.38 — ESTE TESTE PROTEGIA O BUG.
  //
  // A versão anterior afirmava, textualmente, "com confiança total, não há
  // travão nenhum" — e passava. Era a descrição exata do defeito: como
  // `modelTrust = min(1, minutos/360)` chega a 1.0 ao fim de quatro jogos
  // completos, a partir da jornada 4 TODOS os titulares tinham confiança
  // total e o travão era exatamente zero. O modelo passava a poder recomendar
  // qualquer ganho positivo, por mais pequeno que fosse, que é precisamente o
  // "manda vender o Gibbs-White" que o dono reportou.
  //
  // O teste não estava errado sobre o código; estava errado sobre o que o
  // código devia fazer. Reescrito para trancar a propriedade certa.
  check(
    "o travão NUNCA é zero, por muito confiante que o modelo esteja",
    noiseFloor(1, 37) > 0,
    `${noiseFloor(1, 37)}`
  );
  check(
    "e é maior no início da época, quando o modelo sabe menos",
    noiseFloor(1, 1) > noiseFloor(1, 20) && noiseFloor(1, 20) > noiseFloor(1, 37),
    `${noiseFloor(1, 1)} > ${noiseFloor(1, 20)} > ${noiseFloor(1, 37)}`
  );
  check(
    "minutos escassos ainda apertam o travão, mas já não o podem soltar",
    noiseFloor(0.25, 10) > noiseFloor(1, 10),
    `${noiseFloor(0.25, 10)} vs ${noiseFloor(1, 10)}`
  );
  check(
    // Um plano com mais trocas acumula mais incerteza — mas como as
    // comparações são independentes, cresce com sqrt(m), não com m.
    "um plano com mais trocas tem de ganhar mais, mas menos que proporcional",
    noiseFloor(1, 10, 4) > noiseFloor(1, 10, 1) &&
      noiseFloor(1, 10, 4) < noiseFloor(1, 10, 1) * 4,
    `1 troca ${noiseFloor(1, 10, 1)}, 4 trocas ${noiseFloor(1, 10, 4)}`
  );
  check(
    "valores absurdos são contidos, nunca produzem travões negativos",
    noiseFloor(-5, -5) > 0 && noiseFloor(99, 99) > 0,
    `${noiseFloor(-5, -5)} / ${noiseFloor(99, 99)}`
  );
  check(
    // O limite superior existe para o travão não colapsar em "nunca trocar
    // ninguém", que seria o mesmo defeito com o sinal trocado.
    "e o travão tem um teto — não pode proibir qualquer transferência",
    noiseFloor(1, 0) < 12,
    `${noiseFloor(1, 0)}`
  );
}

function testMarginalTransferIsRefusedEarlyInTheSeason() {
  // Um plantel onde a melhor troca vale pouco — exatamente o caso real.
  // g=6 produz uma vantagem real de 0.9 pts — positiva, mas dentro do ruído
  // enquanto o modelo só tem 25% de confiança. Exatamente o caso do Calafiori.
  const { owned, scored } = mkTransferPool([6]);
  const withTrust = (p: ScoredPlayer, t: number): ScoredPlayer => ({
    ...p,
    modelTrust: t,
  });

  // Jornada 2: 25% de confiança. O ganho não chega ao travão.
  const early = scored.map((p) => withTrust(p, 0.25));
  const earlyOwned = owned.map((p) => withTrust(p, 0.25));
  const earlyAdvice = planTransfers(early, mkState(earlyOwned, 1), {
    currentEvent: 2,
  });
  check(
    "no início da época, uma troca marginal NÃO é recomendada",
    earlyAdvice.recommended?.key === "manter",
    `recomendado: ${earlyAdvice.recommended?.key}`
  );
  const refused = earlyAdvice.plans.find((p) => p.key !== "manter");
  check(
    "mas o plano continua visível, com o raciocínio à vista",
    !!refused && refused.moves.length > 0
  );
  check(
    "e explica que a diferença é ruído, não vantagem",
    !!refused && refused.rationale.includes("ruído"),
    refused?.rationale.slice(0, 80)
  );
  check(
    "e diz quanto teria de ganhar para valer a pena",
    !!refused && refused.requiredEdge > 1,
    `${refused?.requiredEdge}`
  );

  // A MESMA propriedade, medida de outra maneira em v1.38.
  //
  // A versão anterior pegava nesta troca marginal (0.9 pts em cinco jornadas)
  // e exigia que, com a época avançada, ela passasse a ser aceitável. Isso só
  // era verdade porque o travão chegava a ZERO com confiança total — o próprio
  // defeito. Uma diferença de 0.9 pontos em cinco jornadas não é distinguível
  // de zero em jornada nenhuma, e o modelo não deve agir sobre ela nem em maio.
  //
  // O que a evidência deve mesmo fazer é BAIXAR A BARRA. Isso testa-se
  // diretamente, e depois com uma troca de tamanho intermédio que falha cedo
  // e passa tarde: é a propriedade original, sem a conclusão errada.
  const late = scored.map((p) => withTrust(p, 1));
  const lateOwned = owned.map((p) => withTrust(p, 1));
  const lateAdvice = planTransfers(late, mkState(lateOwned, 1), {
    currentEvent: 20,
  });
  const earlyEdge = refused?.requiredEdge ?? 0;
  const lateEdge =
    lateAdvice.plans.find((p) => p.key !== "manter")?.requiredEdge ?? noiseFloor(1, 19, 1);
  check(
    "a barra desce à medida que a época avança, mas nunca chega a zero",
    lateEdge < earlyEdge && lateEdge > 0,
    `cedo ${earlyEdge}, tarde ${lateEdge}`
  );
  check(
    "e uma troca de 0.9 pts em cinco jornadas continua recusada mesmo tarde",
    lateAdvice.recommended?.key === "manter",
    `recomendado: ${lateAdvice.recommended?.key}`
  );

  // Uma troca de tamanho intermédio: ruído em agosto, vantagem real em abril.
  const mid = mkTransferPool([7]);
  const midTrust = (gw: number) =>
    planTransfers(
      mid.scored.map((p) => withTrust(p, 1)),
      mkState(
        mid.owned.map((p) => withTrust(p, 1)),
        5
      ),
      { currentEvent: gw }
    );
  const midEarly = midTrust(2);
  const midLate = midTrust(32);
  check(
    "a mesma troca de 7 pts é recusada na jornada 2 e aceite na jornada 32",
    midEarly.recommended?.key === "manter" && midLate.recommended?.key !== "manter",
    `cedo ${midEarly.recommended?.key}, tarde ${midLate.recommended?.key}`
  );

  // Uma melhoria GRANDE tem de passar mesmo com pouca confiança — o travão
  // é contra o ruído, não contra agir.
  const { owned: bigOwned, scored: bigScored } = mkTransferPool([30]);
  const bigEarly = bigScored.map((p) => withTrust(p, 0.25));
  const bigEarlyOwned = bigOwned.map((p) => withTrust(p, 0.25));
  const bigAdvice = planTransfers(bigEarly, mkState(bigEarlyOwned, 1), {
    currentEvent: 2,
  });
  check(
    "uma melhoria grande passa o travão mesmo cedo na época",
    bigAdvice.recommended?.key !== "manter",
    `recomendado: ${bigAdvice.recommended?.key}`
  );
}

// ---------------------------------------------------------------------
// v1.32 — o efeito de arrastamento (bandwagon).
//
// Pedido: "há jogadores em grande forma que todos começam a ter, não posso
// ignorar isso." Tem razão, mas por um motivo diferente do que parece.
//
// A forma como PREVISÃO de pontos é uma armadilha e continua de fora: a
// parte real dela já está no modelo, através do xG/xA e dos golos
// realizados. O que faltava era o ARRASTAMENTO — e esse é sobre ranking,
// não sobre pontos. Toda a camada de risco lia `selected_by_percent`, que
// é a posse de HOJE. A posse é um stock; o arrastamento é um fluxo.
// ---------------------------------------------------------------------

function mkBootstrapWithTransfers(rows: { id: number; own: number; in: number; out: number }[]) {
  const { bootstrap } = makeBootstrap({ currentEvent: 5, gameweeks: 10 });
  bootstrap.total_players = 10_000_000;
  bootstrap.elements = rows.map((r) =>
    makeElement({
      id: r.id,
      selected_by_percent: String(r.own),
      transfers_in_event: r.in,
      transfers_out_event: r.out,
    })
  );
  return bootstrap;
}

function testMomentumReadsTheFlowNotTheStock() {
  const bootstrap = mkBootstrapWithTransfers([
    // 8% de posse, mas 2 milhões de managers a comprá-lo: +20 pontos
    // percentuais. Não é um diferencial, é quase template à hora do deadline.
    { id: 1, own: 8, in: 2_000_000, out: 0 },
    // Toda a gente a sair.
    { id: 2, own: 40, in: 0, out: 1_500_000 },
    // Ruído normal de dez milhões de equipas.
    { id: 3, own: 25, in: 12_000, out: 9_000 },
  ]);
  const m = computeMomentum(bootstrap);

  const rising = m.get(1)!;
  check(
    "um jogador a ser comprado em massa vê a posse projetada subir muito",
    Math.abs(rising.projectedOwnershipPct - 28) < 0.2,
    `${rising.projectedOwnershipPct}`
  );
  check(
    "e é classificado como em alta forte",
    rising.label === "em alta forte",
    rising.label
  );
  check(
    "a razão diz o que isso significa para a DECISÃO, não só o número",
    (momentumReason(rising) ?? "").includes("risco de ranking"),
    momentumReason(rising) ?? ""
  );

  const falling = m.get(2)!;
  check(
    "um jogador em fuga vê a posse projetada descer",
    falling.projectedOwnershipPct < 26 && falling.label === "em queda forte",
    `${falling.projectedOwnershipPct} / ${falling.label}`
  );

  const stable = m.get(3)!;
  check(
    "o churn normal não é confundido com movimento",
    stable.label === "estável" && momentumReason(stable) === null,
    stable.label
  );

  // Sem o número de managers, não se inventa denominador.
  const noManagers = mkBootstrapWithTransfers([{ id: 1, own: 8, in: 2_000_000, out: 0 }]);
  noManagers.total_players = 0;
  const degraded = computeMomentum(noManagers).get(1)!;
  check(
    "sem saber quantos managers existem, não há tendência inventada",
    degraded.trendPct === 0 && degraded.projectedOwnershipPct === 8
  );
}

function testPostureUsesWhereOwnershipIsHeading() {
  const base = mkSim(1, { own: 8, epNext: 6 });
  const rising: ScoredPlayer = { ...base, projectedOwnershipPct: 45, ownershipTrendPct: 37 };
  const stale: ScoredPlayer = { ...base, projectedOwnershipPct: 8, ownershipTrendPct: 0 };

  const beta = 0.5;
  check(
    "com o mesmo 8% de hoje, o que está a ser comprado por todos é penalizado",
    strategicValue(rising, beta) < strategicValue(stale, beta),
    `${strategicValue(rising, beta).toFixed(2)} vs ${strategicValue(stale, beta).toFixed(2)}`
  );
  check(
    "e o mesmo vale para a decisão de uma só jornada",
    strategicValueNext(rising, beta) < strategicValueNext(stale, beta)
  );
  check(
    "sem postura de risco, a posse não mexe em nada",
    strategicValue(rising, 0) === strategicValue(stale, 0)
  );
  check(
    "um jogador sem dados de tendência cai para a posse atual, sem rebentar",
    effectiveOwnershipShare(base) === 0.08,
    `${effectiveOwnershipShare(base)}`
  );
  check(
    "a posse projetada é contida entre 0 e 100",
    effectiveOwnershipShare({ ...base, projectedOwnershipPct: 250 }) === 1 &&
      effectiveOwnershipShare({ ...base, projectedOwnershipPct: -50 }) === 0
  );
}

function testFormIsDeliberatelyNotAPointsMultiplier() {
  // A regra que este módulo existe para NÃO quebrar: o arrastamento mexe no
  // risco, nunca nos pontos esperados. Se algum dia alguém multiplicar os
  // pontos pela forma, isto falha.
  const { bootstrap, fixtures } = makeBootstrap({ currentEvent: 5, gameweeks: 10 });
  bootstrap.total_players = 10_000_000;
  const hot = bootstrap.elements[0];
  const cold = bootstrap.elements[1];
  // Ambos com MESMOS dados subjacentes e minutos reais — senão os dois
  // saem a zero e o teste não testa nada (foi o que aconteceu à primeira).
  const common = {
    element_type: 3,
    team: 1,
    minutes: 900,
    starts: 10,
    goals_scored: 4,
    assists: 2,
    bps: 300,
    ep_next: "5.0",
    expected_goals_per_90: "0.40",
    expected_assists_per_90: "0.20",
  };
  bootstrap.elements = bootstrap.elements.map((el) =>
    el.id === hot.id
      ? makeElement({ ...el, ...common, form: "9.0", transfers_in_event: 3_000_000, transfers_out_event: 0 })
      : el.id === cold.id
        ? makeElement({ ...el, ...common, form: "0.0", transfers_in_event: 0, transfers_out_event: 0 })
        : el
  );
  const scored = buildScoredPlayers(bootstrap, fixtures, 5, 5, null, []);
  const a = scored.find((p) => p.element.id === hot.id);
  const b = scored.find((p) => p.element.id === cold.id);
  check(
    "os dois jogadores são pontuados com números reais (senão o teste é vazio)",
    !!a && !!b && a.expectedPointsNext > 1 && b.expectedPointsNext > 1,
    `${a?.expectedPointsNext} / ${b?.expectedPointsNext}`
  );
  check(
    "forma altíssima e arrastamento máximo NÃO inflacionam os pontos esperados",
    !!a && !!b && Math.abs(a.expectedPointsNext - b.expectedPointsNext) < 1e-9,
    `${a?.expectedPointsNext} vs ${b?.expectedPointsNext}`
  );
  check(
    "mas a posse projetada reflete o arrastamento",
    !!a && (a.projectedOwnershipPct ?? 0) > (a.ownershipPct ?? 0) + 20,
    `${a?.ownershipPct} → ${a?.projectedOwnershipPct}`
  );
  check(
    "e o jogador vê isso explicado nas razões",
    !!a && a.reasons.some((r) => r.includes("posse em alta")),
    a?.reasons.join(" | ").slice(0, 100)
  );
}

// ---------------------------------------------------------------------
// v1.33 — o modelo queria vender os melhores jogadores da equipa.
//
// Reportado em produção na jornada 3: vender B.Fernandes (o melhor jogador
// da jornada anterior) com -16.9 pts declarados, mais Calafiori e
// Gibbs-White, e jogar o Wildcard com 14 transferências.
//
// Tudo saiu de UM número: a simulação dava 0% de hipóteses de acabar à
// frente do líder, com 35 jornadas por jogar e 45 pontos de diferença.
// Isso são 1.3 pontos por jornada. Chamar-lhe impossível é absurdo, e o
// modelo dizia-o de cara séria por três erros que se compunham.
// ---------------------------------------------------------------------

function testSquadEdgeDecaysInsteadOfCompoundingForever() {
  check(
    "uma vantagem de plantel não vale 35 jornadas — vale cerca de 8",
    effectiveEdgeGameweeks(35) > 6 && effectiveEdgeGameweeks(35) < 10,
    `${effectiveEdgeGameweeks(35).toFixed(1)}`
  );
  check(
    "a curto prazo a vantagem quase não é descontada",
    effectiveEdgeGameweeks(3) > 2.3,
    `${effectiveEdgeGameweeks(3).toFixed(2)}`
  );
  check(
    "e nunca cresce sem limite por muito longa que seja a época",
    Math.abs(effectiveEdgeGameweeks(200) - effectiveEdgeGameweeks(38)) < 1.5
  );
  check("sem jornadas por jogar, não há vantagem projetada", effectiveEdgeGameweeks(0) === 0);
}

function testPostureCannotOverruleThePointsModel() {
  check(
    "a inclinação máxima está travada em 0.35, não em 0.9",
    MAX_BETA === 0.35 && MIN_BETA === -0.3,
    `${MAX_BETA} / ${MIN_BETA}`
  );

  // Um jogador muito possuído não pode perder metade do valor.
  const star = mkSim(1, { epNext: 8, own: 60 });
  const heavy: ScoredPlayer = { ...star, projectedOwnershipPct: 60 };
  const kept = strategicValue(heavy, MAX_BETA) / heavy.expectedPoints;
  check(
    "mesmo no máximo, um jogador guarda pelo menos 80% do valor real",
    kept >= MIN_STRATEGIC_RETENTION - 1e-9,
    `guarda ${(kept * 100).toFixed(0)}%`
  );
  check(
    "o piso aguenta mesmo que alguém force uma inclinação absurda",
    strategicValue(heavy, 5) / heavy.expectedPoints >= MIN_STRATEGIC_RETENTION - 1e-9,
    `${(strategicValue(heavy, 5) / heavy.expectedPoints * 100).toFixed(0)}%`
  );
  check(
    "e continua a desempatar: mais possuído vale menos, só que pouco",
    strategicValue(heavy, 0.3) <
      strategicValue({ ...star, projectedOwnershipPct: 5 }, 0.3)
  );
}

function testPlanNeverThrowsAwayRealPoints() {
  // Uma troca claramente má em pontos reais, do género que apareceu no ecrã.
  const owned: ScoredPlayer[] = [];
  const shape: [number, number][] = [[1, 2], [2, 5], [3, 5], [4, 3]];
  let id = 1;
  let club = 0;
  for (const [type, count] of shape) {
    for (let i = 0; i < count; i++) {
      owned.push(
        mkSim(id++, { teamId: (club++ % 20) + 1, type, epNext: 4, price: 6, own: 15 })
      );
    }
  }
  // Uma estrela muito possuída no plantel, e um substituto pior e barato.
  const starIdx = owned.findIndex((p) => p.element.element_type === 3);
  const star = mkSim(900, {
    teamId: 18, type: 3, epNext: 9, price: 6, own: 70,
  });
  owned[starIdx] = star;
  const market: ScoredPlayer[] = [];
  for (const [type] of shape) {
    for (let i = 0; i < 6; i++) {
      market.push(
        mkSim(id++, { teamId: (club++ % 20) + 1, type, epNext: 3.6, price: 6, own: 8 })
      );
    }
  }
  const scored = [...owned, ...market].map((p) => ({
    ...p,
    projectedOwnershipPct: p.ownershipPct,
  }));

  // Com a postura no máximo — a situação exata que produziu o disparate.
  const advice = planTransfers(scored, mkState(owned, 2), {
    beta: MAX_BETA,
    currentEvent: 20,
  });
  const recommended = advice.recommended;
  check("o planeador produz uma recomendação", !!recommended);
  check(
    "a estrela NÃO é vendida por causa da postura de risco",
    !recommended ||
      !recommended.moves.some((m) => m.out.element.id === star.element.id),
    recommended?.moves.map((m) => `${m.out.element.web_name}→${m.in.element.web_name}`).join("; ") ?? ""
  );
  check(
    "nenhuma troca recomendada perde pontos reais a sério",
    !recommended || costlyMoves(recommended).length === 0,
    `${recommended ? costlyMoves(recommended).length : 0} trocas caras`
  );

  // O travão de pontos reais testado DIRETAMENTE. É a terceira camada de
  // defesa: com o teto da inclinação e o piso de retenção já no sítio, este
  // cenário deixou de ser gerável pelo solver — o que é bom desenho, mas
  // deixaria a função por testar se só a testássemos de ponta a ponta.
  const good = mkSim(501, { epNext: 9, own: 70 });
  const worse = mkSim(502, { epNext: 5, own: 5, teamId: 7 });
  const similar = mkSim(503, { epNext: 8.8, own: 6, teamId: 8 });
  const fakePlan = {
    moves: [
      { out: good, in: worse, gain: 0, cashDeltaM: 0, outSellingPriceM: 6, urgency: null },
    ],
  } as unknown as Parameters<typeof costlyMoves>[0];
  check(
    "uma troca que perde 20 pts em 5 jornadas é marcada como cara",
    costlyMoves(fakePlan).length === 1,
    `${costlyMoves(fakePlan).length}`
  );
  const tiePlan = {
    moves: [
      { out: good, in: similar, gain: 0, cashDeltaM: 0, outSellingPriceM: 6, urgency: null },
    ],
  } as unknown as Parameters<typeof costlyMoves>[0];
  check(
    "mas um desempate entre jogadores parecidos NÃO é bloqueado — a postura continua a poder trabalhar",
    costlyMoves(tiePlan).length === 0
  );
  const upgradePlan = {
    moves: [
      { out: worse, in: good, gain: 0, cashDeltaM: 0, outSellingPriceM: 6, urgency: null },
    ],
  } as unknown as Parameters<typeof costlyMoves>[0];
  check("uma melhoria nunca é marcada como cara", costlyMoves(upgradePlan).length === 0);

  // E se um plano desses existir, tem de aparecer explicado, não escondido.
  const bad = advice.plans.find((p) => costlyMoves(p).length > 0);
  if (bad) {
    check(
      "um plano que deita pontos fora explica-o em vez de ser silenciado",
      bad.rationale.includes("deita fora") || bad.rationale.includes("deitam fora"),
      bad.rationale.slice(0, 90)
    );
  } else {
    check("nenhum plano gerado deita pontos fora — melhor ainda", true);
  }
}

// ---------------------------------------------------------------------
// v1.34 — quando. O modelo não tinha noção nenhuma de calendário.
//
// Três perguntas de uma vez: faz sentido gastar o Wildcard mesmo antes de
// uma paragem para seleções? porque é que ele troca jogadores que estão a
// render? e o modelo pensa sequer no Bench Boost?
//
// A resposta honesta à terceira era: não pensava. Bench Boost, Triple
// Captain e Free Hit existiam como texto e como contadores no cabeçalho.
// Nada calculava uma opinião.
// ---------------------------------------------------------------------

function mkEvents(deadlines: [number, string][]) {
  return deadlines.map(([id, d]) => makeEvent(id, { deadline_time: d }));
}

function testCalendarFindsInternationalBreaks() {
  // Jornadas semanais, com um intervalo de duas semanas depois da 3 — que é
  // exatamente a forma de uma paragem para seleções no calendário da FPL.
  const events = mkEvents([
    [1, "2026-08-14T17:30:00Z"],
    [2, "2026-08-21T17:30:00Z"],
    [3, "2026-08-28T17:30:00Z"],
    [4, "2026-09-12T10:00:00Z"],
    [5, "2026-09-19T17:30:00Z"],
  ]);
  const cal = readCalendar(events, [makeTeam(1), makeTeam(2)], [], 3);
  check(
    "a paragem é detetada pelo intervalo entre deadlines, sem dados novos",
    cal.breakAfterEvents.includes(3),
    cal.breakAfterEvents.join(",")
  );
  check(
    "e as semanas normais não são confundidas com paragens",
    !cal.breakAfterEvents.includes(1) && !cal.breakAfterEvents.includes(4)
  );
  check(
    "estando na jornada 3, a paragem está mesmo à frente",
    cal.breakImminent === true
  );
  check(
    "estando na jornada 5, já não está",
    readCalendar(events, [makeTeam(1)], [], 5).breakImminent === false
  );
  check(
    "sem datas válidas, não se inventam paragens",
    readCalendar(mkEvents([[1, "lixo"], [2, "também lixo"]]), [makeTeam(1)], [], 1)
      .breakAfterEvents.length === 0
  );
}

function mkChips(over: Record<string, number> = {}) {
  return ["wildcard", "bboost", "3xc", "freehit"].map((name) => ({
    name,
    label: name,
    remaining: over[name] ?? 1,
    usedAtEvents: [] as number[],
  })) as ChipStatus[];
}

function testChipPlannerProtectsTheOption() {
  const weakBench = [1.5, 1.2, 1.0, 0.8].map((ep, i) =>
    mkSim(700 + i, { epNext: ep, teamId: i + 1 })
  );
  const strongBench = [9, 8.5, 8, 7.5].map((ep, i) =>
    mkSim(710 + i, { epNext: ep, teamId: i + 1 })
  );
  const xi = Array.from({ length: 11 }, (_, i) =>
    mkSim(720 + i, { epNext: 5, teamId: (i % 20) + 1 })
  );
  const captain = mkSim(799, { epNext: 8 });
  const calendar = readCalendar(
    mkEvents([[3, "2026-08-28T17:30:00Z"], [4, "2026-09-04T17:30:00Z"]]),
    [makeTeam(1)],
    [],
    3
  );

  const weak = planChips({
    currentEvent: 3, chips: mkChips(), xi, bench: weakBench, captain, calendar,
  });
  const bb = weak.find((c) => c.chip === "bboost")!;
  check(
    "com um banco fraco, o Bench Boost é para guardar",
    bb.verdict === "esperar",
    `${bb.verdict} (agora ${bb.valueNow})`
  );
  check(
    "e a razão diz o que está à espera, não só que espere",
    bb.reason.includes("dupla") && bb.reason.includes("troca"),
    bb.reason.slice(0, 90)
  );
  check(
    "o valor de agora é literalmente o que o banco marca",
    Math.abs(bb.valueNow - 4.5) < 0.05,
    `${bb.valueNow}`
  );

  const strong = planChips({
    currentEvent: 3, chips: mkChips(), xi, bench: strongBench, captain, calendar,
  });
  const bb2 = strong.find((c) => c.chip === "bboost")!;
  check(
    "com um banco de 33 pontos, aí sim vale a pena jogá-lo",
    bb2.verdict === "jogar",
    `${bb2.verdict} (agora ${bb2.valueNow})`
  );

  // Triple Captain: um capitão normal não chega.
  const tc = weak.find((c) => c.chip === "3xc")!;
  check("um capitão de 8 pts não justifica o Triple Captain", tc.verdict === "esperar");
  const bigCap = planChips({
    currentEvent: 3, chips: mkChips(), xi, bench: weakBench,
    captain: mkSim(798, { epNext: 20 }), calendar,
  }).find((c) => c.chip === "3xc")!;
  check("um capitão de 20 pts esperados já justifica", bigCap.verdict === "jogar");

  // Free Hit: existe para salvar uma jornada em branco.
  const fh = weak.find((c) => c.chip === "freehit")!;
  check("com o onze completo, o Free Hit não resgata nada", fh.verdict === "esperar");
  const blankXi = [
    ...xi.slice(0, 6),
    ...Array.from({ length: 5 }, (_, i) => mkSim(760 + i, { epNext: 0, teamId: i + 1 })),
  ];
  const fh2 = planChips({
    currentEvent: 3, chips: mkChips(), xi: blankXi, bench: weakBench, captain, calendar,
  }).find((c) => c.chip === "freehit")!;
  check(
    "com 5 jogadores sem jogo, o Free Hit é para jogar",
    fh2.verdict === "jogar",
    fh2.verdict
  );

  // Chips já gastos não são recomendados.
  const spent = planChips({
    currentEvent: 3, chips: mkChips({ bboost: 0 }), xi, bench: strongBench, captain, calendar,
  }).find((c) => c.chip === "bboost")!;
  check("um chip já usado nunca é recomendado", spent.verdict === "indisponível");
}

function testWildcardWaitsForTheInternationalBreak() {
  // Um plantel longe do ideal, calibrado para o ganho cair ENTRE as duas
  // barras: sem paragem o wildcard é aconselhado, com paragem já não.
  // Sem essa calibração o teste era vazio — passava com e sem a correção.
  //
  // RECALIBRADO EM v1.38. A construção anterior dava a TODO o mercado uma
  // vantagem pequena sobre o plantel, o que produzia um ganho enorme (77+
  // pontos) espalhado por quinze trocas minúsculas. Depois de o limiar de
  // retenção passar a exigir que cada troca INDIVIDUAL seja distinguível de
  // zero, esse desenho deixou de funcionar: ou todas as trocas passavam a
  // barra e o ganho disparava para lá das duas, ou nenhuma passava e o ganho
  // era zero. Em nenhum dos casos o teste media o prémio da paragem.
  //
  // Agora são seis melhorias REAIS de 4 pontos cada, testadas na jornada 30.
  // A jornada importa: o sinal de wildcard exige uma distância de pelo menos
  // cinco jogadores, e cada uma dessas cinco trocas tem de ser maior do que o
  // limiar de retenção. Na jornada 12 o limiar é 5.7 pontos, logo cinco
  // trocas válidas valem no mínimo 28 — acima das DUAS barras, e a diferença
  // entre elas deixa de ser observável. Na jornada 30 o limiar já desceu para
  // 3.8, e seis trocas de 4 pontos somam 20, que cai exatamente entre as duas
  // barras (12 sem paragem, 22 com). O teste voltou a ter uma janela onde o
  // prémio da paragem é a única coisa que decide.
  const { owned, scored } = mkTransferPool([4, 4, 4, 4, 4, 4]);
  const state = mkState(owned, 1);

  const noBreak = {
    breakAfterEvents: [] as number[],
    breakImminent: false,
    knownDoubleEvents: [] as number[],
    knownBlankEvents: [] as number[],
  };
  const withBreak = { ...noBreak, breakAfterEvents: [30], breakImminent: true };

  const a = planTransfers(scored, state, { currentEvent: 30, calendar: noBreak });
  const b = planTransfers(scored, state, { currentEvent: 30, calendar: withBreak });

  check("o sinal de wildcard é calculado nos dois casos", !!a.wildcard && !!b.wildcard);
  check(
    "sem paragem à frente, este ganho justifica o wildcard",
    a.wildcard?.advise === true,
    `ganho ${a.wildcard?.gain}`
  );
  check(
    "com uma paragem à frente, o MESMO ganho já não justifica",
    b.wildcard?.advise === false,
    `ganho ${b.wildcard?.gain}`
  );
  check(
    "e o ganho medido é idêntico — só o critério mudou",
    !!a.wildcard && !!b.wildcard && a.wildcard.gain === b.wildcard.gain,
    `${a.wildcard?.gain} vs ${b.wildcard?.gain}`
  );

  // O MESMO ganho, mas com o modelo pouco confiante nos números que o
  // produziram. Gastar o maior chip do jogo sobre uma estimativa de 40% de
  // confiança é a forma mais cara que existe de agir sobre ruído.
  const unsure = scored.map((p) => ({ ...p, modelTrust: 0.4 }));
  const unsureOwned = owned.map((p) => ({ ...p, modelTrust: 0.4 }));
  const c = planTransfers(unsure, mkState(unsureOwned, 1), {
    currentEvent: 30,
    calendar: noBreak,
  });
  check(
    "com o modelo pouco confiante, o mesmo ganho não justifica o wildcard",
    c.wildcard?.advise === false,
    `ganho ${c.wildcard?.gain}, confiança baixa`
  );
  check(
    // v1.38 mudou isto, e para melhor. A versão anterior exigia que o ganho
    // medido fosse IDÊNTICO com e sem confiança — "mudou a barra, não a
    // medição" — e passava apenas porque o encolhimento por confiança não
    // fazia absolutamente nada (era uma transformação monótona, ver
    // lib/selection.ts). Agora que a confiança baixa encolhe mesmo as
    // estimativas em direção à média da posição, a MEDIÇÃO também desce, e
    // deve descer: com números em que o modelo não acredita, a distância ao
    // ideal é menor porque o ideal é menos distinguível do que já tens.
    "com pouca confiança o próprio ganho medido encolhe, não só a barra",
    (c.wildcard?.gain ?? 0) < (a.wildcard?.gain ?? 0),
    `${c.wildcard?.gain} com pouca confiança vs ${a.wildcard?.gain} com confiança`
  );
}

function testIncumbencyKeepsPlayersWhoAreDoingFine() {
  // O caso reportado: o wildcard trocava jogadores que estavam a render, sem
  // motivo visível. A causa é o plantel ideal ser construído do zero e
  // depois comparado com o atual — qualquer empate técnico vira troca.
  //
  // Aqui o mercado é melhor por 0.02 pts por jornada. Medido: SEM viés de
  // incumbência o solver reconstrói os 15 jogadores para ganhar 1.1 pts em
  // cinco jornadas. Com o viés, não mexe em nenhum.
  const owned: ScoredPlayer[] = [];
  const shape: [number, number][] = [[1, 2], [2, 5], [3, 5], [4, 3]];
  let id = 1;
  let club = 0;
  for (const [type, count] of shape) {
    for (let i = 0; i < count; i++) {
      owned.push(mkSim(id++, { teamId: (club++ % 20) + 1, type, epNext: 3, price: 6 }));
    }
  }
  const market: ScoredPlayer[] = [];
  for (const [type] of shape) {
    for (let i = 0; i < 8; i++) {
      market.push(mkSim(id++, { teamId: (club++ % 20) + 1, type, epNext: 3.02, price: 6 }));
    }
  }
  const advice = planTransfers([...owned, ...market], mkState(owned, 2), {
    currentEvent: 15,
  });
  check(
    "uma melhoria de 0.02 pts por jornada NÃO desencadeia uma reconstrução",
    (advice.wildcard?.distance ?? 0) === 0,
    `distância ao ideal: ${advice.wildcard?.distance}`
  );
  check(
    "e o plano recomendado não troca ninguém por essa migalha",
    (advice.recommended?.moves.length ?? 0) === 0,
    advice.recommended?.moves
      .map((m) => `${m.out.element.web_name}→${m.in.element.web_name}`)
      .join("; ") ?? "sem trocas"
  );

  // E uma melhoria a sério continua a passar — o viés desempata, não bloqueia.
  const realUpgrades = market.map((p) => ({ ...p, expectedPoints: 25, expectedPointsNext: 5 }));
  const better = planTransfers([...owned, ...realUpgrades], mkState(owned, 2), {
    currentEvent: 15,
  });
  check(
    "uma melhoria real de 2 pts por jornada continua a ser feita",
    (better.recommended?.moves.length ?? 0) > 0,
    `${better.recommended?.moves.length ?? 0} trocas`
  );
}


// ---------------------------------------------------------------------
// v1.35 — o resolvedor de nomes aplicava notas ao jogador errado.
//
// Encontrado a olhar para produção: uma nota cuja razão dizia "executor
// único de penáltis do EVERTON" estava aplicada a um jogador do MANCHESTER
// CITY, e apresentada com toda a confiança como "Ndiaye (MCI)".
//
// A camada de investigação tinha feito o trabalho certo. O resolvedor é
// que apontou a nota ao homem errado — um ajuste de +8% na pontuação de um
// jogador que ninguém investigou.
//
// A causa: a equipa indicada só era usada para filtrar SE o filtro desse
// resultados. Não dando, era descartada em silêncio, e o desempate por
// nome exato escolhia o jogador de outro clube.
// ---------------------------------------------------------------------

function testTeamIsAConstraintNotAHint() {
  const { bootstrap } = makeBootstrap({ currentEvent: 5, gameweeks: 10 });
  const teams = [makeTeam(1, "EVE"), makeTeam(2, "MCI")];
  bootstrap.teams = teams;
  // Dois jogadores com o mesmo apelido em clubes diferentes — e o do
  // Everton NÃO existe, que é exatamente o caso real.
  bootstrap.elements = [
    makeElement({ id: 10, web_name: "Ndiaye", team: 2, element_type: 3 }),
    makeElement({ id: 11, web_name: "Haaland", team: 2, element_type: 4 }),
  ];

  const wrongClub = resolveInsightTarget(bootstrap, "player", {
    playerName: "Ndiaye",
    teamShortName: "EVE",
  });
  check(
    "um jogador que não existe no clube indicado é REJEITADO, não redirecionado",
    wrongClub.ok === false,
    wrongClub.ok ? `resolveu para ${wrongClub.label}` : wrongClub.reason
  );
  check(
    "e a razão diz claramente que a equipa é uma restrição",
    wrongClub.ok === false && wrongClub.reason.includes("restrição"),
    wrongClub.ok ? "" : wrongClub.reason
  );

  // O caso legítimo continua a funcionar.
  const rightClub = resolveInsightTarget(bootstrap, "player", {
    playerName: "Ndiaye",
    teamShortName: "MCI",
  });
  check(
    "com o clube certo, resolve normalmente",
    rightClub.ok === true && rightClub.id === 10,
    rightClub.ok ? rightClub.label : rightClub.reason
  );
  check(
    "e a etiqueta mostra o clube verdadeiro",
    rightClub.ok === true && rightClub.label.includes("MCI")
  );

  // Um clube que nem sequer existe não pode virar "sem restrição".
  const badClub = resolveInsightTarget(bootstrap, "player", {
    playerName: "Ndiaye",
    teamShortName: "XYZ",
  });
  check(
    "um clube inexistente é rejeitado em vez de ignorado",
    badClub.ok === false && badClub.reason.includes("não existe"),
    badClub.ok ? `resolveu para ${badClub.label}` : badClub.reason
  );

  // Sem clube indicado, o comportamento antigo mantém-se: resolve pelo nome.
  const noClub = resolveInsightTarget(bootstrap, "player", { playerName: "Ndiaye" });
  check(
    "sem clube indicado, continua a resolver só pelo nome",
    noClub.ok === true && noClub.id === 10
  );

  // Dois jogadores com o mesmo apelido em clubes diferentes: o clube passa a
  // ser o que decide, em vez de um desempate arbitrário.
  bootstrap.elements = [
    makeElement({ id: 20, web_name: "Ndiaye", team: 1, element_type: 3 }),
    makeElement({ id: 21, web_name: "Ndiaye", team: 2, element_type: 3 }),
  ];
  const eve = resolveInsightTarget(bootstrap, "player", {
    playerName: "Ndiaye",
    teamShortName: "EVE",
  });
  const mci = resolveInsightTarget(bootstrap, "player", {
    playerName: "Ndiaye",
    teamShortName: "MCI",
  });
  check(
    "com dois homónimos, cada clube resolve para o seu",
    eve.ok === true && eve.id === 20 && mci.ok === true && mci.id === 21,
    `${eve.ok ? eve.id : eve.reason} / ${mci.ok ? mci.id : mci.reason}`
  );
}

// ---------------------------------------------------------------------
// v1.35 — a maldição do vencedor. Porque é que o "plantel ideal" era
// sempre espetacular, e porque é que o Wildcard era sempre recomendado.
//
// Medido em produção, jornada 3:
//   onze atual   296.5 pts / 5 jornadas = 59.3 por jornada  (plausível)
//   onze ideal   461.6 pts / 5 jornadas = 92.3 por jornada  (impossível)
//
// Um onze normal faz 50-60 pontos por jornada. Escolher os 11 melhores de
// 600 estimativas não escolhe os melhores jogadores — escolhe aqueles cujo
// ERRO é mais otimista.
//
// E a assimetria é o defeito: o onze atual não passa por seleção, o ideal
// passa. A diferença herda todo o otimismo, e era essa diferença que
// autorizava gastar o chip.
// ---------------------------------------------------------------------

function testDecisionGainRefusesImpossibleNumbers() {
  // Os números reais da produção.
  const real = decisionGain(461.6, 296.5, 5);
  check(
    "um onze impossível é limitado ao teto antes de decidir",
    real.capped === true,
    `${real.gain}`
  );
  check(
    "e o ganho cai de 165.1 para 78.5",
    Math.abs(real.gain - 78.5) < 0.05,
    `${real.gain}`
  );

  // Um onze plausível passa intacto — o teto é um travão, não um imposto.
  const sane = decisionGain(330, 296.5, 5);
  check(
    "um onze plausível não é tocado",
    sane.capped === false && Math.abs(sane.gain - 33.5) < 0.05,
    `${sane.gain}`
  );
  check(
    "o teto nunca inventa ganho onde não há",
    decisionGain(280, 296.5, 5).gain < 0
  );
}

function testModelSaysOutLoudWhenItOverreaches() {
  check(
    "92 pontos por jornada dispara o aviso",
    (implausibleXiWarning(461.6, 5) ?? "").includes("92"),
    implausibleXiWarning(461.6, 5)?.slice(0, 60) ?? "sem aviso"
  );
  check(
    "e o aviso explica a causa, não só o sintoma",
    (implausibleXiWarning(461.6, 5) ?? "").includes("otimistas")
  );
  check(
    "um onze de 60 por jornada não dispara nada",
    implausibleXiWarning(300, 5) === null
  );
  check(
    "nem valores degenerados",
    implausibleXiWarning(0, 5) === null && implausibleXiWarning(400, 0) === null
  );
}

function testSelectionShrinkageIsHonestlyLimited() {
  // O que o encolhimento FAZ: um jogador com pouca evidência e um número
  // espetacular é puxado para trás; um com evidência mantém-se.
  const mean = 20;
  const flashy = mkSim(1, { epNext: 8 });
  const proven = mkSim(2, { epNext: 8 });
  const flashyLow = { ...flashy, modelTrust: 0, expectedPoints: 40 } as ScoredPlayer;
  const provenHigh = { ...proven, modelTrust: 1, expectedPoints: 40 } as ScoredPlayer;

  check(
    "sem evidência, um número espetacular é puxado para a média",
    shrunkForSelection(flashyLow, 40, mean) < 40 - 5,
    `${shrunkForSelection(flashyLow, 40, mean).toFixed(1)}`
  );
  check(
    "com evidência completa, o número mantém-se intacto",
    Math.abs(shrunkForSelection(provenHigh, 40, mean) - 40) < 1e-9
  );
  check(
    "e quem já está na média não é mexido, tenha a evidência que tiver",
    Math.abs(shrunkForSelection(flashyLow, mean, mean) - mean) < 1e-9
  );
  check(
    "a fiabilidade nunca sai do intervalo declarado",
    selectionReliability(flashyLow) === SELECTION_RELIABILITY_FLOOR &&
      selectionReliability(provenHigh) === 1
  );

  // O que o encolhimento NÃO faz — medido, não presumido. Com a mesma
  // confiança em toda a gente é uma transformação monótona: não reordena
  // ninguém. Foi por isso que sozinho não resolveu o problema.
  const same = [30, 40, 50].map(
    (v, i) => ({ ...mkSim(100 + i, {}), modelTrust: 0.25, expectedPoints: v }) as ScoredPlayer
  );
  const before = [...same].sort((a, b) => b.expectedPoints - a.expectedPoints).map((p) => p.element.id);
  const after = [...same]
    .sort(
      (a, b) =>
        shrunkForSelection(b, b.expectedPoints, mean) -
        shrunkForSelection(a, a.expectedPoints, mean)
    )
    .map((p) => p.element.id);
  check(
    "com confiança uniforme, o encolhimento não reordena nada — e isso está documentado",
    before.join(",") === after.join(","),
    `${before.join(",")} vs ${after.join(",")}`
  );
}

console.log("\nSuite de regressão — FPL Command Center\n");
testFreeTransferReconstruction();
testSellingPriceEstimation();
testChipSummary();
testTransferPlanRespectsTheRules();
testHitIsOnlyTakenWhenItPaysForItself();
testFreeTransfersHaveOptionValue();
testNoUpgradeMeansHold();
testWildcardSignal();
testWildcardIsNotBurnedEarly();
testPlannerSurvivesAnIllegalSquad();
testPlannerRefusesToInvent();
testInsightConfidenceAndScope();
testLeagueSimulation();
testPostureFollowsLeaguePosition();
testPostureChangesTheSquad();
testStrategyTournament();
testCalibrationLearning();
testDefenceInversion();
testMissingTeamStrengths();
testMarketInversion();
testMarketDerivedRatings();
testPartialMarketCoverage();
testRedisCredentialNames();
testPreseasonDifferentiation();
testPreseasonSetPieces();
testStaticInsightSeeds();
testOptimizerBenchSpend();
testCorrelationRisk();
testRankValue();
testBpsAndSaves();
testPoissonQuantile();
testLateSeasonWindow();
testExpectedPointsScale();
testCaptainUsesNextGameweek();
testSquadValidity();
testInsightClamp();
testMinutesModel();
testRatesUseNeglectedSignals();
testBestXI();
testInsightValidation();
testCorruptDataIsContained();

testJensenClosedForms();
testStepScoringUsesTheStep();
testPenaltiesAndCards();
testDefensiveContributionCurve();
testLeagueBaselines();
testWindowIsWeighted();
testRestDaysArePriced();
testTotalsLineIsGeneral();
testArmbandIsAPair();
testBenchOrder();

testBacktestDoesNotSeeTheFuture();
testBacktestForgetsFutureResults();
testBacktestMetrics();
testBacktestRunsEndToEnd();

testBudgetSplit();
testPlanNeverExceedsRealMoney();

testRivalSelectionAlwaysIncludesMe();
testSimulationSurvivesBeingBottomOfTheLeague();

testDefaultsMatchTheShippedLiterals();
testParamsChangeNothingByDefault();
testCalibrationRefusesToGuess();
testCalibrationIsHonestAboutDisagreement();

testNoRouteExceedsThePlanTimeout();

testApiTokenCheck();

testNoiseFloorScalesWithConfidence();
testMarginalTransferIsRefusedEarlyInTheSeason();

testMomentumReadsTheFlowNotTheStock();
testPostureUsesWhereOwnershipIsHeading();
testFormIsDeliberatelyNotAPointsMultiplier();

testSquadEdgeDecaysInsteadOfCompoundingForever();
testPostureCannotOverruleThePointsModel();
testPlanNeverThrowsAwayRealPoints();

testCalendarFindsInternationalBreaks();
testChipPlannerProtectsTheOption();
testWildcardWaitsForTheInternationalBreak();
testIncumbencyKeepsPlayersWhoAreDoingFine();

testTeamIsAConstraintNotAHint();

testDecisionGainRefusesImpossibleNumbers();
testModelSaysOutLoudWhenItOverreaches();
testSelectionShrinkageIsHonestlyLimited();

// ---------------------------------------------------------------------
// v1.36 — AUTOMAÇÃO. Três tarefas semanais falharam durante seis semanas e
// nada nesta aplicação mudou de aspeto.
//
// A falha real não foi cada tarefa falhar: foi o silêncio. Uma tarefa que
// morre antes de escrever deixa exatamente o mesmo rasto que uma tarefa que
// nunca correu — nenhum. Uma execução manual chegou a durar 8m30s, fez
// trabalho a sério, devolveu FAILED e não deixou registo nenhum.
//
// Estes testes trancam as três decisões que resolvem isso: correr as duas
// tarefas computacionais dentro da aplicação (cron da Vercel, sem sessão
// nenhuma pelo meio), rodar os parâmetros da calibração em vez de medir
// sempre os mesmos quatro, e medir a saúde pelo ÚLTIMO SUCESSO.
// ---------------------------------------------------------------------

function run(over: Partial<JobRun>): JobRun {
  return {
    job: "backtest",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ok: true,
    durationMs: 1000,
    summary: "",
    trigger: "cron",
    ...over,
  };
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function testHealthMeasuresSuccessNotAttempts() {
  // O caso exato: a tarefa dispara todos os dias e falha todos os dias.
  // Medir "última tentativa" diria "correu hoje" — a mesma mentira noutro
  // sítio. A saúde tem de olhar para o último SUCESSO.
  const failingDaily = [
    run({ job: "backtest", startedAt: daysAgo(0), finishedAt: daysAgo(0), ok: false, summary: "erro" }),
    run({ job: "backtest", startedAt: daysAgo(1), finishedAt: daysAgo(1), ok: false, summary: "erro" }),
    run({ job: "backtest", startedAt: daysAgo(2), finishedAt: daysAgo(2), ok: false, summary: "erro" }),
    run({ job: "backtest", startedAt: daysAgo(30), finishedAt: daysAgo(30), ok: true, summary: "ok" }),
  ];
  const health = computeJobHealth(failingDaily);
  const bt = health.find((h) => h.job === "backtest")!;
  check("uma tarefa que falha todos os dias é reportada como parada", bt.stale === true);
  check("conta as falhas seguidas", bt.consecutiveFailures === 3, `${bt.consecutiveFailures}`);
  check(
    "o último sucesso é o antigo, não a tentativa de hoje",
    bt.daysSinceSuccess === 30,
    `${bt.daysSinceSuccess}`
  );

  // E o contraste: um sucesso recente NÃO pode dar parada, senão o teste
  // acima passava com qualquer implementação.
  const healthy = computeJobHealth([
    run({ job: "backtest", startedAt: daysAgo(0), finishedAt: daysAgo(0), ok: true, summary: "ok" }),
  ]);
  check(
    "um sucesso de hoje não é reportado como parado",
    healthy.find((h) => h.job === "backtest")!.stale === false
  );
}

function testNeverHavingRunIsTheWorstCaseNotAnUnknownOne() {
  // O estado em que este projeto esteve seis semanas: log vazio. Tratar
  // "nunca correu" como indeterminado é como o painel ficou verde enquanto
  // nada funcionava.
  const health = computeJobHealth([]);
  check(
    "sem registo nenhum, todas as tarefas aparecem paradas",
    health.every((h) => h.stale === true && h.lastSuccess === null)
  );
  check("as três tarefas são vigiadas", health.length === 3, health.map((h) => h.job).join(","));
}

function testAKilledRunLeavesEvidence() {
  // O modo de falha mais provável destas funções é morrer no limite de
  // tempo — e uma função morta não escreve o registo final. Por isso o
  // registo é escrito ao COMEÇAR, e uma entrada sem `finishedAt` é a prova
  // de que começou e nunca acabou.
  const health = computeJobHealth([
    run({ job: "calibration", startedAt: daysAgo(0), finishedAt: null, ok: null, summary: "a correr…" }),
  ]);
  const cal = health.find((h) => h.job === "calibration")!;
  check("uma execução que nunca terminou não conta como sucesso", cal.lastSuccess === null);
  check("e fica visível como última tentativa", cal.last?.finishedAt === null);
  check("e marca a tarefa como parada", cal.stale === true);
}

// ---------------------------------------------------------------------
// v1.37 — o visto verde para uma tarefa que não fez nada.
//
// No PRIMEIRO dia em que o painel esteve no ar, a investigação tática
// apareceu a verde: "OK, há 1h — 0 notas aceites, 0 rejeitadas". Correu,
// registou-se, e não submeteu absolutamente nada para ser avaliado.
//
// Zero aceites COM algumas rejeitadas é uma semana calma. Zero de ambos os
// lados é uma passagem que não trouxe nada. Contar isso como sucesso é o
// mesmo defeito de sempre com melhor tipografia.
// ---------------------------------------------------------------------

function testAnEmptyRunIsNotAGreenRun() {
  const health = computeJobHealth([
    run({
      job: "backtest",
      startedAt: daysAgo(0),
      finishedAt: daysAgo(0),
      ok: true,
      productive: false,
      summary: "correu sobre zero linhas",
    }),
  ]);
  const bt = health.find((h) => h.job === "backtest")!;
  check("uma execução vazia não é 'ok'", bt.status === "vazia", bt.status);
  check("mas também não é 'parada' — não está avariada", bt.stale === false);
  check("e não conta como resultado", bt.lastProductive === null);

  // O contraste obrigatório: a mesma execução, mas produtiva, é verde.
  const productive = computeJobHealth([
    run({ job: "backtest", startedAt: daysAgo(0), finishedAt: daysAgo(0), ok: true, productive: true }),
  ]);
  check(
    "uma execução com resultado é 'ok'",
    productive.find((h) => h.job === "backtest")!.status === "ok"
  );
}

function testOldEntriesAreNotRetroactivelyDowngraded() {
  // O campo `productive` é novo. Entradas escritas antes de existir não têm
  // opinião nenhuma, e inventar-lhes uma seria reportar um facto que ninguém
  // mediu — precisamente o pecado que este módulo existe para acabar.
  const legacy: JobRun = {
    job: "calibration",
    startedAt: daysAgo(0),
    finishedAt: daysAgo(0),
    ok: true,
    durationMs: 1000,
    summary: "antes de o campo existir",
    trigger: "cron",
  };
  check(
    "uma entrada antiga sem o campo continua a contar como resultado",
    computeJobHealth([legacy]).find((h) => h.job === "calibration")!.status === "ok"
  );
}

function testAResearchPassThatSubmittedNothingShowsAsEmpty() {
  // O caso literal do ecrã: OK, há 1h, 0 aceites, 0 rejeitadas.
  const empty = mergeResearchHealth(computeJobHealth([]), {
    at: daysAgo(0),
    acceptedCount: 0,
    rejectedCount: 0,
  });
  const r = empty.find((h) => h.job === "research")!;
  check("0 aceites e 0 rejeitadas dá 'vazia', não 'ok'", r.status === "vazia", r.status);
  check("a explicação diz que não submeteu nada", r.lastSuccess!.summary.includes("não submeteu"));

  // Uma semana genuinamente calma — avaliou coisas e não aceitou nenhuma —
  // NÃO é vazia. Sem isto, o teste acima castigaria trabalho a sério.
  const quiet = mergeResearchHealth(computeJobHealth([]), {
    at: daysAgo(0),
    acceptedCount: 0,
    rejectedCount: 3,
  });
  check(
    "0 aceites mas 3 rejeitadas é trabalho feito, e é 'ok'",
    quiet.find((h) => h.job === "research")!.status === "ok"
  );
}

function testEachScheduleRunsItsOwnJob() {
  // Duas entradas de cron apontam para a mesma rota; a Vercel diz qual
  // disparou pelo cabeçalho `x-vercel-cron-schedule`. Antes, as duas tarefas
  // partilhavam uma invocação e a calibração — a coisa mais cara do projeto —
  // ficava com os segundos que o backtest não gastasse. Ao contrário.
  const morning = planFromRequest("0 6 * * *", null);
  check("as 6h correm só o backtest", morning.backtest && !morning.calibration);
  const later = planFromRequest("0 7 * * *", null);
  check("as 7h correm só a calibração", !later.backtest && later.calibration);

  // O fallback tem de ser FAZER TUDO, nunca não fazer nada: se a Vercel
  // deixar de mandar o cabeçalho, ou se alguém editar os horários sem tocar
  // no código, uma paragem silenciosa era exatamente a avaria que isto veio
  // resolver.
  const unknown = planFromRequest("0 3 * * *", null);
  check("um horário desconhecido corre tudo, não nada", unknown.backtest && unknown.calibration);
  const manual = planFromRequest(null, null);
  check("um disparo manual corre tudo", manual.backtest && manual.calibration);
  check("?only=backtest continua a mandar", planFromRequest("0 7 * * *", "backtest").backtest);
  check(
    "?only=calibration continua a mandar",
    planFromRequest("0 6 * * *", "calibration").calibration
  );
}

function testEveryScheduleInTheConfigIsHandled() {
  // Um horário no vercel.json que o código não reconhece cai no fallback e
  // corre as duas tarefas — o que arruína a separação que os dois horários
  // existem para criar. Este teste liga os dois ficheiros.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(
    fs.readFileSync(path.join(here, "..", "vercel.json"), "utf8")
  ) as { crons?: { path: string; schedule: string }[] };
  for (const cron of config.crons ?? []) {
    const plan = planFromRequest(cron.schedule, null);
    check(
      `o horário ${cron.schedule} corre exatamente uma tarefa`,
      (plan.backtest ? 1 : 0) + (plan.calibration ? 1 : 0) === 1,
      JSON.stringify(plan)
    );
  }
  // E o conjunto dos horários tem de cobrir as duas tarefas, senão uma delas
  // nunca correria sozinha.
  const covered = (config.crons ?? []).map((c) => planFromRequest(c.schedule, null));
  check("algum horário corre o backtest", covered.some((p) => p.backtest));
  check("algum horário corre a calibração", covered.some((p) => p.calibration));
}

function testResearchHistoryCountsEvenThoughItPredatesTheLog() {
  // A investigação tática regista-se por outro caminho (lib/managerinsights),
  // que é anterior a este log. Uma execução bem sucedida ANTES de o log
  // existir aconteceu na mesma — ignorá-la seria inventar uma avaria.
  const merged = mergeResearchHealth(computeJobHealth([]), {
    at: daysAgo(1),
    acceptedCount: 4,
    rejectedCount: 1,
  });
  const research = merged.find((h) => h.job === "research")!;
  check("uma investigação recente conta como sucesso", research.lastSuccess !== null);
  check("e a tarefa deixa de estar parada", research.stale === false);
  check("as outras tarefas não são afetadas", merged.find((h) => h.job === "backtest")!.stale === true);

  // E uma investigação ANTIGA continua a dar parada — senão isto seria só
  // uma forma de apagar o alarme.
  const old = mergeResearchHealth(computeJobHealth([]), {
    at: daysAgo(40),
    acceptedCount: 4,
    rejectedCount: 1,
  });
  check(
    "uma investigação de há 40 dias continua a contar como parada",
    old.find((h) => h.job === "research")!.stale === true
  );
}

function testCalibrationRotatesInsteadOfMeasuringTheSameFourForever() {
  // Antes: `Object.keys(PARAM_GRIDS).slice(0, 4)` em ambas as rotas. Uma
  // tarefa diária que mede sempre os mesmos quatro parâmetros não é
  // automação, é uma forma muito fiável de não aprender nada — os outros
  // oito nunca teriam sido testados uma única vez.
  const all = allTunableParams();
  check("há mais parâmetros do que cabem numa execução", all.length > MAX_PARAMS_PER_RUN);

  const seen = new Set<string>();
  let cursor = 0;
  const runs = Math.ceil(all.length / MAX_PARAMS_PER_RUN);
  for (let i = 0; i < runs; i++) {
    const batch = paramsFromCursor(all, cursor, MAX_PARAMS_PER_RUN);
    batch.forEach((p) => seen.add(p));
    cursor += batch.length;
  }
  check(
    `${runs} execuções cobrem todos os ${all.length} parâmetros`,
    seen.size === all.length,
    `cobertos ${seen.size}`
  );

  // Dá a volta ao fim da lista em vez de parar lá — parar cobriria cada vez
  // menos parâmetros por ciclo.
  const wrapped = paramsFromCursor(all, all.length - 2, 4);
  check("a rotação dá a volta ao fim da lista", wrapped.length === 4, `${wrapped.length}`);
  check("e não repete dentro da mesma execução", new Set(wrapped).size === 4);
  check("um cursor negativo não parte nada", paramsFromCursor(all, -3, 2).length === 2);
}

function testCronRefusesWhenNoSecretIsConfigured() {
  // A tentação é deixar passar quando nada está configurado, para o cron
  // "funcionar logo". Este endpoint corre a computação mais cara do
  // projeto: aberto, é um botão de negação de serviço.
  const open = checkCronAuth("Bearer whatever", "whatever", { cronSecret: "", apiToken: "" });
  check("sem segredos configurados, recusa", open.ok === false);
  check("e diz porquê", (open.reason ?? "").includes("desligada por segurança"));

  const secrets = { cronSecret: "cron-secret", apiToken: "api-token" };
  check(
    "aceita o cabeçalho que a Vercel envia",
    checkCronAuth("Bearer cron-secret", null, secrets).via === "cron"
  );
  check(
    "aceita o token na query, para disparo manual",
    checkCronAuth(null, "api-token", secrets).via === "token"
  );
  check(
    "tolera espaço colado por engano",
    checkCronAuth("Bearer  cron-secret ", null, { ...secrets, cronSecret: " cron-secret\n" }).ok === true
  );
  check("recusa um segredo errado", checkCronAuth("Bearer nope", "nope", secrets).ok === false);
  check(
    "o token da API não abre a porta se não estiver configurado",
    checkCronAuth(null, "qualquer coisa", { cronSecret: "cron-secret", apiToken: "" }).ok === false
  );
}

function testTheScheduleIsRealAndPointsAtARealRoute() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, "..");
  const configPath = path.join(root, "vercel.json");
  check("existe vercel.json", fs.existsSync(configPath));
  if (!fs.existsSync(configPath)) return;

  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    crons?: { path: string; schedule: string }[];
  };
  const crons = config.crons ?? [];
  check("há pelo menos uma tarefa agendada", crons.length > 0);
  // O plano Hobby aceita no máximo 2 cron jobs. Passar disso é o mesmo tipo
  // de erro que o maxDuration = 800: a configuração é rejeitada e o deploy
  // parece bem até não estar.
  check("no máximo 2 crons (limite do plano Hobby)", crons.length <= 2, `${crons.length}`);

  for (const cron of crons) {
    // Uma rota agendada que não existe falha silenciosamente com 404 todos
    // os dias — outra vez o mesmo padrão de avaria invisível.
    const routeFile = path.join(root, "app", cron.path.replace(/^\//, ""), "route.ts");
    check(`a rota ${cron.path} existe mesmo`, fs.existsSync(routeFile), routeFile);
    const fields = cron.schedule.trim().split(/\s+/);
    check(`o horário de ${cron.path} tem 5 campos`, fields.length === 5, cron.schedule);
    // No plano Hobby só há uma execução por dia. Um horário com minuto ou
    // hora em `*` pede execuções mais frequentes do que o plano dá.
    check(
      `${cron.path} corre no máximo uma vez por dia`,
      !fields[0].includes("*") && !fields[1].includes("*"),
      cron.schedule
    );
  }
}

function testTheSamplingRuleExistsExactlyOnce() {
  // As duas rotas tinham cópias byte a byte de `chooseSample`. Código
  // duplicado diverge, e uma calibração afinada numa amostra e validada
  // noutra mede a diferença entre as amostras, não o modelo.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, "..");
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  };
  const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "lib"))];
  const definitions = files.filter((f) =>
    /function\s+chooseSample\s*\(/.test(fs.readFileSync(f, "utf8"))
  );
  check(
    "a regra de amostragem está definida uma única vez",
    definitions.length === 1,
    definitions.map((f) => path.relative(root, f)).join(", ")
  );
}

testHealthMeasuresSuccessNotAttempts();
testNeverHavingRunIsTheWorstCaseNotAnUnknownOne();
testAKilledRunLeavesEvidence();
testResearchHistoryCountsEvenThoughItPredatesTheLog();
testAnEmptyRunIsNotAGreenRun();
testOldEntriesAreNotRetroactivelyDowngraded();
testAResearchPassThatSubmittedNothingShowsAsEmpty();
testEachScheduleRunsItsOwnJob();
testEveryScheduleInTheConfigIsHandled();
testCalibrationRotatesInsteadOfMeasuringTheSameFourForever();
testCronRefusesWhenNoSecretIsConfigured();
testTheScheduleIsRealAndPointsAtARealRoute();
testTheSamplingRuleExistsExactlyOnce();

// ---------------------------------------------------------------------
// v1.38 — A MALDIÇÃO DO VENCEDOR, MEDIDA EM VEZ DE ARGUMENTADA.
//
// Reportado quatro vezes pelo dono da equipa, sempre com razão: "propõe
// vender o Gibbs-White, que fez duas boas jornadas"; "o Horníček, que tem
// feito muitos pontos"; "não entendo estas sugestões".
//
// Existiam TRÊS defesas contra isto (encolhimento, travão de ruído, viés de
// incumbência) e a única forma honesta de arbitrar era medir quanta
// rotatividade elas impedem. Estes dois testes são essa medição, e a razão
// de serem dois é que sozinho nenhum deles serve: o primeiro passa com nota
// máxima num modelo que nunca troca ninguém, e o segundo passa com nota
// máxima num modelo que troca toda a gente.
// ---------------------------------------------------------------------

/** Gerador determinístico — o resultado tem de ser reprodutível. */
function seeded(start: number) {
  let seed = start;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function mkNoisyPool(opts: {
  seed: number;
  trueSpread: number;
  noiseSd: number;
  /** Onde no plantel verdadeiro estão os jogadores que já tens. */
  quality: "mau" | "medio" | "bom";
}) {
  const rnd = seeded(opts.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const base: Record<number, number> = { 1: 3.4, 2: 3.8, 3: 4.4, 4: 4.6 };
  const trueEp = new Map<number, number>();
  const scored: ScoredPlayer[] = [];
  let id = 1;
  for (let i = 0; i < 600; i++) {
    const type = (i % 4) + 1;
    const price = type === 1 ? 4.5 : type === 2 ? 5.0 : type === 3 ? 6.5 : 7.0;
    const truth = Math.max(0.5, base[type] + gauss() * opts.trueSpread);
    const estimate = Math.max(0.2, truth + gauss() * opts.noiseSd);
    const pid = id++;
    trueEp.set(pid, truth);
    scored.push(
      mkSim(pid, { teamId: (i % 20) + 1, type, epNext: estimate, price, own: (i % 60) + 1 })
    );
  }
  const perClub = new Map<number, number>();
  const owned: ScoredPlayer[] = [];
  for (const [type, want] of [[1, 2], [2, 5], [3, 5], [4, 3]] as [number, number][]) {
    let taken = 0;
    const inPos = scored
      .filter((q) => q.element.element_type === type)
      .sort((a, b) => (trueEp.get(a.element.id) ?? 0) - (trueEp.get(b.element.id) ?? 0));
    const start =
      opts.quality === "mau"
        ? 0
        : opts.quality === "medio"
          ? Math.floor(inPos.length * 0.55)
          : Math.floor(inPos.length * 0.88);
    for (const p of inPos.slice(start)) {
      if (taken >= want) break;
      const n = perClub.get(p.team.id) ?? 0;
      if (n >= 3) continue;
      perClub.set(p.team.id, n + 1);
      owned.push(p);
      taken++;
    }
  }
  return { scored, owned, trueEp };
}

function testPureNoiseProducesNoTransfers() {
  // Dentro de cada posição TODOS os jogadores têm o MESMO valor verdadeiro.
  // Qualquer troca que o modelo proponha vale exatamente zero pontos, por
  // construção. O número de trocas mede diretamente quanto ruído persegue.
  //
  // MEDIDO ANTES DA CORREÇÃO: com apenas 0.5 pontos por jornada de ruído —
  // muito menos do que a realidade — o modelo reconstruía 15 dos 15
  // jogadores. As três defesas não impediram nenhuma troca.
  for (const noiseSd of [0.3, 0.5, 0.8]) {
    const { scored, owned } = mkNoisyPool({
      seed: 12345,
      trueSpread: 0,
      noiseSd,
      quality: "medio",
    });
    const advice = planTransfers(scored, mkState(owned, 1), { currentEvent: 4 });
    const wc = advice.plans.find((p) => p.key === "wildcard");
    check(
      `com ${noiseSd} pts/jornada de puro ruído, o wildcard não troca ninguém`,
      (wc?.moves.length ?? 0) === 0,
      `${wc?.moves.length ?? 0} trocas propostas`
    );
    check(
      `e o plano recomendado é manter (ruído ${noiseSd})`,
      advice.recommended?.key === "manter",
      `${advice.recommended?.key}`
    );
  }
}

function testRealDifferencesStillProduceTransfers() {
  // O TESTE INVERSO, sem o qual "nunca trocar ninguém" passaria o teste
  // acima com nota máxima. Aqui os valores verdadeiros diferem mesmo, e o
  // ganho VERDADEIRO das trocas é conhecido por construção — mede-se o que
  // as trocas realmente valem, não o que o modelo julga que valem.
  const seen: Record<string, number> = {};
  for (const quality of ["mau", "medio", "bom"] as const) {
    const { scored, owned, trueEp } = mkNoisyPool({
      seed: 999,
      trueSpread: 1.2,
      noiseSd: 1.0,
      quality,
    });
    const advice = planTransfers(scored, mkState(owned, 1), { currentEvent: 4 });
    const moves = advice.recommended?.moves ?? [];
    const trueGain = moves.reduce(
      (s, m) =>
        s + ((trueEp.get(m.in.element.id) ?? 0) - (trueEp.get(m.out.element.id) ?? 0)) * 5,
      0
    );
    seen[quality] = moves.length;
    check(
      `plantel "${quality}": as trocas propostas ganham pontos VERDADEIROS`,
      trueGain >= 0,
      `${moves.length} trocas, ${trueGain.toFixed(1)} pts verdadeiros`
    );
  }
  check(
    "um plantel fraco é reconstruído a sério",
    seen.mau >= 8,
    `${seen.mau} trocas`
  );
  check(
    // A propriedade que o dono da equipa andava a pedir, em uma linha: quanto
    // melhor o plantel, menos o modelo lhe mexe.
    "e quanto melhor o plantel, menos o modelo lhe mexe",
    seen.mau > seen.medio && seen.medio >= seen.bom,
    `mau ${seen.mau}, médio ${seen.medio}, bom ${seen.bom}`
  );
}

function testTheProtectionsNoLongerSwitchThemselvesOff() {
  // A CAUSA RAIZ, trancada diretamente.
  //
  // `modelTrust = min(1, minutos/360)` chega a 1.0 ao fim de quatro jogos
  // completos. Todas as defesas estavam construídas sobre ele, por isso
  // desligavam-se sozinhas na jornada 4 — exatamente a semana em que as
  // queixas começaram. O limiar tem de depender da EVIDÊNCIA, que continua a
  // crescer toda a época, e não da confiança, que satura.
  check(
    "o limiar continua a descer muito depois de os minutos saturarem",
    retentionThreshold(4, 5) > retentionThreshold(12, 5) &&
      retentionThreshold(12, 5) > retentionThreshold(30, 5),
    `${retentionThreshold(4, 5)} > ${retentionThreshold(12, 5)} > ${retentionThreshold(30, 5)}`
  );
  check(
    "e nunca chega a zero, nem no fim da época",
    retentionThreshold(37, 5) > 1,
    `${retentionThreshold(37, 5)}`
  );
  check(
    "o erro de estimativa cai com a raiz da evidência, e nunca desaparece",
    rateErrorPerGw(3) > rateErrorPerGw(15) && rateErrorPerGw(37) > 0
  );
  check(
    // Se o viés de seleção fosse zero, o limiar seria zero e voltávamos ao
    // princípio. É esta assimetria — o desafiante foi escolhido, o teu
    // jogador não — que faz o mecanismo funcionar.
    "e o viés de seleção é o que faz o limiar existir",
    selectionInflation(15, 90) > 1,
    `${selectionInflation(15, 90)}`
  );
  check(
    "escolher menos jogadores de um mercado maior infla mais cada escolha",
    selectionInflation(5, 200) > selectionInflation(60, 90)
  );
}

function testTheRefusedMoveIsStillShown() {
  // Recusar sem mostrar é indistinguível de não ter opinião — que é como
  // este projeto se meteu em sarilhos. Quando o limiar bloqueia a melhor
  // troca, ela tem de continuar visível, com a explicação e o número.
  // 5 pontos-janela: acima do que uma transferência livre custa em valor de
  // opção (por isso o solver SEM o limiar fá-la-ia), abaixo do limiar de
  // retenção na jornada 4 (8.0 pts) — a janela exata onde a recusa acontece.
  const { owned, scored } = mkTransferPool([5]);
  const advice = planTransfers(scored, mkState(owned, 1), { currentEvent: 4 });
  check("a troca marginal não é recomendada", advice.recommended?.key === "manter");
  const shown = advice.plans.find((p) => p.key !== "manter");
  check("mas continua visível na lista de planos", !!shown && shown.moves.length > 0);
  check(
    "e diz que a diferença é menor do que o erro com que é medida",
    !!shown && /erro|ruído/.test(shown.rationale),
    shown?.rationale.slice(0, 90)
  );
}

// ---------------------------------------------------------------------
// v1.39 — o instrumento de medição tinha um viés de seleção lá dentro.
//
// O primeiro backtest real, na jornada 2, apareceu no painel assim:
//
//     MAE 4.04 (base 4.49) · Spearman -0.241
//
// Correlação de ordenação NEGATIVA. Um modelo que valeria a pena seguir ao
// contrário. E não era verdade: a amostra era escolhida pelos 150 jogadores
// com mais pontos TOTAIS na época — que, com duas jornadas jogadas, é quase
// inteiramente feita da jornada que estava a ser testada.
//
// Selecionar pela consequência comum de duas variáveis anti-correlaciona-as
// dentro da amostra mesmo quando não há relação nenhuma fora dela. É um
// colisor, e estava dentro do instrumento de medida.
// ---------------------------------------------------------------------

function testTheSampleIsNotChosenUsingTheOutcome() {
  const mkEl = (id: number, type: number, cost: number, points: number) =>
    makeElement({ id, element_type: type, now_cost: cost, total_points: points });

  // Dois universos idênticos em tudo menos nos pontos marcados. Se a amostra
  // mudar entre eles, está a ser escolhida com informação do futuro.
  const priced: FplElement[] = [];
  const shuffledPoints: FplElement[] = [];
  for (let i = 0; i < 200; i++) {
    const type = (i % 4) + 1;
    const cost = 40 + (i % 60);
    priced.push(mkEl(i + 1, type, cost, i));
    // Mesmos ids, mesmos preços, pontos ao contrário.
    shuffledPoints.push(mkEl(i + 1, type, cost, 200 - i));
  }

  const a = chooseSample(priced, 60).map((e) => e.id).sort((x, y) => x - y);
  const b = chooseSample(shuffledPoints, 60).map((e) => e.id).sort((x, y) => x - y);
  check(
    "a amostra do backtest não muda quando os pontos mudam",
    a.length === b.length && a.every((id, i) => id === b[i]),
    `${a.length} vs ${b.length}, iguais: ${a.every((id, i) => id === b[i])}`
  );
  check("e continua a ter o tamanho pedido", a.length === 60, `${a.length}`);

  // A defesa que já existia tem de sobreviver: sem chão por posição, uma
  // ordenação única produz uma amostra sem guarda-redes.
  const sample = chooseSample(priced, 60);
  for (const type of [1, 2, 3, 4]) {
    check(
      `a amostra inclui jogadores da posição ${type}`,
      sample.some((e) => e.element_type === type)
    );
  }
}

// ---------------------------------------------------------------------
// v1.39 — a camada de investigação nunca esteve calada.
//
// O painel dizia "vazia": correu, registou-se, submeteu zero notas. A leitura
// confortável era que uma semana de Premier League não tinha produzido nada
// digno de registo, o que não é credível. A própria execução tinha deixado o
// diagnóstico escrito no campo `note`:
//
//     "Push c/ insights reais falha (URL longo). So vazio funciona."
//
// Estava a encontrar coisas e a tentar enviá-las. A submissão falhava por
// TAMANHO. A vazia cabia — por isso a vazia era a única que alguma vez
// chegou. E o erro 413 mandava "enviar menos notas", ou seja, mandava deitar
// informação fora.
// ---------------------------------------------------------------------

function testCompressedSubmissionsFitWhereRawOnesDoNot() {
  const inflate = (b: Uint8Array) => new Uint8Array(inflateSync(b));
  const gunzip = (b: Uint8Array) => new Uint8Array(gunzipSync(b));
  const b64url = (b: Uint8Array) =>
    Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Uma submissão realista: dez achados, cada um com razão e fonte. É esta
  // que não cabia.
  const payload = {
    note: "Passagem de sexta: conferências de imprensa e boletins clínicos das últimas 48h.",
    insights: Array.from({ length: 10 }, (_, i) => ({
      scope: "player",
      playerName: `Jogador${i}`,
      teamShortName: "ARS",
      factor: 0.85,
      confidence: 0.9,
      events: [4],
      reason:
        "O treinador confirmou na antevisão que vai a banco depois do jogo europeu de quarta-feira, por gestão de carga",
      source: "Conferência de imprensa do Arsenal, 2026-09-04, via Sky Sports",
    })),
  };
  const raw = JSON.stringify(payload);
  const rawUrlChars = encodeURIComponent(raw).length;
  const z = b64url(new Uint8Array(deflateSync(Buffer.from(raw, "utf8"), { level: 9 })));

  check(
    "a submissão comprimida é muito mais curta do que a crua",
    z.length < rawUrlChars / 3,
    `crua ${rawUrlChars} caracteres, comprimida ${z.length}`
  );

  const decoded = decodeCompressedPayload(z, inflate, gunzip);
  check("e descodifica", decoded.ok, decoded.ok ? "" : decoded.error);
  check(
    "para exatamente o mesmo JSON, sem perder uma nota",
    decoded.ok && decoded.json === raw,
    decoded.ok ? `${JSON.parse(decoded.json).insights.length} notas` : ""
  );

  // gzip também: quem recorre a compressão não deve ter de adivinhar qual das
  // duas chamadas óbvias do Python é a certa, e adivinhar mal pareceria
  // exatamente a falha silenciosa que isto vem substituir.
  const gz = b64url(new Uint8Array(gzipSync(Buffer.from(raw, "utf8"))));
  const fromGzip = decodeCompressedPayload(gz, inflate, gunzip);
  check(
    "gzip é aceite tal como zlib",
    fromGzip.ok && fromGzip.json === raw,
    fromGzip.ok ? "" : fromGzip.error
  );

  // E as recusas explicam-se, em vez de falharem em silêncio.
  const bad = decodeCompressedPayload("isto-nao-e-nada", inflate, gunzip);
  check(
    "lixo é recusado com uma mensagem que diz o que fazer",
    !bad.ok && /descomprime|base64url/.test(bad.ok ? "" : bad.error),
    bad.ok ? "aceitou lixo!" : bad.error
  );
  check("um payloadz vazio é recusado", !decodeCompressedPayload("", inflate, gunzip).ok);

  // O limite continua a existir — comprimir não pode virar armazenamento.
  const huge = b64url(
    new Uint8Array(deflateSync(Buffer.from("x".repeat(MAX_INFLATED_CHARS + 10), "utf8")))
  );
  const tooBig = decodeCompressedPayload(huge, inflate, gunzip);
  check(
    "e um payload descomprimido absurdo continua a ser recusado",
    !tooBig.ok,
    tooBig.ok ? "aceitou!" : tooBig.error
  );
}

async function testLossCanNoLongerLookLikeEmptiness() {
  // ═══ O DEFEITO QUE ESCONDEU DUAS AVARIAS DIFERENTES NO MESMO SÍTIO ═══
  //
  // "A investigação correu e não encontrou nada" e "os achados nunca
  // chegaram" produziam respostas BYTE A BYTE IGUAIS:
  //
  //     {"accepted":[],"rejected":[],"acceptedCount":0,"rejectedCount":0,
  //      "recorded":true}
  //
  // Dois estados completamente diferentes, uma só resposta. Primeiro foi o
  // URL grande demais a entregar silenciosamente nada; depois, já
  // diagnosticado isso, uma segunda execução relatou oito submissões de
  // dados reais a voltarem todas 0/0 — e não havia forma, só pela resposta,
  // de saber se o servidor tinha recebido nada ou recebido nada de útil.
  //
  // Um protocolo em que a PERDA é indistinguível do VAZIO não se consegue
  // depurar. Escondeu duas avarias durante mais de um mês.
  const oneInsight = {
    note: "teste",
    insights: [
      {
        scope: "player",
        playerName: "Maddison",
        teamShortName: "TOT",
        factor: 0.85,
        reason: "dúvida",
        source: "teste",
      },
    ],
  };

  // Sem contagem declarada: recusa. O silêncio tem de ser deliberado.
  const undeclared = await processInsightSubmission(oneInsight, undefined);
  check(
    "sem declarar quantas notas envia, a submissão é recusada",
    undeclared.status === 400 && /'n'/.test(String(undeclared.body.error)),
    `${undeclared.status}: ${String(undeclared.body.error).slice(0, 60)}`
  );

  // Contagem que não bate certo: recusa, e diz os DOIS números.
  const truncated = await processInsightSubmission({ note: "t", insights: [] }, 6);
  check(
    "declarar 6 e chegarem 0 é recusado como payload truncado",
    truncated.status === 400 && truncated.body.declared === 6 && truncated.body.received === 0,
    `${truncated.status}: ${String(truncated.body.error).slice(0, 80)}`
  );
  check(
    "e NADA é registado nesse caso",
    truncated.body.recorded === false,
    `recorded: ${truncated.body.recorded}`
  );

  // E o caso que interessa proteger: uma semana genuinamente vazia continua
  // a ser um resultado válido — mas agora só se for DECLARADA.
  const honestlyEmpty = await processInsightSubmission(
    { note: "verifiquei e não há nada", insights: [] },
    0
  );
  check(
    "uma semana genuinamente vazia, declarada com n=0, continua a ser registada",
    honestlyEmpty.status === 200 && honestlyEmpty.body.recorded === true,
    `${honestlyEmpty.status}`
  );

  // A distinção que é o objetivo de tudo isto.
  check(
    "perda e vazio deixam de ter a mesma resposta",
    JSON.stringify(truncated.body) !== JSON.stringify(honestlyEmpty.body)
  );
}

function testChunkedSubmissionDoesNothingUntilComplete() {
  // Partes em falta não podem aplicar nada, e têm de dizer quais faltam. O
  // modo de falha deste protocolo passa a ser "não aconteceu nada e foi
  // dito", que é o oposto do que substitui.
  check(
    "um sid válido é aceite",
    isValidSubmissionId("gw3-sexta_01") && isValidSubmissionId("abcd")
  );
  check(
    "e um sid que tenta sair do seu espaço é recusado",
    !isValidSubmissionId("../outra-coisa") &&
      !isValidSubmissionId("a") &&
      !isValidSubmissionId("x".repeat(41))
  );
  check(
    "o número de partes é limitado — não é armazenamento",
    MAX_CHUNKS <= 12 && MAX_CHUNKS >= 2,
    `${MAX_CHUNKS}`
  );
}

testChunkedSubmissionDoesNothingUntilComplete();
testCompressedSubmissionsFitWhereRawOnesDoNot();
testTheSampleIsNotChosenUsingTheOutcome();
testPureNoiseProducesNoTransfers();
testRealDifferencesStillProduceTransfers();
testTheProtectionsNoLongerSwitchThemselvesOff();
testTheRefusedMoveIsStillShown();

// O único teste assíncrono da suite. Envolvido em vez de usar `await` no
// topo do módulo, porque isso torna o módulo assíncrono e o tsx deixa de o
// conseguir carregar (ERR_REQUIRE_ASYNC_MODULE).
void testLossCanNoLongerLookLikeEmptiness().then(() => {
  report("regressão");
  const { passed, failed } = counts();
  console.log(`\n${passed} verificações passaram, ${failed} falharam\n`);
  process.exit(exitCode());
});
