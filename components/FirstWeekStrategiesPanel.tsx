import type { FirstWeekComparison, FirstWeekStrategy } from "@/lib/firstweekstrategies";

const labels:Record<FirstWeekStrategy,string>={
  hold:"Guardar FT",free:"Transferir sem hit",hit:"Aceitar hit"
};
export default function FirstWeekStrategiesPanel({comparison,teamId,horizon}:{
  comparison:FirstWeekComparison|null;teamId:number;horizon:number;
}) {
  const url=`/?team=${teamId}&view=simular&horizonte=${horizon}&comparar=1#comparar-primeira-jornada`;
  return <section id="comparar-primeira-jornada" className="mt-4 rounded-xl border border-border p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-sm font-bold">Guardar, transferir ou aceitar hit?</h3>
        <p className="text-xs text-text-muted">Mesma janela e mesmas previsões; três pesquisas independentes.</p>
      </div>
      {!comparison && <a href={url} className="rounded-lg border border-accent px-3 py-2 text-xs font-semibold text-accent">
        Comparar estratégias
      </a>}
    </div>
    {comparison && <>
      <div className="grid gap-2 md:grid-cols-3">
        {comparison.scenarios.map(s=><div key={s.strategy}
          className={`rounded-lg p-3 border ${s.strategy===comparison.preferred?"border-accent bg-accent/5":"border-border"}`}>
          <p className="text-sm font-semibold">{labels[s.strategy]}</p>
          {s.feasible ? <>
            <p className="mt-1 text-lg font-mono font-semibold">{s.totalNetPoints!.toFixed(1)} <span className="text-xs font-normal">pts</span></p>
            <p className="mt-1 text-xs text-text-muted">{s.firstWeekTransfers} transferências · {s.firstWeekHitCost? `Hit -${s.firstWeekHitCost}`:"Sem hit"}</p>
            <p className="text-xs text-text-muted">FT após GW: {s.freeAfterFirstWeek}</p>
          </>:<p className="mt-2 text-xs text-text-muted">Sem percurso viável na pesquisa limitada.</p>}
          {s.strategy===comparison.preferred && <p className="mt-2 text-xs font-semibold text-accent">Melhor projeção encontrada</p>}
        </div>)}
      </div>
      {comparison.preferred && <p className="text-sm">
        Melhor percurso encontrado: <strong>{labels[comparison.preferred]}</strong>.
        {" "}Não é garantia de mais pontos reais nem uma ordem para transferir.
      </p>}
      <p className="text-xs text-text-muted">{comparison.note}</p>
      <a href={`/?team=${teamId}&view=simular&horizonte=${horizon}#plano-multiplo`}
        className="inline-block text-xs text-accent underline">Fechar comparação</a>
    </>}
  </section>;
}
