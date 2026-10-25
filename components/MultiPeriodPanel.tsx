import type { MultiPeriodReport } from "@/lib/multiperiod";

export default function MultiPeriodPanel({ report, teamId, horizon }: {
  report: MultiPeriodReport; teamId: number; horizon: number;
}) {
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-base font-bold">Plano de transferências entre jornadas</h3>
        <p className="text-xs text-text-muted">
          Procura sequências com transferências livres acumuladas, hits e orçamento legal.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[3,5,8].map(n => <a key={n} href={`/?team=${teamId}&view=simular&horizonte=${n}#plano-multiplo`}
          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${horizon===n?"border-accent bg-accent/10 text-accent":"border-border text-text-muted"}`}
          aria-current={horizon===n?"page":undefined}>{n} GW</a>)}
      </div>
    </div>
    {!report.available ? <p className="text-sm text-text-muted">{report.reason ?? "Previsões insuficientes."}</p> : <>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-[11px] text-text-muted">Não transferir</p>
          <p className="font-mono text-base font-semibold">{report.baselinePoints.toFixed(1)}</p>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-[11px] text-text-muted">Plano encontrado</p>
          <p className="font-mono text-base font-semibold">{report.plannedPoints.toFixed(1)}</p>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-[11px] text-text-muted">Ganho teórico · não validado</p>
          <p className={`font-mono text-base font-semibold ${report.gainVsHold < 0?"text-warn":"text-text"}`}>
            {report.gainVsHold>=0?"+":""}{report.gainVsHold.toFixed(1)}
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
        Se os reforços renderem 20% menos do que o previsto enquanto estiverem no plantel,
        a diferença projetada desce para
        {" "}<strong>{report.stressGainVsHold>=0?"+":""}{report.stressGainVsHold.toFixed(1)} pts</strong>.
        É um teste hipotético, não um intervalo de confiança. Um plano com muitas trocas pode
        estar a selecionar os erros mais otimistas do próprio modelo.
      </div>
      <ol className="space-y-2">
        {report.steps.map(step=><li key={step.event} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold text-sm">GW{step.event}</h4>
            <span className="text-xs text-text-muted">Projeção {step.expectedPoints.toFixed(1)} pts · banco £{step.bankAfterM.toFixed(1)}m</span>
          </div>
          {step.moves.length ? <ul className="mt-2 space-y-1 text-sm">
            {step.moves.map((move,i)=><li key={i}>{move.outName} → <strong>{move.inName}</strong>
              <span className="ml-2 text-xs text-text-muted">{move.costM>=0?"+":""}£{move.costM.toFixed(1)}m</span></li>)}
          </ul> : <p className="mt-1 text-sm text-text-muted">Não transferir — guardar flexibilidade.</p>}
          <p className="mt-2 text-xs text-text-muted">
            FT {step.freeBefore} → {step.freeAfter}
            {step.hitCost>0?` · Hit -${step.hitCost} pts`:" · Sem hit"}
          </p>
        </li>)}
      </ol>
      <p className="text-xs leading-relaxed text-text-muted">
        Pesquisa sequencial limitada: {report.evaluated} estados avaliados, beam de {report.beamWidth},
        no máximo duas transferências por jornada. Não garante o ótimo global.
        As projeções futuras usam a informação disponível agora: preços futuros, chips,
        lesões inesperadas e novas notícias não estão previstos. O plano deve ser recalculado
        antes de cada deadline. Nunca executa transferências automaticamente.
      </p>
    </>}
  </div>;
}
