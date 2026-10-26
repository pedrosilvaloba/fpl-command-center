import type { AdviceRecord, OutcomeRecord } from "./decisions";

/**
 * Conservative validation for the two policies archived together before a GW.
 * This does not certify FPL cash/team quotas or replay multiweek paths.
 */
export interface PairedTransferWeek {
  advice: AdviceRecord;
  outcome: OutcomeRecord;
  deadlineIso: string;
}
const legalSquad=(xi:number[],bench:number[])=>{
  const ids=[...xi,...bench];
  return xi.length===11 && bench.length===4 && new Set(ids).size===15 &&
    ids.every(n=>Number.isSafeInteger(n)&&n>0);
};
const validCaptain=(xi:number[],captain:number|null,vice:number|null)=>
  captain!==null && vice!==null && captain!==vice &&
  xi.includes(captain) && xi.includes(vice);
const validMovements=(from:number[],to:number[],moves:{out:number;in:number}[])=>{
  const original=new Set(from),target=new Set(to);
  const outs=from.filter(n=>!target.has(n)).sort((a,b)=>a-b);
  const ins=to.filter(n=>!original.has(n)).sort((a,b)=>a-b);
  if(outs.length!==moves.length || ins.length!==moves.length) return false;
  const listedOut=moves.map(m=>m.out).sort((a,b)=>a-b);
  const listedIn=moves.map(m=>m.in).sort((a,b)=>a-b);
  return outs.every((v,i)=>v===listedOut[i]) && ins.every((v,i)=>v===listedIn[i]);
};
export function auditTransferShadow(weeks:PairedTransferWeek[]) {
  const counts=new Map<number,number>();
  for(const w of weeks) counts.set(w.advice.event,(counts.get(w.advice.event)??0)+1);
  const excluded:Record<string,number>={};
  const paired:{event:number;shadowMinusCurrent:number;shadowMinusHold:number;policiesDiffer:boolean}[]=[];
  for(const {advice,outcome,deadlineIso} of weeks){
    let reason:string|null=null;
    const deadline=Date.parse(deadlineIso),captured=Date.parse(advice.at),settled=Date.parse(outcome.settledAt);
    const shadow=advice.shadowPlan,hold=advice.holdBaseline,s=outcome.settlement;
    if(counts.get(advice.event)!>1) reason="duplicate-event";
    else if(advice.event!==outcome.event || !Number.isSafeInteger(advice.event)) reason="event-mismatch";
    else if(!Number.isFinite(deadline)||!Number.isFinite(captured)||!Number.isFinite(settled)||captured>=deadline||settled<=deadline)
      reason="timing";
    else if(advice.chip!==null || !shadow || !hold) reason="missing-comparable-plan";
    else if(!legalSquad(advice.xi,advice.bench)||!legalSquad(shadow.xi,shadow.bench)||!legalSquad(hold.xi,hold.bench))
      reason="invalid-squad";
    else if(!validCaptain(advice.xi,advice.captain,advice.vice) ||
      !validCaptain(shadow.xi,shadow.captain,shadow.vice) ||
      !validCaptain(hold.xi,hold.captain,hold.vice))
      reason="invalid-captain";
    else if(!validMovements([...hold.xi,...hold.bench],[...shadow.xi,...shadow.bench],shadow.transfers) ||
      !validMovements([...hold.xi,...hold.bench],[...advice.xi,...advice.bench],advice.transfers))
      reason="invalid-transfer-diff";
    else if(shadow.transfers.length>3||advice.transfers.length>3 ||
      !Number.isFinite(shadow.hitCost)||shadow.hitCost<0||
      !Number.isFinite(advice.hitCost)||advice.hitCost<0||
      shadow.hitCost%4!==0||advice.hitCost%4!==0)
      reason="invalid-transfer-cost";
    else if(!s || !Number.isFinite(s.shadowPoints)||!Number.isFinite(s.shadowVsLive)||
      !Number.isFinite(s.shadowVsHold)||!Number.isFinite(s.simulated)||!Number.isFinite(s.holdPoints)||
      !Number.isFinite(s.officialDelta)||Math.abs(s.officialDelta)>1 ||
      !Number.isFinite(s.gainVsHold) || !Number.isFinite(s.netDifference))
      reason="unverified-settlement";
    else if(Math.abs(s.shadowPoints!-s.simulated-s.shadowVsLive!)>0.001 ||
      Math.abs(s.shadowPoints!-s.holdPoints!-s.shadowVsHold!)>0.001 ||
      Math.abs(s.simulated-s.holdPoints!-s.gainVsHold!)>0.001)
      reason="inconsistent-settlement";
    if(reason){excluded[reason]=(excluded[reason]??0)+1;continue;}
    const policiesDiffer=advice.captain!==shadow!.captain ||
      advice.vice!==shadow!.vice || advice.hitCost!==shadow!.hitCost ||
      advice.xi.some((id,i)=>id!==shadow!.xi[i]) ||
      advice.bench.some((id,i)=>id!==shadow!.bench[i]);
    paired.push({event:advice.event,shadowMinusCurrent:s!.shadowVsLive!,
      shadowMinusHold:s!.shadowVsHold!,policiesDiffer});
  }
  paired.sort((a,b)=>a.event-b.event);
  const total=paired.reduce((a,b)=>a+b.shadowMinusCurrent,0);
  return {
    inspected:weeks.length,pairedGameweeks:paired.length,excluded,
    shadowMinusCurrent:paired.length?total:null,
    meanShadowMinusCurrent:paired.length?total/paired.length:null,
    // Same-decision weeks inflate n without testing which policy is better.
    divergentGameweeks:paired.filter(p=>p.policiesDiffer).length,
    meanDifferenceWhenDivergent:(()=>{
      const different=paired.filter(p=>p.policiesDiffer);
      return different.length?different.reduce((sum,p)=>sum+p.shadowMinusCurrent,0)/different.length:null;
    })(),
    wins:paired.filter(p=>p.shadowMinusCurrent>0).length,
    losses:paired.filter(p=>p.shadowMinusCurrent<0).length,
    ties:paired.filter(p=>p.shadowMinusCurrent===0).length,
    verdict:paired.filter(p=>p.policiesDiffer).length<12?"insufficient-evidence" as const:"descriptive-only" as const,
    note:"Same-GW simulated points; identical decisions do not count as independent policy comparisons. Budget, club quota, future FT accrual and multiweek feasibility remain unverified.",
  };
}
