/**
 * Hand-maintained table of QUALITATIVE, tactical/managerial adjustments —
 * the kind of insight that doesn't live in any API field: a manager's
 * substitution habits, a team's attacking-vs-defensive identity, a
 * player's role changing after a new signing, and so on.
 *
 * Why this file exists: every other signal in this model (lib/playerthreat
 * .ts, lib/teamrating.ts, lib/matchmodel.ts) is derived automatically from
 * FPL's own data or betting-market odds. That covers a lot, but it
 * structurally can't capture things like "Arteta has a pattern of pulling
 * Rice at ~55min in games that are already won, so he's a weaker asset
 * than his start-count alone suggests" or "Man United play an open,
 * high-event style this season — concede a lot, but also score a lot" —
 * these are judgment calls a human analyst (or an AI doing real research:
 * match reports, tactical write-ups, press-conference notes) makes by
 * actually watching/reading about the games, not something derivable from
 * a stats API. This is exactly the differentiation the project's owner
 * asked for: a genuinely qualitative research layer on top of the
 * quantitative model, not a replacement for it.
 *
 * Deliberately NOT auto-written by an unsupervised process. The intended
 * workflow is: a periodic research pass (see the weekly scheduled research
 * task set up alongside this file) proposes candidate entries with their
 * sourcing, a human (Pedro) reviews them, and they get added here through
 * the normal code-review/deploy flow — same transparency principle as
 * every other part of this model (nothing invisible, nothing that can't be
 * traced back to a stated reason). Treat every entry as an editorial
 * call with an expiry: tactical patterns change (new signings, injuries,
 * a manager changing his approach after criticism), so `addedDate` is
 * there to make stale entries easy to spot and prune, not just decoration.
 *
 * `factor` is a direct multiplier on the player's/team's raw score in
 * lib/recommend.ts — keep adjustments modest (roughly 0.8-1.2, i.e. +-20%)
 * so this stays a nudge on top of the quantitative model rather than a
 * substitute for it. A pattern strong enough to justify more than that
 * is almost always better expressed by fixing the underlying model
 * instead (see e.g. the minutes-per-start reliability fix in
 * lib/playerthreat.ts, which grew directly out of the Rice example below
 * and needed no manual table entry at all once it existed as real logic).
 */

export interface ManagerInsight {
  scope: "player" | "team";
  // element id (scope "player") or team id (scope "team") — the FPL
  // bootstrap ids, same ones already used everywhere else in this app.
  id: number;
  // Human-readable label only — never read by the scoring logic, purely
  // so this file stays legible/reviewable without cross-referencing ids.
  label: string;
  factor: number;
  reason: string;
  // When this was added or last reconfirmed — review anything older than
  // a few months, and definitely re-check after a managerial change.
  addedDate: string;
  // Where this judgment came from — a specific search finding, a match
  // watched, a pundit note. Kept honest and checkable, not "AI vibes".
  source: string;
}

// Empty by default — this ships with no qualitative overrides baked in
// (nothing was fabricated to fill the table), populated over time via the
// weekly research pass + manual review. Example shape, kept commented out
// as a template:
//
// {
//   scope: "player",
//   id: 123456,
//   label: "Rice (ARS)",
//   factor: 0.9,
//   reason: "padrão de substituição cedo em jogos já resolvidos (Arteta)",
//   addedDate: "2026-08-28",
//   source: "análise semanal — relatórios de jogo das últimas 4 jornadas",
// },
export const MANAGER_INSIGHTS: ManagerInsight[] = [];

export function getManagerInsights(
  scope: "player" | "team",
  id: number
): ManagerInsight[] {
  return MANAGER_INSIGHTS.filter((i) => i.scope === scope && i.id === id);
}

/** Convenience for building a reason string consistently wherever this is surfaced. */
export function formatInsightReason(insight: ManagerInsight): string {
  return `${insight.reason} (nota qualitativa, ${insight.addedDate})`;
}
