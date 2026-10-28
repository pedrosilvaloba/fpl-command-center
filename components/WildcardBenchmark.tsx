"use client";
import type { WildcardAlternative } from "@/lib/wildcardalternatives";
import type { ScenarioView } from "@/lib/chipscenarioview";

export default function WildcardBenchmark({alternatives, main}:{
  alternatives: WildcardAlternative[]|null;
  main: ScenarioView|undefined;
}) {
  const link = () => {
    const q=new URLSearchParams(window.location.search);
    q.set("view","simular");q.set("chip","wildcard");q.set("comparar","1");
    return "/?"+q.toString()+"#cenarios";
  };
  const mainNext = main?.xi.reduce((sum,p)=>sum+p.next,0);
  const mainCaptain = main?.xi.find(p=>p.id===main.captainId);
  const mainNextWithCaptain = mainNext === undefined ? null :
    mainNext+(mainCaptain?.next??0);
  return <section className="rounded-xl border border-border bg-surface p-3 space-y-3" aria-label="Comparação de plantéis">
    <div>
      <h3 className="font-semibold text-text">Três maneiras de construir o Wildcard</h3>
      <p className="text-xs text-text-muted mt-1">Mesmas regras e orçamento. Cada alternativa constrói 15 jogadores, não apenas um capitão.</p>
    </div>
    {!alternatives ? <button type="button" onClick={() => window.location.assign(link())} className="inline-flex rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-contrast">
      Comparar plantéis completos
    </button> : <>
      <div className="grid gap-2 md:grid-cols-3">
        <article className="rounded-lg bg-surface-2 p-3">
          <h4 className="text-sm font-semibold">Modelo Command Center</h4>
          <p className="mt-1 text-xs text-text-muted">11 titulares: {main?.xi.map(p=>p.name).join(", ") || "Indisponível"}</p>
          <p className="mt-2 text-xs text-text-muted">Capitão: {mainCaptain?.name ?? "—"} · Onze + capitão: {mainNextWithCaptain?.toFixed(1) ?? "—"} xP na próxima jornada</p>
        </article>
        {alternatives.map(a=><article className="rounded-lg bg-surface-2 p-3" key={a.criterion}>
          <h4 className="text-sm font-semibold">{a.criterion==="ppg"?"Pontos por jogo":"Previsão oficial FPL"}</h4>
          {a.available?<><p className="mt-1 text-xs text-text-muted">11 titulares: {a.xiNames.join(", ")}</p>
          <p className="mt-2 text-xs text-text-muted">Capitão: {a.xiNames[a.xiIds.indexOf(a.captainId??-1)] ?? "—"}</p>
          <p className="text-xs text-text-muted">Onze + capitão (escala do nosso modelo): {a.modelXiNext!==null&&a.modelCaptainNext!==null?(a.modelXiNext+a.modelCaptainNext).toFixed(1):"—"} xP próxima jornada</p>
          <p className="text-xs text-text-muted">Onze: {a.modelXiWindow?.toFixed(1)} xP em 5 jornadas, sem capitania</p>
          <p className="text-xs text-text-muted">Saldo: £{a.budgetRemaining?.toFixed(1)}m</p></>
          :<p className="mt-1 text-xs text-warn">{a.reason}</p>}
        </article>)}
      </div>
      <p className="text-xs text-text-muted">Esta comparação usa o nosso modelo apenas para avaliar todas as equipas na mesma escala. Não demonstra qual dará mais pontos reais; a previsão oficial é de uma jornada e o PPG é histórico.</p>
    </>}
  </section>;
}
