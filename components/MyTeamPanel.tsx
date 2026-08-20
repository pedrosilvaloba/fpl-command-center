"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScoredPlayer, TransferSuggestion } from "@/lib/recommend";
import { suggestTransfers } from "@/lib/recommend";

const STORAGE_KEY = "fpl_team_id";

interface EntryResponse {
  entry: {
    id: number;
    name: string;
    player_first_name: string;
    player_last_name: string;
    summary_overall_points: number;
    summary_overall_rank: number;
    last_deadline_value: number;
    last_deadline_bank: number;
  };
  history: {
    current: { event: number; points: number; overall_rank: number }[];
  };
}

interface PicksResponse {
  picks: {
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }[];
  entry_history: { points: number; event_transfers_cost: number };
  error?: string;
}

function PlayerRow({
  scored,
  isCaptain,
  isVice,
  isBench,
}: {
  scored: ScoredPlayer;
  isCaptain: boolean;
  isVice: boolean;
  isBench: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded ${
        isBench ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted w-8 font-mono tabular">
          {scored.positionShort}
        </span>
        <span className="font-medium">{scored.element.web_name}</span>
        {isCaptain && (
          <span className="rounded bg-[color-mix(in_srgb,var(--gold)_20%,var(--surface))] text-gold border border-[color-mix(in_srgb,var(--gold)_40%,var(--border))] px-1.5 text-[10px] font-semibold">
            C
          </span>
        )}
        {isVice && (
          <span className="rounded bg-surface-2 text-text-muted border border-border px-1.5 text-[10px] font-semibold">
            V
          </span>
        )}
      </div>
      <span className="font-mono tabular text-accent font-semibold">
        {scored.score.toFixed(1)}
      </span>
    </div>
  );
}

function TransferSuggestionRow({ s }: { s: TransferSuggestion }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-b-0 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-danger line-through decoration-danger/70">
          {s.out.element.web_name}
        </span>
        <span className="text-text-muted">→</span>
        <span className="text-accent font-medium">{s.in.element.web_name}</span>
      </div>
      <div className="flex items-center gap-3 font-mono tabular text-xs text-text-muted">
        <span>
          {s.priceDeltaM > 0 ? "+" : ""}
          {s.priceDeltaM.toFixed(1)}m
        </span>
        <span className="text-accent font-semibold">
          +{s.scoreGain.toFixed(1)} pts
        </span>
      </div>
    </div>
  );
}

export default function MyTeamPanel({
  scored,
  eventId,
}: {
  scored: ScoredPlayer[];
  eventId: number;
}) {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryResponse | null>(null);
  const [picks, setPicks] = useState<PicksResponse | null>(null);

  useEffect(() => {
    // Reading localStorage on mount to sync in a saved Team ID from a
    // previous visit — an external-system read, not derived render state,
    // so this legitimately belongs in an effect despite the lint rule
    // below being tuned for the (much more common) anti-pattern of
    // deriving state from props/state that could just be computed inline.
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setTeamId(saved);
    } catch {
      // localStorage unavailable (private browsing, etc.) — just skip persistence.
    }
  }, []);

  useEffect(() => {
    if (!teamId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/fpl/entry/${teamId}`).then((r) => r.json()),
      fetch(`/api/fpl/entry/${teamId}/picks?event=${eventId}`).then((r) => r.json()),
    ])
      .then(([entryRes, picksRes]) => {
        if (entryRes.error) throw new Error(entryRes.error);
        setEntry(entryRes);
        setPicks(picksRes);
        if (picksRes.error) setError(picksRes.error);
      })
      .catch((e) => setError(e.message || "Erro a carregar a equipa"))
      .finally(() => setLoading(false));
  }, [teamId, eventId]);

  const scoredById = useMemo(
    () => new Map(scored.map((p) => [p.element.id, p])),
    [scored]
  );

  const ownedScored = useMemo(() => {
    if (!picks) return [];
    return picks.picks
      .map((pick) => {
        const s = scoredById.get(pick.element);
        if (!s) return null;
        return { ...pick, scored: s };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => a.position - b.position);
  }, [picks, scoredById]);

  const starters = ownedScored.filter((p) => p.position <= 11);
  const bench = ownedScored.filter((p) => p.position > 11);

  const suggestions = useMemo(() => {
    if (!picks) return [];
    return suggestTransfers(
      picks.picks.map((p) => p.element),
      scored,
      2
    ).slice(0, 6);
  }, [picks, scored]);

  function save() {
    const id = input.trim();
    if (!/^\d+$/.test(id)) {
      setError("O Team ID é só números — copia-o do URL da FPL (…/entry/1234567/…).");
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore — still set in-memory below so it works for this visit
    }
    setTeamId(id);
  }

  function forget() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setTeamId(null);
    setEntry(null);
    setPicks(null);
    setInput("");
  }

  if (!teamId) {
    return (
      <div className="flex flex-col gap-3 max-w-md">
        <p className="text-sm text-text-muted">
          Introduz o teu Team ID da FPL para veres o teu plantel real em vez
          de sugestões genéricas. Encontras o número no URL quando abres
          &quot;Points&quot; no site oficial:{" "}
          <code className="font-mono text-xs bg-surface-2 px-1 py-0.5 rounded">
            fantasy.premierleague.com/entry/<strong>1234567</strong>/event/1
          </code>
        </p>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="ex: 1234567"
            inputMode="numeric"
            className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
          />
          <button
            onClick={save}
            className="rounded-lg bg-accent text-accent-contrast px-4 py-2 text-sm font-semibold hover:opacity-90"
          >
            Guardar
          </button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-text-muted opacity-70">
          Guardado só neste browser (não é enviado a ninguém além da própria
          FPL, para obter os teus dados públicos de gestor).
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          {entry && (
            <>
              <p className="font-display text-xl tracking-wide">
                {entry.entry.name}
              </p>
              <p className="text-sm text-text-muted">
                {entry.entry.player_first_name} {entry.entry.player_last_name} ·
                Rank Geral{" "}
                <span className="font-mono tabular text-text">
                  {entry.entry.summary_overall_rank?.toLocaleString("pt-PT")}
                </span>{" "}
                · Valor{" "}
                <span className="font-mono tabular text-text">
                  £
                  {(
                    (entry.entry.last_deadline_value +
                      entry.entry.last_deadline_bank) /
                    10
                  ).toFixed(1)}
                  m
                </span>
              </p>
            </>
          )}
        </div>
        <button
          onClick={forget}
          className="text-xs text-text-muted hover:text-danger underline"
        >
          Trocar Team ID
        </button>
      </div>

      {loading && <p className="text-sm text-text-muted">A carregar…</p>}
      {error && <p className="text-sm text-danger">{error}</p>}

      {ownedScored.length > 0 && (
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h3 className="font-display text-lg tracking-wide mb-2">
              O Teu Onze
            </h3>
            <div className="rounded-lg border border-border divide-y divide-border">
              {starters.map((p) => (
                <PlayerRow
                  key={p.element}
                  scored={p.scored}
                  isCaptain={p.is_captain}
                  isVice={p.is_vice_captain}
                  isBench={false}
                />
              ))}
            </div>
            <h3 className="font-display text-lg tracking-wide mb-2 mt-4">
              Banco
            </h3>
            <div className="rounded-lg border border-border divide-y divide-border">
              {bench.map((p) => (
                <PlayerRow
                  key={p.element}
                  scored={p.scored}
                  isCaptain={p.is_captain}
                  isVice={p.is_vice_captain}
                  isBench={true}
                />
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-display text-lg tracking-wide mb-2">
              Sugestões de Transferência
            </h3>
            {suggestions.length === 0 ? (
              <p className="text-sm text-text-muted">
                Sem sugestões óbvias esta semana — o plantel está bem
                posicionado segundo o motor de pontuação atual.
              </p>
            ) : (
              <div className="rounded-lg border border-border px-3">
                {suggestions.map((s, i) => (
                  <TransferSuggestionRow key={i} s={s} />
                ))}
              </div>
            )}
            <p className="text-xs text-text-muted mt-2 opacity-70">
              Comparação por pontuação do motor v1, sem considerar quantas
              transferências grátis tens disponíveis nem o custo de hits —
              usa isto como ponto de partida, não como ordem direta.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
