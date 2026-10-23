"use client";

import { useState } from "react";
import type { ChipKey } from "@/lib/transferplan";
import {
  parseChipQuestion,
  type ScenarioPlayerView,
  type ScenarioView,
} from "@/lib/chipscenarioview";
import ClubKit from "./ClubKit";

/**
 * "GOSTAVA DE USAR O WILDCARD ESTA SEMANA. QUAIS SÃO AS MINHAS OPÇÕES?"
 *
 * Todos os cenários já vêm calculados do servidor, com o mesmo solver e os
 * mesmos números do resto da página. Aqui só se escolhe qual mostrar — por
 * botão ou por pergunta escrita — por isso a resposta é instantânea e não
 * há nada que possa divergir do painel de transferências acima.
 */

const EXAMPLES = [
  "Gostava de usar o wildcard esta semana",
  "E se fizer free hit?",
  "Vale a pena o bench boost?",
  "Triplo capitão esta jornada?",
];

const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

function PlayerRow({
  p,
  cap,
  vice,
}: {
  p: ScenarioPlayerView;
  cap?: boolean;
  vice?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border py-1.5 last:border-0">
      <ClubKit shortName={p.team} isKeeper={p.pos === "GK"} size={18} />
      <span className="w-9 font-mono text-[11px] text-text-muted">{p.pos}</span>
      <span className="flex-1 truncate text-[13px] text-text">
        {p.name}
        {cap && (
          <span className="ml-1.5 rounded bg-accent/15 px-1 font-mono text-[10px] font-semibold text-accent">
            C
          </span>
        )}
        {vice && (
          <span className="ml-1.5 rounded bg-surface-3 px-1 font-mono text-[10px] text-text-muted">
            V
          </span>
        )}
        <span className="ml-1.5 text-[11px] text-text-muted">{p.team}</span>
      </span>
      <span className="w-12 text-right font-mono text-[12px] tabular text-text-muted">
        £{p.price.toFixed(1)}
      </span>
      <span className="w-12 text-right font-mono text-[12px] tabular text-text">{p.next.toFixed(1)}</span>
    </div>
  );
}

function Scenario({ s }: { s: ScenarioView }) {
  const status = !s.available
    ? { text: "Chip já usado", cls: "border-border bg-surface-2 text-text-muted" }
    : s.advised
      ? { text: "O modelo também o jogaria", cls: "border-accent/40 bg-accent/10 text-accent" }
      : { text: "O modelo guardava-o", cls: "border-warn/40 bg-warn/10 text-warn" };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-2 py-0.5 text-[12px] font-semibold ${status.cls}`}>
          {status.text}
        </span>
        <span className="font-mono text-[13px] tabular text-text">
          {sign(s.gainNext)} pts esta jornada
        </span>
        {s.gainWindow !== null && (
          <span className="font-mono text-[13px] tabular text-text-muted">
            · {sign(s.gainWindow)} pts em 5 jornadas
          </span>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-text">{s.verdict}</p>

      {(s.chip === "wildcard" || s.chip === "freehit") && (
        <div>
          <p className="eyebrow mb-2 text-text-muted">
            {s.transfers === 0
              ? "Nenhuma troca: o teu plantel já é o melhor para este cenário"
              : `${s.transfers} troca${s.transfers === 1 ? "" : "s"}, sem custo de pontos`}
            {s.bankAfterM !== null && ` · fica £${s.bankAfterM.toFixed(1)}m no banco`}
          </p>
          {s.moves.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {s.moves.map((m) => (
                <div
                  key={`${m.out.id}-${m.in.id}`}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
                >
                  <span className="truncate text-danger">{m.out.name}</span>
                  <span className="text-text-muted">→</span>
                  <ClubKit shortName={m.in.team} isKeeper={m.in.pos === "GK"} size={16} />
                  <span className="truncate font-semibold text-text">{m.in.name}</span>
                  <span className="ml-auto font-mono tabular text-text-muted">£{m.in.price.toFixed(1)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {s.xi.length > 0 && (
        <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
          <div>
            <div className="mb-1 flex justify-between">
              <p className="eyebrow text-text-muted">Onze para esta jornada</p>
              <p className="eyebrow text-text-muted">£ · pts prev.</p>
            </div>
            {s.xi.map((p) => (
              <PlayerRow key={p.id} p={p} cap={p.id === s.captainId} vice={p.id === s.viceCaptainId} />
            ))}
          </div>
          <div>
            <p className="eyebrow mb-1 text-text-muted">
              Banco{s.chip === "bboost" ? " — conta tudo com o chip" : ""}
            </p>
            {s.bench.map((p) => (
              <PlayerRow key={p.id} p={p} />
            ))}
          </div>
        </div>
      )}

      {s.rationale && <p className="text-[12px] leading-relaxed text-text-muted">{s.rationale}</p>}
    </div>
  );
}

export default function ChipScenarioPanel({ scenarios }: { scenarios: ScenarioView[] }) {
  const [active, setActive] = useState<ChipKey | null>(null);
  const [question, setQuestion] = useState("");
  const [notUnderstood, setNotUnderstood] = useState(false);

  if (scenarios.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Sem o teu plantel real carregado não há cenários para calcular.
      </p>
    );
  }

  const ask = (text: string) => {
    const chip = parseChipQuestion(text);
    setNotUnderstood(chip === null);
    if (chip) setActive(chip);
  };
  const current = scenarios.find((s) => s.chip === active) ?? null;

  return (
    <div className="space-y-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ex.: gostava de usar o wildcard esta semana"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-[14px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          aria-label="Pergunta sobre chips"
        />
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-[14px] font-semibold text-accent-contrast"
        >
          Ver opções
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {scenarios.map((s) => (
          <button
            key={s.chip}
            type="button"
            onClick={() => {
              setActive(s.chip);
              setNotUnderstood(false);
            }}
            className={`rounded-full border px-3 py-1 text-[13px] ${
              active === s.chip
                ? "border-accent bg-accent/15 font-semibold text-accent"
                : "border-border text-text-muted hover:text-text"
            } ${s.available ? "" : "opacity-60"}`}
          >
            {s.label}
            {s.advised && " ●"}
          </button>
        ))}
      </div>

      {notUnderstood && (
        <p className="text-[13px] text-warn">
          Não percebi de que chip falas. Experimenta, por exemplo: {EXAMPLES.join(" · ")}.
        </p>
      )}

      {current ? (
        <Scenario s={current} />
      ) : (
        <p className="text-[13px] text-text-muted">
          Pergunta pelo chip que estás a pensar usar, ou escolhe um botão. O ● marca os que o
          modelo jogaria esta jornada.
        </p>
      )}
    </div>
  );
}
