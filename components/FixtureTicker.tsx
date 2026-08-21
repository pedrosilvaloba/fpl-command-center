import type { FplTeam } from "@/lib/types";
import type { ModelFixtureRow } from "@/lib/matchmodel";
import { avgExpectedGoalsFor, avgCleanSheetProbability } from "@/lib/matchmodel";

// Thresholds reused from lib/recommend.ts's own "boa probabilidade de
// clean sheet" (>=0.35) and "golos esperados altos" (>=1.6) cues, so the
// colours here mean the same thing they mean in the scoring reasons —
// no separate, undocumented scale invented just for this chart.
function attackClasses(xg: number): string {
  if (xg >= 1.6)
    return "bg-[color-mix(in_srgb,var(--success)_18%,var(--surface))] text-success border border-[color-mix(in_srgb,var(--success)_35%,var(--border))]";
  if (xg >= 1.1)
    return "bg-[color-mix(in_srgb,var(--warn)_16%,var(--surface))] text-warn border border-[color-mix(in_srgb,var(--warn)_35%,var(--border))]";
  return "bg-[color-mix(in_srgb,var(--danger)_16%,var(--surface))] text-danger border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))]";
}

function defenceClasses(cs: number): string {
  if (cs >= 0.35) return "text-success";
  if (cs >= 0.2) return "text-warn";
  return "text-danger";
}

export default function FixtureTicker({
  teams,
  ticker,
  oddsActive,
  strengthsUsable = true,
}: {
  teams: FplTeam[];
  ticker: Record<number, ModelFixtureRow[]>;
  oddsActive: boolean;
  /** False when FPL has not published its team strength ratings, so every
   * team is running on the same neutral baseline (see lib/matchmodel.ts). */
  strengthsUsable?: boolean;
}) {
  const rows = teams
    .map((t) => ({ team: t, fixtures: ticker[t.id] ?? [] }))
    // Sort by attacking upside first (the more commonly-scanned "who has
    // the kind run of fixtures" question) — defensive solidity is its
    // own separate column for defence-minded picks, not folded in here.
    .sort((a, b) => avgExpectedGoalsFor(b.fixtures) - avgExpectedGoalsFor(a.fixtures));

  return (
    <div className="overflow-x-auto">
      {!strengthsUsable && (
        <div className="mb-4 rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] px-4 py-3 text-sm text-warn">
          <strong>A FPL ainda não publicou as forças das equipas.</strong> Os
          campos de força de ataque/defesa vêm todos a zero da API oficial
          neste momento, por isso o modelo não consegue distinguir uma equipa
          da outra e está a tratar todas como equipas médias. Os números
          abaixo são um valor de referência (vantagem caseira e pouco mais),
          não uma previsão real jogo a jogo — vão passar a diferenciar
          equipas assim que a FPL preencher esses dados, normalmente nos
          primeiros dias da época.
        </div>
      )}
      <table className="w-full border-collapse text-sm min-w-[680px]">
        <thead>
          <tr className="text-left text-text-muted uppercase text-xs tracking-wide">
            <th className="py-2 pr-3 font-medium">Equipa</th>
            <th className="py-2 pr-3 font-medium">Ataque (xG/jogo)</th>
            <th className="py-2 pr-3 font-medium">Defesa (clean sheet)</th>
            <th className="py-2 font-medium">Próximos jogos</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, fixtures }) => {
            const xg = avgExpectedGoalsFor(fixtures);
            const cs = avgCleanSheetProbability(fixtures);
            return (
              <tr key={team.id} className="border-t border-border">
                <td className="py-2 pr-3 font-display text-base tracking-wide">
                  {team.short_name}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono tabular ${attackClasses(xg)}`}
                  >
                    {xg.toFixed(2)}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  <span className={`font-mono tabular text-xs ${defenceClasses(cs)}`}>
                    {Math.round(cs * 100)}%
                  </span>
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {fixtures.length === 0 && (
                      <span className="text-text-muted text-xs">
                        sem jogos agendados
                      </span>
                    )}
                    {fixtures.map((f, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono tabular ${attackClasses(f.expectedGoalsFor)}`}
                        title={`GW${f.event} · ${f.expectedGoalsFor.toFixed(2)}xG · ${Math.round(f.cleanSheetProbability * 100)}% clean sheet${f.marketAdjusted ? " · ajustado com odds" : ""}`}
                      >
                        {f.opponentShort}
                        {f.isHome ? "" : "*"}
                        {f.marketAdjusted && <span className="ml-0.5 opacity-70">°</span>}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-text-muted">
        * fora de casa. {oddsActive && <>° ajustado com odds de mercado. </>}
        Números do próprio modelo desta app (Poisson sobre a força de
        ataque/defesa de cada equipa, corrigido pelos resultados reais
        desta época{oddsActive ? " e por odds de mercado" : ""}) — já não é
        o dígito 1-5 genérico da FPL. Ataque = golos esperados da equipa
        por jogo; Defesa = probabilidade de clean sheet. Uma equipa pode
        ser boa aposta para os teus atacantes e má para os teus defesas
        (ou o contrário) — por isso os dois números aparecem separados,
        não misturados numa única &quot;dificuldade&quot;.
      </p>
    </div>
  );
}
