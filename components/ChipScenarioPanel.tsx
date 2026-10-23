"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ChipKey, MoveKind } from "@/lib/transferplan";
import {
  parseChipQuestion,
  type ScenarioPlayerView,
  type ScenarioView,
} from "@/lib/chipscenarioview";
import ClubKit from "./ClubKit";

/**
 * "GOSTAVA DE USAR O WILDCARD ESTA SEMANA. QUAIS SÃO AS MINHAS OPÇÕES?"
 *
 * Os cenários vêm calculados do servidor, com o mesmo solver do resto da
 * página. Escolher o chip é instantâneo. Fixar um jogador ("manter") volta
 * a pedir a página com `?manter=` no URL, e o servidor refaz o plantel à
 * volta dele — o solver tem de correr de novo, não há atalho honesto.
 *
 * Porque é que fixar existe: entre titulares, as previsões do modelo estão
 * todas a um ou dois pontos umas das outras, e o backtest mostra que ele não
 * distingue diferenças desse tamanho. Com trocas grátis, o solver aproveita
 * cada meio ponto — e vende o melhor marcador da época para pagar outra
 * troca. O gestor sabe coisas que o modelo não mede; fixar é dizer-lhe.
 */

const EXAMPLES = [
  "Gostava de usar o wildcard esta semana",
  "E se fizer free hit?",
  "Vale a pena o bench boost?",
  "Triplo capitão esta jornada?",
];

const KIND_STYLE: Record<MoveKind, { label: string; cls: string; title: string }> = {
  clara: {
    label: "clara",
    cls: "bg-accent/15 text-accent",
    title: "O reforço ganha mais do que o erro com que o modelo distingue os dois jogadores.",
  },
  indiferente: {
    label: "tanto faz",
    cls: "bg-surface-3 text-text-muted",
    title: "Ganha, mas menos do que a margem de erro do modelo. É ruído.",
  },
  financia: {
    label: "só liberta £",
    cls: "bg-warn/15 text-warn",
    title: "Quem entra vale MENOS do que quem sai. A troca só existe para pagar outra.",
  },
};

const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

function KeepButton({
  id,
  kept,
  onToggle,
  pending,
}: {
  id: number;
  kept: boolean;
  onToggle: (id: number) => void;
  pending: boolean;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => onToggle(id)}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${
        kept
          ? "border-accent bg-accent/15 font-semibold text-accent"
          : "border-border text-text-muted hover:border-accent hover:text-text"
      } disabled:opacity-50`}
      title={kept ? "Deixar de fixar" : "Fixar: o cenário tem de o manter"}
    >
      {kept ? "fixo ✓" : "manter"}
    </button>
  );
}

function PlayerRow({
  p,
  cap,
  vice,
  lock,
}: {
  p: ScenarioPlayerView;
  cap?: boolean;
  vice?: boolean;
  lock?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border py-1.5 last:border-0">
      <ClubKit shortName={p.team} isKeeper={p.pos === "GK"} size={18} />
      <span className="w-9 font-mono text-[11px] text-text-muted">{p.pos}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-text">
        {p.name}
        {cap && (
          <span className="ml-1.5 rounded bg-accent/15 px-1 font-mono text-[10px] font-semibold text-accent">
            C
          </span>
        )}
        {vice && (
          <span className="ml-1.5 rounded bg-surface-3 px-1 font-mono text-[10px] text-text-muted">V</span>
        )}
        <span className="ml-1.5 text-[11px] text-text-muted">{p.team}</span>
      </span>
      {lock}
      <span className="w-10 text-right font-mono text-[12px] tabular text-text-muted">{p.seasonPts}</span>
      <span className="hidden w-12 text-right font-mono text-[12px] tabular text-text-muted sm:inline">
        £{p.price.toFixed(1)}
      </span>
      <span className="w-10 text-right font-mono text-[12px] tabular text-text">{p.next.toFixed(1)}</span>
    </div>
  );
}

function Scenario({
  s,
  onToggleKeep,
  pending,
}: {
  s: ScenarioView;
  onToggleKeep: (id: number) => void;
  pending: boolean;
}) {
  const kept = new Set(s.keptIds);
  const owned = new Set(s.ownedIds);
  const rebuilds = s.chip === "wildcard" || s.chip === "freehit";
  const status = !s.available
    ? { text: "Chip já usado", cls: "border-border bg-surface-2 text-text-muted" }
    : s.advised
      ? { text: "O modelo também o jogaria", cls: "border-accent/40 bg-accent/10 text-accent" }
      : { text: "O modelo guardava-o", cls: "border-warn/40 bg-warn/10 text-warn" };
  const lockFor = (p: ScenarioPlayerView) =>
    rebuilds && owned.has(p.id) ? (
      <KeepButton id={p.id} kept={kept.has(p.id)} onToggle={onToggleKeep} pending={pending} />
    ) : null;

  return (
    <div className={`space-y-4 ${pending ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-2 py-0.5 text-[12px] font-semibold ${status.cls}`}>
          {status.text}
        </span>
        <span className="font-mono text-[13px] tabular text-text">{sign(s.gainNext)} pts esta jornada</span>
        {s.gainWindow !== null && (
          <span className="font-mono text-[13px] tabular text-text-muted">
            · {sign(s.gainWindow)} pts em 5 jornadas
          </span>
        )}
        {pending && <span className="text-[12px] text-text-muted">a refazer o plantel…</span>}
      </div>
      <p className="text-[13px] leading-relaxed text-text">{s.verdict}</p>

      {rebuilds && (
        <div>
          <p className="eyebrow mb-2 text-text-muted">
            {s.transfers === 0
              ? "Nenhuma troca: o teu plantel já é o melhor para este cenário"
              : `${s.transfers} troca${s.transfers === 1 ? "" : "s"}, sem custo de pontos`}
            {s.bankAfterM !== null && ` · fica £${s.bankAfterM.toFixed(1)}m no banco`}
            {kept.size > 0 && ` · ${kept.size} fixo${kept.size === 1 ? "" : "s"}`}
          </p>
          {s.moves.length > 0 && (
            <div className="grid gap-1.5 lg:grid-cols-2">
              {s.moves.map((m) => {
                const k = KIND_STYLE[m.kind];
                return (
                  <div
                    key={`${m.out.id}-${m.in.id}`}
                    className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
                  >
                    <KeepButton id={m.out.id} kept={false} onToggle={onToggleKeep} pending={pending} />
                    <span className="truncate text-danger">
                      {m.out.name}
                      <span className="ml-1 font-mono text-[10px] text-text-muted">{m.out.seasonPts}p</span>
                    </span>
                    <span className="text-text-muted">→</span>
                    <ClubKit shortName={m.in.team} isKeeper={m.in.pos === "GK"} size={16} />
                    <span className="truncate font-semibold text-text">
                      {m.in.name}
                      <span className="ml-1 font-mono text-[10px] font-normal text-text-muted">
                        {m.in.seasonPts}p
                      </span>
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${k.cls}`}
                      title={k.title}
                    >
                      {k.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-[11px] text-text-muted">
            <b>clara</b>: o modelo consegue defender a troca · <b>tanto faz</b>: diferença dentro da
            margem de erro · <b>só liberta £</b>: quem entra vale menos do que quem sai, serve para pagar
            outra. &quot;Manter&quot; fixa o jogador e refaz o plantel à volta dele.
          </p>
        </div>
      )}

      {s.xi.length > 0 && (
        <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
          <div>
            <div className="mb-1 flex justify-between gap-2">
              <p className="eyebrow text-text-muted">Onze para esta jornada</p>
              <p className="eyebrow text-text-muted">época · £ · prev.</p>
            </div>
            {s.xi.map((p) => (
              <PlayerRow
                key={p.id}
                p={p}
                cap={p.id === s.captainId}
                vice={p.id === s.viceCaptainId}
                lock={lockFor(p)}
              />
            ))}
          </div>
          <div>
            <p className="eyebrow mb-1 text-text-muted">
              Banco{s.chip === "bboost" ? " — conta tudo com o chip" : ""}
            </p>
            {s.bench.map((p) => (
              <PlayerRow key={p.id} p={p} lock={lockFor(p)} />
            ))}
          </div>
        </div>
      )}

      {s.rationale && <p className="text-[12px] leading-relaxed text-text-muted">{s.rationale}</p>}
    </div>
  );
}

export default function ChipScenarioPanel({
  scenarios,
  initialChip = null,
}: {
  scenarios: ScenarioView[];
  initialChip?: ChipKey | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<ChipKey | null>(initialChip);
  const [question, setQuestion] = useState("");
  const [notUnderstood, setNotUnderstood] = useState(false);

  if (scenarios.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Sem o teu plantel real carregado não há cenários para calcular.
      </p>
    );
  }

  const kept = scenarios.find((s) => s.chip === "wildcard")?.keptIds ?? [];

  const ask = (text: string) => {
    const chip = parseChipQuestion(text);
    setNotUnderstood(chip === null);
    if (chip) setActive(chip);
  };

  const toggleKeep = (id: number) => {
    const next = kept.includes(id) ? kept.filter((k) => k !== id) : [...kept, id];
    const params = new URLSearchParams();
    if (active) params.set("chip", active);
    if (next.length > 0) params.set("manter", next.join(","));
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/?${qs}#cenarios` : "/#cenarios", { scroll: false });
    });
  };

  const current = scenarios.find((s) => s.chip === active) ?? null;

  return (
    <div id="cenarios" className="scroll-mt-24 space-y-4">
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

      <div className="flex flex-wrap items-center gap-2">
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
        {kept.length > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(() =>
                router.replace(active ? `/?chip=${active}#cenarios` : "/#cenarios", { scroll: false })
              )
            }
            className="text-[12px] text-text-muted underline hover:text-text"
          >
            limpar fixos ({kept.length})
          </button>
        )}
      </div>

      {notUnderstood && (
        <p className="text-[13px] text-warn">
          Não percebi de que chip falas. Experimenta, por exemplo: {EXAMPLES.join(" · ")}.
        </p>
      )}

      {current ? (
        <Scenario s={current} onToggleKeep={toggleKeep} pending={pending} />
      ) : (
        <p className="text-[13px] text-text-muted">
          Pergunta pelo chip que estás a pensar usar, ou escolhe um botão. O ● marca os que o modelo
          jogaria esta jornada.
        </p>
      )}
    </div>
  );
}
