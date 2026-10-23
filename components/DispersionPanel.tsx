import type { DispersionApplication } from "@/lib/dispersion";

/**
 * A LARGURA DAS PREVISÕES, À VISTA.
 *
 * Este ficheiro faltou no envio de 9 de setembro de 2026. O `page.tsx`
 * importava-o, o build falhou com "Module not found", e todas as versões a
 * partir daí ficaram por publicar: a correção de largura que o backtest
 * pedia existia no repositório e nunca chegou à app. Um painel simples, mas
 * o build depende dele — não o apagues sem tirar o import do `page.tsx`.
 */

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <p className="eyebrow text-text-muted">{label}</p>
      <p className="font-mono text-[15px] font-semibold tabular text-text">{value}</p>
      {note && <p className="text-[11px] text-text-muted">{note}</p>}
    </div>
  );
}

export default function DispersionPanel({
  application,
}: {
  application: DispersionApplication;
}) {
  const { correction, adjusted, largestCut } = application;
  const active = correction.factor < 0.999;

  return (
    <div className="space-y-3">
      <div
        className={`rounded-md border px-3 py-2 text-[13px] leading-relaxed ${
          active
            ? "border-accent/40 bg-accent/10 text-text"
            : "border-border bg-surface-2 text-text-muted"
        }`}
      >
        {correction.explanation}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Fator aplicado"
          value={`${Math.round(correction.factor * 100)}%`}
          note="100% = largura intacta"
        />
        <Stat
          label="Inclinação medida"
          value={correction.measuredSlope === null ? "—" : correction.measuredSlope.toFixed(2)}
          note={
            correction.stdError === null ? "sem backtest" : `± ${correction.stdError.toFixed(2)}`
          }
        />
        <Stat
          label="Peso da prova"
          value={`${Math.round(correction.weight * 100)}%`}
          note={`${correction.events} jornada${correction.events === 1 ? "" : "s"}, ${correction.n} obs.`}
        />
        <Stat
          label="Jogadores ajustados"
          value={String(adjusted)}
          note={active ? `maior corte ${largestCut.toFixed(2)} pts` : "nenhum"}
        />
      </div>
    </div>
  );
}
