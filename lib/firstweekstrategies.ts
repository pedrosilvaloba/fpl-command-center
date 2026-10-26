import { planMultipleGameweeks, type PeriodForecast, type MultiPeriodReport } from "./multiperiod";
import type { SquadState } from "./squadstate";

export type FirstWeekStrategy = "hold"|"free"|"hit";
export interface FirstWeekAlternative {
  strategy:FirstWeekStrategy;
  feasible:boolean;
  totalNetPoints:number|null;
  gainVsHold:number|null;
  firstWeekTransfers:number|null;
  firstWeekHitCost:number|null;
  freeAfterFirstWeek:number|null;
  steps:MultiPeriodReport["steps"];
}
export interface FirstWeekComparison {
  horizon:number;
  scenarios:FirstWeekAlternative[];
  preferred:FirstWeekStrategy|null;
  note:string;
}
/** Search the same forecasts and beam width under three mutually exclusive
 * first-week constraints. Other weeks use the ordinary full search.
 * This is a forecast sensitivity tool, NOT proven superiority or a globally
 * optimal result. */
export function compareFirstWeekStrategies(
  state:SquadState,forecasts:PeriodForecast[],opts:{beamWidth?:number;horizon?:number}={}
):FirstWeekComparison{
  const scenarios=(["hold","free","hit"] as const).map(strategy=>{
    const r=planMultipleGameweeks(state,forecasts,{...opts,firstWeekMoves:strategy});
    const first=r.steps[0];
    return {strategy,feasible:r.available,totalNetPoints:r.available?r.plannedPoints:null,
      gainVsHold:r.available?r.gainVsHold:null,
      firstWeekTransfers:first?first.moves.length:null,
      firstWeekHitCost:first?first.hitCost:null,
      freeAfterFirstWeek:first?first.freeAfter:null,steps:r.available?r.steps:[]};
  });
  const feasible=scenarios.filter(s=>s.feasible);
  const ranked=feasible.slice().sort((a,b)=>
    b.totalNetPoints!-a.totalNetPoints! ||
    a.steps.reduce((n,s)=>n+s.moves.length,0)-b.steps.reduce((n,s)=>n+s.moves.length,0) ||
    (a.strategy==="hold"?-1:b.strategy==="hold"?1:0));
  return {horizon:forecasts.slice(0,Math.min(8,opts.horizon??forecasts.length)).length,
    scenarios,preferred:ranked[0]?.strategy??null,
    note:"Comparação hipotética: três percursos de pesquisa limitada, mesmas previsões e janela. Custos de hits já descontados; transferências futuras e preços não garantidos."};
}
