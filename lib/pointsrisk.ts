import type { ExpectedPointsBreakdown, MinutesModel } from "./expectedpoints";

/**
 * A FORMA DA APOSTA, NÃO SÓ A SUA MÉDIA.
 *
 * ═══ O QUE FALTAVA ═══
 *
 * Cada jogador trazia um `ceilingGI` e um `floorGI` — percentis 85 e 15 dos
 * seus envolvimentos em golos. Eram calculados para os ~700 jogadores,
 * guardados no objeto, e lidos por NADA. Nenhuma decisão os usava. Sétima
 * ocorrência do mesmo padrão nesta base de código: a peça existe, funciona,
 * e não está ligada ao sítio onde decidiria.
 *
 * E não serviam para o efeito de qualquer maneira: estão em golos, não em
 * pontos, e são da janela de cinco jornadas, não da próxima. Para a
 * capitania — que é uma decisão de UMA jornada — nenhum dos dois serve.
 *
 * ═══ PORQUE É QUE A CAPITANIA PRECISA DISTO ═══
 *
 * A braçadeira dobra os pontos. Se o objetivo for maximizar pontos
 * esperados, dobrar é linear e o melhor capitão é simplesmente o de maior
 * média — que é o que o modelo fazia, e estava CERTO para esse objetivo.
 *
 * Só que o objetivo do Pedro não é esse. É subir 22 lugares numa liga de 48.
 * E dois jogadores com os mesmos 7,3 pontos esperados podem ser apostas
 * opostas: um avançado que marca penáltis, com semanas de 2 e semanas de 20;
 * e um defesa que acumula 2s e 3s quase todas as jornadas. Para quem
 * persegue, o primeiro vale muito mais. Para quem defende uma vantagem, o
 * segundo. O modelo não distinguia os dois.
 *
 * ═══ A DISTINÇÃO QUE É FÁCIL ERRAR, E QUE ESTRAGARIA TUDO ═══
 *
 * A tentação é escolher o capitão com maior desvio-padrão. Isso está errado,
 * e de uma forma perigosa: o maior contribuinte para a variância de um
 * jogador NÃO é o seu talento — é a dúvida sobre se ele joga. Um lesionado
 * em dúvida tem variância enorme (ou 8 pontos ou 0) e é o pior capitão
 * possível.
 *
 * São duas variâncias diferentes e só uma delas se procura:
 *
 *   · RISCO DE FALTA  — ele nem sequer entra. Variância pura, sem prémio.
 *     Um perseguidor NÃO a quer. Ninguém a quer.
 *   · AMPLITUDE       — dado que joga, o quão explosiva é a sua jornada.
 *     É isto, e só isto, que um perseguidor deve procurar.
 *
 * Por isso este módulo devolve as duas separadas, e a capitania só se
 * inclina sobre a segunda. Há um teste dedicado a garantir que um jogador
 * em dúvida nunca ganha atratividade como capitão por causa da dúvida.
 */

const GOAL_POINTS: Record<number, number> = { 1: 10, 2: 6, 3: 5, 4: 4 };
const CLEAN_SHEET_POINTS: Record<number, number> = { 1: 4, 2: 4, 3: 1, 4: 0 };
const ASSIST_POINTS = 3;

/** Abaixo desta probabilidade de aparecer, as contas condicionais deixam de
 * ser informativas — dividir por um número quase nulo amplifica ruído. */
const MIN_APPEAR_FOR_CONDITIONALS = 0.05;

/**
 * O bónus é 0, 1, 2 ou 3 e chega em blocos. Modelá-lo em detalhe exigiria a
 * distribuição do BPS de todo o jogo; o que interessa aqui é que ele
 * ACRESCENTA amplitude e não é desprezável. Tratado como uma variável de
 * escala 3 com média igual ao bónus esperado, o que dá Var ≈ 3·µ − µ².
 */
function bonusVariance(expectedBonus: number): number {
  const mu = Math.max(0, Math.min(3, expectedBonus));
  return Math.max(0, 3 * mu - mu * mu);
}

export interface PointsRisk {
  /** Média incondicional — igual ao `total` da decomposição. */
  mean: number;
  /** Média DADO QUE joga. Sempre >= mean. */
  meanIfPlays: number;
  /**
   * Desvio-padrão da jornada DADO QUE joga. É a "amplitude": o quão
   * explosivo ele é quando entra em campo. É esta que um perseguidor quer.
   */
  sdIfPlays: number;
  /**
   * Desvio-padrão total, incluindo a hipótese de não jogar. Serve para
   * mostrar o risco ao utilizador — NÃO para escolher capitão.
   */
  sdTotal: number;
  /**
   * Quanto da variância total vem só de ele poder não jogar, de 0 a 1.
   * Perto de 1 significa "a incerteza deste jogador é sobre se joga, não
   * sobre o que faz" — exatamente o tipo de variância que não se procura.
   */
  blankShare: number;
  /**
   * Uma jornada boa, dado que joga: média condicional mais um desvio.
   * É o número que responde a "ao que é que estou a apostar quando lhe dou
   * a braçadeira".
   */
  upside: number;
}

/**
 * Constrói o perfil de risco de UMA jornada a partir da decomposição de
 * pontos que o modelo já produz.
 *
 * O método: cada componente é uma contagem ou uma moeda com um valor em
 * pontos conhecido, portanto a sua variância sai da distribuição própria —
 * Poisson para golos e assistências (Var = λ), Bernoulli para a baliza a
 * zero (Var = p(1−p)). Depois a lei da variância total junta o caso de ele
 * não entrar sequer:
 *
 *     Var = q·v + q(1−q)·m²      com q = P(aparece), m = média se joga
 *
 * É exato para uma mistura em que o estado "não joga" vale zero. As
 * aproximações estão nos componentes, não na composição — e estão
 * assinaladas onde ocorrem.
 */
export function pointsRisk(
  elementType: number,
  breakdown: ExpectedPointsBreakdown,
  mins: MinutesModel
): PointsRisk {
  const mean = Number.isFinite(breakdown.total) ? breakdown.total : 0;
  const q = Math.min(1, Math.max(0, mins.pAppear));

  if (q < MIN_APPEAR_FOR_CONDITIONALS) {
    // Sem hipótese realista de jogar não há amplitude para medir: o
    // resultado é quase de certeza zero. Devolver números condicionais
    // aqui seria inventar precisão sobre um caso degenerado.
    return {
      mean,
      meanIfPlays: 0,
      sdIfPlays: 0,
      sdTotal: 0,
      blankShare: 0,
      upside: 0,
    };
  }

  // As decomposições são incondicionais (já contêm a hipótese de faltar).
  // Dividir por q devolve-as ao mundo em que ele joga.
  const cond = (x: number) => (Number.isFinite(x) ? x : 0) / q;

  const goalW = GOAL_POINTS[elementType] ?? 4;
  const csW = CLEAN_SHEET_POINTS[elementType] ?? 0;

  // λ de golos e assistências, reconstruídos a partir dos pontos esperados.
  const lambdaGoals = cond(breakdown.goals) / goalW;
  const lambdaAssists = cond(breakdown.assists) / ASSIST_POINTS;

  // Poisson: Var(contagem) = λ; em pontos, multiplica pelo valor ao quadrado.
  const varGoals = lambdaGoals * goalW * goalW;
  const varAssists = lambdaAssists * ASSIST_POINTS * ASSIST_POINTS;

  // Baliza a zero: uma moeda. p sai dos pontos esperados a dividir pelo
  // valor da baliza a zero para a posição.
  const pCs = csW > 0 ? Math.min(1, Math.max(0, cond(breakdown.cleanSheet) / csW)) : 0;
  const varCs = pCs * (1 - pCs) * csW * csW;

  const varBonus = bonusVariance(cond(breakdown.bonus));

  // Defesas/guarda-redes: golos sofridos e defesas também oscilam. Tratados
  // como Poisson sobre a sua própria média de pontos, que é grosseiro mas
  // do lado conservador — subestima a amplitude de um guarda-redes em vez
  // de a inflacionar.
  const varSaves = Math.abs(cond(breakdown.saves));
  const varConceded = Math.abs(cond(breakdown.concededPenalty));
  // A contribuição defensiva é tudo-ou-nada por jogo: 2 pontos ou zero.
  const pDc = Math.min(1, Math.max(0, cond(breakdown.defensiveContribution) / 2));
  const varDc = pDc * (1 - pDc) * 4;

  const varIfPlays =
    varGoals + varAssists + varCs + varBonus + varSaves + varConceded + varDc;

  const meanIfPlays = mean / q;
  const sdIfPlays = Math.sqrt(Math.max(0, varIfPlays));

  // Lei da variância total sobre "aparece / não aparece".
  const varTotal = q * varIfPlays + q * (1 - q) * meanIfPlays * meanIfPlays;
  const sdTotal = Math.sqrt(Math.max(0, varTotal));

  const blankVar = q * (1 - q) * meanIfPlays * meanIfPlays;
  const blankShare = varTotal > 0 ? blankVar / varTotal : 0;

  return {
    mean,
    meanIfPlays,
    sdIfPlays,
    sdTotal,
    blankShare,
    upside: meanIfPlays + sdIfPlays,
  };
}
