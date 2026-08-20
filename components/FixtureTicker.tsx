import type { FplTeam } from "@/lib/types";
import type { UpcomingFixture } from "@/lib/fdr";
import { averageDifficulty, difficultyLabel } from "@/lib/fdr";

function chipClasses(difficulty: number): string {
  if (difficulty <= 2)
    return "bg-[color-mix(in_srgb,var(--success)_18%,var(--surface))] text-success border border-[color-mix(in_srgb,var(--success)_35%,var(--border))]";
  if (difficulty <= 3)
    return "bg-[color-mix(in_srgb,var(--warn)_16%,var(--surface))] text-warn border border-[color-mix(in_srgb,var(--warn)_35%,var(--border))]";
  return "bg-[color-mix(in_srgb,var(--danger)_16%,var(--surface))] text-danger border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))]";
}

export default function FixtureTicker({
  teams,
  ticker,
}: {
  teams: FplTeam[];
  ticker: Record<number, UpcomingFixture[]>;
}) {
  const rows = teams
    .map((t) => ({ team: t, fixtures: ticker[t.id] ?? [] }))
    .sort(
      (a, b) => averageDifficulty(a.fixtures) - averageDifficulty(b.fixtures)
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[640px]">
        <thead>
          <tr className="text-left text-text-muted uppercase text-xs tracking-wide">
            <th className="py-2 pr-3 font-medium">Equipa</th>
            <th className="py-2 pr-3 font-medium">Média</th>
            <th className="py-2 font-medium">Próximos jogos</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, fixtures }) => {
            const avg = averageDifficulty(fixtures);
            const label = difficultyLabel(avg);
            return (
              <tr key={team.id} className="border-t border-border">
                <td className="py-2 pr-3 font-display text-base tracking-wide">
                  {team.short_name}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono tabular ${chipClasses(
                      avg
                    )}`}
                  >
                    {avg.toFixed(1)} · {label}
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
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono tabular ${chipClasses(
                          f.difficulty
                        )}`}
                        title={`GW${f.event}`}
                      >
                        {f.opponentShort}
                        {f.isHome ? "" : "*"}
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
        * fora de casa. Dificuldade oficial da FPL (1 fácil – 5 difícil) —
        conhecida por ser algo grosseira (baseada em posição na liga); um
        FDR próprio baseado em Elo/xG está no roadmap.
      </p>
    </div>
  );
}
