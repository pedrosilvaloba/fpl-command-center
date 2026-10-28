import {simulateLineup,type SimulatedPlayer} from "./lineupsettlement";
import type {WildcardAlternative} from "./wildcardalternatives";
import type {ScenarioView} from "./chipscenarioview";
import {getRedis} from "./kv";
import {getBootstrap,getEventLive} from "./fpl-client";

const SNAP=(gw:number)=>"fpl:wildcard-abc:snapshot:v1:"+gw;
const OUT=(gw:number)=>"fpl:wildcard-abc:result:v1:"+gw;
const INDEX="fpl:wildcard-abc:index:v1";
export interface FrozenWildcardSquad {
  policy:"model"|"ppg"|"fpl"; xi:number[];bench:number[];
  captain:number;vice:number;
}
export interface FrozenWildcardExperiment {
  version:1;event:number;deadline:string;capturedAt:string;
  squads:FrozenWildcardSquad[];
}
export interface WildcardOutcome {
  event:number;settledAt:string;
  results:{policy:FrozenWildcardSquad["policy"];points:number}[];
}
const legal=(s:FrozenWildcardSquad)=>s.xi.length===11&&s.bench.length===4&&
  new Set([...s.xi,...s.bench]).size===15 &&
  [...s.xi,...s.bench].every(id=>Number.isSafeInteger(id)&&id>0)&&
  s.captain!==s.vice&&s.xi.includes(s.captain)&&s.xi.includes(s.vice);
export function freezeWildcardExperiment(event:number,deadline:string,
  main:ScenarioView|undefined, alternatives:WildcardAlternative[]|null,
  now=Date.now()):FrozenWildcardExperiment|null {
  if(!alternatives||!main||main.xi.length!==11||main.bench.length!==4||
     !Number.isSafeInteger(event)||event<1||!Number.isFinite(Date.parse(deadline))||
     !Number.isFinite(now)||now>=Date.parse(deadline))return null;
  const baseline:FrozenWildcardSquad={policy:"model",xi:main.xi.map(p=>p.id),
    bench:main.bench.map(p=>p.id),captain:main.captainId??0,vice:main.viceCaptainId??0};
  const variants=alternatives.map(a=>{
    if(!a.available||a.xiIds.length!==11||a.ids.length!==15||a.captainId===null||a.viceCaptainId===null)return null;
    const bench=a.ids.filter(id=>!a.xiIds.includes(id));
    return {policy:a.criterion,xi:a.xiIds,bench,captain:a.captainId,vice:a.viceCaptainId} as FrozenWildcardSquad;
  });
  if(variants.some(x=>!x))return null;
  const squads=[baseline,...variants as FrozenWildcardSquad[]];
  if(squads.length!==3||squads.some(x=>!legal(x)))return null;
  return {version:1,event,deadline,capturedAt:new Date(now).toISOString(),squads};
}
export function gradeWildcards(snapshot:FrozenWildcardExperiment,actual:Map<number,SimulatedPlayer>,
  now=new Date().toISOString()):WildcardOutcome|null {
  if(snapshot.version!==1||snapshot.squads.length!==3||
    new Set(snapshot.squads.map(x=>x.policy)).size!==3||
    !Number.isFinite(Date.parse(snapshot.deadline))||
    !Number.isFinite(Date.parse(snapshot.capturedAt))||
    Date.parse(snapshot.capturedAt)>=Date.parse(snapshot.deadline)||
    !Number.isFinite(Date.parse(now))||Date.parse(now)<=Date.parse(snapshot.deadline))return null;
  const results:WildcardOutcome["results"]=[];
  for(const s of snapshot.squads){
    if(!legal(s))return null;
    const ids=[...s.xi,...s.bench];
    if(ids.some(id=>{const p=actual.get(id);return !p||!Number.isFinite(p.minutes)||
      p.minutes<0||p.minutes>180||!Number.isFinite(p.points)||
      ![1,2,3,4].includes(p.position);}))return null;
    const result=simulateLineup({xi:s.xi,bench:s.bench,captain:s.captain,vice:s.vice,
      players:actual,chip:null,hitCost:0});
    if(!result.reliable)return null;
    results.push({policy:s.policy,points:result.points});
  }
  return {event:snapshot.event,settledAt:now,results};
}
export async function captureWildcardExperiment(snapshot:FrozenWildcardExperiment|null){
  if(!snapshot||Date.now()>=Date.parse(snapshot.deadline))return;
  const redis=getRedis();if(!redis)return;
  const saved=await redis.set(SNAP(snapshot.event),snapshot,{nx:true});
  if(saved==="OK")await redis.sadd(INDEX,String(snapshot.event));
}
export async function settleWildcardExperiments(finished:number[]){
  const redis=getRedis();if(!redis)return;
  const ids=(await redis.smembers(INDEX)??[]).map(Number).filter(id=>finished.includes(id));
  const bootstrap=await getBootstrap();
  const positions=new Map(bootstrap.elements.map(p=>[p.id,p.element_type]));
  for(const gw of ids){
    try{
      if(await redis.get(OUT(gw)))continue;
      const snap=await redis.get<FrozenWildcardExperiment>(SNAP(gw));if(!snap||snap.event!==gw)continue;
      const live=await getEventLive(gw);
      const actual=new Map<number,SimulatedPlayer>();
      for(const p of live.elements){
        const position=positions.get(p.id),minutes=p.stats?.minutes,points=p.stats?.total_points;
        if(![1,2,3,4].includes(position??0)||!Number.isFinite(minutes)||!Number.isFinite(points))continue;
        actual.set(p.id,{id:p.id,position:position as 1|2|3|4,minutes:minutes as number,points:points as number});
      }
      const result=gradeWildcards(snap,actual);
      if(result)await redis.set(OUT(gw),result);
    }catch{/* retry future cron */}
  }
}
export async function getWildcardHistory(){
  const empty={configured:false,results:[] as WildcardOutcome[],pending:[] as number[],lastCapture:null as {at:string;ok:boolean;status:string}|null};
  const redis=getRedis();if(!redis)return empty;
  try {
    const ids=(await redis.smembers(INDEX)??[]).map(Number)
      .filter(id=>Number.isSafeInteger(id)&&id>0).sort((a,b)=>b-a).slice(0,20);
    const [results,lastCapture]=await Promise.all([
      Promise.all(ids.map(id=>redis.get<WildcardOutcome>(OUT(id)))),
      redis.get<{at:string;ok:boolean;status:string}>("fpl:wildcard-abc:last-capture:v1")
    ]);
    return {configured:true,results:results.filter((r):r is WildcardOutcome=>
      !!r&&Number.isSafeInteger(r.event)&&r.results?.length===3),
      pending:ids.filter((id,i)=>!results[i]),lastCapture:lastCapture??null};
  } catch {
    // Storage outage must never take down the owner's analysis dashboard.
    return empty;
  }
}
