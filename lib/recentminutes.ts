import { getBootstrap, getEventLive } from "./fpl-client";
import { getRedis } from "./kv";
import type { FplBootstrap } from "./types";
import type { MinutesModel } from "./expectedpoints";

const KEY="fpl:recent-minutes:v1";
export interface RecentMinutesPlayer {
  minutes: number[]; // ordered oldest -> newest; includes zero-minute GWs
  starts: (number | null)[];
}
export interface RecentMinutesSnapshot {
  version:1;
  at:string;
  events:number[];
  players:Record<string,RecentMinutesPlayer>;
}
export function deriveRecentMinutes(
  weeks:{event:number;elements:{id:number;stats:Record<string,number>}[]}[],
  at="2026-10-25T00:00:00.000Z"
):RecentMinutesSnapshot{
  const sorted=weeks.slice().sort((a,b)=>a.event-b.event).slice(-6);
  // An absent element is NOT a documented zero-minute GW: players joining
  // mid-season, or partial live feeds, must not acquire fictitious benchings.
  // Require observations for every archived week; explicit 0 remains valid.
  const ids=new Set(sorted[0]?.elements.map(e=>e.id) ?? []);
  const byGw=sorted.map(w=>new Map(w.elements.map(e=>[e.id,e.stats] as const)));
  const players:RecentMinutesSnapshot["players"]={};
  for(const id of ids){
    if(!byGw.every(gw=>Number.isFinite(gw.get(id)?.minutes) && (gw.get(id)?.minutes??-1)>=0))continue;
    const mins=byGw.map(gw=>Number(gw.get(id)?.minutes??0));
    const starts=byGw.map(gw=>{
      const v=gw.get(id)?.starts;
      return typeof v==="number" && Number.isFinite(v) ? Math.max(0,Math.min(1,v)) : null;
    });
    players[String(id)]={minutes:mins.map(m=>Number.isFinite(m)?Math.max(0,Math.min(180,m)):0),starts};
  }
  return {version:1,at,events:sorted.map(w=>w.event),players};
}
export async function readRecentMinutes():Promise<RecentMinutesSnapshot|null>{
  const redis=getRedis();
  if(!redis)return null;
  try{
    const x=await redis.get<RecentMinutesSnapshot>(KEY);
    return x?.version===1 && Array.isArray(x.events) && x.players ? x : null;
  }catch{return null;}
}
export async function refreshRecentMinutes(bootstrap?:FplBootstrap):Promise<{
  ok:boolean;events:number;players:number;cached:boolean
}>{
  const redis=getRedis();
  if(!redis)return {ok:false,events:0,players:0,cached:false};
  try{
    const data=bootstrap??await getBootstrap();
    const events=data.events.filter(e=>e.finished).map(e=>e.id).sort((a,b)=>a-b).slice(-6);
    const existing=await readRecentMinutes();
    if(existing && existing.events.join(",")===events.join(",") &&
      Date.now()-Date.parse(existing.at)<12*3_600_000){
      return {ok:true,events:existing.events.length,players:Object.keys(existing.players).length,cached:true};
    }
    if(events.length<3)return {ok:false,events:events.length,players:0,cached:false};
    const live=await Promise.all(events.map(async event=>({event,...await getEventLive(event)})));
    if(live.some(x=>!Array.isArray(x.elements)||x.elements.length<100))
      return {ok:false,events:events.length,players:0,cached:false};
    const snapshot=deriveRecentMinutes(live,new Date().toISOString());
    await redis.set(KEY,snapshot);
    return {ok:true,events:events.length,players:Object.keys(snapshot.players).length,cached:false};
  }catch{return {ok:false,events:0,players:0,cached:false};}
}

/** Recency-sensitive alternative to the season-to-date minutes model.
 * Starts are used only if live stats genuinely publish them. This variant
 * is gated behind an explicit "recentes" toggle until prospective MAE and
 * participation calibration beat the existing model. */
export function recentMinutesVariant(base:MinutesModel,recent:RecentMinutesPlayer|undefined):MinutesModel{
  if(!recent || recent.minutes.length<4)return base;
  const minutes=recent.minutes.slice(-6).map(m=>Math.max(0,Math.min(90,m)));
  const weight=minutes.map((_,i)=>Math.pow(1.35,i));
  const total=weight.reduce((a,b)=>a+b,0);
  const weightedMinutes=minutes.reduce((s,m,i)=>s+m*weight[i],0)/total;
  const pRecentAppear=minutes.reduce((s,m,i)=>s+(m>0?1:0)*weight[i],0)/total;
  const starts=recent.starts.slice(-minutes.length);
  const haveStarts=starts.length===minutes.length && starts.every(x=>x!==null);
  const pRecentStart=haveStarts?starts.reduce((s,x,i)=>s+(x??0)*weight[i],0)/total:null;
  // A conservative adjustment: 35% new evidence at most, not a reset on
  // one substitute appearance. Only known starts affect P(start).
  const blend=0.35;
  const expectedMinutes=Math.max(0,Math.min(90,base.expectedMinutes*(1-blend)+weightedMinutes*blend));
  const pStart=pRecentStart===null?base.pStart:Math.max(0,Math.min(1,base.pStart*(1-blend)+pRecentStart*blend));
  const pAppear=Math.max(pStart,Math.min(1,base.pAppear*(1-blend)+pRecentAppear*blend));
  const pPlay60=Math.min(pAppear,base.pPlay60*(1-blend)+
    minutes.reduce((s,m,i)=>s+(m>=60?1:0)*weight[i],0)/total*blend);
  return {
    ...base,pStart,pAppear,pPlay60,expectedMinutes,
    reasons:[...base.reasons,"Cenário experimental: últimos "+minutes.length+
      " jogos ponderados por recência (não calibrado fora da amostra)."],
  };
}
