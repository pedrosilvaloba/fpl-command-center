import type { ScoredPlayer } from "./recommend";
import type { MinutesModel } from "./expectedpoints";
import { recentMinutesVariant, type RecentMinutesSnapshot } from "./recentminutes";
import { getRedis } from "./kv";
import { getEventLive } from "./fpl-client";

const SNAP=(event:number)=>"fpl:minutes-ab:snapshot:v1:"+event;
const RESULT=(event:number)=>"fpl:minutes-ab:result:v1:"+event;
const INDEX="fpl:minutes-ab:index:v1";

export interface MinutePrediction {
  id:number;
  name:string;
  base:{minutes:number;appearance:number;start:number|null;over60:number|null};
  recent:{minutes:number;appearance:number;start:number|null;over60:number|null};
  hasRecent:boolean;
}
export interface MinuteSnapshot {
  version:1;
  event:number;
  deadline:string;
  capturedAt:string;
  lastCompletedEvents:number[];
  players:MinutePrediction[];
}
export interface MinuteScore {
  n:number;
  minutesMAE:number;
  appearanceBrier:number;
  startsBrier:number|null;
  startsN:number;
  sixtyBrier:number|null;
  sixtyN:number;
}
export interface MinuteABResult {
  event:number;
  capturedAt:string;
  settledAt:string;
  eligible:number;
  recentEligible:number;
  base:MinuteScore;
  recent:MinuteScore;
  note:string;
}
export interface MinuteABHistory{
  configured:boolean;
  results:MinuteABResult[];
  pending:number[];
}
const clamp=(v:number)=>Math.min(1,Math.max(0,Number.isFinite(v)?v:0));
const boundedMinutes=(v:number)=>Math.max(0,Math.min(180,Number.isFinite(v)?v:0));

/** Both models are frozen using precisely the SAME players, on the SAME
 * predeadline information. Starts may be absent from FPL's live endpoint;
 * if so we do not fabricate a starts score. */
export function buildMinuteSnapshot(
  scored:ScoredPlayer[],
  recent:RecentMinutesSnapshot|null,
  event:number,
  deadline:string,
  now=Date.now()
):MinuteSnapshot|null{
  const limit=Date.parse(deadline);
  if(!Number.isInteger(event)||event<1||!Number.isFinite(limit)||now>=limit) return null;
  const players:MinutePrediction[]=[];
  for(const p of scored){
    const baseMin=boundedMinutes(p.expectedMinutesNext ?? p.pPlay*90);
    const base:MinutePrediction["base"]={
      minutes:baseMin,
      appearance:clamp(p.pPlay),
      start:p.pStart===undefined?null:clamp(p.pStart),
      over60:p.pPlay60===undefined?null:clamp(p.pPlay60),
    };
    const past=recent?.players[String(p.element.id)];
    const hasRecent=!!past && past.minutes.length>=4;
    const asMinutes:MinutesModel={
      pStart:base.start??base.appearance,
      pAppear:base.appearance,
      pPlay60:base.over60??0,
      expectedMinutes:baseMin,
      avgMinutesPerStart:base.start && base.start>0?
        Math.min(90,baseMin/base.start):baseMin,
      reasons:[],
    };
    const candidate=hasRecent ? recentMinutesVariant(asMinutes,past) : asMinutes;
    const alt:MinutePrediction["recent"]={
      minutes:boundedMinutes(candidate.expectedMinutes),
      appearance:clamp(candidate.pAppear),
      start:base.start===null?null:clamp(candidate.pStart),
      over60:base.over60===null?null:clamp(candidate.pPlay60),
    };
    players.push({id:p.element.id,name:p.element.web_name,base,recent:alt,hasRecent});
  }
  if(!players.length)return null;
  return {
    version:1,event,deadline,capturedAt:new Date(now).toISOString(),
    lastCompletedEvents:recent?.events??[],players,
  };
}
export function gradeMinuteSnapshot(
  snapshot:MinuteSnapshot,
  actual:Map<number,{minutes:number;starts:number|null}>,
  settledAt=new Date().toISOString()
):MinuteABResult {
  // For a fair paired A/B, compare ONLY players with a real pre-GW
  // recent history; all actual zeros remain, including substitutes.
  const cohort=snapshot.players.filter(p=>p.hasRecent && actual.has(p.id));
  const score=(kind:"base"|"recent"):MinuteScore=>{
    if(!cohort.length)return{
      n:0,minutesMAE:0,appearanceBrier:0,startsBrier:null,startsN:0,
      sixtyBrier:null,sixtyN:0,
    };
    let mae=0,appearance=0,start=0,startN=0,sixty=0,sixtyN=0;
    for(const p of cohort){
      const outcome=actual.get(p.id)!;
      const x=p[kind];
      const m=boundedMinutes(outcome.minutes);
      mae+=Math.abs(x.minutes-m);
      appearance+=Math.pow(x.appearance-(m>0?1:0),2);
      if(x.start!==null && outcome.starts!==null){
        start+=Math.pow(x.start-(outcome.starts>0?1:0),2);startN++;
      }
      if(x.over60!==null){
        sixty+=Math.pow(x.over60-(m>=60?1:0),2);sixtyN++;
      }
    }
    return{
      n:cohort.length,
      minutesMAE:mae/cohort.length,
      appearanceBrier:appearance/cohort.length,
      startsBrier:startN?start/startN:null,startsN:startN,
      sixtyBrier:sixtyN?sixty/sixtyN:null,sixtyN,
    };
  };
  return{
    event:snapshot.event,capturedAt:snapshot.capturedAt,settledAt,
    eligible:snapshot.players.filter(p=>actual.has(p.id)).length,
    recentEligible:cohort.length,base:score("base"),recent:score("recent"),
    note:"A/B emparelhado de previsões congeladas antes do deadline. O modelo recente só poderá ser promovido após várias jornadas com ganhos estáveis fora da amostra.",
  };
}
export async function captureMinuteBenchmark(
  scored:ScoredPlayer[],recent:RecentMinutesSnapshot|null,event:number,deadline:string
):Promise<void>{
  const redis=getRedis();
  if(!redis)return;
  const snapshot=buildMinuteSnapshot(scored,recent,event,deadline);
  if(!snapshot)return;
  try {
    if(Date.now()>=Date.parse(deadline))return;
    const wrote=await redis.set(SNAP(event),snapshot,{nx:true});
    if(wrote==="OK") await redis.sadd(INDEX,String(event));
  }catch {/* A logging failure must never take down the dashboard. */}
}
export async function settleMinuteBenchmarks(finished:number[]):Promise<void>{
  const redis=getRedis();if(!redis||!finished.length)return;
  try{
    const tracked=((await redis.smembers(INDEX))??[]).map(Number);
    const ready=new Set(finished);
    for(const gw of tracked.filter(n=>ready.has(n))){
      try{
        if(await redis.get(RESULT(gw)))continue;
        const snap=await redis.get<MinuteSnapshot>(SNAP(gw));
        if(!snap || snap.version!==1 || snap.event!==gw ||
          Date.parse(snap.capturedAt)>=Date.parse(snap.deadline))continue;
        const live=await getEventLive(gw);
        const actual=new Map<number,{minutes:number;starts:number|null}>();
        for(const e of live.elements){
          const m=e.stats?.minutes;
          if(typeof m!=="number"||!Number.isFinite(m))continue;
          const starts=e.stats?.starts;
          actual.set(e.id,{minutes:m,starts:typeof starts==="number"&&Number.isFinite(starts)?starts:null});
        }
        const outcome=gradeMinuteSnapshot(snap,actual);
        if(outcome.recentEligible<10)continue;
        await redis.set(RESULT(gw),outcome);
      }catch{/* Continue when an event has incomplete live statistics. */}
    }
  }catch{}
}
export async function getMinuteABHistory():Promise<MinuteABHistory>{
  const redis=getRedis();if(!redis)return{configured:false,results:[],pending:[]};
  try{
    const ids=((await redis.smembers(INDEX))??[]).map(Number).filter(Number.isInteger).sort((a,b)=>b-a).slice(0,12);
    const data=await Promise.all(ids.map(id=>redis.get<MinuteABResult>(RESULT(id))));
    return{
      configured:true,
      results:data.filter((r):r is MinuteABResult=>!!r&&r.recentEligible>0),
      pending:ids.filter((_,idx)=>!data[idx]),
    };
  }catch{return{configured:true,results:[],pending:[]};}
}
