import assert from "node:assert/strict";
import {projectChipsByEvent} from "../lib/chipschedule";
import {finishCaptureRender} from "../lib/capturerender";
import {clubKitUrl} from "../lib/clubkits";
import type {ScoredPlayer} from "../lib/recommend";
import type {FixtureExpectation} from "../lib/matchmodel";
const p=(id:number,pts:number)=>({element:{id,element_type:3,web_name:'P'+id},team:{id:1},expectedPointsNext:pts}) as ScoredPlayer;
const fx=(event:number)=>({event,expectedGoalsFor:1.5,cleanSheetProbability:0.28}) as FixtureExpectation;
const xi=[p(1,8),p(2,7.8)],bench=[p(3,4)];
const out=projectChipsByEvent(xi,bench,new Map([[1,[fx(1),fx(11),fx(11),fx(12)]]]),11,2,xi[1]);
assert.equal(out[0].tripleCaptain,7.8);assert.equal(out[0].captainName,'P2');
assert.equal(out[0].benchBoost,4);assert.equal(out[1].benchBoost,2);
assert.equal(clubKitUrl('MCI'), 'https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_43-66.png');
assert.ok(clubKitUrl('MCI',true)?.includes('43_1-66'));
assert.equal(clubKitUrl('UNKNOWN'),null);
async function main(){
 let persisted=false;
 const response=new Response(new ReadableStream({start(c){
   c.enqueue(new TextEncoder().encode('headers already sent'));
   setTimeout(()=>{persisted=true;c.close()},20);
 }}));
 assert.equal(persisted,false);
 await finishCaptureRender(response);
 assert.equal(persisted,true);
 console.log('Closeout: current/DGW/captain consistency, actual kits and streamed capture passed');
}
void main().catch(e=>{console.error(e);process.exitCode=1});
