import type {WildcardOutcome} from "@/lib/wildcardprospective";

export default function WildcardEvidence({configured,results,pending,lastCapture}:{
 configured:boolean;results:WildcardOutcome[];pending:number[];
 lastCapture?:{at:string;ok:boolean;status:string}|null;
}){
 const policies=["model","ppg","fpl"] as const;
 const complete=results.filter(r=>policies.every(p=>r.results.some(x=>x.policy===p&&Number.isFinite(x.points))));
 const total=(p:typeof policies[number])=>complete.reduce((sum,r)=>sum+(r.results.find(x=>x.policy===p)?.points??0),0);
 return <section className="rounded-xl border border-border bg-surface p-4 space-y-3" aria-label="Evidência real dos Wildcards">
  <h3 className="text-base font-bold text-text">O modelo está a ganhar?</h3>
  {!configured?<p className="text-sm text-warn">Armazenamento indisponível: não é possível registar provas prospetivas.</p>:
   <><p className="text-sm text-text-muted">{complete.length} jornadas avaliadas · {pending.length} aguardam resultado.</p>
   {lastCapture && <p className={`text-xs ${lastCapture.ok?"text-text-muted":"text-warn"}`}>
     Captura automática: {lastCapture.ok?"operacional":"requer atenção"} · {lastCapture.status} · {new Date(lastCapture.at).toLocaleString("pt-PT")}
   </p>}
   {complete.length===0?<p className="text-sm text-text-muted">Ainda não há jornadas completas. As comparações só contam depois de uma previsão arquivada antes do deadline.</p>:
   <div className="grid grid-cols-3 gap-2">{policies.map(p=><div key={p} className="rounded-lg bg-surface-2 p-3">
    <p className="text-xs text-text-muted">{p==="model"?"Command Center":p==="ppg"?"Pontos por jogo":"FPL oficial"}</p>
    <p className="text-lg font-bold tabular-nums text-text">{total(p)}</p>
    <p className="text-xs text-text-muted">pontos simulados</p>
   </div>)}</div>}
   <p className="text-xs text-text-muted">{complete.length<12?
    "Amostra insuficiente para concluir que alguma estratégia é melhor.":
    "Comparação descritiva, não prova de superioridade estatística."} Nenhuma destas simulações executa transferências reais.</p></>}
 </section>;
}
