import type { ScoredPlayer } from "@/lib/recommend";

/**
 * A APOSTA QUE A BRAÇADEIRA REPRESENTA, E AS ALTERNATIVAS.
 *
 * O ecrã dizia "Capitão: Cherki" e mais nada. Nem quem ficou em segundo, nem
 * por que margem, nem que tipo de jornada se está a comprar. A decisão de
 * maior alavancagem da semana — a única que DOBRA pontos — aparecia como um
 * nome sem contexto, o que a torna impossível de questionar.
 *
 * Aqui aparecem os candidatos com as duas coisas que os separam:
 *
 *   MÉDIA      quanto se espera dele, tudo contado.
 *   AMPLITUDE  o quão explosivo ele é NAS SEMANAS EM QUE JOGA — não a sua
 *              variância total, que é dominada pela dúvida sobre se joga e
 *              que ninguém deve procurar.
 *
 * E o "risco de falta" separado, porque é a variância que se sofre em vez
 * de se escolher.
 */

function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}

export default function CaptainShortlist({
  starters,
  captainId,
  viceId,
  beta,
}: {
  starters: ScoredPlayer[];
  captainId: number | null;
  viceId: number | null;
  beta: number;
}) {
  const top = [...starters]
    .sort((a, b) => b.expectedPointsNext - a.expectedPointsNext)
    .slice(0, 5);
  if (top.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="py-1 pr-3 font-normal">Candidato</th>
              <th className="py-1 pr-3 text-right font-normal">Média</th>
              <th className="py-1 pr-3 text-right font-normal">Amplitude</th>
              <th className="py-1 pr-3 text-right font-normal">Jornada boa</th>
              <th className="py-1 text-right font-normal">Risco de falta</th>
            </tr>
          </thead>
          <tbody>
            {top.map((p) => {
              const r = p.risk;
              const isC = p.element.id === captainId;
              const isV = p.element.id === viceId;
              return (
                <tr
                  key={p.element.id}
                  className={`border-b border-border/50 ${isC ? "bg-accent/5" : ""}`}
                >
                  <td className="py-1 pr-3 text-text">
                    {p.element.web_name}
                    {isC && (
                      <span className="ml-1.5 text-[10px] font-semibold text-accent">
                        CAP
                      </span>
                    )}
                    {isV && (
                      <span className="ml-1.5 text-[10px] text-text-muted">
                        VICE
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular text-text">
                    {p.expectedPointsNext.toFixed(1)}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular text-text-muted">
                    {r ? `±${r.sdIfPlays.toFixed(1)}` : "—"}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular text-text-muted">
                    {r ? r.upside.toFixed(1) : "—"}
                  </td>
                  <td className="py-1 text-right font-mono tabular text-text-muted">
                    {r && r.blankShare > 0.15 ? pct(r.blankShare) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-text-muted">
        <strong className="text-text">Amplitude</strong> é o quão explosiva é
        a jornada dele quando joga; <strong className="text-text">jornada
        boa</strong> é o que esperar num dia acima da média.{" "}
        <strong className="text-text">Risco de falta</strong> é a parte da
        incerteza que vem só de ele poder não entrar — essa não se procura,
        sofre-se.{" "}
        {beta > 0.05 ? (
          <>
            Com a postura atual ({beta.toFixed(2)}) o modelo está a{" "}
            <strong className="text-text">preferir amplitude</strong>: estás
            atrás e precisas de semanas grandes, não de semanas seguras.
          </>
        ) : beta < -0.05 ? (
          <>
            Com a postura atual ({beta.toFixed(2)}) o modelo está a{" "}
            <strong className="text-text">evitar amplitude</strong>: tens
            vantagem a defender, e semanas previsíveis protegem-na.
          </>
        ) : (
          <>
            A postura está neutra ({beta.toFixed(2)}), por isso a amplitude{" "}
            <strong className="text-text">não está a influenciar nada</strong>{" "}
            — a braçadeira vai simplesmente ao de maior média. É o correto no
            início da época: ainda se recupera por competência, não por sorte.
          </>
        )}
      </p>
    </div>
  );
}
