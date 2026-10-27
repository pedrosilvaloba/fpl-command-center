import type { ScenarioPlayerView } from "@/lib/chipscenarioview";
import ClubKit from "./ClubKit";

const groups = [
  { position: "GK", name: "Guarda-redes" },
  { position: "DEF", name: "Defesa" },
  { position: "MID", name: "Meio-campo" },
  { position: "FWD", name: "Ataque" },
] as const;

export default function WildcardPitch({
  players, captainId, viceCaptainId,
}: {
  players: ScenarioPlayerView[];
  captainId: number | null;
  viceCaptainId: number | null;
}) {
  return (
    <div className="rounded-xl border border-emerald-400/30 bg-gradient-to-b from-emerald-950 to-emerald-900 p-3 text-white sm:p-5" aria-label="Onze projetado no relvado">
      <div className="mb-3 flex items-center justify-between text-xs text-white/75">
        <strong>Onze projetado</strong>
        <span>Pontos previstos na próxima jornada</span>
      </div>
      <div className="space-y-3 sm:space-y-5">
        {groups.map(group => (
          <div key={group.position} role="group" aria-label={group.name} className="flex flex-wrap justify-center gap-2 sm:gap-4">
            {players.filter(p => p.pos === group.position).map(p => (
              <div key={p.id} className="min-w-[4.5rem] max-w-[7rem] flex-1 rounded-lg border border-white/20 bg-black/20 px-1.5 py-2 text-center">
                <div className="flex justify-center"><ClubKit shortName={p.team} isKeeper={p.pos === "GK"} size={29} /></div>
                <div className="mt-1 truncate text-xs font-semibold" title={p.name}>
                  {p.name}
                </div>
                <div className="mt-1 text-xs font-mono text-emerald-100">
                  {p.next.toFixed(1)} xP
                  {captainId === p.id ? " · C" : viceCaptainId === p.id ? " · V" : ""}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] text-white/70">
        C = capitão · V = vice-capitão · xP = pontos esperados, não garantidos
      </p>
    </div>
  );
}
