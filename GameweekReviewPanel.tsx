import type { GameweekReview } from "@/lib/gwreview";

/**
 * The gameweek post-mortem for one specific squad — mine.
 *
 * The aggregate accuracy panel answers "is the model any good?". This
 * answers "what happened to me, and who was responsible?", which is a
 * different question and the one a manager actually asks on a Monday.
 *
 * The design choice worth defending: players are sorted by how far they
 * missed the prediction, not by points scored. A seven-point haul from
 * someone the model expected six from is not news. A blank from someone it
 * expected seven from is.
 */

function Delta({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="font-mono text-xs tabular text-text-muted">—</span>;
  }
  const tone =
    value >= 2 ? "text-success" : value <= -2 ? "text-danger" : "text-text-muted";
  return (
    <span className={`font-mono text-sm tabular font-semibold ${tone}`}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}
    </span>
  );
}

export default function GameweekReviewPanel({ review }: { review: GameweekReview }) {
  if (!review.available) {
    return (
      <p className="text-sm text-text-muted">
        {review.reason ??
          "Ainda não há nenhuma jornada começada para rever. Esta secção preenche-se assim que a primeira bola rolar."}
      </p>
    );
  }

  const starters = review.players.filter((p) => p.wasStarter);
  const bench = review.players.filter((p) => !p.wasStarter);
  const vsAverage =
    review.averageScore !== null ? review.actualTotal - review.averageScore : null;

  return (
    <div className="flex flex-col gap-5">
      {/* --- headline ------------------------------------------------------ */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Pontos reais
          </p>
          <p className="mt-0.5 font-display text-2xl font-bold tracking-tight">
            {review.actualTotal}
          </p>
          {review.transferCost > 0 && (
            <p className="mt-0.5 text-[11px] text-danger">
              já com −{review.transferCost} de hit
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Previsto
          </p>
          <p className="mt-0.5 font-display text-2xl font-bold tracking-tight">
            {review.hadStoredPredictions ? review.predictedTotal.toFixed(1) : "—"}
          </p>
          {review.hadStoredPredictions && (
            <p
              className={`mt-0.5 text-[11px] ${review.delta >= 0 ? "text-success" : "text-danger"}`}
            >
              {review.delta >= 0 ? "+" : ""}
              {review.delta.toFixed(1)} face à previsão
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Média da jornada
          </p>
          <p className="mt-0.5 font-display text-2xl font-bold tracking-tight">
            {review.averageScore ?? "—"}
          </p>
          {vsAverage !== null && (
            <p
              className={`mt-0.5 text-[11px] ${vsAverage >= 0 ? "text-success" : "text-danger"}`}
            >
              {vsAverage >= 0 ? "+" : ""}
              {vsAverage} face à média
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Deixado no banco
          </p>
          <p className="mt-0.5 font-display text-2xl font-bold tracking-tight">
            {review.benchPoints}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {review.transfersMade} transferência
            {review.transfersMade === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-text-muted">{review.verdict}</p>

      {/* --- captain ------------------------------------------------------- */}
      {review.captain && (
        <div
          className={`rounded-xl border p-4 ${
            review.captain.cost > 4
              ? "border-[color-mix(in_srgb,var(--danger)_45%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface))]"
              : "border-border bg-surface-2"
          }`}
        >
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted">
            A braçadeira
          </p>
          <p className="text-sm leading-relaxed">
            Capitanaste <strong>{review.captain.chosen}</strong> ({review.captain.chosenPoints}{" "}
            pts).{" "}
            {review.captain.cost === 0 ? (
              <span className="text-success">
                Foi a melhor escolha possível dentro do teu onze.
              </span>
            ) : (
              <>
                A melhor escolha dentro do teu onze teria sido{" "}
                <strong>{review.captain.best}</strong> ({review.captain.bestPoints} pts) — a
                braçadeira custou-te{" "}
                <strong className="text-danger">{review.captain.cost} pontos</strong>.
              </>
            )}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-text-muted">
            A comparação é feita apenas dentro do onze que alinhaste, de
            propósito. Lamentar um capitão que nunca tiveste não ensina nada;
            perceber que tinhas o jogador certo em campo e puseste a braçadeira
            noutro, ensina.
          </p>
        </div>
      )}

      {/* --- players -------------------------------------------------------- */}
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted">
          Onze inicial · ordenado por desvio face à previsão
        </p>
        <ul className="flex flex-col gap-1.5">
          {starters.map((p) => (
            <li
              key={p.elementId}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                <strong>{p.webName}</strong>
                <span className="ml-2 font-mono text-xs text-text-muted">
                  {p.teamShort} · {p.positionShort} · {p.minutes}min
                </span>
                {p.wasCaptain && (
                  <span className="ml-2 rounded bg-accent-vivid px-1.5 py-0.5 text-[10px] font-bold text-accent-contrast">
                    C
                  </span>
                )}
              </span>
              <span className="font-mono text-xs tabular text-text-muted">
                prev {p.predicted === null ? "—" : p.predicted.toFixed(1)}
              </span>
              <span className="font-mono text-sm tabular font-bold">
                {p.actual * (p.multiplier || 1)}
              </span>
              <Delta value={p.delta} />
            </li>
          ))}
        </ul>
      </div>

      {bench.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted">
            Banco
          </p>
          <ul className="flex flex-col gap-1.5 opacity-70">
            {bench.map((p) => (
              <li
                key={p.elementId}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <strong>{p.webName}</strong>
                  <span className="ml-2 font-mono text-xs text-text-muted">
                    {p.teamShort} · {p.minutes}min
                  </span>
                </span>
                <span className="font-mono text-sm tabular font-bold">{p.actual}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!review.finished && (
        <p className="text-xs text-warn">
          A jornada ainda não fechou — estes números vão mexer até ao último
          jogo, e as substituições automáticas ainda não foram aplicadas.
        </p>
      )}
    </div>
  );
}
