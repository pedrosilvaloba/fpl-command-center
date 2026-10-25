import { createHash } from "node:crypto";
import { getRedis } from "./kv";
import { planMultipleGameweeks, type PeriodForecast, type MultiPeriodReport } from "./multiperiod";
import type { SquadState } from "./squadstate";

/**
 * Cache is keyed by the actual decision input, not only GW or team ID.
 * A changed price, injury-adjusted forecast, team or free transfer count
 * invalidates the result. All inputs are public FPL data; no auth secrets.
 */
export function multiPeriodCacheKey(
  state:SquadState, forecasts:PeriodForecast[], horizon:number, beamWidth:number
):string{
  const h=createHash("sha256");
  h.update("multi:v3:"+horizon+":"+beamWidth+";rev:"+(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,12)??"local")+";");
  h.update("bank:"+state.bankM+";ft:"+state.freeTransfers+";");
  state.owned.slice().sort((a,b)=>a.elementId-b.elementId).forEach(o=>
    h.update([o.elementId,o.sellingPriceM].join(":")+";")
  );
  for(const w of forecasts){
    h.update("gw:"+w.event+";");
    for(const p of w.players.slice().sort((a,b)=>a.element.id-b.element.id)){
      h.update([p.element.id,p.team.id,p.element.element_type,p.priceM,
        p.element.status,p.expectedPointsNext].join(":")+";");
    }
  }
  return "fpl:multi:cache:v2:"+h.digest("hex");
}
export async function cachedMultiPeriod(
  state:SquadState,
  forecasts:PeriodForecast[],
  opts:{horizon:number;beamWidth:number}
):Promise<MultiPeriodReport>{
  const redis=getRedis();
  const cacheKey=multiPeriodCacheKey(state,forecasts,opts.horizon,opts.beamWidth);
  if(redis){
    try{
      const old=await redis.get<MultiPeriodReport>(cacheKey);
      if(old?.method==="bounded-beam-search")return old;
    }catch{/* No cache should stop a valid decision calculation. */}
  }
  const start=performance.now();
  const plan=planMultipleGameweeks(state,forecasts,opts);
  const durationMs=Math.round(performance.now()-start);
  if(durationMs>2500)console.warn("fpl:slow-sequential-planner",{durationMs,horizon:opts.horizon,evaluated:plan.evaluated});
  if(redis&&plan.available){
    try{
      await redis.set(cacheKey,plan,{ex:120});
    }catch{/* Best effort and short TTL for price and injury sensitivity. */}
  }
  return plan;
}
