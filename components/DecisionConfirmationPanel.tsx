"use client";
import { useEffect, useRef, useState } from "react";
import { buildJournal, parseJournal, type LocalDecision } from "@/lib/localjournal";

type Confirmation = LocalDecision;
export default function DecisionConfirmationPanel({event,teamId,captain,moves}:{
  event:number;teamId:number;captain:string|null;moves:string[];
}){
  const key="fpl:confirmed:"+teamId+":"+event;
  const [entry,setEntry]=useState<Confirmation|null>(null);
  const [note,setNote]=useState("");
  const fileInput=useRef<HTMLInputElement>(null);
  const [backupMessage,setBackupMessage]=useState("");
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
  const exportHistory=()=>{
    try{
      const prefix="fpl:confirmed:"+teamId+":";
      const values:unknown[]=[];
      for(let i=0;i<window.localStorage.length;i++){
        const k=window.localStorage.key(i);
        if(k?.startsWith(prefix)){
          try{values.push(JSON.parse(window.localStorage.getItem(k)??"null"));}catch{}
        }
      }
      const output=JSON.stringify(buildJournal(teamId,values),null,2);
      const url=URL.createObjectURL(new Blob([output],{type:"application/json"}));
      const anchor=document.createElement("a");
      anchor.href=url;anchor.download="fpl-decisoes-"+teamId+".json";anchor.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      setBackupMessage("Histórico exportado. Guarda o ficheiro em local seguro.");
    }catch{setBackupMessage("Não foi possível exportar o histórico deste browser.");}
  };
  const importHistory=async(file:File)=>{
    try{
      if(file.size>80_000)throw new Error("Ficheiro demasiado grande.");
      const parsed=parseJournal(await file.text(),teamId);
      if(!window.confirm("Importar "+parsed.entries.length+
        " decisões desta equipa? Registos da mesma jornada serão substituídos neste browser."))return;
      for(const item of parsed.entries){
        window.localStorage.setItem("fpl:confirmed:"+teamId+":"+item.event,JSON.stringify(item));
      }
      setEntry(parsed.entries.find(x=>x.event===event)??entry);
      setBackupMessage(parsed.entries.length+" decisões importadas. Nenhuma informação foi enviada ao servidor.");
    }catch(e){setBackupMessage(e instanceof Error?e.message:"Falha a importar ficheiro.");}
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
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <button type="button" onClick={exportHistory} className="rounded-md border border-border px-3 py-2 text-xs">
        Exportar histórico
      </button>
      <button type="button" onClick={()=>fileInput.current?.click()} className="rounded-md border border-border px-3 py-2 text-xs">
        Importar noutro dispositivo
      </button>
      <input ref={fileInput} type="file" accept="application/json,.json" className="hidden"
        onChange={async e=>{
          const file=e.target.files?.[0];
          if(file)await importHistory(file);
          e.target.value="";
        }} aria-label="Importar ficheiro de decisões FPL" />
      <p className="w-full text-xs text-text-muted">
        Backup manual em JSON sem encriptação: pode conter notas pessoais. Não o partilhes publicamente.
        Não existe login nem sincronização automática entre dispositivos.
      </p>
      {backupMessage&&<p className="w-full text-xs text-text-muted" aria-live="polite">{backupMessage}</p>}
    </div>
  </div>;
}
