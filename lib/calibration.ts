import type { FplBootstrap, FplFixture } from "./types";
import {
  collectBacktestRows,
  type ElementHistoryRow,
  type BacktestRow,
} from "./backtest";
import {
  DEFAULT_MODEL_PARAMS,
  PARAM_GRIDS,
  type ModelParams,
  type TunableParam,
} from "./modelparams";

/**
 * CALIBRATION — turning the model's arguments into measurements.
 *
 * The backtest harness answers "how wrong is the model". This answers the
 * question that actually improves it: "which of its constants are wrong, and
 * what should they be".
 *
 * The method is a coarse sweep. For one parameter at a time, replay the same
 * gameweeks with each candidate value and keep the one that predicts best.
 * Everything interesting here is in the guards against fooling ourselves.
 *
 * GUARD 1 — SCORED OUT OF SAMPLE.
 *
 * Fitting a constant on the same gameweeks you then score it on measures how
 * well it memorised those gameweeks, which is not a quantity anybody wants.
 * Every candidate is therefore scored leave-one-gameweek-out: the value is
 * chosen on all gameweeks but one, and graded on the one left out, rotating
 * through. A constant that only helps the weeks it was fitted on scores no
 * better than the default here, which is the entire point.
 *
 * GUARD 2 — A MINIMUM AMOUNT OF EVIDENCE.
 *
 * Over three gameweeks, a sweep of six values WILL find a winner. It always
 * does; that is what sweeps do. With a sample that small the winner is noise
 * wearing a decimal point, and the decimal point is what makes it
 * persuasive. Below `MIN_EVENTS` and `MIN_ROWS` this module refuses to
 * recommend anything and says why, rather than producing a number that looks
 * like a finding.
 *
 * GUARD 3 — A MINIMUM EFFECT SIZE.
 *
 * Even with enough data, a 0.3% error improvement is not a reason to move a
 * constant that has a reasoned justification behind it. `MIN_IMPROVEMENT`
 * makes the default the incumbent: it wins ties, and it wins near-ties.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: search combinations. Sweeping one
 * parameter at a time cannot find interactions, and with the sample sizes a
 * single FPL season affords, a joint search over twelve parameters would fit
 * the noise almost perfectly. One at a time is the honest resolution.
 */

/** Fewest distinct gameweeks before any recommendation is allowed. Below
 * this, leave-one-out has too few folds to mean anything. */
export const MIN_EVENTS = 6;

/** Fewest scored player-gameweeks before any recommendation is allowed. */
export const MIN_ROWS = 900;

/** Fractional improvement in out-of-sample error a candidate must beat the
 * default by. 2% of the default's error — small enough to catch a real
 * effect, large enough to ignore sampling wobble. */
export const MIN_IMPROVEMENT = 0.02;

export interface ParamCandidate {
  value: number;
  /** Mean out-of-sample error across the folds. */
  error: number;
  isDefault: boolean;
}

export interface ParamResult {
  param: TunableParam;
  currentValue: number;
  bestValue: number;
  currentError: number;
  bestError: number;
  /** Fractional improvement of best over current. Negative means the
   * default was already the best value tried. */
  improvement: number;
  /** Whether the evidence clears every guard above. */
  recommended: boolean;
  reason: string;
  curve: ParamCandidate[];
}

export interface CalibrationReport {
  ranAt: string;
  events: number[];
  rows: number;
  /** True when there is enough data for any recommendation at all. */
  sufficientEvidence: boolean;
  evidenceNote: string;
  results: ParamResult[];
  /** Only the parameters that cleared every guard, worst-first by how much
   * the current value is costing. */
  recommendations: ParamResult[];
  /** True when the time budget stopped the sweep before every requested
   * parameter was covered. The ones missed are named, so the next run can
   * pick them up rather than silently never testing them. */
  truncated: boolean;
  notCovered: TunableParam[];
}

/** Mean absolute error. Chosen over RMSE because FPL scores have a long
 * right tail — one hauling captain would otherwise dominate the fit. */
function mae(rows: { predicted: number; actual: number }[]): number {
  if (rows.length === 0) return Number.POSITIVE_INFINITY;
  return rows.reduce((s, r) => s + Math.abs(r.predicted - r.actual), 0) / rows.length;
}

export interface CalibrationInput {
  bootstrap: FplBootstrap;
  fixtures: FplFixture[];
  historyByElement: Map<number, ElementHistoryRow[]>;
  fromEvent: number;
  toEvent: number;
  /** Restrict the sweep to these parameters. Defaults to all of them. */
  params?: TunableParam[];
  /** Absolute timestamp (Date.now() terms) after which no NEW parameter is
   * started. A sweep is easily the most expensive thing this project does
   * and it runs inside a serverless function with a hard wall — without a
   * budget, hitting that wall returns nothing at all, and a partial answer
   * is worth infinitely more than a timeout. */
  deadlineMs?: number;
}

/**
 * Replays every gameweek once per candidate value and scores each candidate
 * leave-one-gameweek-out.
 *
 * Cost: one full replay per candidate value per parameter. That is why the
 * grids are coarse and why this runs on demand rather than on page load.
 */
export function calibrate(input: CalibrationInput): CalibrationReport {
  const { bootstrap, fixtures, historyByElement, fromEvent, toEvent } = input;
  const paramNames = (input.params ??
    (Object.keys(PARAM_GRIDS) as TunableParam[])) as TunableParam[];

  // Replay once per candidate value, keeping the per-gameweek rows so folds
  // can be assembled without replaying again.
  const replay = (over: Partial<ModelParams>): Map<number, BacktestRow[]> => {
    const { rows } = collectBacktestRows({
      bootstrap,
      fixtures,
      historyByElement,
      fromEvent,
      toEvent,
      modelParams: over,
    });
    const byEvent = new Map<number, BacktestRow[]>();
    for (const r of rows) {
      if (!byEvent.has(r.event)) byEvent.set(r.event, []);
      byEvent.get(r.event)!.push(r);
    }
    return byEvent;
  };

  const baseline = replay({});
  const events = [...baseline.keys()].sort((a, b) => a - b);
  const totalRows = [...baseline.values()].reduce((s, v) => s + v.length, 0);

  const sufficientEvidence = events.length >= MIN_EVENTS && totalRows >= MIN_ROWS;
  const evidenceNote = sufficientEvidence
    ? `${events.length} jornadas e ${totalRows} previsões avaliadas — amostra suficiente para recomendar alterações.`
    : `Só ${events.length} jornada(s) e ${totalRows} previsões. São precisas pelo menos ${MIN_EVENTS} jornadas e ${MIN_ROWS} previsões: abaixo disso qualquer "melhor valor" encontrado é ruído, e um número com casas decimais é convincente precisamente por ser preciso. Nada é recomendado até lá.`;

  /** Mean absolute error per gameweek, for one candidate value. */
  const errorByEvent = (byEvent: Map<number, BacktestRow[]>): Map<number, number> => {
    const out = new Map<number, number>();
    for (const event of events) {
      const held = byEvent.get(event);
      if (held && held.length > 0) out.set(event, mae(held));
    }
    return out;
  };

  const baselineErrors = errorByEvent(baseline);
  const meanOver = (errs: Map<number, number>, exclude?: number): number => {
    const vals = [...errs.entries()]
      .filter(([e]) => e !== exclude)
      .map(([, v]) => v);
    if (vals.length === 0) return Number.POSITIVE_INFINITY;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };

  const results: ParamResult[] = [];
  const notCovered: TunableParam[] = [];
  for (const param of paramNames) {
    const grid = PARAM_GRIDS[param as keyof ModelParams];
    if (!grid) continue;
    // Checked BEFORE starting a parameter, never mid-parameter: a half-swept
    // parameter would report a "best value" chosen from part of its grid,
    // which is worse than not reporting it at all.
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      notCovered.push(param);
      continue;
    }
    const currentValue = DEFAULT_MODEL_PARAMS[param as keyof ModelParams] as number;

    // One replay per candidate value, kept as per-gameweek errors so the
    // folds below cost nothing extra.
    const errorsByValue = new Map<number, Map<number, number>>();
    for (const value of grid) {
      const isDefault = Math.abs(value - currentValue) < 1e-9;
      errorsByValue.set(
        value,
        isDefault
          ? baselineErrors
          : errorByEvent(replay({ [param]: value } as Partial<ModelParams>))
      );
    }

    // LEAVE ONE GAMEWEEK OUT, PROPERLY.
    //
    // For each gameweek in turn: choose the value using every OTHER
    // gameweek, then grade that choice on the one held out. A value that
    // only wins on the weeks it was picked from scores no better here than
    // the default — which is exactly the self-deception this guards against.
    //
    // An earlier version of this function averaged per-gameweek errors and
    // called it leave-one-out. It was not: the selection saw every week it
    // was then graded on. The comment promised a guard the code did not
    // implement, which is worse than having no guard, because it reads as
    // rigour.
    let sweptScore = 0;
    let defaultScore = 0;
    let folds = 0;
    const chosen: number[] = [];
    for (const held of events) {
      let bestVal = currentValue;
      let bestTrain = Number.POSITIVE_INFINITY;
      for (const value of grid) {
        const train = meanOver(errorsByValue.get(value)!, held);
        if (train < bestTrain) {
          bestTrain = train;
          bestVal = value;
        }
      }
      const heldErr = errorsByValue.get(bestVal)?.get(held);
      const heldDefault = baselineErrors.get(held);
      if (heldErr === undefined || heldDefault === undefined) continue;
      sweptScore += heldErr;
      defaultScore += heldDefault;
      chosen.push(bestVal);
      folds++;
    }

    const currentError = folds > 0 ? defaultScore / folds : meanOver(baselineErrors);
    const bestError = folds > 0 ? sweptScore / folds : currentError;
    const improvement =
      Number.isFinite(currentError) && currentError > 0
        ? (currentError - bestError) / currentError
        : 0;

    // The value to actually adopt: the one the folds agreed on most often.
    // If the folds disagree, that disagreement IS the finding — the data is
    // not yet telling us anything stable — and the tie goes to the default.
    const tally = new Map<number, number>();
    for (const v of chosen) tally.set(v, (tally.get(v) ?? 0) + 1);
    let bestValue = currentValue;
    let bestCount = 0;
    for (const [v, c] of tally) {
      if (c > bestCount) {
        bestCount = c;
        bestValue = v;
      }
    }
    const unanimous = folds > 0 && bestCount === folds;

    const curve: ParamCandidate[] = grid.map((value) => ({
      value,
      error: meanOver(errorsByValue.get(value)!),
      isDefault: Math.abs(value - currentValue) < 1e-9,
    }));

    let recommended = false;
    let reason: string;
    if (!sufficientEvidence) {
      reason = "Amostra insuficiente — ver a nota de evidência.";
    } else if (Math.abs(bestValue - currentValue) < 1e-9) {
      reason = "O valor atual já é o melhor de todos os testados.";
    } else if (!unanimous) {
      reason = `As jornadas não concordam entre si sobre o melhor valor (${bestCount} de ${folds} escolheram ${bestValue}). Essa discordância é o resultado: ainda não há sinal estável, só ruído.`;
    } else if (improvement < MIN_IMPROVEMENT) {
      reason = `Melhoria de apenas ${(improvement * 100).toFixed(1)}% — abaixo do limiar de ${(MIN_IMPROVEMENT * 100).toFixed(0)}%. O valor atual tem uma justificação por trás; não se troca por uma diferença desta dimensão.`;
    } else {
      recommended = true;
      reason = `Reduz o erro em ${(improvement * 100).toFixed(1)}%, medido fora da amostra e com todas as ${folds} jornadas a concordarem no mesmo valor.`;
    }

    results.push({
      param,
      currentValue,
      bestValue,
      currentError,
      bestError,
      improvement,
      recommended,
      reason,
      curve,
    });
  }

  return {
    ranAt: new Date().toISOString(),
    events,
    rows: totalRows,
    sufficientEvidence,
    evidenceNote,
    results,
    recommendations: results
      .filter((r) => r.recommended)
      .sort((a, b) => b.improvement - a.improvement),
    truncated: notCovered.length > 0,
    notCovered,
  };
}
