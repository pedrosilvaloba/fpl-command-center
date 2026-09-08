import type { DeferredPlan } from "@/lib/deferplan";

/**
 * O PLANO A DUAS SEMANAS.
 *
 * A app respondia sempre à mesma pergunta — "qual é a melhor jogada AGORA?"
 * — e nunca à que um gestor experiente faz primeiro: "e se guardar esta
 * semana para na próxima ter duas e meter os dois que quero?".
 *
 * Toda a representação dessa ideia era uma constante de 1,5 pontos pelo
 * valor abstrato de ter uma transferência no bolso. Nunca nomeava ninguém e
 * nunca sabia distinguir uma semana em que guardar não serve para nada de
 * uma em que guardar desbloqueia exatamente a dupla que o modelo quer.
 *
 * Este painel mostra as duas alternativas lado a lado, com nomes e números,
 * e diz qual ganha e porquê.
 */
export default function DeferralPanel({ plan }: { plan: DeferredPlan | null }) {
  if (!plan) return null;

  return (
    <div
      className={`rounded-md border px-4 py-3 ${
        plan.worthWaiting
          ? "border-accent/40 bg-accent/5"
          : "border-border"
      }`}
    >
      <p
        className={`eyebrow ${plan.worthWaiting ? "text-accent" : "text-text-muted"}`}
      >
        Esta semana ou a próxima
      </p>
      <p className="mt-0.5 text-[15px] font-semibold leading-snug text-text">
        {plan.headline}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div
          className={`rounded-md border px-3 py-2 ${
            plan.worthWaiting ? "border-border" : "border-accent/40 bg-accent/5"
          }`}
        >
          <p className="eyebrow text-text-muted">Mover agora</p>
          <p className="mt-0.5 font-mono text-[15px] font-semibold tabular text-text">
            {plan.nowGain >= 0 ? "+" : ""}
            {plan.nowGain.toFixed(1)} pts
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            {plan.nowMoves.length > 0 ? plan.nowMoves.join(" · ") : "não mexer"}
            {plan.nowHits > 0 && ` · ${plan.nowHits} hit`}
          </p>
        </div>
        <div
          className={`rounded-md border px-3 py-2 ${
            plan.worthWaiting ? "border-accent/40 bg-accent/5" : "border-border"
          }`}
        >
          <p className="eyebrow text-text-muted">
            Guardar · {plan.freeNextWeek} livres na próxima
          </p>
          <p className="mt-0.5 font-mono text-[15px] font-semibold tabular text-text">
            {plan.deferredGain >= 0 ? "+" : ""}
            {plan.deferredGain.toFixed(1)} pts
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            {plan.deferredMoves.length > 0
              ? plan.deferredMoves.join(" · ")
              : "nada"}
            {plan.deferredHits > 0 && ` · ${plan.deferredHits} hit`}
          </p>
        </div>
      </div>

      <p className="mt-2.5 text-[12px] leading-relaxed text-text-muted">
        {plan.detail}
      </p>
      {/* A assimetria é declarada, porque muda como se lê o número. O plano
          adiado é avaliado com a informação de HOJE; na próxima semana
          haverá notícias de equipa, lesões e mais uma jornada de dados. Ou
          seja, quando esta conta diz que esperar ganha, está a subestimar
          esperar — nunca a inflacioná-lo. */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted opacity-80">
        O plano da próxima semana é calculado com o que se sabe hoje. Como na
        próxima haverá mais informação, este número subestima o valor de
        esperar — o erro é para o lado seguro.
      </p>
    </div>
  );
}
