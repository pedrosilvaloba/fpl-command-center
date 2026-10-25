"use client";

import { useState } from "react";
import { answerAdviser, buildChatGPTContext, ADVISER_QUESTIONS, type AdviserContext, type AdviserReply } from "@/lib/adviser";

/** Zero-credit contextual consultant: explanations always use data generated
 * by the FPL solver, not hallucinated web access or private credentials. */
export default function AdviserPanel({ context }: { context: AdviserContext }) {
  const [question,setQuestion]=useState("");
  const [reply,setReply]=useState<AdviserReply|null>(null);
  const [copied,setCopied]=useState(false);
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
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <p className="text-sm font-semibold">Queres uma análise conversacional mais aprofundada?</p>
      <p className="mt-1 text-xs text-text-muted">
        Copia o resumo da tua equipa e cola-o na tua sessão do ChatGPT.
        A aplicação não envia dados nem utiliza créditos de API automaticamente.
        Terás de confirmar as notícias recentes e não assumir que as projeções são factos.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="rounded-lg border border-accent px-3 py-2 text-xs font-semibold text-accent"
          onClick={async()=>{
            const prompt=buildChatGPTContext(context);
            try{
              await navigator.clipboard.writeText(prompt);
              setCopied(true);
            }catch{
              window.prompt("Copia o contexto para ChatGPT:",prompt);
              setCopied(true);
            }
          }}>
          Copiar contexto para ChatGPT
        </button>
        <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer"
          className="rounded-lg border border-border px-3 py-2 text-xs">Abrir ChatGPT</a>
        {copied&&<span className="text-xs text-text-muted" aria-live="polite">
          Contexto preparado. Cola-o no ChatGPT para continuares a análise.
        </span>}
      </div>
    </div>
    {reply && <div className="rounded-lg border border-accent/40 bg-surface-2 p-4 space-y-2" aria-live="polite">
      <h4 className="font-semibold">{reply.subject}</h4>
      <p className="text-sm">{reply.answer}</p>
      <p className="text-xs text-text-muted">{reply.evidence}</p>
      <p className="text-sm font-medium">{reply.next}</p>
    </div>}
  </div>;
}
