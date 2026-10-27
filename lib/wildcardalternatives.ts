import type { ScoredPlayer } from "./recommend";
import type { SquadState } from "./squadstate";
import { planTransfers, type WildcardProfile } from "./transferplan";

export interface WildcardAlternative {
  criterion: "ppg" | "fpl";
  available: boolean;
  reason: string;
  ids: number[];
  xiIds: number[];
  xiNames: string[];
  captainId: number | null;
  budgetRemaining: number | null;
  modelXiNext: number | null;
  modelXiWindow: number | null;
}

export function optimizeWildcardBaselines(
  scored: ScoredPlayer[],
  state: SquadState,
  opts: Parameters<typeof planTransfers>[2],
  profile: WildcardProfile
): WildcardAlternative[] {
  const byId = new Map(scored.map(p => [p.element.id,p]));
  return (["ppg","fpl"] as const).map(criterion => {
    const valid = (p: ScoredPlayer) => {
      const raw = criterion === "ppg" ? p.element.points_per_game : p.element.ep_next;
      if (raw === null || raw === undefined || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const measured = scored.filter(p => valid(p)!==null).length;
    if (measured !== scored.length || scored.length === 0) {
      return { criterion,available:false,reason:"Cobertura de dados insuficiente para comparar sem valores inventados.",ids:[],xiIds:[],xiNames:[],captainId:null,budgetRemaining:null,modelXiNext:null,modelXiWindow:null };
    }
    const input = scored.map(p => {
      const value=valid(p) ?? 0;
      return {...p,expectedPointsNext:value,expectedPoints:value*5,score:value*5};
    });
    const advice = planTransfers(input,state,{
      ...opts,wildcardProfile:profile,defaultIncludeIds:[],
    });
    const scenario = advice.scenarios.find(s=>s.chip==="wildcard");
    const plan=scenario?.plan;
    if(!plan || plan.xi.length!==11 || plan.bench.length!==4) {
      return {criterion,available:false,reason:"Não foi possível construir uma equipa legal sob estas restrições.",ids:[],xiIds:[],xiNames:[],captainId:null,budgetRemaining:null,modelXiNext:null,modelXiWindow:null};
    }
    const xi=plan.xi.map(p=>p.element.id);
    const ids=[...xi,...plan.bench.map(p=>p.element.id)];
    if(new Set(ids).size!==15 || ids.some(id=>!byId.has(id))) {
      return {criterion,available:false,reason:"Equipa resultante inválida.",ids:[],xiIds:[],xiNames:[],captainId:null,budgetRemaining:null,modelXiNext:null,modelXiWindow:null};
    }
    return {
      criterion,available:true,reason:"Plantel otimizado pelo critério independente; pontuação apresentada usa sempre o nosso modelo como unidade comum.",
      ids,xiIds:xi,xiNames:xi.map(id=>byId.get(id)?.element.web_name??("#"+id)),captainId:plan.captain?.element.id??null,budgetRemaining:plan.bankAfterM,
      modelXiNext:Math.round(xi.reduce((sum,id)=>sum+(byId.get(id)?.expectedPointsNext??0),0)*10)/10,
      modelXiWindow:Math.round(xi.reduce((sum,id)=>sum+(byId.get(id)?.expectedPoints??0),0)*10)/10,
    };
  });
}
