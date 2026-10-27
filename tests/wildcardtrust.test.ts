import assert from "node:assert/strict";
import { includeCandidates } from "../lib/chipscenarioview";
import type { ScoredPlayer } from "../lib/recommend";
import { makeElement, makeTeam } from "./fixtures";

// The recommendation forecast must not control whether a historically strong
// premium can even be investigated in the Wildcard UI.
function candidate(id: number, xP: number, points: number, price: number): ScoredPlayer {
  return {
    element: makeElement({
      id, web_name: id === 999 ? "Haaland" : "Forward " + id,
      element_type: 4, now_cost: Math.round(price * 10), total_points: points,
    }),
    team: makeTeam(1),
    positionShort: "FWD",
    priceM: price,
    expectedPointsNext: xP,
    expectedPoints: xP * 5,
  } as ScoredPlayer;
}

const others = Array.from({length: 35}, (_,i)=>candidate(i+1,6-i*0.1,40,7));
const standout = candidate(999,0.5,170,14.5);
const pool = [...others,standout];

// Low modeled xP, ownership of 0: old top-xP-only selection excluded him.
const options = includeCandidates(pool, new Set<number>(), ()=>null, 20);
const found = options.find(p=>p.id===999);
assert.ok(found, "An established premium must be inspectable despite low modeled xP");
assert.equal(found?.seasonPts,170);
assert.equal(found?.price,14.5);
assert.equal(found?.next,0.5);

// Also inspect premium incumbents: the wildcard might sell them.
const owned = includeCandidates(pool,new Set([999]),()=>null,20);
assert.equal(owned.find(p=>p.id===999)?.alreadyOwned,true);

// Shared candidate pool must not confuse a missing owner with an owned player.
assert.equal(options.find(p=>p.id===999)?.alreadyOwned,false);
console.log("Wildcard premium candidate visibility: passed");
