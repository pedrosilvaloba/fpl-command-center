/**
 * QUANTO VALE GUARDAR UM CHIP — a peça que faltava, e que estava errada de
 * uma forma que nenhum ajuste de números resolveria.
 *
 * ═══ O DEFEITO ═══
 *
 * O planeador de chips comparava o valor de hoje com uma CONSTANTE: 16
 * pontos para o Triple Captain, 22 para o Bench Boost — "o que o chip vale
 * numa jornada dupla típica". E exigia ainda uma margem de 15% por cima.
 *
 * Isso dá um limiar de 18,4 pontos esperados de um capitão numa única
 * jornada. O melhor capitão do FPL anda pelos 7-9. A condição não era
 * exigente: era INALCANÇÁVEL. O mesmo para o Bench Boost — 25,3 pontos de
 * quatro suplentes, quando um banco bom vale 8-12.
 *
 * Consequência: os dois chips estavam presos em "esperar" para sempre, e o
 * ecrã dizia "guarda-o para uma dupla" todas as semanas, incluindo a última
 * semana em que era possível usá-lo. O modelo nunca ponderou jogá-los. Não
 * é que ponderasse e recusasse — não conseguia dizer que sim.
 *
 * ═══ E O SEGUNDO DEFEITO, PIOR ═══
 *
 * Em 2026/27 há DOIS conjuntos de chips e o primeiro EXPIRA na GW19. A app
 * sabe disto — está escrito no ecrã de regras, em lib/strategy.ts. O
 * planeador nunca o leu: os seus limiares mudavam na GW20 e na GW30, um
 * raciocínio de época única de 38 jornadas.
 *
 * Jornadas duplas na primeira metade da época são raríssimas — nascem de
 * adiamentos, que são remarcados na segunda metade. Ou seja, o modelo
 * mandava guardar o Triple Captain à espera de uma dupla que quase de
 * certeza não chega antes de o chip desaparecer. Isso não é prudência, é
 * uma perda garantida.
 *
 * ═══ A FORMULAÇÃO CORRETA ═══
 *
 * Guardar um chip é um problema de PARAGEM ÓTIMA, e tem uma resposta exata.
 * Em cada jornada vê-se o que o chip vale essa semana e decide-se sem saber
 * o que virá. Se `V(n)` é o valor de continuar com `n` oportunidades ainda
 * por ver:
 *
 *     V(0) = 0                          (não há mais semanas: o chip perde-se)
 *     V(n) = E[ max(X, V(n-1)) ]        (jogar esta semana, ou continuar)
 *
 * e joga-se agora quando `valorAgora ≥ V(n)`.
 *
 * Repare-se que V(n) NÃO é "o máximo esperado de n semanas". É menos, e a
 * diferença é o preço de ter de decidir às cegas, antes de ver as semanas
 * seguintes. Confundir os dois é o erro clássico aqui, e teria reposto o
 * problema com outra roupagem: o máximo de 15 amostras é sempre maior do
 * que qualquer amostra individual, portanto "esperar" ganharia sempre.
 *
 * Com X normal, o passo da recursão é exato — é a fórmula da opção de
 * compra: E[max(X, v)] = v + σ·φ(z) + (μ − v)·Φ(z), com z = (μ − v)/σ.
 *
 * DUAS PROPRIEDADES QUE FAZEM ISTO FUNCIONAR, e que os testes trancam:
 *
 *   1. V(n) DECRESCE até zero à medida que as jornadas acabam. Na última
 *      semana possível o limiar é zero e o chip joga-se se valer o que quer
 *      que seja — que é a decisão certa, porque a alternativa é perdê-lo.
 *   2. V(n) é ALCANÇÁVEL. Existe sempre um valor de "agora" que o bate.
 *      Há um teste dedicado só a isto, porque foi exatamente esta
 *      propriedade que faltou à versão anterior.
 */

/** Densidade da normal padrão. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Distribuição acumulada da normal padrão, via erf de Abramowitz & Stegun
 * (7.1.26). Erro máximo ~1.5e-7, muito abaixo do que qualquer decisão aqui
 * distingue. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Um passo da recursão: E[max(X, v)] com X ~ N(mean, sd).
 *
 * É a fórmula da opção de compra sobre uma normal. Com `sd` igual a zero
 * degenera corretamente em max(mean, v) — sem incerteza não há valor de
 * espera nenhum.
 */
export function expectedMaxAgainst(
  mean: number,
  sd: number,
  v: number
): number {
  if (!(sd > 0)) return Math.max(mean, v);
  const z = (mean - v) / sd;
  return v + sd * normalPdf(z) + (mean - v) * normalCdf(z);
}

/**
 * O valor de continuar com `draws` oportunidades ainda por ver.
 *
 * `draws` é o número de jornadas FUTURAS em que o chip ainda poderia ser
 * jogado — não inclui a jornada que se está a decidir agora. Com zero, o
 * valor é zero: é a última hipótese, e não jogar é deitar o chip fora.
 */
export function continuationValue(
  mean: number,
  sd: number,
  draws: number
): number {
  const n = Math.max(0, Math.floor(draws));
  let v = 0;
  for (let i = 0; i < n; i += 1) v = expectedMaxAgainst(mean, sd, v);
  return v;
}

/** Onde o PRIMEIRO conjunto de chips expira em 2026/27. Depois desta
 * jornada, um chip do primeiro conjunto por usar vale exatamente zero. */
export const FIRST_SET_LAST_EVENT = 19;
/** E o segundo conjunto morre com a época. */
export const SEASON_LAST_EVENT = 38;

/**
 * A última jornada em que este chip ainda pode ser jogado.
 *
 * Isto é a peça que o planeador não tinha, e sem a qual todo o resto do
 * raciocínio sobre "esperar" é feito sobre um horizonte imaginário.
 */
export function chipDeadlineEvent(currentEvent: number): number {
  return currentEvent <= FIRST_SET_LAST_EVENT
    ? FIRST_SET_LAST_EVENT
    : SEASON_LAST_EVENT;
}

/**
 * Probabilidade de aparecer uma jornada dupla aproveitável antes do prazo.
 *
 * NÃO é simétrica entre as duas metades, e essa assimetria é o ponto. As
 * duplas nascem de jogos adiados — por taças, por competições europeias, por
 * mau tempo — e esses adiamentos são remarcados na segunda metade da época.
 * Na primeira metade praticamente não há duplas, e é por isso que esperar
 * por uma até à GW19 é entregar o chip.
 *
 * Os valores são priores declarados, não medições: `modelparams.ts`
 * expõe-os para poderem ser calibrados quando houver épocas suficientes
 * para o fazer com honestidade.
 */
export const DOUBLE_PRIOR_FIRST_HALF = 0.12;
export const DOUBLE_PRIOR_SECOND_HALF = 0.9;
/** Quantas jornadas restantes chegam para a probabilidade acima saturar. */
export const DOUBLE_WINDOW_EVENTS = 8;

export function doubleProbability(
  currentEvent: number,
  drawsLeft: number,
  knownDoubleAhead: boolean
): number {
  // Uma dupla já marcada no calendário não é uma probabilidade — é um facto.
  if (knownDoubleAhead) return 1;
  const half =
    currentEvent <= FIRST_SET_LAST_EVENT
      ? DOUBLE_PRIOR_FIRST_HALF
      : DOUBLE_PRIOR_SECOND_HALF;
  const reach = Math.min(1, Math.max(0, drawsLeft) / DOUBLE_WINDOW_EVENTS);
  return half * reach;
}

export interface ChipOptionInput {
  /** O que o chip vale se for jogado nesta jornada. */
  valueNow: number;
  /** Média do que valeria numa jornada futura típica. Normalmente igual ao
   * valor de hoje: sem informação em contrário, esta semana é uma amostra
   * como as outras. */
  futureMean: number;
  /** Quanto esse valor oscila de jornada para jornada, em pontos. */
  futureSd: number;
  /** Quantas jornadas futuras restam antes de o chip expirar. */
  drawsLeft: number;
  /** O que o chip vale numa jornada dupla. */
  doubleValue: number;
  /** Probabilidade de haver uma dupla aproveitável antes do prazo. */
  pDouble: number;
}

export interface ChipOption {
  /** O limiar que "agora" tem de bater. */
  holdValue: number;
  /** A parte do limiar que vem de semanas normais futuras. */
  fromSingles: number;
  /** E a parte que vem da hipótese de uma jornada dupla. */
  fromDouble: number;
  /** Verdadeiro quando não há mais nenhuma jornada: usar ou perder. */
  lastChance: boolean;
}

/**
 * O limiar completo: o melhor entre esperar por semanas normais e esperar
 * por uma dupla, pesado pela probabilidade de a dupla existir.
 */
export function chipOptionValue(input: ChipOptionInput): ChipOption {
  const draws = Math.max(0, Math.floor(input.drawsLeft));
  const fromSingles = continuationValue(
    input.futureMean,
    input.futureSd,
    draws
  );
  const p = Math.min(1, Math.max(0, input.pDouble));
  // Sem jornadas por vir, nem a dupla é possível: o prazo apanha as duas.
  const fromDouble = draws > 0 ? p * input.doubleValue : 0;
  const holdValue = draws > 0 ? (1 - p) * fromSingles + fromDouble : 0;
  return {
    holdValue,
    fromSingles,
    fromDouble,
    lastChance: draws === 0,
  };
}
