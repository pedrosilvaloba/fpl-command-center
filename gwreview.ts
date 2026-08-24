import { getRedis } from "./kv";
import { getEventLive, getEntryPicks } from "./fpl-client";
import type { ScoredPlayer } from "./recommend";
import type { FplBootstrap } from "./types";

/**
 * The gameweek post-mortem — what actually happened to MY team, against what
 * the model said would happen.
 *
 * WHY THIS IS DIFFERENT FROM THE ACCURACY PANEL
 * ---------------------------------------------
 * `lib/accuracy.ts` asks a question about the model: do the players it rates
 * highest outscore the ones it rates lowest? That is the right question for
 * deciding whether the engine works, and the wrong question for a manager on
 * a Monday morning, who wants to know three things the aggregate cannot
 * answer:
 *
 *   - Did my team do better or worse than expected, and by how much?
 *   - WHO was responsible — which specific players over- or under-delivered?
 *   - Did my captain choice and my bench cost me anything?
 *
 * Those are questions about one squad, not about a ranking. They also expose
 * a failure mode the aggregate hides entirely: the model can be ranking
 * players correctly and still be systematically wrong about MY team, because
 * my team is eleven specific players and not a distribution.
 *
 * WHY IT NEEDS A SNAPSHOT
 * -----------------------
 * The obvious implementation — compare the model's current numbers with what
 * happened — is invalid, and quietly so. Once a gameweek is in progress the
 * app's `expectedPointsNext` refers to the NEXT gameweek, not the one being
 * reviewed; and the underlying inputs (form, prices, odds) have all moved.
 * Reconstructing "what the model would have said" after the fact is exactly
 * the kind of test a model always passes.
 *
 * So the predictions are written down BEFORE the deadline, for every player,
 * and read back afterwards. Storing all of them rather than just the current
 * squad is deliberate: transfers made after the snapshot still land on
 * players whose prediction was captured.
 */

const PREDICTION_KEY = (event: number) => `fpl-command-center:gw-predictions:${event}`;
/** Keeps the stored payload small enough to be cheap: only players with a
 * meaningful prediction can ever be in a squad worth reviewing. */
const MIN_PREDICTION_STORED = 0.5;

interface PredictionSnapshot {
  event: number;
  takenAt: string;
  /** elementId -> expected points for that gameweek. */
  predictions: Record<string, number>;
}

/** Writes the model's per-player predictions for a gameweek whose deadline
 * has not passed. Idempotent and best-effort. */
export async function snapshotPredictions(
  scored: ScoredPlayer[],
  eventId: number
): Promise<void> {
  const redis = getRedis();
  if (!redis || scored.length === 0) return;
  try {
    if (await redis.get(PREDICTION_KEY(eventId))) return;
    const predictions: Record<string, number> = {};
    for (const p of scored) {
      if (p.expectedPointsNext >= MIN_PREDICTION_STORED) {
        predictions[String(p.element.id)] =
          Math.round(p.expectedPointsNext * 100) / 100;
      }
    }
    const snapshot: PredictionSnapshot = {
      event: eventId,
      takenAt: new Date().toISOString(),
      predictions,
    };
    await redis.set(PREDICTION_KEY(eventId), snapshot);
  } catch {
    // Never let a tracking write affect the page.
  }
}

export interface PlayerReview {
  elementId: number;
  webName: string;
  teamShort: string;
  positionShort: string;
  predicted: number | null;
  actual: number;
  /** actual - predicted. Null when there was no stored prediction. */
  delta: number | null;
  minutes: number;
  multiplier: number;
  wasCaptain: boolean;
  wasStarter: boolean;
}

export interface CaptainReview {
  chosen: string;
  chosenPoints: number;
  best: string;
  bestPoints: number;
  /** Points left on the table by the armband, already doubled. */
  cost: number;
}

export interface GameweekReview {
  available: boolean;
  reason: string | null;
  event: number | null;
  finished: boolean;
  hadStoredPredictions: boolean;
  predictedTotal: number;
  actualTotal: number;
  delta: number;
  /** FPL's own average score for the gameweek, when published. */
  averageScore: number | null;
  players: PlayerReview[];
  benchPoints: number;
  transfersMade: number;
  transferCost: number;
  captain: CaptainReview | null;
  verdict: string;
}

const EMPTY: GameweekReview = {
  available: false,
  reason: null,
  event: null,
  finished: false,
  hadStoredPredictions: false,
  predictedTotal: 0,
  actualTotal: 0,
  delta: 0,
  averageScore: null,
  players: [],
  benchPoints: 0,
  transfersMade: 0,
  transferCost: 0,
  captain: null,
  verdict: "",
};

/**
 * Builds the review for a gameweek that has already started (so FPL is
 * serving both the picks and the live stats). Works while the gameweek is
 * still in progress — a partial review of a live gameweek is useful, as long
 * as it says so, which the `finished` flag lets the page do.
 */
export async function reviewGameweek(
  teamId: number,
  eventId: number,
  bootstrap: FplBootstrap
): Promise<GameweekReview> {
  if (!Number.isFinite(teamId) || teamId <= 0 || eventId < 1) {
    return { ...EMPTY, reason: "Ainda não há nenhuma jornada começada para rever." };
  }

  const event = bootstrap.events.find((e) => e.id === eventId) ?? null;
  let picks: Awaited<ReturnType<typeof getEntryPicks>>;
  let live: Awaited<ReturnType<typeof getEventLive>>;
  try {
    [picks, live] = await Promise.all([
      getEntryPicks(teamId, eventId),
      getEventLive(eventId),
    ]);
  } catch {
    return {
      ...EMPTY,
      event: eventId,
      reason:
        "Não foi possível carregar os dados desta jornada na FPL. A revisão volta assim que a API responder.",
    };
  }

  const redis = getRedis();
  let stored: PredictionSnapshot | null = null;
  if (redis) {
    try {
      stored = await redis.get<PredictionSnapshot>(PREDICTION_KEY(eventId));
    } catch {
      stored = null;
    }
  }

  const statsById = new Map(live.elements.map((e) => [e.id, e.stats ?? {}]));
  const elementById = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const positionById = new Map(
    bootstrap.element_types.map((t) => [t.id, t.singular_name_short])
  );

  const players: PlayerReview[] = [];
  let predictedTotal = 0;
  let actualTotal = 0;
  let benchPoints = 0;

  for (const pick of picks.picks) {
    const el = elementById.get(pick.element);
    if (!el) continue;
    const stats = statsById.get(pick.element) ?? {};
    const rawPoints = Number(stats.total_points ?? 0);
    const predicted = stored?.predictions?.[String(pick.element)] ?? null;
    const isStarter = pick.multiplier > 0;

    if (isStarter) {
      actualTotal += rawPoints * pick.multiplier;
      if (predicted !== null) predictedTotal += predicted * pick.multiplier;
    } else {
      benchPoints += rawPoints;
    }

    players.push({
      elementId: pick.element,
      webName: el.web_name,
      teamShort: teamById.get(el.team)?.short_name ?? "?",
      positionShort: positionById.get(el.element_type) ?? "?",
      predicted,
      actual: rawPoints,
      delta: predicted === null ? null : Math.round((rawPoints - predicted) * 10) / 10,
      minutes: Number(stats.minutes ?? 0),
      multiplier: pick.multiplier,
      wasCaptain: pick.is_captain,
      wasStarter: isStarter,
    });
  }

  const transferCost = picks.entry_history?.event_transfers_cost ?? 0;
  actualTotal -= transferCost;

  // Captain review: what the armband actually returned versus the best
  // choice available inside the eleven that was fielded. Deliberately NOT
  // versus the whole game — beating yourself up over a captain you never
  // owned teaches nothing.
  let captain: CaptainReview | null = null;
  const starters = players.filter((p) => p.wasStarter);
  const chosen = players.find((p) => p.wasCaptain);
  if (chosen && starters.length > 0) {
    const best = starters.reduce((a, b) => (b.actual > a.actual ? b : a));
    captain = {
      chosen: chosen.webName,
      chosenPoints: chosen.actual,
      best: best.webName,
      bestPoints: best.actual,
      cost: Math.max(0, best.actual - chosen.actual),
    };
  }

  const finished = event?.finished ?? false;
  const averageScore = event?.average_entry_score ?? null;
  const delta = Math.round((actualTotal - predictedTotal) * 10) / 10;
  const hadStoredPredictions = predictedTotal > 0;

  let verdict: string;
  if (!hadStoredPredictions) {
    verdict = redis
      ? "Não havia previsões guardadas para esta jornada — a app só começa a guardá-las a partir do momento em que esta funcionalidade foi instalada. A partir da próxima, a comparação aparece aqui."
      : "Sem armazenamento persistente, não há forma de guardar as previsões antes do deadline, e comparar com os números de agora seria enganador: o modelo já mudou.";
  } else if (!finished) {
    verdict = `Jornada ainda a decorrer: ${actualTotal} pontos até agora contra ${predictedTotal.toFixed(1)} esperados no total. Os números vão mexer até ao último jogo.`;
  } else if (delta >= 8) {
    verdict = `Jornada acima da expectativa em ${delta.toFixed(1)} pontos. Vale a pena olhar para quem superou: se foi o mesmo tipo de jogador que costuma superar, é sinal do modelo; se foi um golo de fora da área, foi sorte e não se repete.`;
  } else if (delta <= -8) {
    verdict = `Jornada ${Math.abs(delta).toFixed(1)} pontos abaixo da expectativa. Antes de mudar meia equipa: uma jornada é uma amostra de um. O painel de calibração é que decide se isto é um padrão.`;
  } else {
    verdict = `Jornada dentro do esperado (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pontos face à previsão). É o resultado mais comum e o mais aborrecido — e é o sinal de que o modelo está calibrado.`;
  }

  return {
    available: true,
    reason: null,
    event: eventId,
    finished,
    hadStoredPredictions,
    predictedTotal: Math.round(predictedTotal * 10) / 10,
    actualTotal,
    delta,
    averageScore,
    players: players.sort((a, b) => {
      if (a.wasStarter !== b.wasStarter) return a.wasStarter ? -1 : 1;
      return (b.delta ?? -99) - (a.delta ?? -99);
    }),
    benchPoints,
    transfersMade: picks.entry_history?.event_transfers ?? 0,
    transferCost,
    captain,
    verdict,
  };
}
