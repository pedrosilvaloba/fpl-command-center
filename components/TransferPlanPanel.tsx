import type { TransferAdvice, TransferPlan } from "@/lib/transferplan";
import type { SquadState } from "@/lib/squadstate";
import ClubKit from "./ClubKit";

/**
 * The answer to the only question that matters before a deadline: what do I
 * actually do?
 *
 * Everything above this in the app is analysis. This is the instruction. It
 * leads with one recommendation stated plainly enough to act on without
 * reading anything else, and puts the alternatives underneath with the
 * arithmetic that ranked them — including "do nothing", which competes on
 * equal terms and often wins.
 */

function Move({
  out,
  into,
  gain,
  cashDeltaM,
  urgency,
}: {
  out: { name: string; team: string; type: number; price: number; sellingPrice?: number };
  into: { name: string; team: string; type: number; price: number };
  gain: number;
  cashDeltaM: number;
  urgency: string | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      {/* Two labelled rows on a phone, one arrowed line on a laptop. A single
          wrapping row put the arrow at the end of the first line, pointing at
          nothing — which is exactly the kind of small wrongness that makes an
          instruction hard to trust. */}
      <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <span className="inline-flex items-center gap-1.5 text-danger">
          <span className="w-9 shrink-0 text-[10px] font-bold uppercase tracking-wide opacity-70 sm:hidden">
            sai
          </span>
          <ClubKit shortName={out.team} isKeeper={out.type === 1} size={20} />
          <span className="font-semibold line-through decoration-2">{out.name}</span>
          {/* The SALE price, which is what pays for the incoming player. When
              FPL's half-refund rule makes it lower than the listed price, both
              are shown — hiding the gap is what makes a plan look affordable
              when it is not. */}
          <span className="font-mono text-xs opacity-80">
            £{(out.sellingPrice ?? out.price).toFixed(1)}m
            {out.sellingPrice !== undefined &&
              Math.abs(out.sellingPrice - out.price) > 0.049 && (
                <span className="opacity-70"> (mercado £{out.price.toFixed(1)}m)</span>
              )}
          </span>
        </span>
        <span aria-hidden className="hidden text-text-muted sm:inline">
          →
        </span>
        <span className="inline-flex items-center gap-1.5 text-accent">
          <span className="w-9 shrink-0 text-[10px] font-bold uppercase tracking-wide opacity-70 sm:hidden">
            entra
          </span>
          <ClubKit shortName={into.team} isKeeper={into.type === 1} size={20} />
          <span className="font-bold">{into.name}</span>
          <span className="font-mono text-xs opacity-80">£{into.price.toFixed(1)}m</span>
        </span>
        <span className="mt-1 flex items-center gap-3 font-mono text-xs tabular text-text-muted sm:mt-0 sm:ml-auto">
          <span className={gain >= 0 ? "text-success" : "text-danger"}>
            {gain >= 0 ? "+" : ""}
            {gain.toFixed(1)} pts / 5 jorn.
          </span>
          <span>
            {cashDeltaM >= 0 ? "+" : ""}
            £{cashDeltaM.toFixed(1)}m
          </span>
        </span>
      </div>
      {urgency && (
        <p className="mt-2 border-t border-border pt-2 text-xs text-warn">⏱ {urgency}</p>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  isRecommended,
}: {
  plan: TransferPlan;
  isRecommended: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        isRecommended
          ? "border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))]"
          : "border-border bg-surface-2"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2">
          {isRecommended && (
            <span className="rounded-full bg-accent-vivid px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-accent-contrast">
              recomendado
            </span>
          )}
          <span className="font-display text-base font-bold tracking-tight">
            {plan.label}
          </span>
        </span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs tabular">
          <span className="whitespace-nowrap text-text-muted">
            11 em 5 jorn.:{" "}
            <strong className="text-text">{plan.xiWindowPoints.toFixed(1)}</strong>
          </span>
          {plan.hitCost > 0 && (
            <span className="whitespace-nowrap text-danger">−{plan.hitCost} hit</span>
          )}
          <span
            className={`whitespace-nowrap ${
              plan.netGainVsHold > 0
                ? "font-bold text-success"
                : plan.netGainVsHold < 0
                  ? "text-danger"
                  : "text-text-muted"
            }`}
          >
            {plan.netGainVsHold >= 0 ? "+" : ""}
            {plan.netGainVsHold.toFixed(1)} vs manter
          </span>
        </span>
      </div>

      {plan.moves.length > 0 ? (
        <div className="mb-2 flex flex-col gap-2">
          {plan.moves.map((m, i) => (
            <Move
              key={i}
              out={{
                name: m.out.element.web_name,
                team: m.out.team.short_name,
                type: m.out.element.element_type,
                price: m.out.priceM,
                sellingPrice: m.outSellingPriceM,
              }}
              into={{
                name: m.in.element.web_name,
                team: m.in.team.short_name,
                type: m.in.element.element_type,
                price: m.in.priceM,
              }}
              gain={m.gain}
              cashDeltaM={m.cashDeltaM}
              urgency={m.urgency}
            />
          ))}
        </div>
      ) : (
        <p className="mb-2 text-sm text-text-muted">Nenhuma transferência.</p>
      )}

      {/* Confidence, in plain language. The model blends its own numbers with
          FPL's `ep_next` by minutes played, so early in a season most of what
          it "knows" is FPL's flat league-wide estimate. Hiding that made a
          +0.4 point difference look like a recommendation. */}
      {plan.confidence < 0.9 && (
        <p className="mb-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-text-muted">
          <strong className="text-warn">
            Confiança do modelo: {Math.round(plan.confidence * 100)}%
          </strong>{" "}
          — o resto vem da estimativa da própria FPL, que é quase igual para
          toda a gente nesta altura da época. Por isso este plano só é
          recomendado se ganhar mais de{" "}
          <strong className="text-text">{plan.requiredEdge.toFixed(1)} pts</strong> sobre
          não fazer nada.
        </p>
      )}
      <p className="text-xs leading-relaxed text-text-muted">{plan.rationale}</p>
      <p className="mt-2 font-mono text-[11px] tabular text-text-muted">
        Capitão: {plan.captain?.element.web_name ?? "—"} · Vice:{" "}
        {plan.viceCaptain?.element.web_name ?? "—"} · Saldo depois: £
        {plan.bankAfterM.toFixed(1)}m
      </p>
    </div>
  );
}

export default function TransferPlanPanel({
  advice,
  state,
  fallback,
}: {
  advice: TransferAdvice;
  state: SquadState;
  /** What to show when there is no real squad to plan from. Showing the
   * eleven the model would pick is far more useful than an apology, and it
   * keeps the most valuable thing on the page above the fold instead of
   * burying it under a paragraph explaining what is missing. */
  fallback?: React.ReactNode;
}) {
  if (!advice.available || !advice.recommended) {
    return (
      <div className="flex flex-col gap-4">
        {fallback}
        <p className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-muted">
          <strong className="text-text">Porque não há plano de transferências:</strong>{" "}
          {advice.reason} Assim que houver, esta secção passa a dizer
          exatamente que trocas fazer, quantos pontos valem e se compensa
          pagar um hit.
        </p>
      </div>
    );
  }

  const chipsLeft = state.chips.filter((c) => c.remaining > 0);

  return (
    <div className="flex flex-col gap-5">
      {/* --- squad facts ----------------------------------------------------
          One inline row, not four bordered tiles. Two of those tiles repeated
          numbers the decision card above already states, and the other two are
          context rather than headlines. */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[13px] text-text-muted">
        <span>
          Plantel lido da{" "}
          <strong className="text-text">
            {state.fromEvent ? `jornada ${state.fromEvent}` : "—"}
          </strong>
        </span>
        <span>
          Saldo <strong className="text-text">£{state.bankM.toFixed(1)}m</strong> em £
          {state.squadValueM.toFixed(1)}m de equipa
        </span>
        <span>
          Chips por usar:{" "}
          <strong className="text-text">
            {chipsLeft.length > 0
              ? chipsLeft
                  .map((c) => `${c.label}${c.remaining > 1 ? ` \u00d7${c.remaining}` : ""}`)
                  .join(", ")
              : "nenhum"}
          </strong>
        </span>
      </div>

      {/* --- the options --------------------------------------------------- */}
      <div className="flex flex-col gap-3">
        {advice.plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            isRecommended={plan.key === advice.recommended!.key}
          />
        ))}
      </div>

      {/* --- horizons ------------------------------------------------------ */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface-2 p-4">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-cyan">
            Médio prazo · 5 jornadas
          </p>
          <p className="text-sm leading-relaxed text-text-muted">{advice.mediumTerm}</p>
        </div>
        <div
          className={`rounded-xl border p-4 ${
            advice.wildcard?.advise
              ? "border-[color-mix(in_srgb,var(--warn)_50%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))]"
              : "border-border bg-surface-2"
          }`}
        >
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-warn">
            Longo prazo · estrutura e chips
          </p>
          <p className="text-sm leading-relaxed text-text-muted">{advice.longTerm}</p>
          {/* The model saying out loud that it is over-reaching. A forecast of
              ninety points a gameweek should never quietly justify spending a
              chip — see lib/selection.ts. */}
          {advice.wildcard?.overreach && (
            <p className="mt-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-text-muted">
              <strong className="text-danger">Atenção ao número.</strong>{" "}
              {advice.wildcard.overreach}
            </p>
          )}
        </div>
      </div>

      {/* --- the honest small print ---------------------------------------- */}
      <div className="rounded-lg border border-border bg-surface-2 p-4 text-xs leading-relaxed text-text-muted">
        <p className="mb-2">
          <strong className="text-text">Como os planos são comparados.</strong>{" "}
          Cada um é avaliado pelos pontos esperados do onze ao longo de{" "}
          <strong>5 jornadas</strong>, menos o custo de qualquer hit. O
          horizonte é de 5 jornadas de propósito: um hit é um custo único pago
          contra um benefício que se repete, por isso compará-lo só com a
          próxima jornada rejeitaria transferências claramente certas.
        </p>
        <p className="mb-2">
          <strong className="text-text">Transferências livres:</strong>{" "}
          {state.freeTransfersNote}
        </p>
        {state.sellingPriceIsEstimated && (
          <p className="mb-2">
            <strong className="text-text">Preços de venda:</strong>{" "}
            {state.sellingPriceNote}
          </p>
        )}
        <p>
          <strong className="text-text">Uma limitação real:</strong> a API
          pública da FPL só publica o plantel de um gestor depois de a jornada
          fechar, por isso o ponto de partida é o teu onze da GW
          {state.fromEvent}. Se já fizeste transferências esta semana, elas
          ainda não aparecem aqui e os planos acima podem repetir uma jogada
          que já fizeste.
        </p>
      </div>
    </div>
  );
}
