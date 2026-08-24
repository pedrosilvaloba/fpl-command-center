"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScoredPlayer } from "@/lib/recommend";
import { pickBestXI, pickCaptain } from "@/lib/recommend";

const STORAGE_KEY = "fpl_shadow_team";
const NEED: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
const POSITION_LABELS: Record<number, string> = {
  1: "Guarda-Redes",
  2: "Defesas",
  3: "Médios",
  4: "Avançados",
};
const BUDGET_M = 100;

function loadShadowIds(): number[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function saveShadowIds(ids: number[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage unavailable — the squad just won't persist across visits.
  }
}

type SyncMode = "checking" | "synced" | "local-only";

export default function ShadowTeamPanel({
  scored,
  suggestedElementIds,
}: {
  scored: ScoredPlayer[];
  suggestedElementIds: number[];
}) {
  const [ids, setIds] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>("checking");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [posFilter, setPosFilter] = useState<number | null>(null);

  useEffect(() => {
    // On mount: try the backend (Upstash Redis, when connected) first, so
    // the same Shadow Team shows up on any device. If the backend isn't
    // configured yet, or has nothing saved yet but this browser does
    // (pre-existing localStorage-only squad from before the backend
    // existed), fall back to / migrate the local copy instead of losing
    // it. This is a genuine external-system sync on mount, not derived
    // state — see the same rationale in MyTeamPanel.
    let cancelled = false;
    const localIds = loadShadowIds();

    fetch("/api/shadow-team")
      .then((r) => r.json())
      .then((data: { configured: boolean; ids: number[] | null }) => {
        if (cancelled) return;
        if (!data.configured) {
          setIds(localIds);
          setSyncMode("local-only");
          return;
        }
        if (Array.isArray(data.ids)) {
          setIds(data.ids);
          saveShadowIds(data.ids);
        } else if (localIds.length > 0) {
          // Backend configured but empty, and this browser has an older
          // local-only squad — migrate it up once.
          setIds(localIds);
          fetch("/api/shadow-team", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: localIds }),
          }).catch(() => {});
        }
        setSyncMode("synced");
      })
      .catch(() => {
        if (cancelled) return;
        setIds(localIds);
        setSyncMode("local-only");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return; // don't overwrite storage before the load above runs
    saveShadowIds(ids); // always keep a local write-through copy
    if (syncMode !== "synced") return;
    fetch("/api/shadow-team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
      .then((r) => r.json())
      .then((data: { ok?: boolean }) => {
        setSyncError(data.ok ? null : "Não foi possível sincronizar agora — guardado neste browser.");
      })
      .catch(() => setSyncError("Não foi possível sincronizar agora — guardado neste browser."));
  }, [ids, loaded, syncMode]);

  const byId = useMemo(() => new Map(scored.map((p) => [p.element.id, p])), [scored]);
  const squad = useMemo(
    () => ids.map((id) => byId.get(id)).filter((p): p is ScoredPlayer => !!p),
    [ids, byId]
  );

  const spent = squad.reduce((sum, p) => sum + p.priceM, 0);
  const clubCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of squad) m.set(p.team.id, (m.get(p.team.id) ?? 0) + 1);
    return m;
  }, [squad]);
  const posCount = (posId: number) =>
    squad.filter((p) => p.element.element_type === posId).length;

  const isComplete = squad.length === 15;
  const starters = isComplete ? pickBestXI(squad) : [];
  const bench = isComplete ? squad.filter((p) => !starters.includes(p)) : [];
  const { captain, viceCaptain } = isComplete
    ? pickCaptain(starters)
    : { captain: undefined, viceCaptain: undefined };
  const projectedTotal = isComplete
    ? starters.reduce((sum, p) => sum + (p === captain ? p.score * 2 : p.score), 0)
    : 0;

  function canAdd(p: ScoredPlayer): string | null {
    if (ids.includes(p.element.id)) return "já está na equipa";
    if (posCount(p.element.element_type) >= NEED[p.element.element_type])
      return `já tens ${NEED[p.element.element_type]} ${POSITION_LABELS[
        p.element.element_type
      ].toLowerCase()}`;
    if ((clubCount.get(p.team.id) ?? 0) >= 3) return "máximo de 3 por clube";
    if (spent + p.priceM > BUDGET_M) return "excede o orçamento de £100m";
    return null;
  }

  function add(p: ScoredPlayer) {
    if (canAdd(p)) return;
    setIds((prev) => [...prev, p.element.id]);
  }

  function remove(elementId: number) {
    setIds((prev) => prev.filter((id) => id !== elementId));
  }

  function startFromSuggestion() {
    setIds(suggestedElementIds);
  }

  function clear() {
    setIds([]);
  }

  const CANDIDATE_DISPLAY_CAP = 200;
  const matchingCandidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scored
      .filter((p) => (posFilter ? p.element.element_type === posFilter : true))
      .filter((p) => (q ? p.element.web_name.toLowerCase().includes(q) : true));
  }, [scored, query, posFilter]);
  // The full pool (~600+ jogadores elegíveis) já vem ordenado por pontuação,
  // por isso mostrar sem filtro traz sempre os melhores primeiro — mas sem
  // um teto qualquer lista sem pesquisa ficaria com centenas de linhas.
  // 200 dá margem generosa (muito acima do que uma posição alguma vez tem)
  // sem pesar o browser; a pesquisa por nome não é afetada por este teto
  // porque filtra antes de cortar.
  const candidates = matchingCandidates.slice(0, CANDIDATE_DISPLAY_CAP);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">
            {squad.length}/15 jogadores ·{" "}
            <span
              className={`font-mono tabular font-semibold ${
                spent > BUDGET_M ? "text-danger" : "text-text"
              }`}
            >
              £{spent.toFixed(1)}m
            </span>{" "}
            de £{BUDGET_M.toFixed(1)}m
          </span>
          {isComplete && (
            <span className="rounded bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface))] text-accent border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] px-2 py-0.5 text-xs font-semibold">
              Projeção: {projectedTotal.toFixed(1)} pts (c/ capitão)
            </span>
          )}
        </div>
        <div className="flex gap-2 text-xs">
          <button
            onClick={startFromSuggestion}
            className="rounded-lg border border-border px-3 py-1.5 hover:border-accent hover:text-accent"
          >
            Começar da equipa sugerida
          </button>
          <button
            onClick={clear}
            className="rounded-lg border border-border px-3 py-1.5 hover:border-danger hover:text-danger"
          >
            Limpar
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="font-display text-lg tracking-wide mb-2">
            A Tua Shadow Team
          </h3>
          {squad.length === 0 && (
            <p className="text-sm text-text-muted">
              Ainda vazia — usa a lista à direita para adicionar jogadores, ou
              começa a partir da equipa sugerida.
            </p>
          )}
          {[1, 2, 3, 4].map((posId) => {
            const inPos = squad.filter((p) => p.element.element_type === posId);
            if (inPos.length === 0) return null;
            return (
              <div key={posId} className="mb-3">
                <p className="text-xs uppercase tracking-wide text-text-muted mb-1">
                  {POSITION_LABELS[posId]} ({inPos.length}/{NEED[posId]})
                </p>
                <div className="rounded-lg border border-border divide-y divide-border">
                  {inPos.map((p) => (
                    <div
                      key={p.element.id}
                      className="flex items-center justify-between gap-2 py-1.5 px-2"
                    >
                      <span className="flex items-center gap-2">
                        {p.element.web_name}
                        {isComplete && p === captain && (
                          <span className="rounded bg-[color-mix(in_srgb,var(--gold)_20%,var(--surface))] text-gold border border-[color-mix(in_srgb,var(--gold)_40%,var(--border))] px-1.5 text-[10px] font-semibold">
                            C
                          </span>
                        )}
                        {isComplete && p === viceCaptain && (
                          <span className="rounded bg-surface-2 text-text-muted border border-border px-1.5 text-[10px] font-semibold">
                            V
                          </span>
                        )}
                        {isComplete && bench.includes(p) && (
                          <span className="text-[10px] text-text-muted opacity-70">
                            banco
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="font-mono tabular text-xs text-text-muted">
                          £{p.priceM.toFixed(1)}m
                        </span>
                        <button
                          onClick={() => remove(p.element.id)}
                          className="text-text-muted hover:text-danger text-xs"
                          aria-label={`Remover ${p.element.web_name}`}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div>
          <h3 className="font-display text-lg tracking-wide mb-2">
            Adicionar Jogadores
          </h3>
          <div className="flex gap-2 mb-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Procurar jogador…"
              className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <select
              value={posFilter ?? ""}
              onChange={(e) => setPosFilter(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
            >
              <option value="">Todas</option>
              <option value="1">GK</option>
              <option value="2">DEF</option>
              <option value="3">MID</option>
              <option value="4">FWD</option>
            </select>
          </div>
          <p className="text-xs text-text-muted mb-2">
            {matchingCandidates.length === 0
              ? "Nenhum jogador encontrado."
              : matchingCandidates.length > candidates.length
              ? `A mostrar os ${candidates.length} melhores de ${matchingCandidates.length} — usa a pesquisa para encontrar outro.`
              : `${matchingCandidates.length} jogador${matchingCandidates.length === 1 ? "" : "es"} — ordenados por pontuação.`}
          </p>
          <div className="rounded-lg border border-border divide-y divide-border max-h-96 overflow-y-auto">
            {candidates.map((p) => {
              const blocked = canAdd(p);
              return (
                <div
                  key={p.element.id}
                  className="flex items-center justify-between gap-2 py-1.5 px-2 text-sm"
                >
                  <span>
                    <span className="text-xs text-text-muted w-8 inline-block font-mono tabular">
                      {p.positionShort}
                    </span>
                    {p.element.web_name}{" "}
                    <span className="text-text-muted text-xs">
                      ({p.team.short_name})
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono tabular text-xs text-text-muted">
                      £{p.priceM.toFixed(1)}m
                    </span>
                    <button
                      onClick={() => add(p)}
                      disabled={!!blocked}
                      title={blocked ?? "Adicionar"}
                      className="rounded bg-accent text-accent-contrast disabled:bg-surface-2 disabled:text-text-muted disabled:cursor-not-allowed px-2 py-0.5 text-xs font-semibold hover:opacity-90"
                    >
                      +
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="text-xs text-text-muted opacity-70">
        {syncMode === "synced"
          ? syncError ?? "Sincronizado entre dispositivos."
          : syncMode === "local-only"
          ? "Guardado só neste browser (liga a integração Upstash Redis na Vercel para sincronizar entre dispositivos)."
          : "A verificar sincronização…"}{" "}
        Isto não mexe na tua equipa real — é só para testares ideias antes de
        decidires uma transferência a sério.
      </p>
    </div>
  );
}
