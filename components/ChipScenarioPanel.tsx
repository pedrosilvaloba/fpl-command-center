"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ChipKey, MoveKind, WildcardProfile } from "@/lib/transferplan";
import {
  parseChipQuestion,
  scenarioHref,
  type IncludeCandidate,
  type ScenarioPlayerView,
  type ScenarioView,
} from "@/lib/chipscenarioview";
import ClubKit from "./ClubKit";
import WildcardPitch from "./WildcardPitch";

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

const WILDCARD_PROFILES: { id: WildcardProfile; label: string; description: string }[] = [
  { id: "equilibrado", label: "Equilibrado · 5 GW", description: "Pondera as cinco jornadas seguintes e a utilização do plantel ao longo desse período." },
  { id: "imediato", label: "Atacar já · próxima GW", description: "Prioriza jogadores com pontos esperados na próxima jornada, mesmo sacrificando calendário futuro." },
  { id: "continuidade", label: "Preservar o núcleo", description: "Procura manter até quatro dos teus titulares mais fiáveis e constrói o resto em torno deles." },
];

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
      <span
        className="hidden w-12 text-right font-mono text-[11px] tabular text-text-muted sm:inline"
        title="% das equipas da elite (topo da classificação geral) que o têm"
      >
        {p.elite === null ? "" : `${Math.round(p.elite)}%`}
      </span>
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
      {s.chip === "wildcard" && s.wildcardProfile && (
        <p className="text-xs text-text-muted">
          Estratégia simulada: <strong className="text-text">{WILDCARD_PROFILES.find((p) => p.id === s.wildcardProfile)?.label ?? "Equilibrado"}</strong>.
          Os pontos são estimativas, não um resultado garantido; os preços de venda podem variar face à tua conta FPL.
        </p>
      )}

      {rebuilds && s.xi.length > 0 && (
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
        <div className="space-y-3">
          <WildcardPitch players={s.xi} captainId={s.captainId} viceCaptainId={s.viceCaptainId} />
          <details className="rounded-lg border border-border bg-surface-2 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-text">Ver detalhe de jogadores, preços e banco</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-[1fr_18rem]">
          <div>
            <div className="mb-1 flex justify-between gap-2">
              <p className="eyebrow text-text-muted">Onze para esta jornada</p>
              <p className="eyebrow text-text-muted">elite · época · £ · prev.</p>
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
          </details>
        </div>
      )}

      {s.rationale && <p className="text-[12px] leading-relaxed text-text-muted">{s.rationale}</p>}
    </div>
  );
}

export default function ChipScenarioPanel({
  scenarios,
  initialChip = null,
  wildcardProfile = "equilibrado",
  candidates = [],
}: {
  scenarios: ScenarioView[];
  initialChip?: ChipKey | null;
  wildcardProfile?: WildcardProfile;
  candidates?: IncludeCandidate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<ChipKey | null>(initialChip);
  const [question, setQuestion] = useState("");
  const [notUnderstood, setNotUnderstood] = useState(false);
  const [includeText, setIncludeText] = useState("");

  if (scenarios.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Sem o teu plantel real carregado não há cenários para calcular.
      </p>
    );
  }

  const wcView = scenarios.find((s) => s.chip === "wildcard");
  const kept = wcView?.keptIds ?? [];
  const included = wcView?.includedIds ?? [];
  const nameOf = (id: number) => candidates.find((c) => c.id === id)?.name ?? `#${id}`;
  const premium = candidates.find((c) => c.name.toLowerCase().includes("haaland"));
  const currentWildIds = new Set([...(wcView?.xi ?? []), ...(wcView?.bench ?? [])].map(p => p.id));
  const premiumMissing = premium !== undefined && !currentWildIds.has(premium.id);
  const eliteAlternatives = candidates
    .filter((p) => p.id !== premium?.id && !currentWildIds.has(p.id))
    .filter((p) => p.elite !== null && p.elite >= 30)
    .sort((x, y) => (y.elite ?? 0) - (x.elite ?? 0))
    .slice(0, 4);


  const go = (nextKept: number[], nextIncluded: number[], profile: WildcardProfile = wildcardProfile) => {
    const href = scenarioHref(window.location.search, active ?? "wildcard", nextKept, nextIncluded, profile);
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  };
  const addInclude = () => {
    const t = includeText.trim().toLowerCase();
    const c =
      candidates.find((x) => `${x.name} (${x.team})`.toLowerCase() === t) ??
      candidates.find((x) => x.name.toLowerCase() === t);
    if (!c || included.includes(c.id)) return;
    setIncludeText("");
    go(kept, [...included, c.id]);
  };

  const ask = (text: string) => {
    const chip = parseChipQuestion(text);
    setNotUnderstood(chip === null);
    if (chip) setActive(chip);
  };

  const toggleKeep = (id: number) => {
    const next = kept.includes(id) ? kept.filter((k) => k !== id) : [...kept, id];
    go(next, included);
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
        {kept.length + included.length > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(() =>
                router.replace(scenarioHref(window.location.search, active ?? "wildcard", [], [], wildcardProfile), { scroll: false })
              )
            }
            className="text-[12px] text-text-muted underline hover:text-text"
          >
            limpar fixos e incluídos ({kept.length + included.length})
          </button>
        )}
      </div>

      {active === "wildcard" && (
        <div className="rounded-lg border border-border bg-surface p-3 space-y-3">
          <div>
            <p className="text-sm font-semibold text-text">Quero usar o Wildcard — mostra-me as alternativas</p>
            <p className="mt-1 text-xs text-text-muted">
              O modelo pode aconselhar guardar o chip. Isso não impede simular um plantel para cada estratégia.
              Estas opções não executam transferências na FPL.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {WILDCARD_PROFILES.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={pending}
                aria-pressed={wildcardProfile === p.id}
                onClick={() => go(kept, included, p.id)}
                className={`rounded-lg border p-3 text-left disabled:opacity-50 ${
                  wildcardProfile === p.id
                    ? "border-accent bg-accent/10"
                    : "border-border bg-surface-2 hover:border-accent/50"
                }`}
              >
                <span className="block text-sm font-semibold text-text">{p.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-text-muted">{p.description}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            Só o perfil selecionado é calculado de cada vez para não atrasar a página. Os ganhos apresentados
            utilizam sempre as previsões originais, não os pesos temporários do perfil.
            Podes fixar jogadores, exigir inclusões e voltar a comparar.
          </p>
        </div>
      )}

      {active === "wildcard" && premium && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <h3 className="text-sm font-semibold text-text">Verificar jogadores decisivos</h3>
          <p className="mt-1 text-xs text-text-muted">
            {premiumMissing
              ? "Haaland ficou de fora deste cenário. Isto não significa que seja uma má escolha: testa um plantel com ele antes de decidir."
              : "Haaland já pertence ao plantel projetado."}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Haaland: {premium.next.toFixed(1)} pontos previstos na próxima jornada · {premium.window.toFixed(1)} na janela · {premium.seasonPts} pontos na época · £{premium.price.toFixed(1)}m.
          </p>
          {premiumMissing && (
            <button type="button" disabled={pending || included.includes(premium.id)}
              onClick={() => go(kept, [...included, premium.id])}
              className="mt-2 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-50">
              {included.includes(premium.id) ? "Haaland incluído na comparação" : "Comparar Wildcard com Haaland"}
            </button>
          )}
          <p className="mt-2 text-xs text-text-muted">
            O cenário é recalculado com o mesmo orçamento. Diferenças pequenas na previsão não provam que uma equipa seja superior.
          </p>
        </div>
      )}
      {active === "wildcard" && eliteAlternatives.length > 0 && (
        <section className="rounded-lg border border-border bg-surface-2 p-3">
          <h3 className="text-sm font-semibold text-text">Comparar com jogadores da elite</h3>
          <p className="my-2 text-xs text-text-muted">
            Estes jogadores têm elevada presença nas equipas da elite, mas não constam deste Wildcard.
            A popularidade não substitui uma previsão; usa os botões para testar alternativas.
          </p>
          <div className="flex flex-wrap gap-2">
            {eliteAlternatives.map(p => (
              <button key={p.id} type="button" disabled={pending || included.includes(p.id)}
                onClick={() => go(kept, [...included, p.id])}
                className="rounded-md border border-border px-3 py-2 text-xs text-text hover:border-accent disabled:opacity-50">
                Incluir {p.name} · {p.next.toFixed(1)} xP · elite {Math.round(p.elite ?? 0)}%
              </button>
            ))}
          </div>
        </section>
      )}
      {(active === "wildcard" || active === "freehit") && candidates.length > 0 && (
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="eyebrow mb-2 text-text-muted">Incluir um jogador que não tens</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              list="incluir-candidatos"
              value={includeText}
              onChange={(e) => setIncludeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addInclude();
                }
              }}
              placeholder="Ex.: Haaland"
              className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              aria-label="Jogador a incluir"
            />
            <datalist id="incluir-candidatos">
              {candidates.map((c) => (
                <option key={c.id} value={`${c.name} (${c.team})`}>
                  {`${c.pos} · £${c.price.toFixed(1)}${c.elite !== null ? ` · elite ${c.elite}%` : ""}`}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              disabled={pending}
              onClick={addInclude}
              className="rounded-md border border-accent px-3 py-1.5 text-[13px] font-semibold text-accent disabled:opacity-50"
            >
              Incluir
            </button>
          </div>
          {included.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {included.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={pending}
                  onClick={() => go(kept, included.filter((x) => x !== id))}
                  className="rounded-full border border-accent bg-accent/10 px-2 py-0.5 text-[12px] text-accent"
                  title="Tirar"
                >
                  {nameOf(id)} ✕
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
