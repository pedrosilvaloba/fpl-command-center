import type { FplTeam } from "./types";

export interface OddsMatch {
  homeTeam: string; // team name exactly as returned by the odds provider
  awayTeam: string;
  homeWinProb: number; // de-vigged (bookmaker-margin-removed), sums to 1 with draw+away
  drawProb: number;
  awayWinProb: number;
  commenceTime: string;
}

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Minimal shape of The Odds API's own JSON response — an external,
// unofficial-to-us contract, so kept loose/optional throughout and never
// trusted without the guards in getOddsImpliedProbabilities below.
interface RawOddsOutcome {
  name?: string;
  price?: number;
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
export async function getOddsImpliedProbabilities(): Promise<OddsMatch[] | null> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${ODDS_API_BASE}/sports/soccer_epl/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=uk,eu&markets=h2h&oddsFormat=decimal`,
      { next: { revalidate: REVALIDATE_SECONDS } }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
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

      if (implied.length === 0) continue;
      const n = implied.length;
      matches.push({
        homeTeam,
        awayTeam,
        homeWinProb: implied.reduce((s, x) => s + x.home, 0) / n,
        drawProb: implied.reduce((s, x) => s + x.draw, 0) / n,
        awayWinProb: implied.reduce((s, x) => s + x.away, 0) / n,
        commenceTime: match.commence_time ?? "",
      });
    }

    return matches;
  } catch {
    return null;
  }
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
