import type { LearningState } from "@/lib/strategylearning";

/**
 * Camada 3, made visible.
 *
 * Two separate things are reported here and it matters that they are not
 * blurred together: what the model LEARNED about its own scale
 * (calibration), and what the season is teaching about stance (the
 * tournament). The first is a correction the model applies to itself. The
 * second is a small nudge on top of the league situation.
 */

export default function StrategyPanel({
  learning,
  storageConfigured,
}: {
  learning: LearningState;
  storageConfigured: boolean;
}) {
  if (!storageConfigured) {
    return (
      <p className="text-sm text-danger">
        Esta camada não pode funcionar sem a integração Upstash Redis. Ela
        precisa de guardar, antes de cada jornada, o que cada estratégia
        escolheu — e de voltar lá depois para ver o que aconteceu. Sem
        armazenamento persistente não há &quot;antes&quot; para comparar.
      </p>
    );
  }

  if (learning.events.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        <strong className="text-text">
          Ainda sem jornadas medidas — é o esperado.
        </strong>{" "}
        Esta camada só consegue aprender a partir de jornadas jogadas DEPOIS
        de ser instalada: não há forma honesta de reconstruir o que cada
        estratégia teria escolhido antes de uma jornada que já aconteceu, e
        inventar isso seria a pior espécie de teste — aquele que o modelo
        passa sempre. Cinco estratégias já estão a ser guardadas antes de
        cada deadline; o quadro preenche-se a partir da primeira jornada que
        fechar.
      </p>
    );
  }

  const leader = learning.standings[0];

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-text-muted">
        Cinco formas diferentes de escolher jogadores correm em paralelo
        todas as semanas, cada uma a montar a <strong>mesma forma</strong> de
        equipa (1 GR, 3 DEF, 4 MED, 2 AVA) para que a comparação seja entre
        estratégias e não entre posições. Depois de cada jornada, cada uma é
        avaliada pelos pontos que os seus jogadores realmente fizeram.{" "}
        {learning.events.length} jornada
        {learning.events.length === 1 ? "" : "s"} medida
        {learning.events.length === 1 ? "" : "s"} até agora.
      </p>

      <div className="flex flex-col gap-2">
        {learning.standings.map((s, i) => {
          const isLeader = i === 0;
          const width = leader?.meanPoints
            ? Math.max(4, (s.meanPoints / leader.meanPoints) * 100)
            : 4;
          return (
            <div
              key={s.key}
              className={`rounded-lg border p-3 ${
                isLeader
                  ? "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))]"
                  : "border-border bg-surface-2"
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-display text-base tracking-wide">
                  {i + 1}. {s.label}
                </span>
                <span className="flex items-baseline gap-3 font-mono tabular text-sm">
                  <span className="font-bold">{s.meanPoints.toFixed(2)}</span>
                  <span className="text-xs text-text-muted">pts/escolha</span>
                  {s.key !== "modelo" && (
                    <span
                      className={`text-xs ${s.liftVsModel >= 0 ? "text-success" : "text-danger"}`}
                    >
                      {s.liftVsModel >= 0 ? "+" : ""}
                      {s.liftVsModel.toFixed(2)} vs modelo
                    </span>
                  )}
                </span>
              </div>
              <div
                aria-hidden
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${width}%`,
                    background: isLeader ? "var(--accent-vivid)" : "var(--border-strong)",
                  }}
                />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-text-muted">
                {s.description}
              </p>
            </div>
          );
        })}
      </div>

      {learning.postureTiltReason && (
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--cyan)_40%,var(--border))] bg-[color-mix(in_srgb,var(--cyan)_8%,var(--surface))] p-4">
          {/* The beta is deliberately OUTSIDE the uppercased span: CSS
              text-transform turns a lowercase Greek beta into a capital
              one, which renders as a plain Latin "B" in most UI fonts and
              silently changes what the label says. */}
          <p className="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan">
              Efeito no modelo
            </span>
            <span className="font-mono tabular text-xs text-cyan">
              β {learning.postureTilt >= 0 ? "+" : ""}
              {learning.postureTilt.toFixed(2)}
            </span>
          </p>
          <p className="text-sm leading-relaxed text-text-muted">
            {learning.postureTiltReason}
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface-2 p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
          Calibração aprendida
        </p>
        {learning.calibrationNotes.length === 0 ? (
          <p className="text-sm text-text-muted">
            As previsões desta época ainda não mostram um desvio consistente
            em nenhuma posição — nada a corrigir, o que é a melhor notícia
            possível aqui. A correção é encolhida por tamanho de amostra, por
            isso uma jornada estranha não move nada.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-text-muted">
            {learning.calibrationNotes.map((note, i) => (
              <li key={i}>· {note}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs leading-relaxed text-text-muted opacity-80">
          Compara, por posição, o que o motor previu com os pontos reais, e
          multiplica as previsões futuras dessa posição pela diferença. O
          efeito está limitado a ±25% e cresce com o número de jornadas
          medidas, para que o modelo se corrija sem nunca se afastar da sua
          própria física.
        </p>
      </div>
    </div>
  );
}
