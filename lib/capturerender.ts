/** A streamed page can send HTTP 200 before its evidence is persisted. */
export async function finishCaptureRender(response:Response):Promise<void>{
 const reader=response.body?.getReader();
 if(!reader)return;
 try { while(!(await reader.read()).done){ /* drain without retaining HTML */ } }
 finally { reader.releaseLock(); }
}
