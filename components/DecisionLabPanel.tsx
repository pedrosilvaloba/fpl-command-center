"use client";
import { useMemo, useState } from "react";
import { alternativeSensitivity, type DecisionAlternative } from "@/lib/decisionrobustness";

export default function DecisionLabPanel({ alternatives }: { alternatives: DecisionAlternative[] }) {
  const [selected, setSelected] = useState<string>("");
  const [stress, setStress] = useState(20);
  const active = useMemo(
    () => alternatives.find((p) => p.id === selected) ??
      alternatives.find((p) => p.recommended) ?? alternatives[0],
    [alternatives, selected]
  );
  if (!active) return <p className="text-sm text-text-muted">Sem plantel carregado para comparar alternativas.</p>;
  const result = alternativeSensitivity(active, stress);
  return (
    <div className="space-y-4" aria-label="Comparador de decisões">
      <p className="text-sm text-text-muted">
        Compara opções reais calculadas pelo planeador. O ganho é relativo a não fazer transferências
        durante as próximas cinco jornadas. Nenhuma destas decisões é executada automaticamente.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {alternatives.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={active.id === p.id}
            onClick={() => setSelected(p.id)}
            className={`rounded-lg border px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active.id === p.id ? "border-accent bg-accent/10" : "border-border bg-surface-2 hover:border-accent/60"
            }`}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold text-text">{p.label}</span>
              <span className="shrink-0 font-mono text-sm font-semibold text-text">
                {p.gain > 0 ? "+" : ""}{p.gain.toFixed(1)} pts
              </span>
            </span>
            <span className="mt-1 block text-xs text-text-muted">
              {p.transfers.length ? p.transfers.slice(0, 2).join(" · ") : "Guardar FT e manter plantel"}
              {p.transfers.length > 2 ? ` · +${p.transfers.length-2} alterações` : ""}
            </span>
            {p.recommended && <span className="mt-2 inline-block rounded bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">Conselho atual</span>}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display text-base font-bold">Stress test · {active.label}</h3>
          <span className="text-xs text-text-muted">{active.hits ? `Hits: -${active.hits} pts` : "Sem hits"}</span>
        </div>
        <label htmlFor="decision-downside" className="flex justify-between gap-2 text-sm">
          <span>Reduzir projeções dos jogadores que entram</span>
          <strong className="font-mono">{stress}%</strong>
        </label>
        <input id="decision-downside" type="range" min="0" max="40" step="5"
          value={stress} onChange={(e) => setStress(Number(e.target.value))}
          className="w-full accent-[var(--accent)]" />
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md bg-surface-2 p-3">
            <p className="text-xs text-text-muted">Ganho central · 5 GW</p>
            <p className="mt-1 font-mono text-lg font-semibold">{active.gain > 0 ? "+" : ""}{active.gain.toFixed(1)}</p>
          </div>
          <div className="rounded-md bg-surface-2 p-3">
            <p className="text-xs text-text-muted">Com o cenário adverso</p>
            <p className={`mt-1 font-mono text-lg font-semibold ${result.stressedGain <= 0 ? "text-warn" : "text-text"}`}>
              {result.stressedGain > 0 ? "+" : ""}{result.stressedGain.toFixed(1)}
            </p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-text-muted">
          {active.transfers.length === 0
            ? "Manter não introduz reforços para sujeitar a este stress test."
            : result.reversesDecision
              ? "A vantagem desaparece neste cenário. Não trates a recomendação como robusta sem confirmar minutos e contexto."
              : "A vantagem estimada mantém-se neste cenário; isto não prova que se concretize."}
        </p>
        <p className="text-xs text-text-muted">
          Teste de sensibilidade hipotético, não intervalo estatístico nem probabilidade.
          Altera apenas a projeção dos reforços, não a dos jogadores vendidos ou as outras equipas.
          Margem mínima do planeador: {active.requiredEdge.toFixed(1)} pontos; confiança interna:
          {" "}{Math.round(active.confidence * 100)}% (não calibrada como probabilidade de acerto).
        </p>
      </div>
    </div>
  );
}
