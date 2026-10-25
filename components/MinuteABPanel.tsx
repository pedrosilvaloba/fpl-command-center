import type { MinuteABHistory } from "@/lib/minutebenchmark";
const num=(n:number)=>n.toFixed(2);
export default function MinuteABPanel({history}:{history:MinuteABHistory}){
  if(!history.configured)return <p className="text-sm text-text-muted">
    A comparação precisa de Redis para guardar previsões antes das jornadas.</p>;
  if(!history.results.length)return <p className="text-sm text-text-muted">
    Ainda não existem jornadas concluídas com ambas as previsões guardadas antes do deadline.
    {history.pending.length>0&&<> Aguardam resultados: GW{history.pending.join(", GW")}.</>}
    {" "}A variante recente continua experimental e não substitui as decisões principais.
  </p>;
  const common=history.results.filter(r=>r.base.n>0&&r.recent.n>0);
  const weighted=(key:"minutesMAE"|"appearanceBrier",mode:"base"|"recent")=>{
    const n=common.reduce((s,r)=>s+r[mode].n,0);
    return n>0?common.reduce((s,r)=>s+r[mode][key]*r[mode].n,0)/n:0;
  };
  const base=weighted("minutesMAE","base");
  const recent=weighted("minutesMAE","recent");
  return <div className="space-y-3">
    <p className="text-sm text-text-muted">
      Cada teste usa os mesmos jogadores e a informação congelada antes do deadline.
      Menor erro de minutos e menor Brier de participação são melhores.
      As jornadas — não as centenas de jogadores correlacionados — são a unidade principal de validação.
    </p>
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-lg bg-surface-2 p-3">
        <p className="text-xs text-text-muted">MAE base · minutos</p>
        <p className="text-lg font-semibold font-mono">{num(base)}</p>
      </div>
      <div className="rounded-lg bg-surface-2 p-3">
        <p className="text-xs text-text-muted">MAE recentes · minutos</p>
        <p className="text-lg font-semibold font-mono">{num(recent)}</p>
      </div>
      <div className="rounded-lg bg-surface-2 p-3">
        <p className="text-xs text-text-muted">Jornadas verificadas</p>
        <p className="text-lg font-semibold font-mono">{common.length}</p>
      </div>
    </div>
    {common.length<8&&<p className="text-xs text-warn">
      Evidência insuficiente para substituir o modelo base: são necessárias pelo menos oito jornadas
      prospetivas, além de melhoria consistente e verificações de rotação/titularidade.
    </p>}
    <div className="overflow-x-auto">
      <table className="min-w-[460px] w-full text-left text-xs">
        <thead><tr className="text-text-muted">
          <th className="py-2">GW</th><th className="text-right">N</th>
          <th className="text-right">Min base</th><th className="text-right">Min recentes</th>
          <th className="text-right">Brier base</th><th className="text-right">Brier recentes</th>
        </tr></thead>
        <tbody>{common.slice(0,8).map(r=><tr className="border-t border-border/60" key={r.event}>
          <td className="py-2">GW{r.event}</td>
          <td className="text-right font-mono">{r.recentEligible}</td>
          <td className="text-right font-mono">{num(r.base.minutesMAE)}</td>
          <td className="text-right font-mono">{num(r.recent.minutesMAE)}</td>
          <td className="text-right font-mono">{num(r.base.appearanceBrier)}</td>
          <td className="text-right font-mono">{num(r.recent.appearanceBrier)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-xs text-text-muted">
      Se a API FPL não fornecer titularidades individuais por jornada, a respetiva métrica não é
      inventada. O acompanhamento de minutos e participação continua válido.
    </p>
  </div>;
}
