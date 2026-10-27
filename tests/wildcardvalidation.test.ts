import assert from "node:assert/strict";
import {validateWildcardSquad} from "../lib/wildcardvalidation";
import {makeElement,makeTeam} from "./fixtures";
import type {ScoredPlayer} from "../lib/recommend";
import type {SquadState} from "../lib/squadstate";
const positions=[1,1,2,2,2,2,2,3,3,3,3,3,4,4,4];
const pool=positions.map((position,i)=>({
 element:makeElement({id:i+1,element_type:position,team:Math.floor(i/3)+1}),
 team:makeTeam(Math.floor(i/3)+1),priceM:5,expectedPoints:10,expectedPointsNext:2
} as ScoredPlayer));
const ids=pool.map(p=>p.element.id);
const state={available:true,totalBudgetM:80,owned:[]} as SquadState;
assert.equal(validateWildcardSquad(ids,pool,state).valid,true);
assert.equal(validateWildcardSquad(ids,pool,{...state,totalBudgetM:70}).valid,false);
assert.equal(validateWildcardSquad([...ids.slice(0,14),ids[0]],pool,state).valid,false);
assert.equal(validateWildcardSquad(ids,pool.map((p,i)=>i===14?{...p,element:{...p.element,team:1}}:p),state).valid,false);
assert.equal(validateWildcardSquad(ids,pool,{...state,owned:[{elementId:1,sellingPriceM:20}]}).valid,false);
console.log("Independent wildcard squad integrity passed");