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
      {row.fullCohort && (
        <details className="mt-3 rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-text">
            Ver todos os jogadores e risco de minutos
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-text-muted">
              Amostra completa ({row.fullCohort.model.n} jogadores): modelo MAE
              {" "}{fmt(row.fullCohort.model.mae)}, média pts/jogo
              {" "}{fmt(row.fullCohort.ppg.mae)}, FPL
              {" "}{row.fullCohort.fpl.n ? fmt(row.fullCohort.fpl.mae) : "—"}.
            </p>
            {(row.availabilityBands ?? []).map((band) => (
              <div key={band.label} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 py-1 text-xs">
                <span>{band.label} · {band.model.n} jogadores</span>
                <span className="font-mono">MAE modelo {band.model.n ? fmt(band.model.mae) : "—"}</span>
              </div>
            ))}
            <p className="text-xs text-text-muted">
              Os grupos são definidos ANTES do jogo e incluem quem acabou com zero pontos.
              Não usar uma amostra de prováveis titulares para declarar precisão em lesões e rotações.
            </p>
          </div>
        </details>
      )}
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

  const rows = history.rows.filter(r=>
    r.captain.model && r.captain.ppg && r.captain.fpl &&
    r.model.n >= 10 && r.ppg.n >= 10 && r.fpl.n >= 10
  );
  const sum=(key:"model"|"ppg"|"fpl")=>
    rows.reduce((v,r)=>v+(r.captain[key]?.points??0),0);
  const delta=(reference:"ppg"|"fpl")=>rows.map(r=>
    (r.captain.model?.points??0)-(r.captain[reference]?.points??0)
  );
  const total=(values:number[])=>values.reduce((a,b)=>a+b,0);
  return <div className="space-y-3">
    <div className="rounded-lg border border-border p-3 space-y-2">
      <h4 className="font-semibold text-sm">Capitania: comparação em condições equivalentes</h4>
      {rows.length ? <>
        <div className="grid grid-cols-3 gap-2">
          <div><p className="text-xs text-text-muted">Modelo próprio</p><p className="font-mono text-lg font-semibold">{sum("model")}</p></div>
          <div><p className="text-xs text-text-muted">Capitão por PPG</p><p className="font-mono text-lg font-semibold">{sum("ppg")}</p></div>
          <div><p className="text-xs text-text-muted">Capitão por FPL</p><p className="font-mono text-lg font-semibold">{sum("fpl")}</p></div>
        </div>
        <p className="text-xs text-text-muted">
          {rows.length} jornadas com os três capitães elegíveis arquivados antes do deadline.
          Diferença modelo − PPG: {total(delta("ppg"))>=0?"+":""}{total(delta("ppg"))} pontos
          {" · "}modelo − FPL: {total(delta("fpl"))>=0?"+":""}{total(delta("fpl"))} pontos.
          São pontos-base do capitão, sem multiplicador, chips nem mudança de plantel.
        </p>
        {rows.length<10&&<p className="text-xs text-warn">
          Ainda não existe amostra de jornadas suficiente para declarar vantagem de capitania.
        </p>}
      </>:<p className="text-sm text-text-muted">
        Ainda não existem jornadas com um plantel pré-deadline e os três métodos comparáveis.
        Não é possível concluir que o capitão do modelo tenha tido melhor desempenho.
      </p>}
    </div>
    <p className="text-xs leading-relaxed text-text-muted">
      Dados guardados antes dos jogos; jogadores incluídos pela probabilidade e minutos esperados ANTES da jornada.
      MAE mais baixo e Spearman mais alto são preferíveis. São métricas de previsões,
      não uma prova de que as transferências ou os chips renderam mais pontos.
      Uma jornada isolada não comprova superioridade.
    </p>
    {history.rows.slice(0, 6).map((row) => <OneEvent key={row.event} row={row} />)}
  </div>;
}
