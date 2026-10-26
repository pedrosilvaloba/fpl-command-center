import { getRedis } from "./kv";
import { getEventLive, getBootstrap } from "./fpl-client";
import { simulateLineup, type SimulatedPlayer } from "./lineupsettlement";
import type { MinutesDecisionComparison, FrozenMinutesDecision } from "./minutesdecisioncomparison";

const SNAP=(gw:number)=>"fpl:minutes-decisions:snapshot:v1:"+gw;
const RESULT=(gw:number)=>"fpl:minutes-decisions:result:v1:"+gw;
const INDEX="fpl:minutes-decisions:index:v1";
export interface FrozenPair {
  version:1;event:number;capturedAt:string;deadline:string;
  baseline:FrozenMinutesDecision;challenger:FrozenMinutesDecision;
  benchBase:number[];benchChallenger:number[];
}
export interface SettledPair {
  event:number;baselinePoints:number;challengerPoints:number;
  gain:number;different:boolean;settledAt:string;
}
export function makeFrozenPair(event:number,deadline:string,comparison:MinutesDecisionComparison,
  owned:number[],now=Date.now()):FrozenPair|null {
  const limit=Date.parse(deadline);
  if(!comparison.comparable||!Number.isSafeInteger(event)||event<1||
    !Number.isFinite(limit)||now>=limit||!Number.isFinite(now)||
    owned.length!==15||new Set(owned).size!==15)return null;
  const bench=(xi:number[])=>owned.filter(id=>!xi.includes(id));
  const base=bench(comparison.baseline.xi),challenge=bench(comparison.challenger.xi);
  if(base.length!==4||challenge.length!==4)return null;
  return {version:1,event,capturedAt:new Date(now).toISOString(),deadline,
    baseline:comparison.baseline,challenger:comparison.challenger,
    benchBase:base,benchChallenger:challenge};
}
/** The recorded bench order is not an optimal bench-order prediction; it is
 * the stable input order of the owned squad. Compare only two policies on
 * that same frozen order. No chips or transfer hits are assumed.
 */
export function gradeFrozenPair(pair:FrozenPair,actual:Map<number,SimulatedPlayer>,
  settledAt=new Date().toISOString()):SettledPair|null {
  const captured=Date.parse(pair.capturedAt),limit=Date.parse(pair.deadline),settled=Date.parse(settledAt);
  if(pair.version!==1||!Number.isSafeInteger(pair.event)||pair.event<1||
    !Number.isFinite(captured)||!Number.isFinite(limit)||!Number.isFinite(settled)||
    captured>=limit||settled<=limit)return null;
  const validate=(d:FrozenMinutesDecision,bench:number[])=>{
    const squad=[...d.xi,...bench];
    return d.valid && d.xi.length===11 && bench.length===4 &&
      new Set(squad).size===15 && squad.every(id=>Number.isSafeInteger(id)&&id>0) &&
      d.captain!==null && d.vice!==null && d.captain!==d.vice &&
      d.xi.includes(d.captain) && d.xi.includes(d.vice);
  };
  if(!validate(pair.baseline,pair.benchBase)||!validate(pair.challenger,pair.benchChallenger)||
    [...pair.baseline.xi,...pair.benchBase].slice().sort((a,b)=>a-b).join(",")!==
    [...pair.challenger.xi,...pair.benchChallenger].slice().sort((a,b)=>a-b).join(","))
    return null;
  const result=(d:FrozenMinutesDecision,bench:number[])=>simulateLineup({
    xi:d.xi,bench,captain:d.captain,vice:d.vice,players:actual,chip:null,hitCost:0,
  });
  // Each of the 15 actual player rows must be complete; a partial API
  // response cannot be treated as 0 minutes/points or a settled week.
  const ids=[...pair.baseline.xi,...pair.benchBase];
  if(ids.some(id=>{const p=actual.get(id);
    return !p||!Number.isFinite(p.minutes)||p.minutes<0||p.minutes>180||
      !Number.isFinite(p.points)||![1,2,3,4].includes(p.position);
  }))return null;
  const b=result(pair.baseline,pair.benchBase),c=result(pair.challenger,pair.benchChallenger);
  if(!b.reliable||!c.reliable)return null;
  return {event:pair.event,baselinePoints:b.points,challengerPoints:c.points,
    gain:c.points-b.points,
    different:pair.baseline.captain!==pair.challenger.captain||
      pair.baseline.vice!==pair.challenger.vice||
      pair.baseline.xi.some(id=>!pair.challenger.xi.includes(id)),settledAt};
}
export async function captureFrozenMinutesPair(pair:FrozenPair|null):Promise<void>{
  if(!pair)return;
  const redis=getRedis();if(!redis)return;
  try{
    if(Date.now()>=Date.parse(pair.deadline))return;
    const saved=await redis.set(SNAP(pair.event),pair,{nx:true});
    if(saved==="OK")await redis.sadd(INDEX,String(pair.event));
  }catch{}
}
export async function settleFrozenMinutesPairs(finished:number[]):Promise<void>{
  const redis=getRedis();if(!redis)return;
  try{
    const events=(await redis.smembers(INDEX)??[]).map(Number).filter(gw=>finished.includes(gw));
    for(const gw of events){
      try{
        if(await redis.get(RESULT(gw)))continue;
        const pair=await redis.get<FrozenPair>(SNAP(gw));if(!pair||pair.event!==gw)continue;
        const [live,bootstrap]=await Promise.all([getEventLive(gw),getBootstrap()]);
        const positions=new Map(bootstrap.elements.map(p=>[p.id,p.element_type]));
        const actual=new Map<number,SimulatedPlayer>();
        for(const p of live.elements){
          const minutes=p.stats?.minutes,points=p.stats?.total_points;
          const position=positions.get(p.id);
          if(typeof minutes!=="number"||!Number.isFinite(minutes)||minutes<0||
            typeof points!=="number"||!Number.isFinite(points)||
            (position!==1&&position!==2&&position!==3&&position!==4))continue;
          actual.set(p.id,{id:p.id,minutes,points,position});
        }
        const outcome=gradeFrozenPair(pair,actual);
        if(outcome)await redis.set(RESULT(gw),outcome);
      }catch{}
    }
  }catch{}
}

export async function getFrozenMinutesDecisionHistory():Promise<{
  configured:boolean;results:SettledPair[];pending:number[];
}>{
  const redis=getRedis();if(!redis)return {configured:false,results:[],pending:[]};
  try{
    const ids=(await redis.smembers(INDEX)??[]).map(Number).filter(Number.isSafeInteger).sort((a,b)=>b-a).slice(0,20);
    const results=await Promise.all(ids.map(id=>redis.get<SettledPair>(RESULT(id))));
    return {configured:true,results:results.filter((r):r is SettledPair=>!!r),
      pending:ids.filter((id,i)=>!results[i])};
  }catch{return {configured:true,results:[],pending:[]};}
}
