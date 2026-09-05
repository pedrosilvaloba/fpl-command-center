import type { LeagueChipState } from "@/lib/rivalchips";

/**
 * OS CHIPS DA LIGA — a informação que o Pedro viu sozinho e o modelo não.
 *
 * A app já lia os onzes dos rivais para simular a liga. Passava ao lado do
 * campo `chips` do histórico de cada gestor, que diz exatamente que chips
 * gastaram e em que jornada — a única coisa que ele tinha notado por conta
 * própria e sobre a qual o modelo não tinha nada a dizer.
 *
 * O painel mostra os factos e recusa-se a tirar deles a conclusão fácil.
 * Numa liga privada, o que a maioria faz não é sabedoria de mercado; é o
 * que os amigos decidiram. O que torna isto decisivo não é terem razão — é
 * que um chip que expira por usar custa posição contra quem já cobrou o
 * seu, e não custa nada se toda a gente o desperdiçar também.
 */

function Bar({ used, of }: { used: number; of: number }) {
  const pct = of > 0 ? Math.round((used / of) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-accent-vivid"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[11px] tabular text-text-muted">
        {used}/{of}
      </span>
    </div>
  );
}

export default function LeagueChipsPanel({
  state,
}: {
  state: LeagueChipState;
}) {
  if (!state.available) {
    return (
      <p className="text-sm text-text-muted">
        {state.reason ??
          "Ainda não foi possível ler os chips dos teus rivais."}
      </p>
    );
  }

  const spenders = state.records.filter((r) => r.chips.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {state.summaries.map((s) => (
          <div
            key={s.chip}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div>
              <p className="text-[13px] font-semibold text-text">{s.label}</p>
              <p className="text-[11px] text-text-muted">
                {s.used === 0
                  ? "ninguém gastou"
                  : `1.º uso na GW${s.firstEvent}`}
                {s.mineUsed && " · tu já gastaste"}
              </p>
            </div>
            <Bar used={s.used} of={s.of} />
          </div>
        ))}
      </div>

      {spenders.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="py-1 pr-3 font-normal">#</th>
                <th className="py-1 pr-3 font-normal">Equipa</th>
                <th className="py-1 font-normal">Chips gastos</th>
              </tr>
            </thead>
            <tbody>
              {spenders.map((r) => (
                <tr
                  key={r.entry}
                  className={`border-b border-border/50 ${r.isMe ? "bg-accent/5" : ""}`}
                >
                  <td className="py-1 pr-3 font-mono tabular text-text-muted">
                    {r.rank}
                  </td>
                  <td className="py-1 pr-3 text-text">
                    {r.entryName}
                    {r.isMe && (
                      <span className="ml-1 text-[10px] text-accent">(tu)</span>
                    )}
                  </td>
                  <td className="py-1 font-mono text-[11px] text-text-muted">
                    {r.chips
                      .map((c) => `${c.name} GW${c.event}`)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-text-muted">
        Lidos {state.sampled} gestores de {state.fieldSize}
        {state.myRank !== null && ` · estás em ${state.myRank}.º`}.{" "}
        <strong className="text-text">
          Isto não é prova de que eles tenham razão.
        </strong>{" "}
        Numa liga de amigos, o consenso não é sabedoria de mercado — é o que
        os teus amigos decidiram, e podem estar todos errados ao mesmo tempo.
        Onde isto pesa mesmo é no desperdício: um chip que deixares expirar
        na GW19 custa-te posição contra quem já cobrou o seu, e não te custa
        nada se toda a gente o desperdiçar também. O modelo usa isto para
        descontar, no máximo 25%, o valor de continuar à espera — nunca para
        te mandar seguir a maioria.
      </p>
    </div>
  );
}
