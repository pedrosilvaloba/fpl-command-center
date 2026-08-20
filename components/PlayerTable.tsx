import type { ScoredPlayer } from "@/lib/recommend";

export default function PlayerTable({
  players,
  showReasons = false,
}: {
  players: ScoredPlayer[];
  showReasons?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[560px]">
        <thead>
          <tr className="text-left text-text-muted uppercase text-xs tracking-wide">
            <th className="py-2 pr-3 font-medium">Jogador</th>
            <th className="py-2 pr-3 font-medium">Equipa</th>
            <th className="py-2 pr-3 font-medium text-right">Preço</th>
            <th className="py-2 pr-3 font-medium text-right">Posse</th>
            <th className="py-2 pr-3 font-medium text-right">Pontuação</th>
            {showReasons && <th className="py-2 font-medium">Porquê</th>}
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.element.id} className="border-t border-border">
              <td className="py-2 pr-3">
                <span className="font-medium">{p.element.web_name}</span>
                {p.isDifferential && (
                  <span className="ml-2 rounded bg-[color-mix(in_srgb,var(--gold)_18%,var(--surface))] text-gold border border-[color-mix(in_srgb,var(--gold)_35%,var(--border))] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    diferencial
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 text-text-muted">{p.team.short_name}</td>
              <td className="py-2 pr-3 text-right font-mono tabular">
                £{p.priceM.toFixed(1)}m
              </td>
              <td className="py-2 pr-3 text-right font-mono tabular">
                {p.ownershipPct.toFixed(1)}%
              </td>
              <td className="py-2 pr-3 text-right font-mono tabular font-semibold text-accent">
                {p.score.toFixed(1)}
              </td>
              {showReasons && (
                <td className="py-2 text-text-muted text-xs">
                  {p.reasons.join(" · ") || "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
