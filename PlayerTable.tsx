import type { ScoredPlayer } from "@/lib/recommend";
import ClubKit from "./ClubKit";

/**
 * A list of players that is a real table on a laptop and a list of cards on
 * a phone.
 *
 * The previous version was one table with `min-w-[560px]` and a horizontal
 * scroll container. On a 390px screen that meant the two columns a manager
 * most wants — the name and the score — could never be on screen at the
 * same time as the reasoning. Rendering the same data twice, hidden by
 * breakpoint, costs a little markup and removes the sideways scroll
 * entirely.
 */

function Badges({ player }: { player: ScoredPlayer }) {
  return (
    <>
      {player.isDifferential && (
        <span className="ml-1.5 rounded border border-[color-mix(in_srgb,var(--cyan)_40%,var(--border))] bg-[color-mix(in_srgb,var(--cyan)_14%,var(--surface))] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan">
          dif
        </span>
      )}
      {player.element.status !== "a" && (
        <span
          className="ml-1.5 rounded border border-[color-mix(in_srgb,var(--danger)_40%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_12%,var(--surface))] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
          title={player.element.news || undefined}
        >
          dúvida
        </span>
      )}
    </>
  );
}

export default function PlayerTable({
  players,
  showReasons = false,
}: {
  players: ScoredPlayer[];
  showReasons?: boolean;
}) {
  if (players.length === 0) {
    return <p className="text-sm text-text-muted">Sem jogadores para mostrar.</p>;
  }

  return (
    <>
      {/* --- phone: cards ------------------------------------------------ */}
      <ul className="flex flex-col gap-2 sm:hidden">
        {players.map((p) => (
          <li
            key={p.element.id}
            className="rounded-lg border border-border bg-surface-2 p-3"
          >
            <div className="flex items-start gap-2.5">
              <ClubKit
                shortName={p.team.short_name}
                isKeeper={p.element.element_type === 1}
                size={26}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {p.element.web_name}
                  <Badges player={p} />
                </p>
                <p className="mt-0.5 font-mono text-xs text-text-muted">
                  {p.team.short_name} · {p.positionShort} · £{p.priceM.toFixed(1)}m ·{" "}
                  {p.ownershipPct.toFixed(1)}%
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-lg font-bold leading-none text-accent">
                  {p.score.toFixed(1)}
                </p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                  pts / 5 jorn.
                </p>
              </div>
            </div>
            {showReasons && p.reasons.length > 0 && (
              <p className="mt-2 border-t border-border pt-2 text-xs leading-relaxed text-text-muted">
                {p.reasons.join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>

      {/* --- laptop: table ----------------------------------------------- */}
      <div className="hidden scroll-x sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
              <th className="py-2 pr-3 font-semibold">Jogador</th>
              <th className="py-2 pr-3 font-semibold">Equipa</th>
              <th className="py-2 pr-3 text-right font-semibold">Preço</th>
              <th className="py-2 pr-3 text-right font-semibold">Posse</th>
              {/* `score` is the expected-points total over the whole
                  five-gameweek scoring window, not the next gameweek — the
                  header used to say only "Pontos esp.", which invited it to
                  be read as a single-gameweek number roughly five times too
                  large. */}
              <th className="py-2 pr-3 text-right font-semibold">
                Pts esperados (5 jorn.)
              </th>
              {showReasons && <th className="py-2 font-semibold">Porquê</th>}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.element.id} className="border-t border-border align-top">
                <td className="py-2 pr-3">
                  <span className="font-medium">{p.element.web_name}</span>
                  <Badges player={p} />
                </td>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-1.5 text-text-muted">
                    <ClubKit
                      shortName={p.team.short_name}
                      isKeeper={p.element.element_type === 1}
                      size={18}
                    />
                    {p.team.short_name}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular">
                  £{p.priceM.toFixed(1)}m
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular">
                  {p.ownershipPct.toFixed(1)}%
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular font-bold text-accent">
                  {p.score.toFixed(1)}
                </td>
                {showReasons && (
                  <td className="py-2 text-xs leading-relaxed text-text-muted">
                    {p.reasons.join(" · ") || "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
