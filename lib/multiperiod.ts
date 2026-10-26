import type { ScoredPlayer } from "./recommend";
import { pickBestXI, pickCaptain } from "./recommend";
import type { SquadState } from "./squadstate";

export interface PeriodForecast { event: number; players: ScoredPlayer[] }
export interface PeriodMove { out: number; into: number; outName: string; inName: string; costM: number }
export interface PeriodStep {
  event: number;
  moves: PeriodMove[];
  freeBefore: number;
  freeAfter: number;
  hitCost: number;
  bankAfterM: number;
  xi: number[];
  captain: number | null;
  expectedPoints: number;
}
export interface MultiPeriodReport {
  available: boolean;
  reason: string | null;
  horizon: number;
  baselinePoints: number;
  plannedPoints: number;
  gainVsHold: number;
  /** Purely hypothetical downside if acquired players underperform by 20%. */
  stressGainVsHold: number;
  steps: PeriodStep[];
  evaluated: number;
  beamWidth: number;
  method: "bounded-beam-search";
}

interface Node {
  ids: number[];
  bankT: number;
  free: number;
  total: number;
  steps: PeriodStep[];
  ownedSellT: Map<number, number>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const priceT = (p: ScoredPlayer) => Math.round(p.priceM * 10);
/** Equivalent rosters can have DIFFERENT future sale proceeds depending on
 * acquisition history. Omitting the sale basis silently merges paths that
 * have different legal next-week budgets. */
export function multiPeriodStateKey(ids:number[],free:number,bankT:number,sellPrices:Map<number,number>):string {
  return ids.slice().sort((a,b)=>a-b).map(id=>id+"@"+(sellPrices.get(id)??"unknown")).join(",")
    +":"+free+":"+bankT;
}
const key=(n:Node)=>multiPeriodStateKey(n.ids,n.free,n.bankT,n.ownedSellT);
const churn=(n:Node)=>n.steps.reduce((sum,step)=>sum+step.moves.length,0);
const need: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
/** Cost of the next transfer relative to doing one fewer in this GW.
 * Ranking candidates on gross xP can otherwise spend the scarce beam on
 * hit-heavy paths before the objective even deducts the -4.
 */
export function incrementalTransferHit(freeBefore:number,movesAlready:number):number {
  const free=Math.max(0,Math.min(5,Math.floor(freeBefore)));
  const count=Math.max(0,Math.floor(movesAlready));
  return Math.max(0,count+1-free)*4-Math.max(0,count-free)*4;
}


/**
 * Genuine sequential, bounded multi-GW search, not a claim of global
 * optimality. Every state carries roster, cash, selling prices, banked FTs
 * and all transfer actions. No future results leak into the forecasts.
 *
 * Transparent limitations: 2 transfers/GW maximum, max 4-point hits each
 * GW unless more free transfers; no future prices or chips; static
 * as-of-today estimates. It is a decision-path candidate generator.
 */
export function planMultipleGameweeks(
  state: SquadState,
  forecasts: PeriodForecast[],
  opts: { beamWidth?: number; horizon?: number } = {}
): MultiPeriodReport {
  const horizon = Math.min(8, Math.max(1, Math.floor(opts.horizon ?? forecasts.length)));
  const width = Math.min(20, Math.max(3, Math.floor(opts.beamWidth ?? 10)));
  const unavailable = (reason: string): MultiPeriodReport => ({
    available:false, reason, horizon, baselinePoints:0, plannedPoints:0,
    gainVsHold:0, stressGainVsHold:0, steps:[], evaluated:0, beamWidth:width, method:"bounded-beam-search",
  });
  if (!state.available || state.owned.length !== 15) return unavailable("Sem os 15 jogadores da equipa real.");
  const weeks = forecasts.slice(0,horizon);
  if (!weeks.length || weeks.some(w => !w.players.length)) return unavailable("Previsões semanais indisponíveis.");
  if (weeks.some((w,i) => i && w.event !== weeks[i-1].event+1)) return unavailable("Jornadas não consecutivas.");
  const maps = weeks.map(w => new Map(w.players.map(p => [p.element.id,p] as const)));
  const initialIds = state.owned.map(p => p.elementId);
  if (new Set(initialIds).size !== 15 || initialIds.some(id => !maps[0].has(id))) return unavailable("Plantel inicial incompleto nas previsões.");
  for (const pos of [1,2,3,4]) {
    if (initialIds.filter(id => maps[0].get(id)?.element.element_type === pos).length !== need[pos])
      return unavailable("Plantel inicial com posições inválidas.");
  }

  // A lawful alternative may have been bought in a previous simulated GW:
  // its hypothetical selling price remains at purchase price, without
  // pretending to know future price moves.
  const initialSell = new Map(state.owned.map(o => [o.elementId,Math.round(o.sellingPriceM*10)] as const));
  const initial: Node = {
    ids: initialIds, bankT: Math.round(state.bankM*10),
    free: Math.min(5,Math.max(0,state.freeTransfers)), total:0,
    steps:[], ownedSellT:initialSell,
  };
  const weekScoreCache = new Map<string,{points:number;xi:number[];captain:number|null}>();
  const scoreWeek = (node: Node, k: number) => {
    const scoreKey = String(k) + ":" + node.ids.slice().sort((a,b)=>a-b).join(",");
    const previous = weekScoreCache.get(scoreKey);
    if(previous) return previous;
    const byId = maps[k];
    const squad = node.ids.map(id => byId.get(id) ?? maps[0].get(id)!)
      .map(p => p && byId.has(p.element.id) ? p : ({...p, score:0, expectedPointsNext:0} as ScoredPlayer));
    const xi = pickBestXI(squad.map(p => ({...p,score:p.expectedPointsNext})));
    const { captain, viceCaptain } = pickCaptain(xi);
    const value = {
      points: xi.reduce((s,p) => s + p.expectedPointsNext,0)+(captain?.expectedPointsNext??0)+(viceCaptain ? Math.max(0.02,1-(captain?.pPlay??1))*viceCaptain.expectedPointsNext : 0),
      xi:xi.map(p=>p.element.id), captain:captain?.element.id??null,
    };
    weekScoreCache.set(scoreKey,value);
    return value;
  };
  const baseScores = weeks.map((w,i) => scoreWeek(initial,i).points);
  const baselinePoints = round1(baseScores.reduce((a,b)=>a+b,0));
  let beam: Node[] = [initial];
  let evaluated = 0;
  for(let k=0;k<weeks.length;k++){
    const map = maps[k];
    const candidates = new Map<number,ScoredPlayer[]>();
    const remainingValue = new Map<number,number>();
    for(let t=k;t<weeks.length;t++) {
      for(const [id,p] of maps[t])
        remainingValue.set(id,(remainingValue.get(id)??0)+p.expectedPointsNext);
    }
    for(const pos of [1,2,3,4]) {
      const pool = weeks[k].players.filter(p=>p.element.element_type===pos && p.element.status!=="u");
      const weighted = pool.slice().sort((a,b)=>(remainingValue.get(b.element.id)??0)-(remainingValue.get(a.element.id)??0)).slice(0,7);
      const cheap = pool.slice().sort((a,b)=>a.priceM-b.priceM).slice(0,3);
      candidates.set(pos,[...new Map([...weighted,...cheap].map(p=>[p.element.id,p])).values()]);
    }
    const next: Node[]=[];
    const validMove=(node:Node,out:number,into:ScoredPlayer):Node|null=>{
      if(node.ids.includes(into.element.id)||!node.ids.includes(out))return null;
      const old = map.get(out)??maps[0].get(out);
      if(!old || old.element.element_type!==into.element.element_type)return null;
      const sell=node.ownedSellT.get(out)??priceT(old);
      const buy=priceT(into), bank=node.bankT+sell-buy;
      if(bank<0)return null;
      const ids=node.ids.map(id=>id===out?into.element.id:id);
      const clubs=new Map<number,number>();
      for(const id of ids){
        const p=map.get(id)??maps[0].get(id);
        if(!p)return null;
        clubs.set(p.team.id,(clubs.get(p.team.id)??0)+1);
      }
      if([...clubs.values()].some(count=>count>3))return null;
      const sells=new Map(node.ownedSellT);sells.delete(out);sells.set(into.element.id,buy);
      return {...node,ids,bankT:bank,ownedSellT:sells};
    };
    const add=(node:Node,moves:PeriodMove[])=>{
      const cost=Math.max(0,moves.length-node.free)*4;
      const result=scoreWeek(node,k);
      const step:PeriodStep={
        event:weeks[k].event,moves,freeBefore:node.free,
        freeAfter:Math.min(5,Math.max(0,node.free-moves.length)+1),
        hitCost:cost,bankAfterM:round1(node.bankT/10),xi:result.xi,
        captain:result.captain,expectedPoints:round1(result.points-cost),
      };
      next.push({...node,free:step.freeAfter,total:node.total+result.points-cost,
        steps:[...node.steps,step]});
      evaluated++;
    };
    for(const node of beam){
      add(node,[]);
      const single:{n:Node;m:PeriodMove;score:number}[]=[];
      for(const out of node.ids){
        const old=map.get(out)??maps[0].get(out);
        if(!old)continue;
        for(const incoming of candidates.get(old.element.element_type)??[]){
          const n=validMove(node,out,incoming);
          if(!n)continue;
          const v=scoreWeek(n,k).points-scoreWeek(node,k).points;
          const future=(remainingValue.get(incoming.element.id)??0)-(remainingValue.get(out)??0)
            -(map.get(incoming.element.id)?.expectedPointsNext??0)+(map.get(out)?.expectedPointsNext??0);
          single.push({n,m:{out,into:incoming.element.id,outName:old.element.web_name,
            inName:incoming.element.web_name,costM:round1((priceT(incoming)-(node.ownedSellT.get(out)??priceT(old)))/10)},
            score:v+future-incrementalTransferHit(node.free,0)});
        }
      }
      single.sort((a,b)=>b.score-a.score);
      const singles=single.slice(0,16);
      for(const s of singles)add(s.n,[s.m]);
      for(const s of singles.slice(0,8)){
        const seconds:typeof single=[];
        for(const out of s.n.ids){
          if(out===s.m.into)continue; // avoid selling immediately acquired player
          const old=map.get(out)??maps[0].get(out);
          if(!old)continue;
          for(const incoming of candidates.get(old.element.element_type)??[]){
            if(incoming.element.id===s.m.out)continue;
            const n=validMove(s.n,out,incoming);
            if(!n)continue;
            seconds.push({n,m:{out,into:incoming.element.id,outName:old.element.web_name,
              inName:incoming.element.web_name,costM:round1((priceT(incoming)-(s.n.ownedSellT.get(out)??priceT(old)))/10)},
              score:scoreWeek(n,k).points-scoreWeek(node,k).points-incrementalTransferHit(node.free,1)});
          }
        }
        seconds.sort((a,b)=>b.score-a.score);
        for(const second of seconds.slice(0,5))add(second.n,[s.m,second.m]);
      }
    }
    const unique=new Map<string,Node>();
    for(const n of next){
      const id=key(n);
      if(!unique.has(id)||unique.get(id)!.total<n.total-1e-8 ||
        (Math.abs(unique.get(id)!.total-n.total)<=1e-8&&churn(n)<churn(unique.get(id)!)))unique.set(id,n);
    }
    // Look ahead to avoid the trivial greedy path that sells assets with
    // attractive upcoming fixtures. This heuristic is not a guarantee.
    const potential=(n:Node) => weeks.slice(k+1).reduce((sum,_,idx)=>sum+scoreWeek(n,k+idx+1).points,0);
    beam=[...unique.values()]
      .sort((a,b)=>(b.total+potential(b)+b.free*.2)-(a.total+potential(a)+a.free*.2)||churn(a)-churn(b))
      .slice(0,width);
    if(!beam.length)return unavailable("O planeador não encontrou uma sequência legal.");
  }
  const best=beam.slice().sort((a,b)=>b.total-a.total||churn(a)-churn(b))[0];
  // Hypothetical forecast downside test for acquired assets, not calibrated
  // uncertainty or a reason to force a transfer. An asset is at risk only
  // while still present in the chosen path.
  const acquired=new Set<number>();
  let acquiredExposure=0;
  best.steps.forEach((step,k)=>{
    step.moves.forEach(m=>{ acquired.delete(m.out);acquired.add(m.into); });
    for(const id of acquired) acquiredExposure+=maps[k].get(id)?.expectedPointsNext??0;
  });
  const stressGainVsHold=round1(best.total-baselinePoints-acquiredExposure*.20);
  return {
    available:true,reason:null,horizon:weeks.length,
    baselinePoints,plannedPoints:round1(best.total),
    gainVsHold:round1(best.total-baselinePoints),stressGainVsHold,
    steps:best.steps,evaluated,beamWidth:width,method:"bounded-beam-search",
  };
}
