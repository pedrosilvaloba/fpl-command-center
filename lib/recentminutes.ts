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

/** A trend is only flagged when TWO consecutive games move together, and
 * both preceding games support a different role. One benching or short
 * substitute cameo is not a change of first-team status.
 * This is an experimental heuristic, not a medical or lineup prediction. */
export function detectMinutesRoleTrend(recent: RecentMinutesPlayer | undefined):
  "reduced" | "increased" | "stable" | "insufficient" {
  if(!recent || recent.minutes.length<4 ||
    recent.minutes.length!==recent.starts.length ||
    recent.minutes.some(m=>!Number.isFinite(m)||m<0||m>180))return "insufficient";
  const m=recent.minutes.slice(-4);
  const previous=m.slice(0,2),latest=m.slice(2);
  if(previous.every(n=>n>=60)&&latest.every(n=>n<=30))return "reduced";
  if(previous.every(n=>n<=30)&&latest.every(n=>n>=60))return "increased";
  return "stable";
}

/** Descriptive recent playing pattern. Minutes alone cannot diagnose injury.
 * Two observations are required; official availability is checked elsewhere.
 */
export function detectReturnPattern(recent: RecentMinutesPlayer|undefined):
  "cameos"|"starting-return"|"none"|"insufficient" {
  if(!recent || recent.minutes.length<4 ||
    recent.starts.length!==recent.minutes.length ||
    recent.minutes.some(m=>!Number.isFinite(m)||m<0||m>180) ||
    recent.starts.some(v=>v!==null && (!Number.isFinite(v)||v<0||v>1)))
    return "insufficient";
  const m=recent.minutes.slice(-4);
  const starts=recent.starts.slice(-2);
  if(m[0]===0 && m[1]===0 && m[2]>0 && m[2]<=30 && m[3]>0 && m[3]<=30)
    return "cameos";
  if(m[0]<=30 && m[1]<=30 && m[2]>=60 && m[3]>=60 &&
    starts.every(v=>v===1))return "starting-return";
  return "none";
}

/** Recency-sensitive alternative to the season-to-date minutes model.
 * Starts are used only if live stats genuinely publish them. This variant
 * is gated behind an explicit "recentes" toggle until prospective MAE and
 * participation calibration beat the existing model. */
export function recentMinutesVariant(base:MinutesModel,recent:RecentMinutesPlayer|undefined):MinutesModel{
  if(!recent || recent.minutes.length<4 || recent.starts.length!==recent.minutes.length ||
    recent.minutes.some(m=>!Number.isFinite(m) || m<0 || m>180) ||
    recent.starts.some(v=>v!==null && (!Number.isFinite(v)||v<0||v>1)))return base;
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
  const trend=detectMinutesRoleTrend(recent);
  const returnPattern=detectReturnPattern(recent);
  // Confirmed two-match role transitions get slightly more weight, but
  // the season baseline still controls a majority of the estimate.
  const blend=trend==="reduced"||trend==="increased"?0.45:0.35;
  const expectedMinutes=Math.max(0,Math.min(90,base.expectedMinutes*(1-blend)+weightedMinutes*blend));
  const pStart=pRecentStart===null?base.pStart:Math.max(0,Math.min(1,base.pStart*(1-blend)+pRecentStart*blend));
  const pAppear=Math.max(pStart,Math.min(1,base.pAppear*(1-blend)+pRecentAppear*blend));
  const pPlay60=Math.max(0,Math.min(pAppear,base.pPlay60*(1-blend)+
    minutes.reduce((s,m,i)=>s+(m>=60?1:0)*weight[i],0)/total*blend));
  // P(60+) cannot exceed P(start) in a single 90-minute fixture.
  const coherent60=Math.min(pPlay60,pStart);
  return {
    ...base,pStart,pAppear,pPlay60:coherent60,expectedMinutes,
    reasons:[...base.reasons,"Cenário experimental: últimos "+minutes.length+
      " jogos ponderados por recência (não calibrado fora da amostra).",
      ...(trend==="reduced"?["Sinal experimental: redução de minutos em dois jogos consecutivos."]:
        trend==="increased"?["Sinal experimental: subida de minutos em dois jogos consecutivos."]:[]),
      ...(returnPattern==="cameos"?["Duas entradas curtas após duas jornadas sem minutos; não implica titularidade nem confirma regresso de lesão."]:
        returnPattern==="starting-return"?["Duas titularidades longas após utilização reduzida; padrão descritivo, não diagnóstico médico."]:[])],
  };
}
