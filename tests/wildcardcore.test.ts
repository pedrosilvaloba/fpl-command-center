import assert from "node:assert/strict";
import { wildcardCoreHaaland } from "../lib/wildcardcore";
import type { ScoredPlayer } from "../lib/recommend";
import { makeElement } from "./fixtures";
const player=(id:number,name:string,points:number,position=4)=>({
  element:makeElement({id,web_name:name,total_points:points,element_type:position}),
}) as ScoredPlayer;
const scored=[player(10,"Haaland",130),player(20,"Other",180),player(30,"Haaland",200,3)];
assert.deepEqual(wildcardCoreHaaland(scored,new Set()),[10]);
assert.deepEqual(wildcardCoreHaaland(scored,new Set([10])),[]);
assert.deepEqual(wildcardCoreHaaland([player(10,"Haaland",0)],new Set()),[]);
assert.deepEqual(wildcardCoreHaaland([player(10,"Haaland",130,3)],new Set()),[]);
console.log("Wildcard automatic Haaland core policy passed");
