"use client";

import { useState } from "react";
import { answerAdviser, ADVISER_QUESTIONS, type AdviserContext, type AdviserReply } from "@/lib/adviser";

/** Zero-credit contextual consultant: explanations always use data generated
 * by the FPL solver, not hallucinated web access or private credentials. */
export default function AdviserPanel({ context }: { context: AdviserContext }) {
  const [question,setQuestion]=useState("");
  const [reply,setReply]=useState<AdviserReply|null>(null);
  const ask=(text:string)=>{setQuestion(text);setReply(answerAdviser(text,context));};
  return <div className="space-y-3">
    <div>
      <h3 className="text-base font-bold">Consultor contextual</h3>
      <p className="text-xs text-text-muted">
        Responde sobre a tua equipa com as projeções e planos desta página.
        Não tem custos de modelos de IA; é um intérprete de decisões suportadas, não um LLM.
      </p>
    </div>
    <div className="flex flex-wrap gap-2">
      {ADVISER_QUESTIONS.map(text=><button key={text} type="button"
        onClick={()=>ask(text)}
        className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-xs hover:border-accent/60">
        {text}
      </button>)}
    </div>
    <form onSubmit={e=>{e.preventDefault();if(question.trim())ask(question)}} className="flex flex-col gap-2 sm:flex-row">
      <input value={question} maxLength={240} onChange={e=>setQuestion(e.target.value)}
        aria-label="Pergunta sobre o meu plantel"
        placeholder="Ex.: Porque não recomendas Wildcard?"
        className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"/>
      <button type="submit" className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast">
        Analisar
      </button>
    </form>
    {reply && <div className="rounded-lg border border-accent/40 bg-surface-2 p-4 space-y-2" aria-live="polite">
      <h4 className="font-semibold">{reply.subject}</h4>
      <p className="text-sm">{reply.answer}</p>
      <p className="text-xs text-text-muted">{reply.evidence}</p>
      <p className="text-sm font-medium">{reply.next}</p>
    </div>}
  </div>;
}
