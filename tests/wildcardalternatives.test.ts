import assert from "node:assert/strict";
import { optimizeWildcardBaselines } from "../lib/wildcardalternatives";
import { makeElement, makeTeam } from "./fixtures";
import type { ScoredPlayer } from "../lib/recommend";
import type { SquadState } from "../lib/squadstate";

const players = Array.from({length:20},(_,i)=>({
  element:makeElement({id:i+1,web_name:"Player "+i,element_type:4,points_per_game:"4.5",ep_next:i===0?null:"3.5"}),
  team:makeTeam(1),priceM:6,expectedPointsNext:3,expectedPoints:15,score:15,
} as ScoredPlayer));
const outcomes=optimizeWildcardBaselines(players,{} as SquadState,{},"equilibrado");
assert.equal(outcomes.length,2);
const official=outcomes.find(x=>x.criterion==="fpl");
assert.equal(official?.available,false);
assert.match(official?.reason??"",/insuficiente/i);
assert.equal(official?.ids.length,0);
console.log("Full wildcard baseline incomplete-official-data safety passed");
