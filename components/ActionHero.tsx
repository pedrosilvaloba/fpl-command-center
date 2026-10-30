import type {ReactNode} from "react";

export default function ActionHero({
  headline, captain, vice, freeTransfers, bank, gain, simHref, children,
}:{
  headline:string;captain:string;vice:string;freeTransfers:number|null;
  bank:number|null;gain:number|null;simHref:string;children?:ReactNode;
}){
  return <div className="action-hero">
    <div className="action-hero-eyebrow">O TEU PLANO</div>
    <h2 className="action-hero-headline">{headline}</h2>
    <div className="action-hero-quick">
      <div><span>CAPITÃO</span><strong>{captain}</strong></div>
      <div><span>VICE</span><strong>{vice}</strong></div>
      {freeTransfers!==null&&<div><span>TRANSFERÊNCIAS LIVRES</span><strong>{freeTransfers}</strong></div>}
      {gain!==null&&gain!==0&&<div><span>GANHO ESTIMADO</span><strong>{gain>0?"+":""}{gain.toFixed(1)} pts</strong></div>}
    </div>
    {children}
    <div className="action-hero-bottom">
      <a href="#onze" className="action-primary">Ver o meu onze <span aria-hidden>→</span></a>
      <a href={simHref} className="action-secondary">Explorar outra decisão</a>
    </div>
    {bank!==null&&<p className="action-hero-foot">Orçamento disponível: £{bank.toFixed(1)}m · Projeções, não pontos garantidos</p>}
  </div>
}
