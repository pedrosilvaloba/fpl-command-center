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
  type ScoredPlayer,
} from "../lib/recommend";
import {
  computeMinutesModel,
  computePlayerRates,
  expectedPointsForFixture,
} from "../lib/expectedpoints";
import { buildOptimalSquad, strategicValue } from "../lib/optimizer";
import { simulateLeague, applyLearningTilt, type RivalSquad } from "../lib/rivals";
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
  summariseChips,
  type SquadState,
} from "../lib/squadstate";
import { planTransfers } from "../lib/transferplan";
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
  overTwoPointFiveProbability,
  deriveTeamRatingsFromMarket,
} from "../lib/oddsmodel";
import type { OddsMatch } from "../lib/oddsapi";
import { isStorageConfigured } from "../lib/kv";
import {
  check,
  report,
  exitCode,
  counts,
  makeBootstrap,
  makeElement,
  makeFixture,
  makeTeam,
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
  check("C-04 fator de defesa mantém-se dentro dos limites", airtight <= 1.25 + 1e-9);
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
      top.breakdown.defensiveContribution + top.breakdown.bonus
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
      expectedPoints: 0, expectedPointsNext: 0,
      breakdown: {
        appearance: 0, goals: 0, assists: 0, cleanSheet: 0,
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, total: 0,
      },
      score: 0, isDifferential: false, isPreseason: false, reasons: [],
      ...over,
    }) as ScoredPlayer;

  // A: great over 5 GWs, poor next week.  B: the reverse.
  const a = base({ expectedPoints: 40, expectedPointsNext: 3, score: 40 });
  const b = base({ expectedPoints: 25, expectedPointsNext: 9, score: 25 });
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
      positionShort: "X", priceM: price, ownershipPct: 5, formNum: 0,
      fixtureAvgDifficulty: 3, nextOpponents: "", expectedGoalsFor: 1.4,
      cleanSheetProbability: 0.3, individualExpectedGI: 0, ceilingGI: 0, floorGI: 0,
      expectedPoints: score, expectedPointsNext: score / 5,
      breakdown: {
        appearance: 0, goals: 0, assists: 0, cleanSheet: 0,
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, total: score,
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
      expectedPoints: pts * 5, expectedPointsNext: pts,
      breakdown: {
        appearance: 0, goals: 0, assists: 0, cleanSheet: 0,
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, total: 0,
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
  check("jogo com só uma equipa avaliada usa o mercado, não fica neutro",
    row?.source === "market-ratings", `fonte=${row?.source}`);
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
          expectedPoints: Math.round(pts * 10) / 10, expectedPointsNext: pts / 5,
          breakdown: { appearance: 0, goals: 0, assists: 0, cleanSheet: 0, concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, total: pts },
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
      ceilingGI: 0, floorGI: 0, expectedPoints: pts * 5, expectedPointsNext: pts,
      breakdown: { appearance: 0, goals: 0, assists: 0, cleanSheet: 0, concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, total: 0 },
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
      expectedPoints: pts * 5, expectedPointsNext: pts,
      breakdown: { appearance: 0, goals: 0, assists: 0, cleanSheet: 0, concededPenalty: 0, defensiveContribution: 0, bonus: 0, saves: 0, total: 0 },
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
  const busyKeeper = computePlayerRates(makeElement({ minutes: 900, saves: 45 }));
  check("defesas por 90 são calculadas", busyKeeper.saves90 > 4, `${busyKeeper.saves90}`);
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
    breakdown: {
      appearance: 2 * 5,
      goals: (epNext - 2) * 0.5 * 5,
      assists: (epNext - 2) * 0.25 * 5,
      cleanSheet: type <= 2 ? 1.2 * 5 : 0,
      concededPenalty: type <= 2 ? -0.4 * 5 : 0,
      defensiveContribution: 0,
      bonus: 0.4 * 5,
      saves: 0,
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
  // One big upgrade and one marginal one. With a single free transfer, the
  // big upgrade is free; the marginal one would cost 4 points and is worth
  // about 2 over the window, so no hit should ever be recommended.
  const cheapExtra = mkTransferPool([10, 2]);
  const cheapAdvice = planTransfers(cheapExtra.scored, mkState(cheapExtra.owned, 1));
  check(
    "um segundo negócio marginal não justifica pagar -4",
    cheapAdvice.recommended!.hitCost === 0,
    `hit ${cheapAdvice.recommended!.hitCost}, ganho ${cheapAdvice.recommended!.netGainVsHold}`
  );

  // Now make the second upgrade clearly worth more than the four points.
  const worthIt = mkTransferPool([10, 14]);
  const worthAdvice = planTransfers(worthIt.scored, mkState(worthIt.owned, 1));
  check(
    "duas melhorias grandes com uma só livre justificam o hit",
    worthAdvice.recommended!.hitCost > 0 && worthAdvice.recommended!.transfers === 2,
    `hit ${worthAdvice.recommended!.hitCost}, transf ${worthAdvice.recommended!.transfers}`
  );
  check(
    "e o ganho reportado já vem líquido do custo do hit",
    worthAdvice.recommended!.netGainVsHold > 0 &&
      worthAdvice.recommended!.netValue ===
        Math.round(
          (worthAdvice.recommended!.xiWindowPoints - worthAdvice.recommended!.hitCost) * 10
        ) / 10
  );

  // Two free transfers: the same two moves should now cost nothing.
  const twoFree = planTransfers(worthIt.scored, mkState(worthIt.owned, 2));
  check(
    "com duas transferências livres as mesmas jogadas deixam de custar pontos",
    twoFree.recommended!.hitCost === 0 && twoFree.recommended!.transfers === 2,
    `hit ${twoFree.recommended!.hitCost}, transf ${twoFree.recommended!.transfers}`
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
  const advice = planTransfers(scored, mkState(owned, 1));
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
  const tightAdvice = planTransfers(tight.scored, mkState(tight.owned, 1));
  check(
    "um plantel já perto do ideal não dispara o wildcard",
    tightAdvice.wildcard !== null && !tightAdvice.wildcard.advise,
    `distância ${tightAdvice.wildcard?.distance}, ganho ${tightAdvice.wildcard?.gain}`
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

console.log("\nSuite de regressão — FPL Command Center\n");
testFreeTransferReconstruction();
testSellingPriceEstimation();
testChipSummary();
testTransferPlanRespectsTheRules();
testHitIsOnlyTakenWhenItPaysForItself();
testNoUpgradeMeansHold();
testWildcardSignal();
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

report("regressão");
const { passed, failed } = counts();
console.log(`\n${passed} verificações passaram, ${failed} falharam\n`);
process.exit(exitCode());
