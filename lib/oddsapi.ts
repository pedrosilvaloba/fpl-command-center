import type { FplTeam } from "./types";

export interface OddsMatch {
  homeTeam: string; // team name exactly as returned by the odds provider
  awayTeam: string;
  homeWinProb: number; // de-vigged (bookmaker-margin-removed), sums to 1 with draw+away
  drawProb: number;
  awayWinProb: number;
  commenceTime: string;
  /** De-vigged P(total goals > 2.5), averaged across bookmakers, when the
   * totals market is available. This is what lets the model recover TOTAL
   * expected goals rather than only the home/away balance — see
   * lib/oddsmodel.ts. Null when no bookmaker priced the 2.5 line. */
  overProb: number | null;
}

/**
 * Why odds are or aren't available, instead of a bare null.
 *
 * This used to return `null` for every failure mode alike — no API key,
 * a failed request, a malformed response, an empty result. The dashboard
 * then said "running on the statistical model alone", which reads like a
 * deliberate configuration rather than a fault. In practice the key was
 * never set in production and nothing ever said so out loud, so the single
 * most valuable data source in the app was silently absent for weeks while
 * the fixture model quietly ran on nothing. Failing loudly is the fix.
 */
export type OddsStatus =
  | { status: "ok"; matches: OddsMatch[] }
  | { status: "no-key"; message: string }
  | { status: "request-failed"; message: string }
  | { status: "empty"; message: string };

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Minimal shape of The Odds API's own JSON response — an external,
// unofficial-to-us contract, so kept loose/optional throughout and never
// trusted without the guards in getOddsImpliedProbabilities below.
interface RawOddsOutcome {
  name?: string;
  price?: number;
  point?: number; // totals market line, e.g. 2.5
}
interface RawOddsMarket {
  key?: string;
  outcomes?: RawOddsOutcome[];
}
interface RawOddsBookmaker {
  markets?: RawOddsMarket[];
}
interface RawOddsEvent {
  home_team?: string;
  away_team?: string;
  commence_time?: string;
  bookmakers?: RawOddsBookmaker[];
}

// The free plan is 500 credits/month. We only need a directional weekly
// signal, not live-updating odds, so this is deliberately conservative —
// ~2 refreshes/day keeps us well inside the free budget even if a single
// call costs more than 1 credit. Widen it if usage on the-odds-api.com's
// dashboard shows real headroom.
const REVALIDATE_SECONDS = 12 * 60 * 60;

/**
 * Fetches upcoming Premier League match odds (head-to-head market) from
 * The Odds API and converts bookmaker decimal odds into de-vigged implied
 * probabilities, averaged across whichever bookmakers the API returns
 * (never trust a single bookmaker's number as gospel). Bookmakers price
 * in team news, tactical changes, and expert analysis almost as soon as
 * it's known — this is how the app captures "the eye test" and public
 * expert opinion without doing any subjective judgment of our own.
 *
 * Returns null whenever this enrichment isn't available for any reason —
 * no ODDS_API_KEY configured, the request fails, the response is
 * malformed — so callers always have a clean, safe way to degrade to the
 * pure statistical model in lib/matchmodel.ts. This is strictly optional
 * enrichment, never a hard dependency of the app.
 */
export async function getOddsStatus(): Promise<OddsStatus> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return {
      status: "no-key",
      message:
        "ODDS_API_KEY não está configurada na Vercel. Sem ela a app não consegue usar probabilidades de mercado e a dificuldade de calendário fica dependente apenas dos dados da FPL.",
    };
  }

  try {
    const res = await fetch(
      `${ODDS_API_BASE}/sports/soccer_epl/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal`,
      { next: { revalidate: REVALIDATE_SECONDS } }
    );
    if (!res.ok) {
      const detail =
        res.status === 401
          ? "chave rejeitada (401) — verifica o valor de ODDS_API_KEY"
          : res.status === 429
            ? "quota mensal esgotada (429) — o plano gratuito da The Odds API dá 500 pedidos/mês"
            : `a API respondeu ${res.status}`;
      return { status: "request-failed", message: `Odds indisponíveis: ${detail}.` };
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      return { status: "request-failed", message: "Odds indisponíveis: resposta da API em formato inesperado." };
    }
    const events = data as RawOddsEvent[];

    const matches: OddsMatch[] = [];
    for (const match of events) {
      const homeTeam = match?.home_team;
      const awayTeam = match?.away_team;
      const bookmakers = Array.isArray(match?.bookmakers) ? match.bookmakers : [];
      if (typeof homeTeam !== "string" || typeof awayTeam !== "string") continue;

      const implied: { home: number; draw: number; away: number }[] = [];
      for (const bm of bookmakers) {
        const h2h = Array.isArray(bm?.markets)
          ? bm.markets.find((m) => m?.key === "h2h")
          : undefined;
        const outcomes = Array.isArray(h2h?.outcomes) ? h2h.outcomes : [];
        const home = outcomes.find((o) => o?.name === homeTeam);
        const away = outcomes.find((o) => o?.name === awayTeam);
        const draw = outcomes.find((o) => o?.name === "Draw");
        if (!home?.price || !away?.price || !draw?.price) continue;

        const rawHome = 1 / home.price;
        const rawDraw = 1 / draw.price;
        const rawAway = 1 / away.price;
        const overround = rawHome + rawDraw + rawAway;
        if (!overround) continue;
        implied.push({
          home: rawHome / overround,
          draw: rawDraw / overround,
          away: rawAway / overround,
        });
      }

      // Totals market (over/under 2.5 goals), de-vigged the same way.
      // Without this the market can only tell us who is more likely to
      // win, not how many goals to expect — which is exactly the half the
      // fixture model needs for clean sheets.
      const overs: number[] = [];
      for (const bm of bookmakers) {
        const totals = Array.isArray(bm?.markets)
          ? bm.markets.find((m) => m?.key === "totals")
          : undefined;
        const outcomes = Array.isArray(totals?.outcomes) ? totals.outcomes : [];
        const over = outcomes.find(
          (o) => o?.name === "Over" && Math.abs((o?.point ?? 0) - 2.5) < 1e-9
        );
        const under = outcomes.find(
          (o) => o?.name === "Under" && Math.abs((o?.point ?? 0) - 2.5) < 1e-9
        );
        if (!over?.price || !under?.price) continue;
        const rawOver = 1 / over.price;
        const rawUnder = 1 / under.price;
        const total = rawOver + rawUnder;
        if (!total) continue;
        overs.push(rawOver / total);
      }

      if (implied.length === 0) continue;
      const n = implied.length;
      matches.push({
        homeTeam,
        awayTeam,
        homeWinProb: implied.reduce((s, x) => s + x.home, 0) / n,
        drawProb: implied.reduce((s, x) => s + x.draw, 0) / n,
        awayWinProb: implied.reduce((s, x) => s + x.away, 0) / n,
        overProb: overs.length ? overs.reduce((s, x) => s + x, 0) / overs.length : null,
        commenceTime: match.commence_time ?? "",
      });
    }

    if (matches.length === 0) {
      return {
        status: "empty",
        message:
          "A API de odds respondeu mas não devolveu jogos da Premier League — normalmente porque ainda não há mercados abertos para as próximas jornadas.",
      };
    }
    return { status: "ok", matches };
  } catch {
    return { status: "request-failed", message: "Odds indisponíveis: a chamada à API falhou." };
  }
}

/** Backwards-compatible wrapper — returns just the matches, or null. */
export async function getOddsImpliedProbabilities(): Promise<OddsMatch[] | null> {
  const result = await getOddsStatus();
  return result.status === "ok" ? result.matches : null;
}

// --- Matching FPL teams to the odds provider's team names ---

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|afc)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Known abbreviation mismatches between FPL's own team names (often
// shortened — "Man City", "Spurs"/"Tottenham", "Nott'm Forest", "Wolves")
// and the fuller names odds providers tend to use. Plain normalization
// handles most teams; this covers the handful that don't reduce to the
// same string either way. If a team's odds silently stop applying after
// a rename/promotion, this table is the first place to check — add the
// missing alias rather than loosening the matcher itself (see the "never
// fuzzy-match" note below).
const KNOWN_ALIASES: Record<string, string> = {
  mancity: "manchestercity",
  manutd: "manchesterunited",
  manu: "manchesterunited",
  spurs: "tottenhamhotspur",
  tottenham: "tottenhamhotspur",
  wolves: "wolverhamptonwanderers",
  nottmforest: "nottinghamforest",
  brighton: "brightonhovealbion",
  newcastle: "newcastleunited",
  westham: "westhamunited",
  leeds: "leedsunited",
};

function resolveAlias(normalized: string): string {
  return KNOWN_ALIASES[normalized] ?? normalized;
}

/**
 * Matches one FPL team to an odds-provider team name from a candidate
 * list. Exact (post-normalization/alias) matching only — deliberately
 * never a fuzzy/partial match. Silently pairing the wrong two clubs would
 * apply one team's market signal to a different team, which corrupts the
 * data more than simply not having a market signal for that fixture.
 * Returns null (and the caller falls back to the pure statistical model
 * for that team) rather than guess.
 */
export function matchOddsTeam(fplTeam: FplTeam, oddsTeamNames: string[]): string | null {
  const candidates = new Set([
    resolveAlias(normalize(fplTeam.name)),
    resolveAlias(normalize(fplTeam.short_name)),
  ]);
  for (const oddsName of oddsTeamNames) {
    if (candidates.has(resolveAlias(normalize(oddsName)))) return oddsName;
  }
  return null;
}
