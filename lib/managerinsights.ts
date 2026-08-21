import { getRedis } from "./kv";
import type { FplBootstrap } from "./types";

/**
 * QUALITATIVE, tactical/managerial adjustments — the kind of insight that
 * doesn't live in any API field: a manager's substitution habits, a team's
 * attacking-vs-defensive identity, a player's role changing after a new
 * signing, and so on.
 *
 * Why this file exists: every other signal in this model (lib/playerthreat
 * .ts, lib/teamrating.ts, lib/matchmodel.ts) is derived automatically from
 * FPL's own data or betting-market odds. That covers a lot, but it
 * structurally can't capture things like "Arteta has a pattern of pulling
 * Rice at ~55min in games that are already won, so he's a weaker asset
 * than his start-count alone suggests" or "Man United play an open,
 * high-event style this season — concede a lot, but also score a lot" —
 * these are judgment calls made by actually reading match reports,
 * tactical write-ups and press-conference notes, not something derivable
 * from a stats API. This is exactly the differentiation the project's
 * owner asked for: a genuinely qualitative research layer on top of the
 * quantitative model, not a replacement for it.
 *
 * Two sources feed into this, merged at read time by `loadActiveInsights`:
 *
 * 1. MANAGER_INSIGHTS below — a hand-curated, permanent list for judgment
 *    calls confident/durable enough to commit to code and review like
 *    everything else in this project. Starts empty; add entries here
 *    through the normal edit/test/deploy flow when something is worth
 *    that level of permanence.
 * 2. A Redis-backed DYNAMIC layer, written by a weekly scheduled research
 *    pass (see app/api/insights/route.ts) that searches the web for
 *    exactly this kind of pattern and posts candidate findings. This is
 *    intentionally NOT gated behind manual review before taking effect —
 *    Pedro asked for this specifically so the qualitative layer isn't
 *    bottlenecked on him being available every week — but it ships with
 *    real guardrails instead of blind trust in an AI web-research pass:
 *      - `factor` is hard-capped to 0.8-1.2 (enforced server-side in the
 *        API route, not just documented here) — a nudge on top of the
 *        quantitative model, never a takeover of it.
 *      - every id is checked against the LIVE FPL bootstrap before being
 *        accepted — a hallucinated player/team simply gets rejected.
 *      - every dynamic entry expires automatically 2 weeks after being
 *        added (Pedro's choice — short enough that a stale or wrong
 *        pattern ages itself out, forcing the next research pass to
 *        reconfirm it rather than letting it linger silently).
 *      - a hard cap on how many dynamic entries can be active at once,
 *        so this can never gradually crowd out the quantitative model.
 *      - every applied insight — static or dynamic — still shows up in
 *        that player's `reasons[]` on the dashboard, exactly like any
 *        other scoring signal. Automatic does not mean invisible.
 *      - the write endpoint is auth-gated (INSIGHTS_API_TOKEN) since,
 *        unlike everything else in this file, it can be called from
 *        outside a deploy — see app/api/insights/route.ts.
 */

export interface ManagerInsight {
  scope: "player" | "team";
  // element id (scope "player") or team id (scope "team") — the FPL
  // bootstrap ids, same ones already used everywhere else in this app.
  id: number;
  // Human-readable label only — never read by the scoring logic, purely
  // so this stays legible/reviewable without cross-referencing ids.
  label: string;
  factor: number;
  reason: string;
  // When this was added or last reconfirmed.
  addedDate: string;
  // Where this judgment came from — a specific search finding, a match
  // watched, a pundit note. Kept honest and checkable, not "AI vibes".
  source: string;
  // Only set on dynamic (Redis-backed) entries — static, hand-curated
  // entries in MANAGER_INSIGHTS below have no expiry (a human already
  // committed to them). ISO timestamp.
  expiresAt?: string;
}

// Permanent, hand-curated entries — starts empty (nothing fabricated to
// fill it), populated over time for judgment calls confident enough to
// commit to code. Example shape, kept commented out as a template:
//
// {
//   scope: "player",
//   id: 123456,
//   label: "Rice (ARS)",
//   factor: 0.9,
//   reason: "padrão de substituição cedo em jogos já resolvidos (Arteta)",
//   addedDate: "2026-08-28",
//   source: "confirmado manualmente após várias semanas de sinal dinâmico consistente",
// },
/**
 * A hand-curated entry that identifies its target BY NAME rather than by
 * FPL's numeric id.
 *
 * Nobody can look up FPL element ids by hand reliably, and guessing one is
 * how a note silently lands on the wrong player. These are resolved at
 * read time against the live bootstrap by `resolveInsightTarget`, the same
 * deterministic matcher the weekly research endpoint uses — so a name that
 * does not unambiguously match a real, current player is dropped rather
 * than applied to somebody else.
 */
export interface StaticInsightSeed {
  scope: "player" | "team";
  playerName?: string;
  teamShortName?: string;
  teamName?: string;
  label: string;
  factor: number;
  reason: string;
  addedDate: string;
  source: string;
}

/**
 * WHAT BELONGS HERE, AND WHAT DOES NOT.
 *
 * The bar is not "is this true" — it is "is this true AND invisible to the
 * quantitative model". Several genuinely correct findings were deliberately
 * left out of this list because including them would count the same thing
 * twice:
 *
 *   - "Man Utd face Hull and Ipswich in GW1-2, so start Bruno" is real, but
 *     it is FIXTURE QUALITY, which the odds-derived match model already
 *     prices per fixture.
 *   - "Hull's defence is the weakest of the promoted sides" is real, but it
 *     is TEAM STRENGTH, which the market-derived team ratings already
 *     capture.
 *
 * What survives is what no data source in this app can express:
 *
 *   1. FORMATION AND ROLE. The model has no concept of a back three. A
 *      wing-back is registered as a defender by FPL and scores clean-sheet
 *      points as one, while producing attacking returns like a midfielder.
 *      Nothing in the data says so.
 *   2. MINUTES RISK BEFORE ANY MINUTES EXIST. In preseason `minutes` and
 *      `starts` are zero for everyone, so the minutes model necessarily
 *      assumes a full-time starter. A player who has not trained since a
 *      summer tournament is a real risk the data cannot yet show.
 *   3. SET-PIECE CHANGES FPL HAS NOT PUBLISHED YET. Partial overlap: the
 *      model does read `penalties_order`, so where FPL has already updated
 *      it these are double-counted. Factors here are therefore deliberately
 *      smaller than the research proposed, and are the first entries to
 *      remove once FPL's own field catches up.
 *
 * Every entry below is dated and sourced. Prune anything stale — a
 * substitution habit or a set-piece hierarchy is not a permanent fact.
 */
export const MANAGER_INSIGHT_SEEDS: StaticInsightSeed[] = [
  // --- 1. Formation and role: wing-backs in a back three -----------------
  {
    scope: "player", playerName: "Neco Williams", teamShortName: "NFO",
    label: "Neco Williams (NFO)", factor: 1.12,
    reason: "ala no 3-4-3 que Glasner instalou na pré-época — pontua como defesa mas produz como médio",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época de cada clube (2026-08)",
  },
  {
    scope: "player", playerName: "Aina", teamShortName: "NFO",
    label: "Ola Aina (NFO)", factor: 1.10,
    reason: "ala direito no 3-4-3 de Glasner, com liberdade ofensiva que a posição de defesa na FPL não reflete",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época de cada clube (2026-08)",
  },
  {
    scope: "player", playerName: "Muñoz", teamShortName: "CRY",
    label: "Daniel Muñoz (CRY)", factor: 1.10,
    reason: "Sage adotou linha de três na pré-época; ala com participação ofensiva regular",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época de cada clube (2026-08)",
  },
  {
    scope: "player", playerName: "Mitchell", teamShortName: "CRY",
    label: "Tyrick Mitchell (CRY)", factor: 1.08,
    reason: "ala esquerdo na linha de três do Palace, mesma lógica de produção acima do esperado para um defesa",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época de cada clube (2026-08)",
  },

  // --- 2. Minutes risk the data cannot yet show --------------------------
  {
    scope: "player", playerName: "Solanke", teamShortName: "TOT",
    label: "Solanke (TOT)", factor: 0.88,
    reason: "apenas 45min desde 1 de agosto após regresso tardio do Mundial — risco de minutos que os dados a zero da pré-época não conseguem mostrar",
    addedDate: "2026-08-21",
    source: "Fantasy Football Scout — team news GW1 (2026-08-17)",
  },
  {
    scope: "player", playerName: "Watkins", teamShortName: "AVL",
    label: "Watkins (AVL)", factor: 0.92,
    reason: "zero minutos de pré-época após o Mundial e despromovido a segunda opção de penáltis",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época; Squawka — executores de bolas paradas (2026-08)",
  },

  // --- 3. Set-piece duty FPL may not have published yet ------------------
  // Smaller than the research proposed, because `penalties_order` partially
  // covers this already — see the note above.
  {
    scope: "player", playerName: "Buendia", teamShortName: "AVL",
    label: "Buendía (AVL)", factor: 1.10,
    reason: "assume os penáltis do Villa com a saída de Tielemans; melhor jogador da equipa na pré-época",
    addedDate: "2026-08-21",
    source: "Squawka e Premier League — executores de bolas paradas 2026/27",
  },
  {
    scope: "player", playerName: "Gross", teamShortName: "BHA",
    label: "Pascal Gross (BHA)", factor: 1.08,
    reason: "recuperou os penáltis do Brighton e converteu na pré-época",
    addedDate: "2026-08-21",
    source: "Premier League — Scout Selection 2026/27",
  },
  {
    scope: "player", playerName: "Ndiaye", teamShortName: "EVE",
    label: "Ndiaye (EVE)", factor: 1.08,
    reason: "confirmado como executor único de penáltis do Everton; converteu dois na pré-época",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época; Squawka (2026-08)",
  },
  {
    scope: "player", playerName: "Tavernier", teamShortName: "BOU",
    label: "Tavernier (BOU)", factor: 1.08,
    reason: "assume penáltis, livres e cantos com Kroupi operado ao pé",
    addedDate: "2026-08-21",
    source: "Premier League — lições de pré-época de cada clube (2026-08)",
  },
  {
    scope: "player", playerName: "Gibbs-White", teamShortName: "NFO",
    label: "Gibbs-White (NFO)", factor: 1.08,
    reason: "passa a primeiro executor de penáltis do Forest, à frente de Chris Wood",
    addedDate: "2026-08-21",
    source: "Squawka e allaboutfpl — executores de bolas paradas 2026/27",
  },
];

/** Resolved at read time against the live bootstrap — see StaticInsightSeed. */
export function resolveStaticInsights(bootstrap: FplBootstrap): ManagerInsight[] {
  const out: ManagerInsight[] = [];
  for (const seed of MANAGER_INSIGHT_SEEDS) {
    const resolution = resolveInsightTarget(bootstrap, seed.scope, {
      playerName: seed.playerName,
      teamShortName: seed.teamShortName,
      teamName: seed.teamName,
    });
    // A seed that cannot be matched to exactly one real player is dropped
    // in silence-by-design: applying it to the wrong player would be worse
    // than not applying it at all.
    if (!resolution.ok) continue;
    out.push({
      scope: seed.scope,
      id: resolution.id,
      label: resolution.label,
      factor: seed.factor,
      reason: seed.reason,
      addedDate: seed.addedDate,
      source: seed.source,
    });
  }
  return out;
}

/** Kept for callers that have no bootstrap to resolve names against. */
export const MANAGER_INSIGHTS: ManagerInsight[] = [];

export function filterInsights(
  insights: ManagerInsight[],
  scope: "player" | "team",
  id: number
): ManagerInsight[] {
  return insights.filter((i) => i.scope === scope && i.id === id);
}

/** Convenience for building a reason string consistently wherever this is surfaced. */
export function formatInsightReason(insight: ManagerInsight): string {
  const tag = insight.expiresAt ? "nota da investigação semanal" : "nota qualitativa";
  return `${insight.reason} (${tag}, ${insight.addedDate})`;
}

const RESEARCH_RUN_KEY = "fpl-command-center:insights:lastrun";
const DYNAMIC_INDEX_KEY = "fpl-command-center:insights:dynamic:index";
const DYNAMIC_ENTRY_KEY = (key: string) => `fpl-command-center:insights:dynamic:entry:${key}`;

export interface DynamicInsight extends ManagerInsight {
  key: string; // unique storage key, needed to delete/prune a specific entry
}

/**
 * Reads every non-expired dynamic (Redis-backed) insight. Best-effort and
 * never throws — without Redis configured, or on any read failure, this
 * degrades to "no dynamic insights" rather than breaking the page, same
 * pattern as lib/accuracy.ts.
 */
export async function loadDynamicInsights(): Promise<DynamicInsight[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const keys = (await redis.get<string[]>(DYNAMIC_INDEX_KEY)) ?? [];
    if (keys.length === 0) return [];
    const nowMs = Date.now();
    const entries = await Promise.all(keys.map((k) => redis.get<DynamicInsight>(DYNAMIC_ENTRY_KEY(k))));
    return entries.filter((e): e is DynamicInsight => {
      if (!e) return false;
      if (!e.expiresAt) return true;
      return new Date(e.expiresAt).getTime() > nowMs;
    });
  } catch {
    return [];
  }
}

/** Static + dynamic, merged — this is what lib/recommend.ts should be given. */
export async function loadActiveInsights(
  bootstrap?: FplBootstrap
): Promise<ManagerInsight[]> {
  const dynamic = await loadDynamicInsights();
  const staticResolved = bootstrap ? resolveStaticInsights(bootstrap) : MANAGER_INSIGHTS;
  return [...staticResolved, ...dynamic];
}

// Guardrails on the dynamic (auto-applied, AI-researched) layer — see the
// big comment at the top of this file for why each of these exists.
export const MAX_DYNAMIC_INSIGHTS = 15;
export const DYNAMIC_TTL_DAYS = 14; // Pedro's explicit choice: 2 weeks
const FACTOR_MIN = 0.8;
const FACTOR_MAX = 1.2;
const REASON_MAX_LENGTH = 300;

export interface NewInsightInput {
  scope: "player" | "team";
  id: number;
  label: string;
  factor: number;
  reason: string;
  source: string;
}

export interface RejectedInsight {
  input: NewInsightInput;
  reason: string;
}

/**
 * Name -> id resolution, run entirely by deterministic code — never by an
 * LLM reading through bootstrap-static's ~700-player JSON itself. This is
 * the same principle the rest of this project already applies (see the
 * README's "JSON grande não deve ser lido por um modelo de IA" note): the
 * weekly research agent knows player/team NAMES from what it read, not
 * FPL's internal numeric ids, and asking it to open bootstrap-static and
 * pick out the right id by hand is exactly the kind of bulk-JSON-reading
 * that produces confidently wrong answers (wrong player, right-looking
 * but incorrect id). So the agent submits names; this function resolves
 * them against a live bootstrap fetched fresh in the API route.
 */
export interface InsightTarget {
  id?: number; // already-known numeric id — skips name resolution entirely
  playerName?: string; // scope "player" — matched against web_name / full name
  teamShortName?: string; // scope "team" target, OR a disambiguator for scope "player"
  teamName?: string; // scope "team" target (full name), alternative to teamShortName
}

// A few common Latin letters used in real player names that DON'T have a
// canonical NFD decomposition (so the accent-strip below can't reach
// them) — e.g. Martin Ødegaard. Small, explicit and non-exhaustive on
// purpose: this only needs to cover names that actually show up in the
// Premier League, not be a general transliteration library.
const SPECIAL_LETTERS: [RegExp, string][] = [
  [/[øØ]/g, "o"],
  [/[æÆ]/g, "ae"],
  [/[œŒ]/g, "oe"],
  [/[đĐ]/g, "d"],
  [/[łŁ]/g, "l"],
  [/ß/g, "ss"],
];

function normalizeName(s: string): string {
  let out = s;
  for (const [pattern, replacement] of SPECIAL_LETTERS) {
    out = out.replace(pattern, replacement);
  }
  return out
    .normalize("NFD")
    // Strips the Unicode combining-diacritics block (U+0300-U+036F) left
    // behind by NFD normalization — á -> a, ã -> a, ç -> c, etc.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function resolveInsightTarget(
  bootstrap: FplBootstrap,
  scope: "player" | "team",
  target: InsightTarget
): { ok: true; id: number; label: string } | { ok: false; reason: string } {
  if (typeof target.id === "number") {
    if (scope === "player") {
      const el = bootstrap.elements.find((e) => e.id === target.id);
      if (!el) return { ok: false, reason: "id de jogador não encontrado nos dados atuais da FPL" };
      const team = bootstrap.teams.find((t) => t.id === el.team);
      return { ok: true, id: el.id, label: `${el.web_name} (${team?.short_name ?? "?"})` };
    }
    const team = bootstrap.teams.find((t) => t.id === target.id);
    if (!team) return { ok: false, reason: "id de equipa não encontrado nos dados atuais da FPL" };
    return { ok: true, id: team.id, label: team.short_name };
  }

  if (scope === "team") {
    const query = normalizeName(target.teamName ?? target.teamShortName ?? "");
    if (!query) return { ok: false, reason: "teamName ou teamShortName em falta para scope 'team'" };
    const matches = bootstrap.teams.filter(
      (t) =>
        normalizeName(t.name) === query ||
        normalizeName(t.short_name) === query ||
        normalizeName(t.name).includes(query)
    );
    if (matches.length === 0) {
      return { ok: false, reason: `equipa "${target.teamName ?? target.teamShortName}" não encontrada` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: `nome de equipa ambíguo entre: ${matches.map((m) => m.name).join(", ")} — usa teamShortName`,
      };
    }
    return { ok: true, id: matches[0].id, label: matches[0].short_name };
  }

  // scope === "player"
  const nameQuery = normalizeName(target.playerName ?? "");
  if (!nameQuery) return { ok: false, reason: "playerName em falta para scope 'player'" };
  let candidates = bootstrap.elements.filter((e) => {
    const web = normalizeName(e.web_name);
    const full = normalizeName(`${e.first_name} ${e.second_name}`);
    return web === nameQuery || full === nameQuery || web.includes(nameQuery) || full.includes(nameQuery);
  });
  if (target.teamShortName) {
    const teamQuery = normalizeName(target.teamShortName);
    const teamMatch = bootstrap.teams.find(
      (t) => normalizeName(t.short_name) === teamQuery || normalizeName(t.name) === teamQuery
    );
    if (teamMatch) {
      const narrowed = candidates.filter((e) => e.team === teamMatch.id);
      if (narrowed.length > 0) candidates = narrowed;
    }
  }
  if (candidates.length === 0) {
    return { ok: false, reason: `jogador "${target.playerName}" não encontrado` };
  }
  if (candidates.length > 1) {
    const exact = candidates.filter((e) => normalizeName(e.web_name) === nameQuery);
    if (exact.length === 1) {
      candidates = exact;
    } else {
      return {
        ok: false,
        reason: `nome de jogador ambíguo (${candidates.length} correspondências) — inclui teamShortName para desambiguar`,
      };
    }
  }
  const el = candidates[0];
  const team = bootstrap.teams.find((t) => t.id === el.team);
  return { ok: true, id: el.id, label: `${el.web_name} (${team?.short_name ?? "?"})` };
}

/**
 * Pure validation for a single candidate insight — no Redis, no network,
 * fully unit-testable on its own. `activeCount` is the number of dynamic
 * insights already active BEFORE this one, so the cap can be checked
 * correctly while validating a whole batch one at a time. Kept separate
 * from saveDynamicInsights (which does the actual Redis I/O) specifically
 * so this safety-critical logic — the one thing standing between an AI
 * web-research pass and the live scoring model — can be tested in
 * isolation, not just as a side effect of a Redis round-trip.
 */
export function validateInsightInput(
  input: NewInsightInput,
  isValidId: (scope: "player" | "team", id: number) => boolean,
  activeCount: number
): { ok: true } | { ok: false; reason: string } {
  if (input.scope !== "player" && input.scope !== "team") {
    return { ok: false, reason: "scope inválido (tem de ser 'player' ou 'team')" };
  }
  if (!Number.isInteger(input.id) || input.id <= 0) {
    return { ok: false, reason: "id inválido" };
  }
  if (!isValidId(input.scope, input.id)) {
    return { ok: false, reason: "id não corresponde a nenhum jogador/equipa nos dados atuais da FPL" };
  }
  if (
    typeof input.factor !== "number" ||
    !Number.isFinite(input.factor) ||
    input.factor < FACTOR_MIN ||
    input.factor > FACTOR_MAX
  ) {
    return { ok: false, reason: `factor fora do intervalo permitido (${FACTOR_MIN}-${FACTOR_MAX})` };
  }
  if (!input.reason || typeof input.reason !== "string" || input.reason.length > REASON_MAX_LENGTH) {
    return { ok: false, reason: `reason em falta ou demasiado longo (máx ${REASON_MAX_LENGTH} caracteres)` };
  }
  if (!input.label || !input.source) {
    return { ok: false, reason: "label ou source em falta" };
  }
  if (activeCount >= MAX_DYNAMIC_INSIGHTS) {
    return { ok: false, reason: `limite de ${MAX_DYNAMIC_INSIGHTS} notas dinâmicas ativas em simultâneo já atingido` };
  }
  return { ok: true };
}

/**
 * Validates and persists candidate insights from the weekly research pass.
 * `isValidId` is injected by the caller (app/api/insights/route.ts) rather
 * than fetched here, so this file never needs its own network access —
 * the route already has a fresh bootstrap loaded for other reasons.
 * Every rejection reason is returned so the calling research agent (or
 * Pedro, reading the response) can see exactly why something didn't apply
 * — this file rejects loudly, it never silently drops or clamps a
 * malformed entry into something that looks accepted.
 */
export async function saveDynamicInsights(
  inputs: NewInsightInput[],
  isValidId: (scope: "player" | "team", id: number) => boolean
): Promise<{
  ok: boolean;
  accepted: DynamicInsight[];
  rejected: RejectedInsight[];
  error?: string;
}> {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, accepted: [], rejected: [], error: "Redis não configurado nesta instalação." };
  }
  try {
    const existingKeys = (await redis.get<string[]>(DYNAMIC_INDEX_KEY)) ?? [];
    const existingEntries = await Promise.all(
      existingKeys.map((k) => redis.get<DynamicInsight>(DYNAMIC_ENTRY_KEY(k)))
    );
    const nowMs = Date.now();
    const stillActive = existingEntries.filter(
      (e): e is DynamicInsight => !!e && (!e.expiresAt || new Date(e.expiresAt).getTime() > nowMs)
    );

    const accepted: DynamicInsight[] = [];
    const rejected: RejectedInsight[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DYNAMIC_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let activeCount = stillActive.length;

    for (const input of inputs) {
      const validation = validateInsightInput(input, isValidId, activeCount);
      if (!validation.ok) {
        rejected.push({ input, reason: validation.reason });
        continue;
      }
      const key = `${input.scope}-${input.id}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry: DynamicInsight = {
        key,
        scope: input.scope,
        id: input.id,
        label: input.label,
        factor: input.factor,
        reason: input.reason,
        addedDate: now.toISOString().slice(0, 10),
        source: input.source,
        expiresAt,
      };
      await redis.set(DYNAMIC_ENTRY_KEY(key), entry);
      accepted.push(entry);
      activeCount++;
    }

    // Keep the index pruned of expired keys even on a request that adds
    // nothing new — otherwise it only ever grows.
    const newIndex = [...stillActive.map((e) => e.key), ...accepted.map((e) => e.key)];
    if (newIndex.length !== existingKeys.length || accepted.length > 0) {
      await redis.set(DYNAMIC_INDEX_KEY, newIndex);
    }

    return { ok: true, accepted, rejected };
  } catch {
    return { ok: false, accepted: [], rejected: [], error: "Falha a gravar no Redis." };
  }
}

/** Manual override: lets Pedro kill one specific dynamic insight before
 * its natural expiry, without needing a code change/deploy — the safety
 * net for "automatic doesn't mean irreversible". */
export async function deleteDynamicInsight(key: string): Promise<{ ok: boolean; error?: string }> {
  const redis = getRedis();
  if (!redis) return { ok: false, error: "Redis não configurado nesta instalação." };
  try {
    const keys = (await redis.get<string[]>(DYNAMIC_INDEX_KEY)) ?? [];
    if (!keys.includes(key)) return { ok: false, error: "chave não encontrada" };
    await redis.del(DYNAMIC_ENTRY_KEY(key));
    await redis.set(
      DYNAMIC_INDEX_KEY,
      keys.filter((k) => k !== key)
    );
    return { ok: true };
  } catch {
    return { ok: false, error: "Falha a apagar no Redis." };
  }
}


/**
 * A record of the most recent weekly-research run.
 *
 * The research runs in a separate, unattended session and reports back by
 * push notification and email. Twice in a row those notifications never
 * arrived, and there was no way to tell from the outside whether the run
 * had failed, succeeded silently, or never started at all — the only
 * observable state was "no notes", which is equally consistent with "the
 * research found nothing worth submitting" and "the research never ran".
 *
 * Making the run leave a trace in the app itself removes that ambiguity
 * permanently, and does not depend on any notification channel working.
 */
export interface ResearchRun {
  at: string; // ISO timestamp
  acceptedCount: number;
  rejectedCount: number;
  acceptedLabels: string[];
  rejectedReasons: string[];
  /** Free-text note from the research session — used above all to record
   * "I searched and found nothing solid enough to submit", which is a
   * legitimate and informative outcome, not a failure. */
  note: string | null;
}

export async function recordResearchRun(run: ResearchRun): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(RESEARCH_RUN_KEY, run);
  } catch {
    // Best-effort: never let bookkeeping fail the actual submission.
  }
}

export async function getLastResearchRun(): Promise<ResearchRun | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.get<ResearchRun>(RESEARCH_RUN_KEY)) ?? null;
  } catch {
    return null;
  }
}
