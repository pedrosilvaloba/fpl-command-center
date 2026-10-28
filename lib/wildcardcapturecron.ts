import {getBootstrap} from "./fpl-client";
import {getRedis} from "./kv";

/** Uses the already authenticated production cron to warm a hypothetical
 * same-input three-way Wildcard snapshot; no additional Vercel schedule. */
export async function runDailyWildcardCapture():Promise<{ok:boolean;status:string}>{
 if(process.env.VERCEL_ENV!=="production")return {ok:false,status:"production-only"};
 const redis=getRedis(),host=process.env.VERCEL_PROJECT_PRODUCTION_URL;
 if(!redis||!host||!/^[a-z0-9.-]+$/i.test(host))return {ok:false,status:"storage-or-host-missing"};
 try{
  const bootstrap=await getBootstrap(),now=Date.now();
  const next=bootstrap.events.filter(e=>Number.isFinite(Date.parse(e.deadline_time))&&Date.parse(e.deadline_time)>now)
   .sort((a,b)=>Date.parse(a.deadline_time)-Date.parse(b.deadline_time))[0];
  if(!next)return {ok:true,status:"no-upcoming-gw"};
  if(Date.parse(next.deadline_time)-now<3600000)return {ok:false,status:"deadline-too-close"};
  const key="fpl:wildcard-abc:snapshot:v1:"+next.id;
  if(await redis.get(key))return {ok:true,status:"already-frozen"};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  try{
   const response=await fetch("https://"+host+"/?view=simular&chip=wildcard&comparar=1",{
    signal:controller.signal,cache:"no-store",redirect:"error",
    headers:{"x-fpl-snapshot-trigger":"scheduled",
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":process.env.VERCEL_AUTOMATION_BYPASS_SECRET}:{})}});
   if(!response.ok)return {ok:false,status:"simulator-http-"+response.status};
  }finally{clearTimeout(timer)}
  return await redis.get(key)?{ok:true,status:"frozen"}:{ok:false,status:"capture-unavailable"};
 }catch{return {ok:false,status:"capture-failed"}}
}

/** Persist operational outcome separately from immutable match evidence. */
export async function runDailyWildcardCapture():Promise<{ok:boolean;status:string}>{
 const result=await attemptWildcardCapture();
 if(process.env.VERCEL_ENV==="production"){
   try{
     const redis=getRedis();
     if(redis)await redis.set("fpl:wildcard-abc:last-capture:v1",{
       at:new Date().toISOString(),ok:result.ok,status:result.status
     });
   }catch{/* Never hide the original capture outcome behind telemetry failure. */}
 }
 return result;
}
