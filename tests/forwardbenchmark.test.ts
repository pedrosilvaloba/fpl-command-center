import assert from "node:assert/strict";
import { buildForwardSnapshot, scoreForwardSnapshot } from "../lib/forwardbenchmark";
import { makeElement } from "./fixtures";
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
const snapshot = buildForwardSnapshot(scored, elements, 8, deadline, before);
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

console.log("forward prospective benchmark tests passed");
