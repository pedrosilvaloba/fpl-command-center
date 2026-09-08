import { planTransfers } from "./transferplan";
import type { TransferAdvice, TransferPlan } from "./transferplan";
import type { ScoredPlayer } from "./recommend";
import type { SquadState } from "./squadstate";
import type { CalendarContext } from "./chipplan";

/**
 * ESPERAR ESTA SEMANA PARA FAZER DUAS MUDANÇAS NA PRÓXIMA.
 *
 * ═══ O QUE FALTAVA, E A FORMA COMO FALTAVA ═══
 *
 * O planeador respondia sempre à mesma pergunta: "dado ESTE plantel, ESTE
 * dinheiro e ESTAS transferências livres, qual é a melhor jogada AGORA?".
 * Nunca à pergunta que qualquer gestor experiente faz:
 *
 *     "E se não gastar nada esta semana, ficar com duas na próxima, e
 *      meter os dois jogadores que quero em vez de um?"
 *
 * Toda a representação que a app tinha dessa ideia era uma constante:
 * `FT_OPTION_VALUE = 1.5`, "uma transferência guardada vale 1,5 pontos".
 * Isso é um prior sobre o valor abstrato de ter opções. Não é um plano, não
 * nomeia ninguém, e não sabe distinguir uma semana em que guardar não serve
 * para nada de uma semana em que guardar desbloqueia exatamente a dupla que
 * o modelo quer.
 *
 * ═══ A ARITMÉTICA QUE TORNA ISTO REAL ═══
 *
 * Com 1 transferência livre, fazer duas mudanças custa −4. Com 2, custa
 * zero. Portanto adiar uma semana pode valer literalmente 4 pontos, e essa
 * é a parte fácil de ver.
 *
 * A parte que se paga por adiar é igualmente concreta e costuma ser
 * esquecida: perde-se UMA JORNADA inteira do benefício. Se a melhoria vale
 * 8 pontos-janela em 5 jornadas, adiá-la uma semana deixa 4 jornadas — quatro
 * quintos. E o jogador que se queria pode subir de preço, ou lesionar-se.
 *
 * A comparação honesta é portanto entre:
 *
 *     AGORA    o melhor plano de hoje, sobre a janela inteira
 *     ADIAR    o melhor plano da próxima semana, com uma transferência a
 *              mais, sobre uma janela mais curta, e sem nada esta semana
 *
 * ═══ O QUE ESTA ANÁLISE NÃO SABE, E DIZ ═══
 *
 * O plano adiado é avaliado com a INFORMAÇÃO DE HOJE. Na próxima semana
 * haverá notícias de equipa, lesões e uma jornada de dados a mais, e é
 * precisamente por isso que guardar tem valor extra — valor que esta
 * comparação NÃO consegue medir e que o `FT_OPTION_VALUE` continua a
 * representar. Ou seja: quando esta análise diz "adiar ganha", está a
 * subestimar o adiamento, não a inflacioná-lo. Erra do lado seguro.
 */

/** Quanto de uma janela de 5 jornadas se perde ao adiar uma semana. */
const DEFERRED_WINDOW_SHARE = 4 / 5;

/**
 * Quanto vale a informação extra de uma semana, em pontos-janela.
 *
 * Não é medido — é o mesmo prior que já governava `FT_OPTION_VALUE`, aqui
 * a fazer o que sempre devia ter feito: inclinar a comparação a favor de
 * esperar quando as duas alternativas estão empatadas, em vez de servir de
 * substituto para não haver comparação nenhuma.
 */
export const DEFERRED_INFORMATION_VALUE = 1.5;

export interface DeferredPlan {
  /** Vale a pena adiar? */
  worthWaiting: boolean;
  /** Transferências livres que terias na próxima jornada. */
  freeNextWeek: number;
  /** O melhor plano de hoje, se houver. */
  nowGain: number;
  nowMoves: string[];
  /** O melhor plano da próxima semana com uma transferência a mais, já
   * descontada a jornada perdida e somado o valor da informação futura. */
  deferredGain: number;
  /** O mesmo ganho ANTES desses dois ajustes. Exposto porque sem ele é
   * impossível verificar de fora que o desconto foi mesmo aplicado — e um
   * teste que recalcula o desconto a partir do resultado é uma tautologia
   * que passa com o desconto desligado. Foi o que aconteceu à primeira. */
  deferredGainRaw: number;
  deferredMoves: string[];
  /** Quantos hits o plano de hoje pagaria, e o adiado. */
  nowHits: number;
  deferredHits: number;
  /** Frase pronta para o ecrã. */
  headline: string;
  detail: string;
}

/**
 * A REGRA DE DECISÃO, extraída de propósito.
 *
 * Estava embutida numa função de sessenta linhas que precisa de um plantel,
 * um solver e um pool de jogadores para correr. Testá-la assim exigia
 * fabricar um cenário com um ganho positivo mas pequeno — e a grelha de
 * testes não consegue produzir um: com os limiares de retenção, uma troca
 * ou não acontece, ou vale muito. Resultado prático: uma mutação que punha
 * `worthWaiting` sempre a verdadeiro passava por todos os testes.
 *
 * Uma regra que decide alguma coisa tem de ser testável sozinha. Aqui é.
 *
 * DUAS CONDIÇÕES, e a segunda é a que interessa. Não basta o plano adiado
 * valer mais na conta: tem de fazer MAIS mudanças. Adiar para fazer
 * exatamente a mesma troca uma semana depois é perder uma jornada por nada
 * — e é o modo de falha mais silencioso que este planeador pode ter, uma
 * equipa que nunca melhora porque há sempre uma razão para esperar.
 */
export function shouldWaitForMore(input: {
  nowGain: number;
  deferredGain: number;
  nowMoves: number;
  deferredMoves: number;
}): boolean {
  return (
    input.deferredGain > input.nowGain && input.deferredMoves > input.nowMoves
  );
}

function movesOf(plan: TransferPlan | null): string[] {
  if (!plan) return [];
  return plan.moves.map(
    (m) => `${m.out.element.web_name} → ${m.in.element.web_name}`
  );
}

/**
 * Compara "mover agora" com "guardar e mover a dobrar na próxima".
 *
 * Corre o planeador uma segunda vez com mais uma transferência livre. É
 * deliberadamente o MESMO planeador: uma reimplementação aqui compararia
 * duas coisas diferentes e a comparação não valeria nada — foi assim que
 * este projeto já produziu um solver a otimizar uma quantidade e uma lista
 * ordenada por outra.
 */
export function planDeferral(
  scored: ScoredPlayer[],
  state: SquadState,
  today: TransferAdvice,
  opts: {
    beta?: number;
    likelyRisers?: number[];
    likelyFallers?: number[];
    currentEvent?: number;
    calendar?: CalendarContext;
  } = {}
): DeferredPlan | null {
  if (!today.available) return null;

  const freeNow = state.freeTransfers;
  // A FPL acumula até cinco. Com cinco já não há nada a ganhar em guardar
  // mais uma, e a pergunta deixa de fazer sentido.
  if (freeNow >= 5) return null;
  const freeNextWeek = Math.min(5, freeNow + 1);

  const nowPlan = today.recommended;
  const nowGainRaw = nowPlan ? nowPlan.netGainVsHold : 0;
  const nowHits = nowPlan ? Math.max(0, nowPlan.moves.length - freeNow) : 0;

  // O mesmo plantel, a mesma informação, mais uma transferência livre.
  const nextWeekState: SquadState = { ...state, freeTransfers: freeNextWeek };
  const deferred = planTransfers(scored, nextWeekState, {
    ...opts,
    currentEvent: (opts.currentEvent ?? 20) + 1,
  });
  const deferredPlan = deferred.recommended;
  if (!deferredPlan) return null;

  // SE NENHUM DOS LADOS MEXE ALGUÉM, NÃO HÁ PERGUNTA NENHUMA.
  //
  // Sem esta saída, o painel mostrava "guardar: +1,5 pts" quando o plano
  // de ambas as semanas era não fazer nada — o 1,5 é o valor da informação
  // futura, e sozinho não é um plano, é uma constante a passear. Anunciar
  // um ganho por não fazer nada nas duas semanas seria exatamente o género
  // de número tranquilizador e vazio que esta app tem andado a eliminar.
  if (deferredPlan.moves.length === 0 && (nowPlan?.moves.length ?? 0) === 0) {
    return null;
  }

  const deferredHits = Math.max(0, deferredPlan.moves.length - freeNextWeek);
  // O ganho adiado sofre o desconto de uma jornada perdida, e ganha o valor
  // da informação que ainda não existe.
  const deferredGain =
    deferredPlan.netGainVsHold * DEFERRED_WINDOW_SHARE +
    DEFERRED_INFORMATION_VALUE;

  const worthWaiting = shouldWaitForMore({
    nowGain: nowGainRaw,
    deferredGain,
    nowMoves: nowPlan?.moves.length ?? 0,
    deferredMoves: deferredPlan.moves.length,
  });

  const nowMoves = movesOf(nowPlan);
  const deferredMoves = movesOf(deferredPlan);

  const headline = worthWaiting
    ? `Guardar a transferência: com ${freeNextWeek} na próxima jornada entram ${deferredMoves.length} jogadores sem hit`
    : nowPlan
      ? "Mover agora vale mais do que esperar por uma jornada dupla de transferências"
      : "Sem plano de hoje nem de adiamento que valha a pena";

  const detail = worthWaiting
    ? `Hoje o melhor plano é ${nowMoves.length > 0 ? nowMoves.join(", ") : "não mexer"}${nowHits > 0 ? ` (com ${nowHits} hit)` : ""}, e vale ${nowGainRaw.toFixed(1)} pts. ` +
      `Se guardares, na próxima jornada ficas com ${freeNextWeek} transferências livres e o modelo faria ${deferredMoves.join(", ")}${deferredHits > 0 ? ` (ainda assim com ${deferredHits} hit)` : " sem hit nenhum"}, ` +
      `o que vale ${deferredGain.toFixed(1)} pts já descontada a jornada que se perde por esperar. ` +
      `A diferença é ${(deferredGain - nowGainRaw).toFixed(1)} pts a favor de esperar — e está subestimada, porque na próxima semana saberás mais do que sabes hoje.`
    : nowPlan && nowMoves.length > 0
      ? `Guardar daria ${freeNextWeek} transferências e o plano seria ${deferredMoves.join(", ")}, a valer ${deferredGain.toFixed(1)} pts contra ${nowGainRaw.toFixed(1)} de mover já. Esperar não compensa a jornada que se perde.`
      : "O modelo não encontra hoje nenhuma mudança que valha a pena, nem uma dupla que justifique guardar para a próxima.";

  return {
    worthWaiting,
    freeNextWeek,
    nowGain: Math.round(nowGainRaw * 10) / 10,
    nowMoves,
    deferredGain: Math.round(deferredGain * 10) / 10,
    deferredMoves,
    deferredGainRaw: Math.round(deferredPlan.netGainVsHold * 10) / 10,
    nowHits,
    deferredHits,
    headline,
    detail,
  };
}
