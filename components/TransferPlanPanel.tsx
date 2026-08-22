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
  out: { name: string; team: string; type: number; price: number };
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
          <span className="font-mono text-xs opacity-80">£{out.price.toFixed(1)}m</span>
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

      <p className="text-xs leading-relaxed text-text-muted">{plan.rationale}</p>
      <p className="mt-2 font-mono text-[11px] tabular text-text-muted">
        Capitão: {plan.captain?.element.web_name ?? "—"} · Vice:{" "}
        {plan.viceCaptain?.element.web_name ?? "—"} · Saldo depois: £
        {plan.bankAfterM.toFixed(1)}m
      </p>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        {label}
      </p>
      <p className="mt-0.5 font-display text-lg font-bold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-text-muted">{hint}</p>}
    </div>
  );
}

export default function TransferPlanPanel({
  advice,
  state,
}: {
  advice: TransferAdvice;
  state: SquadState;
}) {
  if (!advice.available || !advice.recommended) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">{advice.reason}</p>
        <p className="text-xs leading-relaxed text-text-muted">
          Enquanto não houver plantel real, a app mostra o plantel ideal para o
          orçamento inicial — útil como referência, mas não é um plano: numa
          época a decorrer partes sempre da equipa que já tens, com o número
          de transferências que tens.
        </p>
      </div>
    );
  }

  const chipsLeft = state.chips.filter((c) => c.remaining > 0);

  return (
    <div className="flex flex-col gap-5">
      {/* --- the instruction ---------------------------------------------- */}
      <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] p-4">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-accent">
          Curto prazo · esta jornada
        </p>
        <p className="text-base font-semibold leading-relaxed">{advice.shortTerm}</p>
      </div>

      {/* --- squad facts --------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Fact
          label="Transferências livres"
          value={String(state.freeTransfers)}
          hint={`Máx. 5 acumuláveis`}
        />
        <Fact
          label="Valor + saldo"
          value={`£${state.totalBudgetM.toFixed(1)}m`}
          hint={`£${state.squadValueM.toFixed(1)}m equipa · £${state.bankM.toFixed(1)}m banco`}
        />
        <Fact
          label="Plantel lido de"
          value={state.fromEvent ? `GW${state.fromEvent}` : "—"}
          hint="A FPL só publica depois do fecho"
        />
        <Fact
          label="Chips por usar"
          value={chipsLeft.length > 0 ? String(chipsLeft.reduce((s, c) => s + c.remaining, 0)) : "0"}
          hint={
            chipsLeft.length > 0
              ? chipsLeft.map((c) => `${c.label}${c.remaining > 1 ? `×${c.remaining}` : ""}`).join(", ")
              : "Todos gastos"
          }
        />
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
