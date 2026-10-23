import assert from "node:assert/strict";
import { simulateLineup, type SimulatedPlayer } from "../lib/lineupsettlement";
import { settleOutcome, type AdviceRecord } from "../lib/decisions";

const pos: Record<number, 1 | 2 | 3 | 4> = {
  1: 1, 2: 1,
  3: 2, 4: 2, 5: 2, 13: 2, 14: 2,
  6: 3, 7: 3, 8: 3, 9: 3, 10: 3,
  11: 4, 12: 4, 15: 4,
};
const points = new Map<number, number>([
  [1, 2], [2, 6], [3, 0], [4, 4], [5, 3],
  [6, 5], [7, 9], [8, 4], [9, 2], [10, 2],
  [11, 0], [12, 2], [13, 8], [14, 1], [15, 6],
]);
const played = new Map<number, number>(Object.keys(pos).map((key) => [Number(key), 90]));
played.set(3, 0);
played.set(11, 0);
const players = new Map<number, SimulatedPlayer>(Object.keys(pos).map((key) => {
  const id = Number(key);
  return [id, { id, position: pos[id], points: points.get(id) ?? 0, minutes: played.get(id) ?? 0 }];
}));
const xi = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const bench = [2, 13, 14, 15];
const normal = simulateLineup({ xi, bench, captain: 11, vice: 7, hitCost: 4, players });
assert.equal(normal.reliable, true);
assert.deepEqual(normal.subs, [{ inId: 13, outId: 3 }, { inId: 15, outId: 11 }]);
assert.equal(normal.captainUsed, 7);
const expected = [1, 13, 4, 5, 6, 7, 8, 9, 10, 15, 12]
  .reduce((n, id) => n + (points.get(id) ?? 0), 0) + (points.get(7) ?? 0) - 4;
assert.equal(normal.points, expected);
assert.equal(normal.counted.length, 11);

const triple = simulateLineup({ xi, bench, captain: 11, vice: 7, chip: "3xc", hitCost: 4, players });
assert.equal(triple.points, normal.points + 9, "triple captain increases by one extra vice score");
const bboost = simulateLineup({ xi, bench, captain: 11, vice: 7, chip: "bboost", players });
assert.equal(bboost.subs.length, 0, "no autosubs are needed with Bench Boost");
assert.equal(bboost.points,
  [...xi, ...bench].reduce((n, id) => n + (points.get(id) ?? 0), 0) + 9);

const keeperOut = new Map(players);
keeperOut.set(1, { ...players.get(1)!, minutes: 0, points: 0 });
const keeper = simulateLineup({ xi, bench, captain: 7, vice: 6, players: keeperOut });
assert.equal(keeper.subs[0].inId, 2, "reserve GK must replace absent starting GK");

const bad = simulateLineup({ xi: xi.slice(1), bench, captain: 11, vice: 7, players });
assert.equal(bad.reliable, false);
const missing = new Map(players); missing.delete(12);
assert.equal(simulateLineup({ xi, bench, captain: 7, vice: 6, players: missing }).reliable, false);

const advice: AdviceRecord = {
  event: 8, at: "2026-10-23T16:00:00Z",
  captain: 11, vice: 7, xi, bench, transfers: [],
  hitCost: 4, chip: null, captainSource: "modelo", predictedXi: 40,
};
const officialPicks = [...xi, ...bench].map((id, i) => ({
  element: id, position: i + 1,
  is_captain: id === 7, multiplier: id === 7 ? 2 : i < 11 ? 1 : 0,
}));
const compare = settleOutcome(advice, {
  picks: officialPicks, activeChip: null, officialPoints: 0,
  transfersCost: 0, transfersIn: [],
  minutesById: played,
  positionById: new Map(Object.keys(pos).map((x) => [Number(x), pos[Number(x)]])),
}, (id) => points.get(id) ?? 0);
assert.equal(compare.settlement?.simulated, normal.points);
assert.equal(compare.settlement?.subCount, 2);
assert.ok(compare.settlement?.officialDelta !== undefined);
console.log("decision integrity tests passed");
