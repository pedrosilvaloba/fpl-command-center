import type { DecisionHistory } from "@/lib/decisions";

/**
 * SEGUIR A APP TERIA DADO MAIS PONTOS?
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
          face ao que fizeste.
        </p>
      )}
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
                <td className="py-1.5 pr-3 text-right font-mono">{r.outcome ? r.outcome.app.points : "—"}</td>
                <td className="py-1.5 pr-3 text-right font-mono">{r.outcome ? r.outcome.pedro.points : "—"}</td>
                <td
                  className={`py-1.5 text-right font-mono ${
                    !r.outcome ? "text-text-muted" : r.outcome.diff >= 0 ? "text-accent" : "text-danger"
                  }`}
                >
                  {r.outcome ? `${r.outcome.diff >= 0 ? "+" : ""}${r.outcome.diff}` : "aberta"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
