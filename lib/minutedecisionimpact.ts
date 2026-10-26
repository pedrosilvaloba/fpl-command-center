import type { MinuteSnapshot } from "./minutebenchmark";

/** Same-deadline diagnostic, NOT a replacement FPL points calculation.
 * Finds whose minutes shift materially under the recent-minutes challenger.
 * Only a complete, valid predeadline snapshot is considered.
 */
export interface MinutesDecisionAlert {
  id:number;
  name:string;
  baseMinutes:number;
  candidateMinutes:number;
  changeMinutes:number;
  direction:"up"|"down";
  roleTrend:string;
  availability:string;
}
export function minuteDecisionAlerts(snapshot:MinuteSnapshot, threshold=12):MinutesDecisionAlert[] {
  const captured=Date.parse(snapshot.capturedAt),deadline=Date.parse(snapshot.deadline);
  if(!Number.isFinite(captured)||!Number.isFinite(deadline)||captured>=deadline ||
    !Number.isFinite(threshold)||threshold<1)return [];
  return snapshot.players.flatMap(p=>{
    if(!p.hasRecent || p.availabilityContext!=="available" ||
      !Number.isFinite(p.base.minutes)||!Number.isFinite(p.recent.minutes))return [];
    const delta=p.recent.minutes-p.base.minutes;
    if(Math.abs(delta)<threshold)return [];
    return [{
      id:p.id,name:p.name,baseMinutes:p.base.minutes,candidateMinutes:p.recent.minutes,
      changeMinutes:Math.round(delta*10)/10,
      direction:delta>0?"up" as const:"down" as const,
      roleTrend:p.roleTrend??"insufficient",availability:p.availabilityContext,
    }];
  }).sort((a,b)=>Math.abs(b.changeMinutes)-Math.abs(a.changeMinutes)||a.id-b.id);
}
