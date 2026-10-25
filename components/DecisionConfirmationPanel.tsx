"use client";
import { useEffect, useState } from "react";

interface Confirmation {
  event:number;teamId:number;at:string;
  action:"followed"|"different"|"no-action";
  note:string;
  captain:string|null;
  transfers:string[];
  source:"self-reported-local";
}
export default function DecisionConfirmationPanel({event,teamId,captain,moves}:{
  event:number;teamId:number;captain:string|null;moves:string[];
}){
  const key="fpl:confirmed:"+teamId+":"+event;
  const [entry,setEntry]=useState<Confirmation|null>(null);
  const [note,setNote]=useState("");
  useEffect(()=>{
    try{
      const saved=window.localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntry(saved?JSON.parse(saved) as Confirmation:null);
    }catch{/* no persistence permission */}
  },[key]);
  const save=(action:Confirmation["action"])=>{
    const result:Confirmation={event,teamId,at:new Date().toISOString(),action,
      note:note.slice(0,250),captain,transfers:moves,source:"self-reported-local"};
    try{window.localStorage.setItem(key,JSON.stringify(result));}catch{/* local-only */}
    setEntry(result);
  };
  return <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
    <h3 className="text-sm font-semibold">O que decidiste realmente fazer na FPL?</h3>
    <p className="text-xs text-text-muted">Só para registo pessoal neste browser. Não executa transferências,
      não verifica automaticamente a ação e não altera os benchmarks do modelo.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={()=>save("followed")} className="rounded-md border border-accent px-3 py-2 text-xs text-accent">
        Segui o plano
      </button>
      <button type="button" onClick={()=>save("different")} className="rounded-md border border-border px-3 py-2 text-xs">Fiz outra coisa</button>
      <button type="button" onClick={()=>save("no-action")} className="rounded-md border border-border px-3 py-2 text-xs">Não transferi</button>
    </div>
    <label className="block text-xs text-text-muted">Nota opcional (porquê, notícias, alternativa)
      <input type="text" value={note} maxLength={250} onChange={e=>setNote(e.target.value)}
        className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-2 text-sm" />
    </label>
    {entry && <p className="text-xs text-text-muted" aria-live="polite">
      Último registo: {new Date(entry.at).toLocaleString("pt-PT")} ·
      {" "}{entry.action==="followed"?"Segui o plano":entry.action==="different"?"Outra decisão":"Sem transferência"}.
      É uma declaração tua, não uma confirmação da API FPL.
    </p>}
  </div>;
}
