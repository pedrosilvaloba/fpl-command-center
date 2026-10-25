export interface AdviserContext {
  event: number;
  teamName: string;
  recommendation: string;
  recommendedMoveNames: string[];
  gainVsHold: number;
  requiredEdge: number;
  captain: string | null;
  captainEp: number | null;
  wildcardAvailable: boolean;
  wildcardAdvised: boolean;
  wildcardGain: number | null;
  wildcardRequired: number | null;
  waiting: string | null;
  horizon: number;
  multiGain: number | null;
  multiMoves: { event:number; description:string }[];
  riskPlayers: string[];
}
export interface AdviserReply {
  subject:string;
  answer:string;
  evidence:string;
  next:string;
}
export const ADVISER_QUESTIONS = [
  "Porque devo guardar a transferência?",
  "E se eu utilizar o Wildcard?",
  "Porquê este capitão?",
  "Que transferências planeias para as próximas jornadas?",
  "Quais são os maiores riscos de minutos?",
];
/** Read-only, deterministic explanations over the exact scenario state.
 * No model/API key, no personal-data transmission, no invented news.
 * Natural language is a selector for known evidence, NOT a general LLM. */
export function answerAdviser(input:string,ctx:AdviserContext):AdviserReply{
  const t=input.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
  if(/wild|chip|free.?hit|bench boost|triplo capitao/.test(t)){
    const available=ctx.wildcardAvailable;
    return {
      subject:"Alternativa Wildcard",
      answer:!available?"Não tens Wildcard disponível nesta janela.":
        ctx.wildcardAdvised?"O motor sinaliza Wildcard, mas a decisão exige rever o orçamento e as notícias antes do deadline.":
        "O motor aconselha guardá-lo, mas podes comparar os três perfis e fixar jogadores antes de escolher.",
      evidence:ctx.wildcardGain===null?"Ainda não há vantagem comparável calculada.":
        "Ganho estimado em 5 jornadas: "+ctx.wildcardGain.toFixed(1)+
        " pontos; limiar heurístico para o gastar: "+
        (ctx.wildcardRequired?.toFixed(1)??"desconhecido")+
        ". Isto não é uma probabilidade calibrada de sucesso.",
      next:"Usa Simular → Wildcard (Equilibrado / Atacar já / Continuidade) para ver planteis, custos e diferenças.",
    };
  }
  if(/capitao|bracadeira|captain|vice/.test(t)){
    return {
      subject:"Capitania",
      answer:ctx.captain?"A opção proposta para esta jornada é "+ctx.captain+".":
        "Não existe candidato elegível confirmado neste contexto.",
      evidence:ctx.captainEp===null?"Sem projeção válida de pontos.":
        "Pontos esperados: "+ctx.captainEp.toFixed(1)+" antes do multiplicador. Minutos, adversário e vice-capitão importam; a posse da elite da jornada anterior não decide a próxima.",
      next:"Confirma as notícias e utiliza a lista de candidatos no ecrã Hoje antes do deadline.",
    };
  }
  if(/minut|les|rodar|titular|risk|rotac|disponib/.test(t)){
    return {
      subject:"Risco de utilização",
      answer:ctx.riskPlayers.length?
        "Jogadores com incerteza de participação identificados no plantel: "+ctx.riskPlayers.slice(0,6).join(", ")+
        ".":"Não detetei jogadores do plantel com probabilidade de participação abaixo do limiar de alerta.",
      evidence:"O modo de minutos recentes é experimental e utiliza dados de jornadas concluídas, sem afirmar que conhece o próximo onze.",
      next:"Seleciona Simular → Minutos recentes para ver um cenário alternativo; não confundas com notícias oficiais de escalação.",
    };
  }
  if(/prox|jornad|futur|plan|semana|medio prazo|horizonte/.test(t)){
    const descriptions=ctx.multiMoves.slice(0,5).map(x=>"GW"+x.event+": "+x.description).join("; ");
    return {
      subject:"Plano sequencial",
      answer:ctx.multiGain===null?"Ainda não foi calculado um plano multiperíodo para este ecrã.":
        "Em "+ctx.horizon+" jornadas, a sequência encontrada prevê "+
        (ctx.multiGain>=0?"+":"")+ctx.multiGain.toFixed(1)+" pontos face a não transferir.",
      evidence:descriptions||"Nenhuma troca nos cenários disponíveis. As transferências livres e o banco acumulam entre jornadas.",
      next:"Consulta Simular → Plano 3/5/8 GW e reavalia semanalmente. A pesquisa é limitada e não garante o ótimo global.",
    };
  }
  if(/transfer|guardar|troca|vender|comprar|hit|decisao|fazer/.test(t)){
    return {
      subject:"Decisão principal",
      answer:ctx.recommendation,
      evidence:"Diferença estimada face a manter: "+ctx.gainVsHold.toFixed(1)+
        " pontos em cinco jornadas. Limiar de prudência: "+ctx.requiredEdge.toFixed(1)+
        " pontos. Alterações consideradas: "+
        (ctx.recommendedMoveNames.join("; ")||"nenhuma")+".",
      next:ctx.waiting??"No Simular podes reduzir a projeção dos reforços e verificar se a vantagem resiste.",
    };
  }
  return {
    subject:"Questão fora das intenções suportadas",
    answer:"Este assistente responde apenas sobre decisões calculadas pela aplicação: transferências, Wildcard, capitania, riscos e calendário.",
    evidence:"Não utilizo um LLM nesta versão: uma resposta fluente não deve inventar factos da Fantasy.",
    next:"Experimenta uma das perguntas sugeridas ou usa o laboratório para recalcular alternativas.",
  };
}
