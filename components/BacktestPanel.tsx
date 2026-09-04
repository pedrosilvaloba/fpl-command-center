import type { BacktestResult } from "@/lib/backtest";

/**
 * O BACKTEST CORRIA E NINGUÉM O VIA.
 *
 * Todas as noites, um cron replicava o modelo contra jornadas já jogadas,
 * medindo se as previsões acertaram. O resultado ia para o Redis e ficava
 * lá. Não havia um único pixel na app que o mostrasse.
 *
 * A pergunta a que este projeto inteiro serve — "posso confiar neste
 * modelo?" — tinha resposta calculada e guardada, e invisível. É o mesmo
 * padrão que a auditoria encontrou seis vezes: a peça existe, funciona, e
 * não está ligada ao sítio onde faria diferença.
 *
 * ═══ O QUE ESTE PAINEL SE RECUSA A FAZER ═══
 *
 * Mostrar "Spearman 0,430 vs base 0,412" e deixar quem lê concluir que o
 * modelo ganha. Com 101 observações e uma jornada, essa diferença é ruído.
 * O veredicto vem PRIMEIRO e em letra grande, e na maior parte do tempo vai
 * dizer "ainda não dá para saber" — que é a verdade, e é mais útil do que
 * um número tranquilizador.
 */

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  insuficiente: {
    label: "Dados insuficientes",
    cls: "border-warn/40 bg-warn/10 text-warn",
  },
  inconclusivo: {
    label: "Inconclusivo",
    cls: "border-warn/40 bg-warn/10 text-warn",
  },
  "bate a base": {
    label: "O modelo bate a base",
    cls: "border-accent/40 bg-accent/10 text-accent",
  },
  "pior que a base": {
    label: "O modelo é pior que a base",
    cls: "border-danger/40 bg-danger/10 text-danger",
  },
};

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <p className="eyebrow text-text-muted">{label}</p>
      <p className="font-mono text-[15px] font-semibold tabular text-text">
        {value}
      </p>
      {note && <p className="text-[11px] text-text-muted">{note}</p>}
    </div>
  );
}

export default function BacktestPanel({
  result,
  configured,
}: {
  result: BacktestResult | null;
  configured: boolean;
}) {
  if (!configured) {
    return (
      <p className="text-sm text-text-muted">
        O backtest precisa de armazenamento ligado para guardar resultados.
        Sem isso corre e perde-se.
      </p>
    );
  }
  if (!result) {
    return (
      <p className="text-sm text-text-muted">
        Ainda não há nenhum backtest guardado. Corre sozinho todas as noites;
        também podes forçá-lo em Sistema.
      </p>
    );
  }

  const m = result.metrics;
  const v = VERDICT_STYLE[m.evidence.verdict] ?? VERDICT_STYLE.inconclusivo;
  const reg = m.regression;
  // A inclinação só se lê com o seu erro padrão ao lado. Sozinha, um 0,33
  // medido em 101 linhas parece uma descoberta e é uma flutuação.
  const slopeReadable =
    reg.n >= 3 && reg.slopeStdError > 0
      ? `${reg.slope.toFixed(2)} ± ${reg.slopeStdError.toFixed(2)}`
      : "—";
  const slopeIsMeasurablyOff =
    reg.slopeStdError > 0 && Math.abs(1 - reg.slope) > 2 * reg.slopeStdError;

  return (
    <div className="flex flex-col gap-4">
      <div className={`rounded-md border px-4 py-3 ${v.cls}`}>
        <p className="eyebrow">{v.label}</p>
        <p className="mt-1 text-[14px] leading-relaxed text-text">
          {m.evidence.explanation}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat
          label="Ordenação (modelo)"
          value={m.spearman.toFixed(3)}
          note={`base ${m.baselineSpearman.toFixed(3)}`}
        />
        <Stat
          label="Erro médio"
          value={`${m.mae.toFixed(2)} pts`}
          note={`base ${m.baselineMae.toFixed(2)}`}
        />
        <Stat
          label="Viés"
          value={`${m.bias >= 0 ? "+" : ""}${m.bias.toFixed(2)} pts`}
          note={m.bias >= 0 ? "otimista" : "pessimista"}
        />
        <Stat
          label="Amostra"
          value={`${m.n}`}
          note={`${m.events.length} jornada${m.events.length === 1 ? "" : "s"}`}
        />
      </div>

      <div className="rounded-md border border-border px-4 py-3">
        <p className="eyebrow text-text-muted">
          Calibração — inclinação {slopeReadable}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-text-muted">
          Com 1,00 uma previsão de 8 pontos corresponde mesmo a 8. Abaixo de
          1, o modelo espalha as previsões mais do que a realidade justifica —
          e erra mais no balde de cima, que é de onde saem o capitão e as
          transferências.{" "}
          {slopeIsMeasurablyOff ? (
            <strong className="text-warn">
              Esta medição está mensuravelmente longe de 1.
            </strong>
          ) : (
            "Esta medição ainda não se distingue de 1."
          )}
          {m.suggestedShrinkage !== null && (
            <>
              {" "}
              <strong className="text-text">
                Encolhimento sugerido: ×{m.suggestedShrinkage.toFixed(2)}.
              </strong>{" "}
              Não está aplicado — é uma sugestão medida, à espera de decisão.
            </>
          )}
        </p>
      </div>

      {m.calibration.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-[12px] tabular">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="py-1 pr-3 font-normal">Previsto</th>
                <th className="py-1 pr-3 font-normal">n</th>
                <th className="py-1 pr-3 font-normal">Média prevista</th>
                <th className="py-1 font-normal">Média real</th>
              </tr>
            </thead>
            <tbody>
              {m.calibration.map((b) => {
                // Um balde com meia dúzia de linhas não diz nada, e
                // apresentá-lo com o mesmo peso dos outros convida a
                // conclusões sobre ruído.
                const thin = b.n < 10;
                return (
                  <tr
                    key={b.label}
                    className={`border-b border-border/50 ${thin ? "opacity-50" : ""}`}
                  >
                    <td className="py-1 pr-3">{b.label}</td>
                    <td className="py-1 pr-3">{b.n}</td>
                    <td className="py-1 pr-3">{b.meanPredicted.toFixed(2)}</td>
                    <td className="py-1">{b.meanActual.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-text-muted">
            Linhas esbatidas têm menos de 10 observações — são ruído, não
            sinal.
          </p>
        </div>
      )}

      <div>
        <p className="eyebrow mb-1 text-text-muted">O que este teste não mede</p>
        <ul className="flex flex-col gap-0.5 text-[12px] leading-relaxed text-text-muted">
          {result.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-text-muted">
          Última corrida:{" "}
          {new Date(result.ranAt).toLocaleString("pt-PT", {
            timeZone: "Europe/Lisbon",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
          {" · "}jornadas {result.fromEvent}–{result.toEvent}
          {" · "}
          {result.playersSampled} jogadores na amostra
        </p>
      </div>
    </div>
  );
}
