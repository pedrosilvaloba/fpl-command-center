import type { EliteSnapshot, EliteGap, CaptainDecision } from "@/lib/elite";
import type { ScoredPlayer } from "@/lib/recommend";
import { eliteOwn, eliteCap } from "@/lib/elite";
import ClubKit from "./ClubKit";

/**
 * O QUE A ELITE TEM QUE TU NÃO TENS.
 *
 * O modelo da app não prevê melhor do que a média de pontos por jogo (ver o
 * backtest). A posse dos melhores gestores do mundo é o consenso de quem tem
 * acertado — um sinal que o modelo não vê. Este painel mostra-o sem filtro:
 * o capitão da elite, os jogadores que ela tem e tu não, e a tua equipa
 * lida pela mesma lente.
 */
export default function ElitePanel({
  elite,
  gaps,
  squad,
  captain,
}: {
  elite: EliteSnapshot | null;
  gaps: EliteGap[];
  squad: ScoredPlayer[];
  captain: CaptainDecision;
}) {
  if (!elite) {
    return (
      <p className="text-sm text-text-muted">
        Os dados da elite ainda não foram recolhidos. São lidos todas as manhãs pelo cron; também se
        podem pedir à mão em /api/cron/refresh?only=elite.
      </p>
    );
  }
  const outsiders = squad
    .map((p) => ({ p, own: eliteOwn(elite, p.element.id) }))
    .filter((x) => x.own < 5)
    .sort((a, b) => a.own - b.own);
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-text-muted">
        Os {elite.managers} primeiros da classificação geral, escolhas da GW{elite.event}.
      </p>

      <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
        <p className="eyebrow text-text-muted">Capitão</p>
        <p className="text-[14px] font-semibold text-text">{captain.captain?.element.web_name ?? "—"}</p>
        <p className="text-[12px] leading-relaxed text-text-muted">{captain.reason}</p>
      </div>

      <div>
        <p className="eyebrow mb-1.5 text-text-muted">
          {gaps.length === 0
            ? "Tens todos os jogadores que a elite tem a 70% ou mais"
            : `A elite tem e tu não (${gaps.length})`}
        </p>
        {gaps.length > 0 && (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {gaps.map((g) => (
              <div
                key={g.player.element.id}
                className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/5 px-2 py-1.5 text-[12px]"
              >
                <ClubKit shortName={g.player.team.short_name} isKeeper={g.player.element.element_type === 1} size={16} />
                <span className="font-semibold text-text">{g.player.element.web_name}</span>
                <span className="text-text-muted">
                  {g.player.positionShort} · £{g.player.priceM.toFixed(1)} · {g.player.element.total_points} pts
                </span>
                <span className="ml-auto font-mono tabular text-warn">{Math.round(g.ownPct)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {outsiders.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5 text-text-muted">Teus, e quase ninguém na elite os tem (menos de 5%)</p>
          <p className="text-[12px] text-text">
            {outsiders
              .map((x) => `${x.p.element.web_name} (${Math.round(x.own)}%${eliteCap(elite, x.p.element.id) > 0 ? ", capitão de alguns" : ""})`)
              .join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}
