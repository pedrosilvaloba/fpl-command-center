import type { ForwardHistory, ForwardResult } from "@/lib/forwardbenchmark";

const fmt = (n: number) => Number.isFinite(n) ? n.toFixed(2) : "—";

function OneEvent({ row }: { row: ForwardResult }) {
  const values = [
    { label: "Motor próprio", score: row.model, cap: row.captain.model },
    { label: "Média pts/jogo", score: row.ppg, cap: row.captain.ppg },
    { label: "Previsão FPL", score: row.fpl, cap: row.captain.fpl },
  ];
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-semibold text-text">GW{row.event} — previsão congelada</h4>
        <span className="text-xs text-text-muted">
          {new Date(row.capturedAt).toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "short" })}
          {" · "}{row.eligible} jogadores avaliados
        </span>
      </div>
      <div className="scroll-x">
        <table className="w-full text-left text-[12px]">
          <thead><tr className="text-text-muted">
            <th className="py-1.5">Referência</th>
            <th className="py-1.5 text-right">N</th>
            <th className="py-1.5 text-right">MAE</th>
            <th className="py-1.5 text-right">Spearman</th>
            <th className="py-1.5 text-right">Viés</th>
            <th className="py-1.5 text-right">Capitão (pontos)</th>
          </tr></thead>
          <tbody>{values.map((v) => (
            <tr key={v.label} className="border-t border-border/60">
              <td className="py-2 font-medium">{v.label}</td>
              <td className="py-2 text-right font-mono">{v.score.n}</td>
              <td className="py-2 text-right font-mono">{v.score.n ? fmt(v.score.mae) : "—"}</td>
              <td className="py-2 text-right font-mono">{v.score.n >= 3 ? fmt(v.score.spearman) : "—"}</td>
              <td className="py-2 text-right font-mono">{v.score.n ? fmt(v.score.bias) : "—"}</td>
              <td className="py-2 text-right">{v.cap ? v.cap.name + " (" + v.cap.points + ")" : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {row.fpl.n !== row.model.n && <p className="mt-2 text-xs text-text-muted">
        Previsão FPL disponível para {row.fpl.n}/{row.model.n} jogadores; os MAE não são diretamente comparáveis sem a mesma amostra.
      </p>}
    </div>
  );
}

export default function ForwardBenchmarkPanel({ history }: { history: ForwardHistory }) {
  if (!history.configured) return <p className="text-sm text-text-muted">
    O benchmark prospetivo requer armazenamento persistente. Não há resultados guardados.
  </p>;
  if (!history.rows.length) return <div className="rounded-lg border border-border p-3 text-sm text-text-muted">
    Ainda sem jornadas concluídas com previsões congeladas antes do deadline.
    A partir desta versão, as visitas antes do deadline guardam as previsões do motor,
    a média de pontos/jogo e a previsão FPL; a comparação é feita depois da jornada terminar.
    {history.pending.length > 0 && <span> Aguardam resultados: GW{history.pending.join(", GW")}.</span>}
  </div>;

  return <div className="space-y-3">
    <p className="text-xs leading-relaxed text-text-muted">
      Dados guardados antes dos jogos; jogadores incluídos pela probabilidade e minutos esperados ANTES da jornada.
      MAE mais baixo e Spearman mais alto são preferíveis. São métricas de previsões,
      não uma prova de que as transferências ou os chips renderam mais pontos.
      Uma jornada isolada não comprova superioridade.
    </p>
    {history.rows.slice(0, 6).map((row) => <OneEvent key={row.event} row={row} />)}
  </div>;
}
