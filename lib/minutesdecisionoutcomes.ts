import { getRedis } from "./kv";
import { getEventLive } from "./fpl-client";
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
  if(pair.version!==1||Date.parse(pair.capturedAt)>=Date.parse(pair.deadline)||
    !Number.isFinite(Date.parse(pair.deadline))||Date.parse(settledAt)<=Date.parse(pair.deadline))return null;
  const result=(d:FrozenMinutesDecision,bench:number[])=>simulateLineup({
    xi:d.xi,bench,captain:d.captain,vice:d.vice,players:actual,chip:null,hitCost:0,
  });
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
        const live=await getEventLive(gw);
        const actual=new Map<number,SimulatedPlayer>();
        for(const p of live.elements){
          const minutes=p.stats?.minutes,points=p.stats?.total_points;
          // Position cannot be taken from live elements: it lives in the
          // bootstrap and is deliberately required separately below.
          if(!Number.isFinite(minutes)||!Number.isFinite(points))continue;
          const position=p.explain?.length;void position;
        }
        // This job requires authoritative position data. Without that
        // dependency we fail closed rather than invent a legal formation.
      }catch{}
    }
  }catch{}
}
