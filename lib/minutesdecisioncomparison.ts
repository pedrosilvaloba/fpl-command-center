import {pickBestXIChecked,pickCaptain,type ScoredPlayer} from "./recommend";

/** Compare exactly the same owned 15 against two COMPLETE scored forecasts.
 * No transfer, bank, chip, league-posture or ownership adjustments: only
 * experimental minutes differ. Never assert observed point superiority.
 */
export interface FrozenMinutesDecision {
  valid:boolean;
  xi:number[];
  captain:number|null;
  vice:number|null;
  expectedXI:number;
}
export interface MinutesDecisionComparison {
  baseline:FrozenMinutesDecision;
  challenger:FrozenMinutesDecision;
  changes:{out:number[];in:number[]};
  captainChanged:boolean;
  viceChanged:boolean;
  comparable:boolean;
  reason:string;
}
function decision(players:ScoredPlayer[]):FrozenMinutesDecision {
  const {xi,valid}=pickBestXIChecked(players);
  if(!valid||xi.length!==11)return {valid:false,xi:[],captain:null,vice:null,expectedXI:0};
  const {captain,viceCaptain}=pickCaptain(xi);
  return {valid:!!captain&&!!viceCaptain,xi:xi.map(p=>p.element.id),
    captain:captain?.element.id??null,vice:viceCaptain?.element.id??null,
    expectedXI:xi.reduce((sum,p)=>sum+p.expectedPointsNext,0)};
}
export function compareMinutesDecisions(
  baseline:ScoredPlayer[],challenger:ScoredPlayer[],ownedIds:number[],
):MinutesDecisionComparison {
  const ids=new Set(ownedIds);
  const eligible=ids.size===15 && ownedIds.every(id=>Number.isSafeInteger(id)&&id>0);
  const base=baseline.filter(p=>ids.has(p.element.id));
  const experimental=challenger.filter(p=>ids.has(p.element.id));
  const complete=(players:ScoredPlayer[])=>players.length===15 &&
    new Set(players.map(p=>p.element.id)).size===15 &&
    players.every(p=>Number.isFinite(p.expectedPointsNext)&&p.expectedPointsNext>=0);
  const safe=eligible&&complete(base)&&complete(experimental)&&
    base.every(p=>experimental.some(q=>q.element.id===p.element.id&&q.element.element_type===p.element.element_type));
  const b=safe?decision(base):decision([]);
  const c=safe?decision(experimental):decision([]);
  const comparable=safe&&b.valid&&c.valid;
  const prior=new Set(b.xi),next=new Set(c.xi);
  const out=comparable?b.xi.filter(id=>!next.has(id)):[];
  const incoming=comparable?c.xi.filter(id=>!prior.has(id)):[];
  return {baseline:b,challenger:c,changes:{out,in:incoming},
    captainChanged:comparable&&b.captain!==c.captain,
    viceChanged:comparable&&b.vice!==c.vice,
    comparable,reason:comparable?"same-squad-full-scoring":"incomplete-or-invalid-squad"};
}
