import type { ExpertApplication } from "@/lib/expertviews";

/**
 * O QUE OS ESPECIALISTAS DIZEM, CRUZADO COM O QUE O MODELO PENSA.
 *
 * A tentação era importar as opiniões e transformá-las em ajustes. Isso
 * seria contar a mesma coisa duas vezes: a percentagem de posse já É o
 * consenso agregado de milhões de pessoas que leem esses especialistas.
 *
 * O que este painel mostra é a DISCORDÂNCIA, e mostra-a com o número do
 * modelo ao lado para que o Pedro possa julgar por si. As concordâncias
 * aparecem sem destaque mas contadas — sem denominador, "discordaram três
 * vezes" não significa nada.
 */

const AGREEMENT_STYLE: Record<string, string> = {
  discorda: "border-warn/50 bg-warn/10",
  concorda: "border-border",
  neutro: "border-border",
  "sem-referencia": "border-border",
};

const AGREEMENT_LABEL: Record<string, string> = {
  discorda: "o modelo discorda",
  concorda: "o modelo concorda",
  neutro: "zona intermédia",
  "sem-referencia": "sem correspondência",
};

export default function ExpertViewsPanel({
  application,
}: {
  application: ExpertApplication;
}) {
  const { summary, adjusted } = application;
  if (summary.total === 0) {
    return (
      <p className="text-sm text-text-muted">
        Nenhuma opinião de especialista recolhida para esta jornada. A
        investigação de quinta procura-as em fóruns e analistas de FPL; se
        esta secção ficar vazia várias semanas seguidas, a tarefa não está a
        entregar.
      </p>
    );
  }

  // As discordâncias primeiro: são as únicas que acrescentam informação.
  const ordered = [...summary.checks].sort((a, b) => {
    const rank = (x: string) =>
      x === "discorda" ? 0 : x === "neutro" ? 1 : x === "concorda" ? 2 : 3;
    return rank(a.agreement) - rank(b.agreement);
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]">
        <span className="text-text">
          <strong className="font-mono tabular">{summary.total}</strong>{" "}
          opiniões recolhidas
        </span>
        <span className="text-warn">
          <strong className="font-mono tabular">{summary.disagree}</strong>{" "}
          em que o modelo discorda
        </span>
        <span className="text-text-muted">
          <strong className="font-mono tabular">{summary.agree}</strong>{" "}
          em que concorda
        </span>
        <span className="text-text-muted">
          <strong className="font-mono tabular">{adjusted}</strong> mexeram
          mesmo no número
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {ordered.map((c, i) => (
          <div
            key={`${c.view.id}-${i}`}
            className={`rounded-md border px-3 py-2 ${AGREEMENT_STYLE[c.agreement]}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-text">
                {c.view.label}
                <span className="ml-2 text-[11px] font-normal text-text-muted">
                  {c.view.stance === "sobe" ? "▲ otimista" : "▼ pessimista"} ·{" "}
                  {c.view.expert}
                </span>
              </span>
              <span
                className={`rounded-full border border-current px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  c.agreement === "discorda" ? "text-warn" : "text-text-muted"
                }`}
              >
                {AGREEMENT_LABEL[c.agreement]}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {c.view.reason}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-text">
              {c.verdict}
            </p>
            <p className="mt-0.5 font-mono text-[11px] tabular text-text-muted">
              novidade {(c.novelty * 100).toFixed(0)}% · efeito aplicado{" "}
              {c.novelty < 0.05
                ? "praticamente nulo"
                : `${Math.round((c.view.factor - 1) * (c.view.confidence ?? 1) * c.novelty * 100)}%`}
              {" · "}
              {c.view.source}
            </p>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-text-muted">
        {/* A regra, dita ao utilizador e não só ao compilador. */}
        Uma opinião só mexe no modelo na medida em que diga algo que ele ainda
        não diz — é isso que a coluna <strong className="text-text">novidade</strong>{" "}
        mede. Um especialista entusiasmado com o jogador que o modelo já tem
        em primeiro não acrescenta informação nenhuma: acrescenta a mesma
        informação uma segunda vez, e empurrava o plantel para o template.{" "}
        <strong className="text-text">
          As concordâncias contam-se mas não ajustam nada.
        </strong>
      </p>
    </div>
  );
}
