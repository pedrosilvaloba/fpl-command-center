import type { EventProjection } from "@/lib/chipschedule";
import type { ChipAdvice, CalendarContext } from "@/lib/chipplan";

/**
 * The chip panel. Its job is to answer one question per chip — play it or
 * wait — and to say what it is waiting FOR, because "wait" without a reason
 * is indistinguishable from the model having no opinion.
 */

const VERDICT_STYLE: Record<ChipAdvice["verdict"], string> = {
  jogar: "border-success/50 bg-success/10 text-success",
  esperar: "border-border bg-surface-2 text-text-muted",
  indisponível: "border-border bg-surface-2 text-text-muted opacity-60",
};

const VERDICT_LABEL: Record<ChipAdvice["verdict"], string> = {
  jogar: "jogar agora",
  esperar: "guardar",
  indisponível: "usado",
};

export default function ChipPlanPanel({
  advice,
  calendar,
  event,
  projections = [],
}: {
  advice: ChipAdvice[];
  calendar: CalendarContext;
  event: number;
  /** Valor projetado de cada chip por jornada. Ver lib/chipschedule.ts. */
  projections?: EventProjection[];
}) {
  const nextBreak = calendar.breakAfterEvents.find((e) => e >= event) ?? null;

  return (
    <div className="mb-5 rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base font-bold tracking-tight">Chips</h3>
        <p className="font-mono text-[11px] tabular text-text-muted">
          um chip é uma opção de um só uso — jogá-lo agora abdica da melhor semana
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {advice.map((a) => (
          <div
            key={a.chip}
            className={`rounded-lg border p-3 ${VERDICT_STYLE[a.verdict]}`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="font-display text-sm font-bold text-text">{a.label}</span>
              <span className="rounded-full border border-current px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                {VERDICT_LABEL[a.verdict]}
              </span>
            </div>
            {a.verdict !== "indisponível" && (
              <p className="mb-1 font-mono text-[11px] tabular text-text-muted">
                {/* Este número mudou de significado na v1.50 e o rótulo tinha
                    de mudar com ele. Dizia "numa dupla", porque era uma
                    constante fixa — o que o chip renderia numa jornada
                    dupla. Agora é o VALOR DE ESPERAR: quanto vale, em
                    pontos, continuar a guardar o chip em vez de o gastar
                    hoje, já a contar com quantas jornadas restam antes de
                    ele expirar. Manter o rótulo antigo sobre o número novo
                    seria o mesmo defeito de sempre — um ecrã a explicar uma
                    conta que já não é aquela. */}
                agora <strong className="text-text">{a.valueNow.toFixed(1)} pts</strong>
                {" · "}
                esperar vale{" "}
                <strong className="text-text">
                  {a.bestLaterValue.toFixed(1)} pts
                </strong>
                {a.bestLaterValue === 0 && " — última hipótese"}
              </p>
            )}
            <p className="text-xs leading-relaxed text-text-muted">{a.reason}</p>
          </div>
        ))}
      </div>

      {projections.length > 1 && (
        <div className="mt-4 border-t border-border pt-3">
          {/* "GUARDA" SEM UM ALVO É INDISTINGUÍVEL DE "NÃO SEI".
              O planeador já decidia bem QUANDO gastar, mas o "depois" era
              um número sem semana. Aqui está a semana. */}
          <p className="eyebrow mb-2 text-text-muted">
            O que cada chip renderia, jornada a jornada
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[12px] tabular">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="py-1 pr-3 font-normal">GW</th>
                  <th className="py-1 pr-3 text-right font-normal">Bench Boost</th>
                  <th className="py-1 pr-3 text-right font-normal">Triple Cap.</th>
                  <th className="py-1 font-normal">notas</th>
                </tr>
              </thead>
              <tbody>
                {projections.map((pr, i) => {
                  const bestBb = Math.max(
                    ...projections.slice(1).map((x) => x.benchBoost)
                  );
                  const bestTc = Math.max(
                    ...projections.slice(1).map((x) => x.tripleCaptain)
                  );
                  return (
                    <tr
                      key={pr.event}
                      className={`border-b border-border/50 ${i === 0 ? "text-text" : "text-text-muted"}`}
                    >
                      <td className="py-1 pr-3">
                        {pr.event}
                        {i === 0 && (
                          <span className="ml-1 text-[10px] text-accent">agora</span>
                        )}
                      </td>
                      <td
                        className={`py-1 pr-3 text-right ${i > 0 && pr.benchBoost === bestBb ? "font-semibold text-accent" : ""}`}
                      >
                        {pr.benchBoost.toFixed(1)}
                      </td>
                      <td
                        className={`py-1 pr-3 text-right ${i > 0 && pr.tripleCaptain === bestTc ? "font-semibold text-accent" : ""}`}
                      >
                        {pr.tripleCaptain.toFixed(1)}
                        {pr.captainName && (
                          <span className="ml-1 text-[10px] opacity-70">
                            {pr.captainName}
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-[11px]">
                        {pr.maxFixtures >= 2 && (
                          <span className="text-accent">jornada dupla · </span>
                        )}
                        {pr.blanking > 0 && `${pr.blanking} sem jogo`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
            Cada jogador é reescalado pela qualidade do calendário dessa
            semana, a partir dos seus pontos da próxima jornada. Assume que a
            forma não muda, só o adversário — o que é falso a cinco semanas,
            mas capta exatamente o que decide um chip: jornadas em branco
            (zero jogos) e duplas (dois). <strong className="text-text">Não
            ver nada de especial aqui não quer dizer que não venha</strong>:
            as duplas só entram no calendário poucas semanas antes.
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-xs text-text-muted">
        {nextBreak !== null && (
          <p>
            <strong className="text-warn">Paragem para seleções</strong> a seguir à
            jornada {nextBreak}. Reconstruções grandes ficam melhor depois dela:
            lesões ao serviço das seleções, reforços a assentar e sistemas a mudar
            só se sabem quando ela acaba.
          </p>
        )}
        {calendar.knownDoubleEvents.length > 0 ? (
          <p>
            Jornadas duplas já marcadas: {calendar.knownDoubleEvents.join(", ")}.
          </p>
        ) : (
          <p>
            Ainda não há jornadas duplas marcadas — só entram no calendário poucas
            semanas antes. Não haver nenhuma marcada não é sinal de que não venham.
          </p>
        )}
        {calendar.knownBlankEvents.length > 0 && (
          <p>Jornadas em branco já marcadas: {calendar.knownBlankEvents.join(", ")}.</p>
        )}
      </div>
    </div>
  );
}
