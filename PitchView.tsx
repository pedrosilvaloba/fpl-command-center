import type { ScoredPlayer } from "@/lib/recommend";
import ClubKit from "./ClubKit";

/**
 * The starting eleven laid out on a pitch, plus the bench.
 *
 * This replaces two side-by-side tables of eleven and four names. The tables
 * were not wrong, but they made the two things a manager actually checks at
 * a glance — the shape, and whether one club is over-represented — into a
 * reading exercise. On a phone they were worse still: 560px of minimum
 * width inside a 390px screen meant the squad could only ever be seen
 * through a horizontally-scrolling window.
 *
 * Rows are derived from the eleven itself rather than assumed, so any legal
 * formation renders correctly without a lookup table of shapes.
 */

const ROW_ORDER: { type: number; label: string }[] = [
  { type: 1, label: "GR" },
  { type: 2, label: "DEF" },
  { type: 3, label: "MED" },
  { type: 4, label: "AVA" },
];

function PlayerChip({
  player,
  badge,
  metric,
}: {
  player: ScoredPlayer;
  badge?: "C" | "V" | null;
  metric: "points" | "price";
}) {
  const value =
    metric === "points"
      ? `${player.expectedPointsNext.toFixed(1)}`
      : `£${player.priceM.toFixed(1)}`;
  const doubt = player.element.status !== "a";

  return (
    <div className="relative flex w-[60px] flex-col items-center gap-0.5 sm:w-[76px]">
      {badge && (
        <span
          className={`absolute -top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
            badge === "C"
              ? "bg-[var(--brand-green)] text-[var(--accent-contrast)]"
              : "bg-[var(--brand-cyan)] text-[var(--accent-contrast)]"
          }`}
          title={badge === "C" ? "Capitão" : "Vice-capitão"}
        >
          {badge}
        </span>
      )}
      {doubt && (
        <span
          className="absolute -top-1 left-0 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--brand-pink)] text-[9px] font-bold text-white"
          title={player.element.news || "Dúvida / indisponibilidade sinalizada pela FPL"}
        >
          !
        </span>
      )}
      <ClubKit
        shortName={player.team.short_name}
        isKeeper={player.element.element_type === 1}
        size={34}
      />
      <span className="w-full truncate rounded-[3px] bg-white px-1 py-px text-center text-[11px] font-semibold leading-tight text-[#14101a]">
        {player.element.web_name}
      </span>
      {/* Near-opaque backing, not a wash. At 78% opacity over a mid-green
          pitch the brand green came out muddy and the number — the whole
          point of the chip — was the least legible thing on it. */}
      <span className="w-full truncate rounded-[3px] bg-[#12071a]/92 px-1 py-px text-center font-mono text-[11px] font-medium leading-tight text-[var(--brand-green)]">
        {value}
      </span>
    </div>
  );
}

export default function PitchView({
  starters,
  bench,
  showBenchOrder = true,
  captainId,
  viceCaptainId,
  metric = "points",
}: {
  starters: ScoredPlayer[];
  /** Already in FPL substitution order — see orderBench in lib/recommend.ts. */
  bench: ScoredPlayer[];
  /** Numbers the bench 1/2/3. An unnumbered row communicates nothing about
   * the order automatic substitutions will actually follow. */
  showBenchOrder?: boolean;
  captainId?: number;
  viceCaptainId?: number;
  /** Which number to print under each shirt. */
  metric?: "points" | "price";
}) {
  const rows = ROW_ORDER.map((row) => ({
    ...row,
    players: starters.filter((p) => p.element.element_type === row.type),
  })).filter((row) => row.players.length > 0);

  const badgeFor = (p: ScoredPlayer): "C" | "V" | null =>
    p.element.id === captainId ? "C" : p.element.id === viceCaptainId ? "V" : null;

  return (
    // Constrained and centred rather than stretched. A 3-4-3 spread across a
    // 1200px card reads as an empty field with a huddle in the middle; at
    // roughly 600px it reads as a pitch, which is the whole point of drawing
    // one instead of listing names.
    <div className="mx-auto flex w-full max-w-[620px] flex-col gap-3">
      <div
        className="relative overflow-hidden rounded-xl px-2 py-3 sm:px-4 sm:py-4"
        style={{
          background:
            "repeating-linear-gradient(to bottom, var(--pitch-1) 0 30px, var(--pitch-2) 30px 60px)",
        }}
      >
        {/* Pitch markings — decorative only, hidden from assistive tech. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div
            className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ borderColor: "var(--pitch-line)" }}
          />
          <div
            className="absolute left-0 right-0 top-1/2 border-t"
            style={{ borderColor: "var(--pitch-line)" }}
          />
          <div
            className="absolute left-1/2 top-0 h-12 w-2/5 -translate-x-1/2 border-x border-b"
            style={{ borderColor: "var(--pitch-line)" }}
          />
          <div
            className="absolute bottom-0 left-1/2 h-12 w-2/5 -translate-x-1/2 border-x border-t"
            style={{ borderColor: "var(--pitch-line)" }}
          />
        </div>

        <div className="relative flex flex-col gap-3 sm:gap-4">
          {rows.map((row) => (
            <div
              key={row.type}
              className="flex flex-wrap items-start justify-center gap-x-2 gap-y-2.5 sm:gap-x-4"
            >
              {row.players.map((p) => (
                <PlayerChip
                  key={p.element.id}
                  player={p}
                  badge={badgeFor(p)}
                  metric={metric}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {bench.length > 0 && (
        <div className="rounded-xl border border-border bg-surface-2 px-2 py-2.5 sm:px-4">
          <p className="mb-2 text-center eyebrow text-text-muted">
            Banco
          </p>
          <div className="flex flex-wrap items-start justify-center gap-x-2 gap-y-2.5 sm:gap-x-4">
            {bench.map((p, i) => (
              <div key={p.element.id} className="flex flex-col items-center gap-1">
                <PlayerChip player={p} metric={metric} />
                {showBenchOrder && (
                  <span className="font-mono text-[10px] leading-none text-text-muted">
                    {p.element.element_type === 1 ? "GR" : String(i)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-[11px] text-text-muted">
        {metric === "points"
          ? "Número sob cada camisola: pontos esperados na próxima jornada."
          : "Número sob cada camisola: preço atual."}{" "}
        <span className="text-[var(--brand-green)]">C</span> capitão ·{" "}
        <span className="text-[var(--brand-cyan)]">V</span> vice ·{" "}
        <span className="text-[var(--brand-pink)]">!</span> dúvida sinalizada
        pela FPL. O banco está pela ordem em que a FPL fará as substituições
        automáticas — 1 entra primeiro.
      </p>
    </div>
  );
}
