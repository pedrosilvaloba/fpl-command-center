/** Comparing complete legal Wildcard XI decisions on a common five-GW scale.
 * Captaincy provides a second copy of the captain's points. This is not
 * a player-name override and cannot justify an illegal or unaffordable team. */
export function wildcardCaptainAwareValue(
  xi: readonly {expectedPoints:number}[],
  bench: readonly {expectedPoints:number}[],
  captain: {expectedPoints:number}|null|undefined
): number {
  if(xi.length!==11||bench.length!==4||!captain) return Number.NEGATIVE_INFINITY;
  const values=[...xi,...bench,captain].map(p=>p.expectedPoints);
  if(values.some(p=>!Number.isFinite(p)||p<0)) return Number.NEGATIVE_INFINITY;
  return xi.reduce((sum,p)=>sum+p.expectedPoints,0)+
    captain.expectedPoints+
    bench.reduce((sum,p)=>sum+p.expectedPoints,0)*0.15;
}
