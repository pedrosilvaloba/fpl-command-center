import { getRedis } from "./kv";

/**
 * Independent editorial monitoring. We preserve article-level provenance:
 * a headline does NOT prove that the player will start, be injured, or score.
 * This read-only layer NEVER feeds multipliers into projected points.
 *
 * Two independently maintained, publicly accessible feeds:
 * Fantasy Football Scout and BBC Football. Bounded parallel requests
 * and explicit failure reporting mean a partial response is not disguised
 * as a fully completed research pass.
 */
export const EXTERNAL_RESEARCH_KEY = "fpl:external-research:v2";
const MAX_XML_CHARS = 380_000;
const MAX_ARTICLES = 18;
const MAX_AGE_HOURS = 96;
const UPDATE_AFTER_HOURS = 6;
const FEEDS = [
  { name: "Fantasy Football Scout", url: "https://www.fantasyfootballscout.co.uk/feed/", domain: "fantasyfootballscout.co.uk" },
  { name: "BBC Football", url: "https://feeds.bbci.co.uk/sport/football/rss.xml", domain: "bbc.co.uk" },
] as const;

export interface EditorialFinding {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  subject: "team-news" | "tactics" | "strategy" | "general";
}
export interface ExternalResearchReport {
  version: 2;
  at: string;
  mode: "editorial-feeds";
  findings: EditorialFinding[];
  sourcesChecked: string[];
  sourcesFailed: { source: string; reason: string }[];
  /** Descriptive aggregation: not AI opinions or verified tactical inference. */
  note: string;
}

function decodeEntities(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Math.min(0x10ffff, Number(value))))
    .replace(/<[^>]+>/g, "").trim();
}
function tag(item: string, name: string): string {
  const m = item.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
}
function topic(title: string): EditorialFinding["subject"] {
  if (/injur|fitness|team news|availability|doubt|suspend|rotation|start(?:ing)? xi|line.?up/i.test(title)) return "team-news";
  if (/tactic|formation|pressing|set.piece|penalt|role|minutes/i.test(title)) return "tactics";
  if (/fantasy|fpl|captain|wildcard|chip|transfer|fixture|gameweek|gw\d/i.test(title)) return "strategy";
  return "general";
}
export function parseEditorialFeed(
  xml: string, source: string, allowedDomain: string, now = Date.now()
): EditorialFinding[] {
  if (xml.length > MAX_XML_CHARS || !/<rss[\s>]/i.test(xml)) return [];
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)?.slice(0, 70) ?? [];
  const rows: EditorialFinding[] = [];
  for (const item of items) {
    const title = tag(item, "title").slice(0, 170);
    const link = tag(item, "link");
    const when = Date.parse(tag(item, "pubDate"));
    if (!title || !Number.isFinite(when) || when > now + 3_600_000 || now - when > MAX_AGE_HOURS * 3_600_000) continue;
    try {
      const u = new URL(link);
      if (u.protocol !== "https:" || !(u.hostname === allowedDomain || u.hostname.endsWith("." + allowedDomain))) continue;
      rows.push({ title, url: u.toString(), source, publishedAt: new Date(when).toISOString(), subject: topic(title) });
    } catch { /* discard invalid and non-https links */ }
  }
  return rows;
}
export function buildEditorialReport(
  sources: { source: string; findings: EditorialFinding[]; error?: string }[],
  at = new Date().toISOString()
): ExternalResearchReport {
  const checked = sources.filter(s => !s.error).map(s => s.source);
  const failed = sources.filter(s => s.error).map(s => ({ source: s.source, reason: s.error! }));
  const seen = new Set<string>();
  const findings = sources.flatMap(s => s.findings)
    .sort((a, b) => {
      const weight = (v: EditorialFinding) => v.subject === "team-news" ? 3 : v.subject === "tactics" ? 2 : v.subject === "strategy" ? 1 : 0;
      return weight(b) - weight(a) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    })
    .filter(x => {
      const k = x.url.split("?")[0];
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, MAX_ARTICLES);
  return {
    version: 2, mode: "editorial-feeds", at, findings,
    sourcesChecked: checked, sourcesFailed: failed,
    note: "Monitorização editorial automática: títulos, datas e URLs de fontes independentes. Não conclui que o jogador será titular e não altera previsões sem validação adicional.",
  };
}
export async function readExternalResearch(): Promise<ExternalResearchReport | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const r = await redis.get<ExternalResearchReport>(EXTERNAL_RESEARCH_KEY);
    return r?.version === 2 && r.mode === "editorial-feeds" && Array.isArray(r.findings) ? r : null;
  } catch { return null; }
}
export async function runExternalResearch(): Promise<
  | { ok: true; productive: boolean; summary: string; detail: Record<string, unknown> }
  | { ok: false; productive: false; summary: string; error: string; retryable: boolean; detail: Record<string, unknown> }
> {
  const redis = getRedis();
  if (!redis) return { ok: false, productive: false, summary: "Sem Redis", error: "Redis não configurado", retryable: false, detail: {} };
  try {
    const existing = await readExternalResearch();
    if (existing && existing.sourcesChecked.length === FEEDS.length && existing.findings.length > 0 &&
        Date.now() - Date.parse(existing.at) < UPDATE_AFTER_HOURS * 3_600_000) {
      return { ok: true, productive: true, summary: "Investigação editorial atualizada e em cache", detail: { cached: true, sources: existing.sourcesChecked.length, findings: existing.findings.length } };
    }
    const loaded = await Promise.all(FEEDS.map(async (feed) => {
      try {
        const response = await fetch(feed.url, {
          headers: { Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
          signal: AbortSignal.timeout(12_000),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > MAX_XML_CHARS) throw new Error("Feed demasiado grande");
        const body = await response.text();
        if (body.length > MAX_XML_CHARS || !/<rss[\s>]/i.test(body)) throw new Error("Resposta não é RSS válido");
        return { source: feed.name, findings: parseEditorialFeed(body, feed.name, feed.domain) };
      } catch (error) {
        return { source: feed.name, findings: [] as EditorialFinding[], error: error instanceof Error ? error.message.slice(0,100) : "Erro desconhecido" };
      }
    }));
    const report = buildEditorialReport(loaded);
    if (report.sourcesChecked.length === 0) return {
      ok: false, productive: false, error: "As fontes RSS não responderam", retryable: true,
      summary: "Investigação externa sem fontes verificáveis", detail: { failed: report.sourcesFailed },
    };
    await redis.set(EXTERNAL_RESEARCH_KEY, report);
    const productive = report.findings.length > 0;
    return {
      ok: true, productive,
      summary: `Investigação editorial: ${report.sourcesChecked.length}/${FEEDS.length} fontes, ${report.findings.length} artigos atuais`,
      detail: { sources: report.sourcesChecked, failed: report.sourcesFailed, findings: report.findings.length, mode: report.mode },
    };
  } catch (error) {
    return { ok: false, productive: false, error: String(error).slice(0,200), retryable: true, summary: "Falha a guardar investigação", detail: {} };
  }
}
