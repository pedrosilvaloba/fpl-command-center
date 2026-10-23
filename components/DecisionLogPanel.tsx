import type { DecisionHistory } from "@/lib/decisions";

/**
 * A SIMULAÇÃO DA APP TERIA DADO MAIS PONTOS?
 *
 * A única pergunta que decide se vale a pena melhorar este modelo — e até
 * à v1.62 não tinha resposta. Uma linha por jornada: o onze e o capitão que
 * a app aconselhava contra os teus, pela mesma regra (titulares, capitão a
 * dobrar, menos hits; sem substituições automáticas de nenhum dos lados).
 */
export default function DecisionLogPanel({
  history,
  names,
}: {
  history: DecisionHistory;
  names: Map<number, string>;
}) {
  if (!history.configured) {
    return <p className="text-sm text-text-muted">Precisa do armazenamento ligado para guardar os conselhos.</p>;
  }
  if (history.rows.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        O registo começou agora: o conselho desta jornada fica guardado até ao deadline e é comparado com o
        que fizeste quando a jornada terminar.
      </p>
    );
  }
  const n = (id: number | null) => (id === null ? "—" : (names.get(id) ?? `#${id}`));
  return (
    <div className="space-y-3">
      {history.settled > 0 && (
        <p className="text-[14px] text-text">
          Em {history.settled} jornada{history.settled === 1 ? "" : "s"} fechada
          {history.settled === 1 ? "" : "s"}, seguir a app teria dado{" "}
          <b className={history.totalDiff >= 0 ? "text-accent" : "text-danger"}>
            {history.totalDiff >= 0 ? "+" : ""}
            {history.totalDiff} pts
          </b>{" "}
          face aos multiplicadores da tua equipa na API (comparação simulada, não transferências executadas).
        </p>
      )}
      <p className="text-xs leading-relaxed text-text-muted">
        Apenas jornadas com dados de minutos completos, substituições calculadas e
        pontuação que coincide com o valor oficial entram no acumulado.
        Os registos antigos continuam visíveis, mas não provam vantagem real.
        A coluna “vs. manter” confronta o conselho da app com o plantel sem transferências, ambos registados antes do deadline. Um plantel teórico pode não ser financeiramente executável.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-[12px]">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-1 pr-3 font-medium">GW</th>
              <th className="py-1 pr-3 font-medium">Capitão app</th>
              <th className="py-1 pr-3 font-medium">Teu capitão</th>
              <th className="py-1 pr-3 text-right font-medium">Onze app</th>
              <th className="py-1 pr-3 text-right font-medium">Teu onze</th>
              <th className="py-1 text-right font-medium">Diferença</th>
              <th className="py-1 text-right font-medium">vs. manter</th>
            </tr>
          </thead>
          <tbody>
            {history.rows.map((r) => (
              <tr key={r.event} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono">{r.event}</td>
                <td className="py-1.5 pr-3">
                  {n(r.advice?.captain ?? null)}
                  {r.outcome ? ` (${r.outcome.app.captainPts})` : ""}
                </td>
                <td className="py-1.5 pr-3">
                  {r.outcome ? `${n(r.outcome.pedro.captain)} (${r.outcome.pedro.captainPts})` : "por jogar"}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">{r.outcome?.settlement ? r.outcome.settlement.simulated : "—"}</td>
                <td className="py-1.5 pr-3 text-right font-mono">{r.outcome?.settlement ? r.outcome.settlement.actualViaMultipliers : "—"}</td>
                <td
                  className={`py-1.5 text-right font-mono ${
                    !r.outcome?.settlement || Math.abs(r.outcome.settlement.officialDelta) > 1 ? "text-text-muted" : r.outcome.settlement.netDifference >= 0 ? "text-accent" : "text-danger"
                  }`}
                >
                  {r.outcome?.settlement && Math.abs(r.outcome.settlement.officialDelta) <= 1
                    ? `${r.outcome.settlement.netDifference >= 0 ? "+" : ""}${r.outcome.settlement.netDifference}`
                    : r.outcome ? "indicativa" : "aberta"}
                </td>
                <td className="py-1.5 text-right font-mono text-text-muted">
                  {r.outcome?.settlement?.gainVsHold !== undefined
                    ? `${r.outcome.settlement.gainVsHold >= 0 ? "+" : ""}${r.outcome.settlement.gainVsHold}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
