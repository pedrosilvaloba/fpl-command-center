import type { ScoredPlayer } from "./recommend";
import type { MinutesModel } from "./expectedpoints";
import { recentMinutesVariant, detectMinutesRoleTrend, detectReturnPattern, type RecentMinutesSnapshot } from "./recentminutes";
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
  uncappedMinutes?:number;
  hasRecent:boolean;
  roleTrend?: "reduced"|"increased"|"stable"|"insufficient";
  returnPattern?: "cameos"|"starting-return"|"none"|"insufficient";
  availabilityContext?: "available"|"doubtful"|"unavailable"|"unknown";
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
  uncappedMinutesMAE?:number;
  cappedVsUncappedMinutesGain?:number;
  uncappedComparableN?:number;
  roleTrendBands?: {trend:"reduced"|"increased"|"stable";base:MinuteScore;recent:MinuteScore}[];
  returnPatternBands?: {pattern:"cameos"|"starting-return";base:MinuteScore;recent:MinuteScore}[];
  availabilityBands?: {context:"available"|"doubtful"|"unavailable"|"unknown";base:MinuteScore;recent:MinuteScore}[];
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
  // Only historical, complete and strictly predeadline observations can
  // influence a frozen challenger. A future event or malformed history
  // would leak data into a prospective experiment.
  const safeRecent = recent && Number.isFinite(Date.parse(recent.at)) &&
    Date.parse(recent.at) < limit &&
    recent.events.length >= 4 && recent.events.length <= 6 &&
    new Set(recent.events).size === recent.events.length &&
    recent.events.every((gw,i) => Number.isInteger(gw) && gw > 0 &&
      gw < event && (i === 0 || gw > recent.events[i-1])) &&
    Object.values(recent.players).every(p => p.minutes.length === recent.events.length &&
      p.starts.length === recent.events.length)
    ? recent : null;
  const players:MinutePrediction[]=[];
  for(const p of scored){
    const baseMin=boundedMinutes(p.expectedMinutesNext ?? p.pPlay*90);
    const base:MinutePrediction["base"]={
      minutes:baseMin,
      appearance:clamp(p.pPlay),
      start:p.pStart===undefined?null:clamp(p.pStart),
      over60:p.pPlay60===undefined?null:clamp(p.pPlay60),
    };
    const past=safeRecent?.players[String(p.element.id)];
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
    const uncapped=hasRecent ? recentMinutesVariant(asMinutes,past,false) : asMinutes;
    const alt:MinutePrediction["recent"]={
      minutes:boundedMinutes(candidate.expectedMinutes),
      appearance:clamp(candidate.pAppear),
      start:base.start===null?null:clamp(candidate.pStart),
      over60:base.over60===null?null:clamp(candidate.pPlay60),
    };
    const status=p.element.status;
    const chance=p.element.chance_of_playing_next_round;
    // Availability is a separate predeadline signal, not evidence that the
    // manager dropped a player. FPL null chance means "not specified".
    const availabilityContext=status==="i"||status==="s"||status==="u"||status==="n"
      ? "unavailable" as const
      : status==="d"||(typeof chance==="number"&&chance<100)
        ? "doubtful" as const
        : status==="a" ? "available" as const : "unknown" as const;
    players.push({id:p.element.id,name:p.element.web_name,base,recent:alt,hasRecent,
      uncappedMinutes:hasRecent?boundedMinutes(uncapped.expectedMinutes):undefined,
      availabilityContext,
      returnPattern:hasRecent && availabilityContext==="available"
        ?detectReturnPattern(past):"insufficient",
      roleTrend:hasRecent && availabilityContext==="available"
        ?detectMinutesRoleTrend(past):"insufficient"});
  }
  if(!players.length)return null;
  return {
    version:1,event,deadline,capturedAt:new Date(now).toISOString(),
    lastCompletedEvents:safeRecent?.events??[],players,
  };
}
export function gradeMinuteSnapshot(
  snapshot:MinuteSnapshot,
  actual:Map<number,{minutes:number;starts:number|null}>,
  settledAt=new Date().toISOString()
):MinuteABResult {
  // For a fair paired A/B, compare ONLY players with a real pre-GW
  // recent history; all actual zeros remain, including substitutes.
  const cohort=snapshot.players.filter(p=>{ const x=actual.get(p.id); return p.hasRecent && !!x && Number.isFinite(x.minutes) && x.minutes>=0 && x.minutes<=180; });
  const score=(kind:"base"|"recent",group=cohort):MinuteScore=>{
    if(!group.length)return{
      n:0,minutesMAE:0,appearanceBrier:0,startsBrier:null,startsN:0,
      sixtyBrier:null,sixtyN:0,
    };
    let mae=0,appearance=0,start=0,startN=0,sixty=0,sixtyN=0;
    for(const p of group){
      const outcome=actual.get(p.id)!;
      const x=p[kind];
      const m=boundedMinutes(outcome.minutes);
      mae+=Math.abs(x.minutes-m);
      appearance+=Math.pow(x.appearance-(m>0?1:0),2);
      if(x.start!==null && outcome.starts!==null && Number.isFinite(outcome.starts) && (outcome.starts===0 || outcome.starts===1)){
        start+=Math.pow(x.start-(outcome.starts>0?1:0),2);startN++;
      }
      if(x.over60!==null){
        sixty+=Math.pow(x.over60-(m>=60?1:0),2);sixtyN++;
      }
    }
    return{
      n:group.length,
      minutesMAE:mae/group.length,
      appearanceBrier:appearance/group.length,
      startsBrier:startN?start/startN:null,startsN:startN,
      sixtyBrier:sixtyN?sixty/sixtyN:null,sixtyN,
    };
  };
  return{
    event:snapshot.event,capturedAt:snapshot.capturedAt,settledAt,
    eligible:snapshot.players.filter(p=>actual.has(p.id)).length,
    recentEligible:cohort.length,base:score("base"),recent:score("recent"),
    ...(()=>{const comparable=cohort.filter(p=>typeof p.uncappedMinutes==="number" && Number.isFinite(p.uncappedMinutes));
      if(!comparable.length)return {};
      const uncappedMinutesMAE=comparable.reduce((sum,p)=>sum+Math.abs(p.uncappedMinutes!-actual.get(p.id)!.minutes),0)/comparable.length;
      const cappedMAE=comparable.reduce((sum,p)=>sum+Math.abs(p.recent.minutes-actual.get(p.id)!.minutes),0)/comparable.length;
      return {uncappedMinutesMAE,cappedVsUncappedMinutesGain:uncappedMinutesMAE-cappedMAE,uncappedComparableN:comparable.length};
    })(),
    roleTrendBands:(["reduced","increased","stable"] as const).map(trend=>{
      const group=cohort.filter(p=>p.roleTrend===trend);
      return {trend,base:score("base",group),recent:score("recent",group)};
    }),
    returnPatternBands:(["cameos","starting-return"] as const).map(pattern=>{
      const group=cohort.filter(p=>p.returnPattern===pattern);
      return {pattern,base:score("base",group),recent:score("recent",group)};
    }),
    availabilityBands:(["available","doubtful","unavailable","unknown"] as const).map(context=>{
      const group=cohort.filter(p=>(p.availabilityContext??"unknown")===context);
      return {context,base:score("base",group),recent:score("recent",group)};
    }),
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
          if(typeof m!=="number"||!Number.isFinite(m)||m<0||m>180)continue;
          const starts=e.stats?.starts;
          actual.set(e.id,{minutes:m,starts:starts===0||starts===1?starts:null});
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

export interface MinuteABVerdict {
  status:"insufficient"|"improved"|"not-better"|"worse";
  events:number;
  meanGainMinutes:number;
  confidenceLow:number|null;
  confidenceHigh:number|null;
  meanGainBrier:number;
  startsEvaluatedGameweeks:number;
  meanGainStartsBrier:number|null;
  rationale:string;
}
/** Conservative, event-level paired evaluation. Observations within one GW
 * share injuries/fixtures and are not independent replicates. Avoid making
 * 600 player rows appear like hundreds of independent gameweeks. */
export function judgeMinuteExperiment(results:MinuteABResult[]):MinuteABVerdict {
  // One observation per distinct GW; duplicate records must not create
  // fictitious independent evidence or tighten a confidence interval.
  const counts=new Map<number,number>();
  for(const r of results)counts.set(r.event,(counts.get(r.event)??0)+1);
  const sample=results.filter(r=>counts.get(r.event)===1 &&
    r.base.n>=10 && r.recent.n>=10 && r.base.n===r.recent.n &&
    Number.isFinite(r.base.minutesMAE) && Number.isFinite(r.recent.minutesMAE) &&
    Number.isFinite(r.base.appearanceBrier) && Number.isFinite(r.recent.appearanceBrier));
  const minutes=sample.map(r=>r.base.minutesMAE-r.recent.minutesMAE);
  const briers=sample.map(r=>r.base.appearanceBrier-r.recent.appearanceBrier);
  const startPairs=sample.filter(r=>r.base.startsBrier!==null && r.recent.startsBrier!==null && r.base.startsN>=10 && r.recent.startsN>=10 && r.base.startsN===r.recent.startsN && Number.isFinite(r.base.startsBrier) && Number.isFinite(r.recent.startsBrier));
  const starts=startPairs.map(r=>r.base.startsBrier!-r.recent.startsBrier!);
  const avg=(v:number[])=>v.length?v.reduce((s,x)=>s+x,0)/v.length:0;
  const mean=avg(minutes),brier=avg(briers),startBrier=starts.length?avg(starts):null;
  const variance=minutes.length>1
    ? minutes.reduce((s,x)=>s+(x-mean)**2,0)/(minutes.length-1):0;
  const stderr=minutes.length>1?Math.sqrt(variance/minutes.length):null;
  const low=stderr===null?null:mean-1.96*stderr;
  const high=stderr===null?null:mean+1.96*stderr;
  const n=sample.length;
  const status:MinuteABVerdict["status"]=n<12?"insufficient":
    high!==null && high<0?"worse":
    low!==null && low>0 && brier>0 && (startPairs.length<10 || (startBrier!==null && startBrier>=0))?"improved":"not-better";
  const rationale=n<12?
    "É necessário observar pelo menos 12 jornadas prospetivas distintas para avaliar estabilidade.":
    status==="improved"?
      "Os minutos recentes superaram o modelo base em MAE e Brier de participação, com intervalo da média por jornada acima de zero. Rever também o efeito em pontos e transferências antes de promover.":
      status==="worse"?
        "Os minutos recentes aumentaram o erro médio em comparação emparelhada.":
        "Não existe evidência suficientemente clara de ganho estável; manter o modelo base.";
  return{status,events:n,meanGainMinutes:mean,confidenceLow:low,confidenceHigh:high,meanGainBrier:brier,startsEvaluatedGameweeks:startPairs.length,meanGainStartsBrier:startBrier,rationale};
}
