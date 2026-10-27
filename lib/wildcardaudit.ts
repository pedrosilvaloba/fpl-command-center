import type { ScenarioPlayerView } from "./chipscenarioview";

export interface IndependentCheck {
  comparable: boolean;
  coverage: number;
  modelCaptain: number | null;
  ppgCaptain: number | null;
  officialCaptain: number | null;
  modelVsPpgDisagree: boolean;
  modelVsOfficialDisagree: boolean | null;
  reason: string;
}
const valid = (v: number | null) => v !== null && Number.isFinite(v) && v >= 0;
function best(xs: ScenarioPlayerView[], score: (p:ScenarioPlayerView)=>number | null) {
  const eligible=xs.filter(p=>valid(score(p)));
  eligible.sort((a,b)=>(score(b) ?? 0)-(score(a) ?? 0) || a.id-b.id);
  return eligible[0]?.id ?? null;
}
/** Comparing CAPTAINS inside the same legal XI. We never substitute a
 * different 15-player squad or mislabel these metrics as actual outcomes. */
export function auditWildcardXI(xi: ScenarioPlayerView[], selectedCaptain: number|null): IndependentCheck {
  if(xi.length!==11 || new Set(xi.map(p=>p.id)).size!==11 || xi.some(p=>!Number.isSafeInteger(p.id)||p.id<=0)) {
    return {comparable:false,coverage:0,modelCaptain:selectedCaptain,ppgCaptain:null,officialCaptain:null,modelVsPpgDisagree:false,modelVsOfficialDisagree:null,reason:"Onze incompleto ou inválido"};
  }
  const officialPlayers=xi.filter(p=>valid(p.officialNext));
  const modelCaptain=selectedCaptain!==null && xi.some(p=>p.id===selectedCaptain)?selectedCaptain:null;
  const ppgCaptain=best(xi,p=>p.ppg);
  const officialCaptain=officialPlayers.length===xi.length?best(xi,p=>p.officialNext):null;
  return {
    comparable:modelCaptain!==null && ppgCaptain!==null,
    coverage:officialPlayers.length,
    modelCaptain,ppgCaptain,officialCaptain,
    modelVsPpgDisagree:modelCaptain!==null && ppgCaptain!==null && modelCaptain!==ppgCaptain,
    modelVsOfficialDisagree:officialCaptain===null||modelCaptain===null?null:modelCaptain!==officialCaptain,
    reason:officialPlayers.length<11
      ? "A FPL não publicou projeções completas para este onze; a comparação oficial fica indisponível."
      : "São três critérios para escolher capitão no mesmo onze, não três plantéis nem uma medição de precisão.",
  };
}
