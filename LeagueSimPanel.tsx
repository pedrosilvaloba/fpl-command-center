import type { LeagueOutlook } from "@/lib/rivals";

/**
 * Camada 2, made visible.
 *
 * The important thing this panel has to communicate is not the probabilities
 * — it is that the probabilities CHANGED THE SQUAD. A dashboard that reports
 * "you have a 22% chance of catching the leader" and then recommends the
 * same eleven it would have recommended at 95% is decoration. So the posture
 * card leads, states the number it fed into the optimizer, and says in plain
 * language what the optimizer did differently because of it.
 */

function Probability({ value, highlight = false }: { value: number; highlight?: boolean }) {
  const pct = Math.round(value * 100);
  const tone =
    pct >= 60 ? "var(--success)" : pct >= 40 ? "var(--warn)" : "var(--danger)";
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`font-mono tabular text-sm ${highlight ? "font-bold" : ""}`}
        style={{ color: tone }}
      >
        {pct}%
      </span>
      <span
        aria-hidden
        className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-surface-3 sm:inline-block"
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: tone }}
        />
      </span>
    </span>
  );
}

const POSTURE_TONE: Record<string, string> = {
  atacar: "var(--brand-pink)",
  proteger: "var(--brand-cyan)",
  equilibrar: "var(--brand-green)",
};

export default function LeagueSimPanel({ outlook }: { outlook: LeagueOutlook }) {
  const { posture, me, rivals } = outlook;
  const tone = POSTURE_TONE[posture.label] ?? "var(--brand-green)";
  // Your own row is included in the standings order. Without it the table
  // jumps from 2nd to 4th with no explanation of where you sit, which is the
  // one row a manager looks for first.
  const table = me ? [...rivals, me].sort((a, b) => a.rank - b.rank) : rivals;

  return (
    <div className="flex flex-col gap-5">
      {/* --- posture ----------------------------------------------------- */}
      <div
        className="rounded-xl border p-4"
        style={{
          borderColor: `color-mix(in srgb, ${tone} 45%, var(--border))`,
          background: `color-mix(in srgb, ${tone} 8%, var(--surface))`,
        }}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.14em]"
            style={{ background: tone, color: "var(--accent-contrast)" }}
          >
            {posture.label}
          </span>
          <span className="font-display text-lg tracking-wide">{posture.headline}</span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          {posture.rationale}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-3 text-xs text-text-muted">
          <span>
            Inclinação aplicada ao otimizador:{" "}
            <strong className="font-mono tabular text-text">
              β = {posture.beta.toFixed(2)}
            </strong>
          </span>
          <span>
            Fonte: <strong className="text-text">{posture.source}</strong>
          </span>
          {outlook.runs > 0 && (
            <span>
              {outlook.runs.toLocaleString("pt-PT")} jornadas simuladas ·{" "}
              {outlook.gameweeksRemaining} por jogar
            </span>
          )}
        </div>
      </div>

      {!outlook.available && (
        <p className="text-sm text-text-muted">{outlook.reason}</p>
      )}

      {/* --- rivals ------------------------------------------------------ */}
      {outlook.available && me && rivals.length > 0 && (
        <>
          <ul className="flex flex-col gap-2 sm:hidden">
            {table.map((r) => (
              <li
                key={r.entry}
                className={`rounded-lg border p-3 ${
                  r.entry === me.entry
                    ? "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]"
                    : "border-border bg-surface-2"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold">
                    <span className="mr-1.5 font-mono text-text-muted">{r.rank}.</span>
                    {r.playerName}
                    {r.entry === me.entry && (
                      <span className="ml-2 rounded bg-accent-vivid px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-contrast">
                        tu
                      </span>
                    )}
                  </span>
                  <span className="font-mono tabular text-sm">{r.totalPoints}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-text-muted">{r.entryName}</p>
                {r.entry !== me.entry && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
                    <span>
                      Diferença{" "}
                      <strong
                        className={`font-mono tabular ${r.gap >= 0 ? "text-success" : "text-danger"}`}
                      >
                        {r.gap >= 0 ? "+" : ""}
                        {r.gap}
                      </strong>
                    </span>
                    <span>{r.overlap} jogadores em comum</span>
                    <span className="flex items-center gap-1.5">
                      Acabar à frente <Probability value={r.pAheadAtSeasonEnd} highlight />
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="hidden scroll-x sm:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="py-2 pr-3 font-semibold">#</th>
                  <th className="py-2 pr-3 font-semibold">Gestor</th>
                  <th className="py-2 pr-3 text-right font-semibold">Pontos</th>
                  <th className="py-2 pr-3 text-right font-semibold">Diferença</th>
                  <th className="py-2 pr-3 text-right font-semibold">Em comum</th>
                  <th className="py-2 pr-3 font-semibold">Ganhar-lhe a jornada</th>
                  <th className="py-2 font-semibold">Acabar à frente</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => {
                  const isMe = r.entry === me.entry;
                  return (
                    <tr
                      key={r.entry}
                      className={`border-t border-border ${
                        isMe
                          ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]"
                          : ""
                      }`}
                    >
                      <td className="py-2 pr-3 font-mono tabular">{r.rank}</td>
                      <td className="py-2 pr-3">
                        <span className="font-medium">{r.playerName}</span>
                        <span className="ml-2 text-xs text-text-muted">{r.entryName}</span>
                        {isMe && (
                          <span className="ml-2 rounded bg-accent-vivid px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-contrast">
                            tu
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular">
                        {r.totalPoints}
                      </td>
                      <td
                        className={`py-2 pr-3 text-right font-mono tabular font-semibold ${
                          isMe ? "text-text-muted" : r.gap >= 0 ? "text-success" : "text-danger"
                        }`}
                      >
                        {isMe ? "—" : `${r.gap >= 0 ? "+" : ""}${r.gap}`}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular">
                        {isMe ? "—" : r.overlap}
                      </td>
                      <td className="py-2">
                        {isMe ? (
                          <span className="text-xs text-text-muted">—</span>
                        ) : (
                          <Probability value={r.pWinGameweek} />
                        )}
                      </td>
                      <td className="py-2">
                        {isMe ? (
                          <span className="text-xs text-text-muted">—</span>
                        ) : (
                          <Probability value={r.pAheadAtSeasonEnd} highlight />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs leading-relaxed text-text-muted">
            Cada linha vem de {outlook.runs.toLocaleString("pt-PT")} jornadas
            simuladas ao nível do jogador: em cada simulação sorteia-se{" "}
            <strong>um</strong> resultado por jogador — um clean sheet por
            clube, um número de golos por avançado — e depois soma-se o onze de
            cada gestor sobre esses mesmos sorteios. É por isso que a coluna
            &quot;em comum&quot; importa tanto: quantos mais jogadores
            partilhas com alguém, mais as vossas pontuações sobem e descem
            juntas, e mais difícil é abrir ou fechar uma diferença.{" "}
            {outlook.squadsFromEvent !== null && (
              <>
                Os plantéis dos rivais são os da{" "}
                <strong>jornada {outlook.squadsFromEvent}</strong> — a API
                pública da FPL só publica o onze de um gestor depois de a
                jornada fechar, por isso transferências feitas esta semana
                ainda não aparecem aqui.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
