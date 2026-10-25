export interface LocalDecision {
  event:number;teamId:number;at:string;
  action:"followed"|"different"|"no-action";
  note:string;
  captain:string|null;
  transfers:string[];
  source:"self-reported-local";
}
export interface JournalFile {
  format:"fpl-command-center-journal-v1";
  teamId:number;
  exportedAt:string;
  entries:LocalDecision[];
}
export function isDecision(value:unknown,teamId:number):value is LocalDecision{
  if(!value || typeof value!=="object")return false;
  const r=value as Partial<LocalDecision>;
  return typeof r.event==="number"&&Number.isInteger(r.event)&&r.event>=1&&r.event<=38 &&
    r.teamId===teamId &&
    r.source==="self-reported-local" &&
    ["followed","different","no-action"].includes(r.action??"") &&
    typeof r.at==="string" && Number.isFinite(Date.parse(r.at)) &&
    typeof r.note==="string" && r.note.length<=250 &&
    (r.captain===null||typeof r.captain==="string"&&r.captain.length<=120) &&
    Array.isArray(r.transfers) && r.transfers.length<=15 &&
    r.transfers.every(t=>typeof t==="string"&&t.length<=120);
}
export function buildJournal(teamId:number,items:unknown[]):JournalFile{
  const byEvent=new Map<number,LocalDecision>();
  for(const i of items)if(isDecision(i,teamId))byEvent.set(i.event,i);
  return{
    format:"fpl-command-center-journal-v1",teamId,
    exportedAt:new Date().toISOString(),
    entries:[...byEvent.values()].sort((a,b)=>a.event-b.event),
  };
}
export function parseJournal(json:string,teamId:number):JournalFile{
  if(json.length>80_000)throw new Error("Ficheiro demasiado grande.");
  const item=JSON.parse(json) as Partial<JournalFile>;
  if(item.format!=="fpl-command-center-journal-v1"||item.teamId!==teamId||
    !Array.isArray(item.entries)||item.entries.length>38)
    throw new Error("Ficheiro inválido ou pertencente a outra equipa.");
  if(!item.entries.every(e=>isDecision(e,teamId)))
    throw new Error("Existem registos malformados no ficheiro.");
  return buildJournal(teamId,item.entries);
}
