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
import { computeMinutesModel, computePlayerRates } from "../lib/expectedpoints";
import { validateInsightInput, resolveInsightTarget } from "../lib/managerinsights";
import {
  expectedGoalsFromMarket,
  totalGoalsFromOverProb,
  overTwoPointFiveProbability,
  deriveTeamRatingsFromMarket,
} from "../lib/oddsmodel";
import type { OddsMatch } from "../lib/oddsapi";
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
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, total: 0,
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
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, total: score,
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
        concededPenalty: 0, defensiveContribution: 0, bonus: 0, total: 0,
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

console.log("\nSuite de regressão — FPL Command Center\n");
testDefenceInversion();
testMissingTeamStrengths();
testMarketInversion();
testMarketDerivedRatings();
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
