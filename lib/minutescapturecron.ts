import { getBootstrap } from "./fpl-client";
import { getRedis } from "./kv";
import { validProspectiveMinutesSnapshot,readRecentMinutes,refreshRecentMinutes } from "./recentminutes";

/** Best-effort daily automated warm-up of the same full scoring analysis.
 * On Hobby, reuse an existing cron rather than creating a third scheduled job.
 * The response is not treated as success unless the immutable archive exists.
 */
export async function runDailyMinutesCapture():Promise<{ok:boolean;status:string}>{
  // Preview deployments can share Redis credentials with production.
  // Never allow a preview/manual diagnostic to create immutable official evidence.
  if(process.env.VERCEL_ENV!=="production")
    return {ok:false,status:"production-only"};
  const redis=getRedis();
  const domain=process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if(!redis||!domain||!/^[a-z0-9.-]+$/i.test(domain))
    return {ok:false,status:"missing-storage-or-production-host"};
  try{
    const bootstrap=await getBootstrap();
    const now=Date.now();
    const next=bootstrap.events.filter(e=>Number.isFinite(Date.parse(e.deadline_time))&&Date.parse(e.deadline_time)>now)
      .sort((a,b)=>Date.parse(a.deadline_time)-Date.parse(b.deadline_time))[0];
    if(!next)return {ok:true,status:"no-upcoming-event"};
    // A late daily snapshot is not a useful basis for predeadline action.
    if(Date.parse(next.deadline_time)-now<60*60_000)
      return {ok:false,status:"deadline-too-close"};
    if(await redis.get("fpl:minutes-decisions:snapshot:v1:"+next.id))
      return {ok:true,status:"already-frozen"};
    let recent=await readRecentMinutes();
    // Daily capture must not rely on a human opening another page to warm
    // the historical minute archive. Refresh only when the prospective
    // snapshot is missing/invalid, then validate it again before use.
    if(!validProspectiveMinutesSnapshot(recent,next.id,next.deadline_time)){
      const refreshed=await refreshRecentMinutes(bootstrap);
      if(!refreshed.ok)return {ok:false,status:"recent-minutes-refresh-failed"};
      recent=await readRecentMinutes();
    }
    if(!validProspectiveMinutesSnapshot(recent,next.id,next.deadline_time))
      return {ok:false,status:"missing-prospective-history"};
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),35_000);
    try{
      const response=await fetch("https://"+domain+"/?view=analisar",{
        signal:controller.signal,cache:"no-store",redirect:"error",
        headers:{"x-fpl-snapshot-trigger":"scheduled"}
      });
      if(!response.ok)return {ok:false,status:"analysis-page-"+response.status};
    }finally{clearTimeout(timeout);}
    const saved=await redis.get("fpl:minutes-decisions:snapshot:v1:"+next.id);
    return saved?{ok:true,status:"frozen"}:{ok:false,status:"analysis-did-not-freeze"};
  }catch{return {ok:false,status:"capture-failed"};}
}
