import { getRedis } from "./kv";
import { getEventLive } from "./fpl-client";
import type { ScoredPlayer } from "./recommend";

/**
 * CAMADA 3 — aprendizagem entre estratégias.
 *
 * WHY A MODEL THAT NEVER CHECKS ITSELF IS A GUESS
 * -----------------------------------------------
 * Every number in this app is an assumption until a real gameweek settles
 * it. The accuracy panel (lib/accuracy.ts) took the first step: it asks
 * whether the players the model rated highest actually outscored the ones
 * it rated lowest. That is a pass/fail check. It tells you the model is
 * working; it does not change anything about the model when it is not.
 *
 * This module closes that loop, with two mechanisms that do different jobs.
 *
 * 1. CALIBRATION — is the scale right?
 *    The model predicts a number of points per player per gameweek. Once
 *    the gameweek is played, we know what those same players actually
 *    scored. If the model systematically predicts 4.1 for defenders who
 *    then average 3.2, that is not noise — it is a bias, and it is
 *    correctable by multiplying defenders' predictions by 0.78. Crucially
 *    this is done PER POSITION, because the biases have different sources
 *    (clean-sheet probabilities are modelled; attacking returns lean on
 *    FPL's own estimate) and there is no reason for them to be equal.
 *
 *    The correction is shrunk toward 1 by sample size, so one freak
 *    gameweek moves nothing, and it is hard-capped at ±25% so a bad run
 *    can never spiral the model away from its own physics.
 *
 * 2. TOURNAMENT — is the STANCE right?
 *    Five different ways of ranking players run in parallel every week,
 *    each picking the same team shape (1 GK, 3 DEF, 4 MID, 2 FWD) so the
 *    comparison is not secretly a comparison of positions. Once the
 *    gameweek settles, each gets scored on what its picks really did.
 *
 *    This answers a question no amount of modelling can: is THIS season
 *    rewarding template-chasing or differentials? Some seasons a handful
 *    of premiums dominate and fighting the template is self-harm; others
 *    are wide open. When the evidence is clear enough, the winner nudges
 *    the variance posture that Camada 2 sets — deliberately by a small
 *    amount, because league position is the stronger signal and this is
 *    the correction on top of it, not a replacement for it.
 *
 * HONEST LIMITS, STATED UP FRONT
 * ------------------------------
 *   - The tournament ranks players without a budget constraint. All five
 *     strategies are equally unconstrained, so the comparison between them
 *     is fair, but "the differential strategy scored more" does not mean a
 *     legal £100m differential squad would have.
 *   - Nothing here works without Upstash Redis, and nothing here can
 *     reconstruct the past: it starts measuring from the first gameweek
 *     after it is deployed, and says so rather than showing an empty table
 *     that looks like a failure.
 */

const SNAPSHOT_KEY = (event: number) => `fpl-command-center:strategy:snapshot:${event}`;
const RESULT_KEY = (event: number) => `fpl-command-center:strategy:result:${event}`;
const INDEX_KEY = "fpl-command-center:strategy:index";

/** The shape every strategy must fill, so the tournament compares stances
 * rather than accidentally comparing positions. */
const SHAPE: Record<string, number> = { GK: 1, DEF: 3, MID: 4, FWD: 2 };

/** How many finished gameweeks before the learned corrections are allowed
 * to reach full strength. Below this they are shrunk toward doing nothing. */
const CALIBRATION_FULL_TRUST_EVENTS = 6;
const CALIBRATION_MIN = 0.75;
const CALIBRATION_MAX = 1.25;

/** Gameweeks of evidence required before the tournament is allowed to move
 * the posture at all, and the most it may move it. */
const TOURNAMENT_MIN_EVENTS = 4;
const TOURNAMENT_MAX_TILT = 0.15;

// --------------------------------------------------------------------------
// The strategies
// --------------------------------------------------------------------------

export interface StrategyDefinition {
  key: string;
  label: string;
  description: string;
  /** Higher is better. */
  rank(p: ScoredPlayer): number;
}

export const STRATEGIES: StrategyDefinition[] = [
  {
    key: "modelo",
    label: "Modelo puro",
    description:
      "Pontos esperados da próxima jornada, exatamente como o motor os calcula. É a referência contra a qual todas as outras são julgadas.",
    rank: (p) => p.expectedPointsNext,
  },
  {
    key: "template",
    label: "Template",
    description:
      "Pontos esperados com bónus para quem é muito possuído. Representa a estratégia de acompanhar o pelotão: em épocas dominadas por dois ou três premiums, é difícil de bater.",
    rank: (p) => p.expectedPointsNext * (1 + 0.6 * Math.min(1, p.ownershipPct / 100)),
  },
  {
    key: "diferencial",
    label: "Diferencial",
    description:
      "Pontos esperados com penalização por posse. Representa a estratégia de procurar quem o pelotão não tem — a única forma de recuperar terreno, e a mais cara quando falha.",
    rank: (p) => p.expectedPointsNext * (1 - 0.9 * Math.min(1, p.ownershipPct / 100)),
  },
  {
    key: "calendario",
    label: "Só calendário",
    description:
      "Ignora o jogador e olha só para o jogo: probabilidade de clean sheet para guarda-redes e defesas, golos esperados da equipa para médios e avançados. Testa quanto do resultado é apenas ter os adversários certos.",
    rank: (p) =>
      p.element.element_type <= 2 ? p.cleanSheetProbability * 10 : p.expectedGoalsFor,
  },
  {
    key: "forma",
    label: "Só forma",
    description:
      "A forma recente publicada pela FPL, sem mais nada. É a heurística que a maioria dos gestores usa por instinto — vale a pena saber se bate o modelo.",
    rank: (p) => p.formNum,
  },
];

const STRATEGY_BY_KEY = new Map(STRATEGIES.map((s) => [s.key, s]));

/** Picks one strategy's team-shaped selection from the scored pool. */
export function selectForStrategy(
  strategy: StrategyDefinition,
  scored: ScoredPlayer[]
): ScoredPlayer[] {
  const out: ScoredPlayer[] = [];
  for (const [positionShort, count] of Object.entries(SHAPE)) {
    const inPos = scored
      .filter((p) => p.positionShort === positionShort)
      .sort((a, b) => strategy.rank(b) - strategy.rank(a))
      .slice(0, count);
    out.push(...inPos);
  }
  return out;
}

// --------------------------------------------------------------------------
// Stored shapes
// --------------------------------------------------------------------------

interface StrategySnapshot {
  event: number;
  takenAt: string;
  /** Per strategy, the element ids it picked. */
  picks: { key: string; elementIds: number[] }[];
  /** Per player picked by ANY strategy, what the model predicted for this
   * single gameweek — the raw material for calibration. */
  predictions: { elementId: number; positionShort: string; predicted: number }[];
}

export interface StrategyEventResult {
  event: number;
  settledAt: string;
  perStrategy: { key: string; totalPoints: number; meanPoints: number; picks: number }[];
  calibration: {
    positionShort: string;
    predicted: number;
    actual: number;
    samples: number;
  }[];
}

// --------------------------------------------------------------------------
// Write path
// --------------------------------------------------------------------------

/** Snapshots every strategy's picks for a gameweek whose deadline has not
 * passed. Idempotent, best-effort, never throws. */
export async function snapshotStrategies(
  scored: ScoredPlayer[],
  eventId: number
): Promise<void> {
  const redis = getRedis();
  if (!redis || scored.length === 0) return;
  try {
    if (await redis.get(SNAPSHOT_KEY(eventId))) return;

    const picks: StrategySnapshot["picks"] = [];
    const predictionById = new Map<
      number,
      { elementId: number; positionShort: string; predicted: number }
    >();

    for (const strategy of STRATEGIES) {
      const chosen = selectForStrategy(strategy, scored);
      picks.push({ key: strategy.key, elementIds: chosen.map((p) => p.element.id) });
      for (const p of chosen) {
        predictionById.set(p.element.id, {
          elementId: p.element.id,
          positionShort: p.positionShort,
          predicted: Math.round(p.expectedPointsNext * 100) / 100,
        });
      }
    }
    if (picks.length === 0) return;

    const snapshot: StrategySnapshot = {
      event: eventId,
      takenAt: new Date().toISOString(),
      picks,
      predictions: [...predictionById.values()],
    };
    await redis.set(SNAPSHOT_KEY(eventId), snapshot);
  } catch {
    // Learning is an enhancement — a failure here must never affect the page.
  }
}

/** For each finished gameweek that has a snapshot but no settled result,
 * fetches real points and records what each strategy scored and how far
 * off the predictions were. */
export async function settleStrategies(finishedEventIds: number[]): Promise<void> {
  const redis = getRedis();
  if (!redis || finishedEventIds.length === 0) return;
  try {
    const index = (await redis.get<number[]>(INDEX_KEY)) ?? [];
    const pending = finishedEventIds.filter((e) => !index.includes(e));
    if (pending.length === 0) return;

    const settled: number[] = [];
    for (const event of pending) {
      const snapshot = await redis.get<StrategySnapshot>(SNAPSHOT_KEY(event));
      if (!snapshot) {
        // Mark processed regardless, or every future page load re-checks a
        // gameweek that will never have a snapshot.
        settled.push(event);
        continue;
      }

      const live = await getEventLive(event);
      const pointsById = new Map(
        live.elements.map((e) => [e.id, e.stats?.total_points ?? 0])
      );

      const perStrategy = snapshot.picks.map((entry) => {
        const total = entry.elementIds.reduce(
          (sum, id) => sum + (pointsById.get(id) ?? 0),
          0
        );
        return {
          key: entry.key,
          totalPoints: total,
          picks: entry.elementIds.length,
          meanPoints:
            entry.elementIds.length > 0
              ? Math.round((total / entry.elementIds.length) * 100) / 100
              : 0,
        };
      });

      const byPosition = new Map<
        string,
        { predicted: number; actual: number; samples: number }
      >();
      for (const pred of snapshot.predictions ?? []) {
        const bucket = byPosition.get(pred.positionShort) ?? {
          predicted: 0,
          actual: 0,
          samples: 0,
        };
        bucket.predicted += pred.predicted;
        bucket.actual += pointsById.get(pred.elementId) ?? 0;
        bucket.samples += 1;
        byPosition.set(pred.positionShort, bucket);
      }

      const result: StrategyEventResult = {
        event,
        settledAt: new Date().toISOString(),
        perStrategy,
        calibration: [...byPosition.entries()].map(([positionShort, v]) => ({
          positionShort,
          predicted: Math.round(v.predicted * 100) / 100,
          actual: v.actual,
          samples: v.samples,
        })),
      };
      await redis.set(RESULT_KEY(event), result);
      settled.push(event);
    }
    if (settled.length > 0) {
      await redis.set(INDEX_KEY, [...index, ...settled]);
    }
  } catch {
    // Retried automatically on the next visit.
  }
}

// --------------------------------------------------------------------------
// Read path — what the model and the page consume
// --------------------------------------------------------------------------

export interface StrategyStanding {
  key: string;
  label: string;
  description: string;
  meanPoints: number;
  totalPoints: number;
  events: number;
  /** Points per pick above or below the pure-model strategy. */
  liftVsModel: number;
}

export interface LearningState {
  configured: boolean;
  /** Finished gameweeks with a settled result. */
  events: number[];
  standings: StrategyStanding[];
  /** Position short name -> multiplier applied to that position's expected
   * points. 1 means "no evidence of bias yet". */
  calibration: Record<string, number>;
  calibrationNotes: string[];
  /** Adjustment added to Camada 2's beta. Positive means this season is
   * rewarding differentials. */
  postureTilt: number;
  postureTiltReason: string | null;
}

export const NEUTRAL_LEARNING: LearningState = {
  configured: false,
  events: [],
  standings: [],
  calibration: {},
  calibrationNotes: [],
  postureTilt: 0,
  postureTiltReason: null,
};

export async function getLearningState(): Promise<LearningState> {
  const redis = getRedis();
  if (!redis) return NEUTRAL_LEARNING;
  try {
    const index = (await redis.get<number[]>(INDEX_KEY)) ?? [];
    if (index.length === 0) return { ...NEUTRAL_LEARNING, configured: true };
    const raw = await Promise.all(
      index.map((event) => redis.get<StrategyEventResult>(RESULT_KEY(event)))
    );
    const results = raw
      .filter((r): r is StrategyEventResult => r !== null)
      .sort((a, b) => a.event - b.event);
    return buildLearningState(results);
  } catch {
    return { ...NEUTRAL_LEARNING, configured: true };
  }
}

/** Pure aggregation — separated from Redis so it can be tested directly. */
export function buildLearningState(results: StrategyEventResult[]): LearningState {
  if (results.length === 0) return { ...NEUTRAL_LEARNING, configured: true };

  const totals = new Map<string, { total: number; picks: number; events: number }>();
  for (const r of results) {
    for (const s of r.perStrategy) {
      const bucket = totals.get(s.key) ?? { total: 0, picks: 0, events: 0 };
      bucket.total += s.totalPoints;
      // `picks` is stored explicitly rather than recovered from
      // total/mean — a gameweek where a strategy's picks all blanked has
      // mean 0 and would otherwise divide by zero.
      bucket.picks += s.picks ?? 10;
      bucket.events += 1;
      totals.set(s.key, bucket);
    }
  }

  const modelMean = (() => {
    const m = totals.get("modelo");
    return m && m.picks > 0 ? m.total / m.picks : 0;
  })();

  const standings: StrategyStanding[] = [...totals.entries()]
    .map(([key, v]) => {
      const def = STRATEGY_BY_KEY.get(key);
      const meanPoints = v.picks > 0 ? v.total / v.picks : 0;
      return {
        key,
        label: def?.label ?? key,
        description: def?.description ?? "",
        meanPoints: Math.round(meanPoints * 100) / 100,
        totalPoints: v.total,
        events: v.events,
        liftVsModel: Math.round((meanPoints - modelMean) * 100) / 100,
      };
    })
    .sort((a, b) => b.meanPoints - a.meanPoints);

  // ---- calibration ------------------------------------------------------
  const byPosition = new Map<string, { predicted: number; actual: number }>();
  for (const r of results) {
    for (const c of r.calibration ?? []) {
      const bucket = byPosition.get(c.positionShort) ?? { predicted: 0, actual: 0 };
      bucket.predicted += c.predicted;
      bucket.actual += c.actual;
      byPosition.set(c.positionShort, bucket);
    }
  }
  const trust = Math.min(1, results.length / CALIBRATION_FULL_TRUST_EVENTS);
  const calibration: Record<string, number> = {};
  const calibrationNotes: string[] = [];
  for (const [positionShort, v] of byPosition) {
    if (v.predicted <= 0.5) continue;
    const rawRatio = v.actual / v.predicted;
    // Shrink toward 1 by how much evidence there is, then hard-cap.
    const shrunk = 1 + (rawRatio - 1) * trust;
    const factor = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, shrunk));
    calibration[positionShort] = Math.round(factor * 1000) / 1000;
    if (Math.abs(factor - 1) >= 0.04) {
      calibrationNotes.push(
        `${positionShort}: o modelo previu ${v.predicted.toFixed(0)} pontos e a realidade deu ${v.actual} — previsões desta posição corrigidas em ${factor >= 1 ? "+" : ""}${Math.round((factor - 1) * 100)}%`
      );
    }
  }

  // ---- posture tilt -----------------------------------------------------
  let postureTilt = 0;
  let postureTiltReason: string | null = null;
  if (results.length >= TOURNAMENT_MIN_EVENTS) {
    const diff = totals.get("diferencial");
    const tmpl = totals.get("template");
    if (diff && tmpl && diff.picks > 0 && tmpl.picks > 0) {
      const diffMean = diff.total / diff.picks;
      const tmplMean = tmpl.total / tmpl.picks;
      const edge = diffMean - tmplMean;
      // Half a point per pick is a meaningful edge over a ten-player shape.
      const scaled = Math.max(
        -TOURNAMENT_MAX_TILT,
        Math.min(TOURNAMENT_MAX_TILT, (edge / 0.5) * TOURNAMENT_MAX_TILT)
      );
      postureTilt = Math.round(scaled * 100) / 100;
      if (Math.abs(postureTilt) >= 0.03) {
        postureTiltReason =
          edge > 0
            ? `Ao longo de ${results.length} jornadas, a estratégia diferencial está a render ${edge.toFixed(2)} pontos por escolha acima da template — esta época está a pagar por divergir, e a postura foi inclinada nesse sentido.`
            : `Ao longo de ${results.length} jornadas, a estratégia template está a render ${Math.abs(edge).toFixed(2)} pontos por escolha acima da diferencial — esta época está a ser dominada pelas escolhas consensuais, e a postura foi inclinada nesse sentido.`;
      }
    }
  }

  return {
    configured: true,
    events: results.map((r) => r.event),
    standings,
    calibration,
    calibrationNotes,
    postureTilt,
    postureTiltReason,
  };
}

/** Applies the learned per-position calibration to a scored pool. Returns a
 * new array; the input is not mutated. A position with no evidence is left
 * exactly as it was. */
export function applyCalibration(
  scored: ScoredPlayer[],
  calibration: Record<string, number>
): ScoredPlayer[] {
  if (Object.keys(calibration).length === 0) return scored;
  return scored.map((p) => {
    const factor = calibration[p.positionShort];
    if (!factor || factor === 1) return p;
    const expectedPoints = Math.round(p.expectedPoints * factor * 100) / 100;
    return {
      ...p,
      expectedPoints,
      expectedPointsNext: Math.round(p.expectedPointsNext * factor * 100) / 100,
      score: expectedPoints,
      reasons: [
        ...p.reasons,
        `calibração aprendida: previsões de ${p.positionShort} corrigidas em ${factor >= 1 ? "+" : ""}${Math.round((factor - 1) * 100)}% face aos resultados reais desta época`,
      ],
    };
  });
}
