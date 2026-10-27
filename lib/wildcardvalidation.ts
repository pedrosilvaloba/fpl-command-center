import type { ScoredPlayer } from "./recommend";
import type { SquadState } from "./squadstate";

/** Independent verification of a hypothetical FPL 15, not the solver's own
 * 'feasible' assertion. Pricing uses purchase costs for newcomers and the
 * manager's actual selling value for incumbents. */
export function validateWildcardSquad(
 ids: number[], pool: ScoredPlayer[], state: SquadState,
): {valid:boolean; reason:string; totalCostM:number|null} {
 if (!state.available || !Number.isFinite(state.totalBudgetM) || state.totalBudgetM <= 0)
   return {valid:false,reason:"Orçamento real indisponível",totalCostM:null};
 if (ids.length !== 15 || new Set(ids).size !== 15)
   return {valid:false,reason:"O plantel não tem 15 jogadores diferentes",totalCostM:null};
 const byId = new Map(pool.map(p=>[p.element.id,p]));
 const owned = new Map(state.owned.map(o=>[o.elementId,o.sellingPriceM]));
 const positions=new Map<number,number>(),clubs=new Map<number,number>();
 let cost=0;
 for (const id of ids) {
   const p=byId.get(id);
   if (!p || !Number.isSafeInteger(id) || id<1) return {valid:false,reason:"Jogador desconhecido",totalCostM:null};
   const pos=p.element.element_type,club=p.element.team;
   if (![1,2,3,4].includes(pos) || !Number.isSafeInteger(club) || club<1)
     return {valid:false,reason:"Posição ou clube inválido",totalCostM:null};
   positions.set(pos,(positions.get(pos)??0)+1);
   clubs.set(club,(clubs.get(club)??0)+1);
   const price=owned.get(id)??p.priceM;
   if (!Number.isFinite(price) || price<=0) return {valid:false,reason:"Preço inválido",totalCostM:null};
   cost+=price;
 }
 if ([2,5,5,3].some((n,i)=>positions.get(i+1)!==n))
   return {valid:false,reason:"Composição por posições inválida",totalCostM:cost};
 if ([...clubs.values()].some(n=>n>3))
   return {valid:false,reason:"Mais de três jogadores do mesmo clube",totalCostM:cost};
 if (cost>state.totalBudgetM+0.0001)
   return {valid:false,reason:"Plantel excede o orçamento",totalCostM:cost};
 return {valid:true,reason:"Plantel legal e dentro do orçamento",totalCostM:cost};
}
