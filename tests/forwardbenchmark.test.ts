import assert from "node:assert/strict";
import { buildForwardSnapshot, scoreForwardSnapshot, hasCompleteOwnedSquad } from "../lib/forwardbenchmark";
import { buildAccuracyPicks } from "../lib/accuracy";
import { makeElement, makeTeam, makeEvent } from "./fixtures";
import { buildScoutReport } from "../lib/officialscout";
import { deriveRecentMinutes, recentMinutesVariant } from "../lib/recentminutes";
import { parseEditorialFeed, buildEditorialReport } from "../lib/externalresearch";
import type { ScoredPlayer } from "../lib/recommend";

// Pure test: no API, Redis, mutable production state, or hidden current GW.
const deadline = "2026-10-23T17:30:00Z";
const before = Date.parse("2026-10-23T16:00:00Z");
const after = Date.parse("2026-10-23T18:00:00Z");
const elements = Array.from({ length: 20 }, (_, i) => makeElement({
  id: i + 1,
  web_name: "P" + (i + 1),
  element_type: i % 2 ? 3 : 4,
  points_per_game: String(1 + i / 5),
  ep_next: String(2 + i / 7),
}));
const scored = elements.map((p, i) => ({
  element: p,
  expectedPointsNext: 2 + (i % 5),
  pPlay: i === 0 ? 0.15 : 0.95,
  expectedMinutesNext: i === 0 ? 15 : 85,
} as ScoredPlayer));
const snapshot = buildForwardSnapshot(scored, elements, 8, deadline, before, elements.map((p) => p.id));
assert.ok(snapshot);
assert.equal(snapshot.event, 8);
assert.equal(snapshot.players.length, 20);
assert.equal(snapshot.players[0].fpl, 2);
assert.equal(snapshot.players[0].ppg, 1);
assert.equal(buildForwardSnapshot(scored, elements, 8, deadline, after), null, "no snapshots after deadline");

const points = new Map(elements.map((p, i) => [p.id, i % 4 === 0 ? 0 : 2 + (i % 7)]));
const result = scoreForwardSnapshot(snapshot, points, "2026-10-26T10:00:00Z");
assert.equal(result.eligible, 19, "select only on a priori play probabilities; preserve real zeros");
assert.equal(result.model.n, 19);
assert.equal(result.ppg.n, 19);
assert.equal(result.fpl.n, 19);
assert.equal(result.fullCohort?.model.n, 20, "Include risky players and actual zeros in full universe");
assert.equal(result.positionBands?.reduce((sum, b) => sum + b.model.n, 0), 20, "All player outcomes must appear in positional audit");
assert.equal(result.positionBands?.find(b => b.position === 3)?.model.n, 10);
assert.equal(result.positionBands?.find(b => b.position === 4)?.model.n, 10);
assert.equal(result.positionBands?.find(b => b.position === 1)?.model.n, 0);
assert.equal(result.availabilityBands?.reduce((n, b) => n + b.model.n, 0), 20);
const withoutSquad = buildForwardSnapshot(scored, elements, 8, deadline, before)!;
assert.equal(scoreForwardSnapshot(withoutSquad, points).captain.model, null, "Do not pick impossible captain from global pool");
assert.ok(result.captain.model && snapshot.ownedIds?.includes(result.captain.model.id));
assert.ok(Number.isFinite(result.model.mae));
assert.ok(Number.isFinite(result.model.spearman));
assert.equal(result.captain.model?.name.startsWith("P"), true);

const noFpl = {
  ...snapshot,
  players: snapshot.players.map((p, i) => ({ ...p, fpl: i % 2 ? p.fpl : null })),
};
const sparse = scoreForwardSnapshot(noFpl, points);
assert.equal(sparse.model.n, 19);
assert.equal(sparse.fpl.n, 10);
assert.equal(sparse.ppg.n, 19);

// Most important: changing the actual outcome cannot change who was eligible.
const allZero = new Map(elements.map((p) => [p.id, 0]));
const resZero = scoreForwardSnapshot(snapshot, allZero);
assert.equal(resZero.eligible, result.eligible);
assert.ok(resZero.model.mae > 0);

// A completely absent FPL estimate must not be mistaken for zero expected points.
const missing = elements.map((e) => ({ ...e, ep_next: undefined }));
const missingSnap = buildForwardSnapshot(scored, missing, 8, deadline, before);
assert.equal(missingSnap?.players[0].fpl, null);

// The legacy accuracy tracker had a 5-GW / 1-GW horizon mismatch.
const p1 = { ...scored[1], score: 30, expectedPointsNext: 1 } as ScoredPlayer;
const p2 = { ...scored[3], score: 5, expectedPointsNext: 9 } as ScoredPlayer;
const oneWeek = buildAccuracyPicks([p1, p2]);
assert.equal(oneWeek[0].elementId, p2.element.id, "sort by next GW, not 5-week score");
assert.equal(oneWeek[0].score, 9, "snapshot actual next GW forecast");

console.log("forward prospective benchmark tests passed");

const official = buildScoutReport({
  events: [makeEvent(8, { is_next: true })],
  teams: [makeTeam(1, "ARS")],
  element_types: [], total_players: 1,
  elements: [makeElement({
    id: 99, team: 1, selected_by_percent: "45",
    status: "d", chance_of_playing_next_round: 25,
    news: "Muscle issue", starts: 2, minutes: 100,
    transfers_in_event: 0, transfers_out_event: 80000
  })],
}, "2026-10-23T16:00:00Z");
assert.equal(official.event, 8);
assert.equal(official.source, "official-fpl");
assert.equal(official.analystResearchCompleted, false);
assert.ok(official.items.some((item) => item.category === "availability" && item.playerId === 99));
assert.ok(official.items.every((item) => item.officialUrl.startsWith("https://fantasy.premierleague.com/")));

const rssNow = Date.parse("2026-10-25T12:00:00Z");
const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>FPL team news: player injury &amp; rotations</title>
<link>https://www.fantasyfootballscout.co.uk/2026/10/24/fpl-team-news/</link>
<pubDate>Sat, 24 Oct 2026 11:00:00 GMT</pubDate></item>
<item><title>Blocked malicious link</title>
<link>https://evil.example/football</link>
<pubDate>Sat, 24 Oct 2026 11:00:00 GMT</pubDate></item>
<item><title>Expired article</title>
<link>https://www.fantasyfootballscout.co.uk/2026/07/02/old/</link>
<pubDate>Thu, 02 Jul 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;
const articles = parseEditorialFeed(xml, "Fantasy Football Scout", "fantasyfootballscout.co.uk", rssNow);
assert.equal(articles.length, 1, "Only fresh, HTTPS, allowlisted source links are accepted");
assert.equal(articles[0].subject, "team-news");
assert.equal(articles[0].title, "FPL team news: player injury & rotations");
const editorial = buildEditorialReport([
  { source: "Fantasy Football Scout", findings: articles },
  { source: "BBC Football", findings: [], error: "HTTP 503" },
], "2026-10-25T12:00:00Z");
assert.equal(editorial.findings.length, 1);
assert.equal(editorial.sourcesChecked.length, 1);
assert.equal(editorial.sourcesFailed.length, 1);
assert.equal(editorial.mode, "editorial-feeds");

const recentHistory = deriveRecentMinutes([
  { event: 4, elements: [{ id: 8, stats: { minutes: 0, starts: 0 } }] },
  { event: 5, elements: [{ id: 8, stats: { minutes: 5, starts: 0 } }] },
  { event: 6, elements: [{ id: 8, stats: { minutes: 85, starts: 1 } }] },
  { event: 7, elements: [{ id: 8, stats: { minutes: 90, starts: 1 } }] },
  { event: 8, elements: [{ id: 8, stats: { minutes: 90, starts: 1 } }] },
]);
assert.deepEqual(recentHistory.events,[4,5,6,7,8]);
const baseMinutes = {pStart:0.4,pAppear:0.55,pPlay60:0.3,expectedMinutes:35,avgMinutesPerStart:75,reasons:[]};
const enhanced = recentMinutesVariant(baseMinutes,recentHistory.players["8"]);
assert.ok(enhanced.pStart>baseMinutes.pStart && enhanced.pStart<1);
assert.ok(enhanced.pAppear>baseMinutes.pAppear);
assert.ok(enhanced.expectedMinutes>35 && enhanced.expectedMinutes<90);
assert.ok(enhanced.pPlay60<=enhanced.pAppear);
assert.deepEqual(recentMinutesVariant(baseMinutes,{minutes:[90,90],starts:[1,1]}),baseMinutes,
  "Sparse snapshots cannot change a baseline");
const withoutStartFlags = recentMinutesVariant(baseMinutes,{
  minutes:[85,85,85,85],starts:[null,null,null,null]
});
assert.equal(withoutStartFlags.pStart,baseMinutes.pStart,"Never fabricate starts from missing stats");
console.log("recent minutes shadow tests passed");

assert.equal(hasCompleteOwnedSquad(Array.from({length:15},(_,i)=>i+1)),true);
assert.equal(hasCompleteOwnedSquad(Array.from({length:14},(_,i)=>i+1)),false);
assert.equal(hasCompleteOwnedSquad(Array.from({length:15},(_,i)=>i===14?1:i+1)),false);
assert.equal(hasCompleteOwnedSquad(Array.from({length:15},(_,i)=>i===14?-1:i+1)),false);
console.log("immutable owner-cohort guards passed");
