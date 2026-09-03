import type { FplBootstrap, FplElement } from "./types";

/**
 * OWNERSHIP MOMENTUM — the bandwagon, measured instead of felt.
 *
 * The request that produced this file: "há jogadores em grande forma que
 * todos começam a ter, não posso ignorar isso."
 *
 * That observation is right, but it contains two different things and only
 * one of them belongs in the scoring engine. Separating them is the whole
 * design of this module.
 *
 * WHAT IS *NOT* HERE, AND WHY: FORM AS A POINTS PREDICTOR.
 *
 * FPL's `form` field is mean points over the last four matches. Points are
 * lumpy — a goal is four or five of them — so a defender who scored once in
 * four games shows "form 4.5" without his underlying rate having moved at
 * all. Recent points are a weak predictor of future points next to expected
 * goals, expected assists and minutes, and the real part of form is ALREADY
 * in the model: `computePlayerRates` blends FPL's published per-90
 * underlying numbers with the player's own realised goals and assists, so a
 * player genuinely producing more is picked up through the mechanism that
 * produced the goals, not through the scoreline.
 *
 * Multiplying expected points by a form factor on top of that would count
 * the same evidence twice and import the noise with it. This module
 * therefore adds NOTHING to expected points. `form` stays what it is: a
 * display signal.
 *
 * WHAT *IS* HERE: THE BANDWAGON, WHICH IS REAL AND WAS IGNORED.
 *
 * The part of the observation that the model genuinely missed is not about
 * points at all — it is about RANK. FPL is a ranking game: a player owned by
 * half your league is not a neutral asset, he is a risk position. If he
 * hauls and you do not own him, you lose ground on a good week.
 *
 * The whole risk layer — the variance posture, the differential flags, the
 * rank-value model — read `selected_by_percent`, which is TODAY's ownership.
 * Ownership is a stock; the bandwagon is a flow. A player at 8% who is being
 * bought by 400,000 managers this week is not an 8% differential, he is a
 * 25% near-template asset by the deadline, and treating him as the former is
 * exactly how you end up on the wrong side of a bandwagon while a model
 * reassures you that you hold a differential.
 *
 * FPL publishes the flow: `transfers_in_event` and `transfers_out_event`,
 * net, against `total_players`. That is a direct measurement of what
 * everyone is about to own, and it needed no modelling at all — only
 * reading.
 */

export interface PlayerMomentum {
  elementId: number;
  /** Ownership FPL publishes right now, in percent. */
  ownershipPct: number;
  /** Change in ownership implied by this gameweek's net transfers, in
   * percentage points. Positive means the market is buying him. */
  trendPct: number;
  /** Where ownership is heading: today's plus the trend, clamped to 0-100. */
  projectedOwnershipPct: number;
  /** Net transfers this gameweek, as published. */
  netTransfers: number;
  /** A plain label for the UI and for the reasons list. */
  label: "em alta forte" | "em alta" | "estável" | "em queda" | "em queda forte";
}

/** Ownership-point moves smaller than this are indistinguishable from the
 * ordinary churn of ten million managers and are called stable. */
const NOISE_PCT = 0.5;
const STRONG_PCT = 2;

function classify(trendPct: number): PlayerMomentum["label"] {
  if (trendPct >= STRONG_PCT) return "em alta forte";
  if (trendPct >= NOISE_PCT) return "em alta";
  if (trendPct <= -STRONG_PCT) return "em queda forte";
  if (trendPct <= -NOISE_PCT) return "em queda";
  return "estável";
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

export function computeMomentum(bootstrap: FplBootstrap): Map<number, PlayerMomentum> {
  const out = new Map<number, PlayerMomentum>();
  // `total_players` is the number of managers in the game. Without it the
  // flow cannot be converted into ownership points, so degrade to "no
  // trend" rather than inventing a denominator.
  const managers = num(bootstrap.total_players);
  for (const el of bootstrap.elements as FplElement[]) {
    const ownershipPct = num(el.selected_by_percent);
    const netTransfers = num(el.transfers_in_event) - num(el.transfers_out_event);
    const trendPct =
      managers > 0 ? Math.round((netTransfers / managers) * 1000) / 10 : 0;
    out.set(el.id, {
      elementId: el.id,
      ownershipPct,
      trendPct,
      projectedOwnershipPct: Math.min(100, Math.max(0, ownershipPct + trendPct)),
      netTransfers,
      label: classify(trendPct),
    });
  }
  return out;
}

/**
 * The line the app should show about a player's momentum, or null when
 * nothing is happening. Deliberately says what it means for the DECISION,
 * not just what the number is — "500k a comprar" tells you nothing on its
 * own.
 */
export function momentumReason(m: PlayerMomentum): string | null {
  if (m.label === "estável") return null;
  const arrow = m.trendPct > 0 ? "+" : "";
  const base = `posse ${m.label}: ${arrow}${m.trendPct.toFixed(1)} pontos percentuais esta jornada (${m.ownershipPct.toFixed(1)}% → ~${m.projectedOwnershipPct.toFixed(1)}%)`;
  if (m.trendPct >= STRONG_PCT) {
    return `${base} — deixa de ser diferencial: não o ter passa a ser um risco de ranking, não uma escolha neutra`;
  }
  if (m.trendPct <= -STRONG_PCT) {
    return `${base} — o mercado está a sair; tê-lo passa a ser mais diferencial do que era`;
  }
  return base;
}
