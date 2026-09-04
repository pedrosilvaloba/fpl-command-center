/**
 * QUANTO É QUE UMA MEDIÇÃO PERMITE CONCLUIR.
 *
 * ═══ PORQUE É QUE ISTO EXISTE ═══
 *
 * O backtest correu e devolveu isto:
 *
 *     modelo    MAE 2,97   Spearman 0,430
 *     base      MAE 3,28   Spearman 0,412
 *
 * A leitura natural — a que eu próprio ia fazendo — é "o modelo bate a
 * base". A leitura correta é que com n = 101 e UMA jornada, o erro padrão
 * de um Spearman anda por 0,10. Uma diferença de 0,018 entre duas medidas
 * com essa incerteza não é um resultado: é ruído com duas casas decimais.
 *
 * Um número sem margem de erro convida a ser lido como facto. Todos os
 * números deste backtest estavam a ser apresentados assim, e a decisão que
 * dependia deles — "vale a pena continuar a complicar o modelo?" — estava a
 * ser tomada sobre uma diferença indistinguível de zero.
 *
 * ═══ E A SEGUNDA COISA, QUE É PIOR ═══
 *
 * A tabela de calibração do mesmo backtest:
 *
 *     previsto 0-2  →  real 2,33     (n=43)
 *     previsto 2-3  →  real 5,70     (n=23)
 *     previsto 8+   →  real 4,55     (n=11)
 *
 * As previsões mais altas saíram-se PIOR do que as do meio. Isto não é
 * "ligeiramente descalibrado" — é o modelo a espalhar as suas previsões
 * muito para além do que a realidade justifica, e a errar mais precisamente
 * onde as decisões são tomadas: capitão, transferências para dentro,
 * diferenciais. Todos saem do balde de cima.
 *
 * A medida disto é a INCLINAÇÃO da regressão do real sobre o previsto. Se
 * for 1, uma previsão de 8 corresponde de facto a 8. Se for 0,5, o modelo
 * está a espalhar as previsões o dobro do que devia, e a correção é
 * encolhê-las para a média. É uma medição, não uma opinião, e mede-se com
 * três somas.
 *
 * NADA AQUI CORRIGE O MODELO. Isto mede-o, e diz quando é que a medição já
 * chega para justificar mexer nele. É deliberado: encolher previsões com
 * base numa jornada seria substituir uma intuição minha por outra, com um
 * verniz de estatística por cima.
 */

export interface Regression {
  /** Inclinação do real sobre o previsto. 1 = calibrado. */
  slope: number;
  intercept: number;
  /** Erro padrão da inclinação — sem ele, a inclinação não se lê. */
  slopeStdError: number;
  /** Fração da variação do real que o previsto explica. */
  r2: number;
  n: number;
}

/**
 * Regressão de mínimos quadrados de `actual` sobre `predicted`.
 *
 * A inclinação é o número que interessa. Um modelo bem calibrado tem
 * inclinação 1: em média, quem é previsto com 8 pontos marca 8. Uma
 * inclinação de 0,4 diz que a diferença entre uma previsão de 2 e uma de 8
 * corresponde, na realidade, a menos de metade dessa distância.
 */
export function regressActualOnPredicted(
  pairs: { predicted: number; actual: number }[]
): Regression {
  const n = pairs.length;
  const empty: Regression = {
    slope: 0,
    intercept: 0,
    slopeStdError: 0,
    r2: 0,
    n: 0,
  };
  if (n < 3) return empty;

  let sx = 0;
  let sy = 0;
  for (const p of pairs) {
    sx += p.predicted;
    sy += p.actual;
  }
  const mx = sx / n;
  const my = sy / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pairs) {
    const dx = p.predicted - mx;
    const dy = p.actual - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Sem variação nas previsões não há inclinação para estimar. Acontece
  // quando o modelo prevê o mesmo para toda a gente, que é uma patologia
  // real e não uma divisão por zero a evitar em silêncio.
  if (sxx <= 0) return { ...empty, n };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  // Soma dos quadrados dos resíduos, e daí o erro padrão da inclinação.
  let sse = 0;
  for (const p of pairs) {
    const fitted = intercept + slope * p.predicted;
    sse += (p.actual - fitted) ** 2;
  }
  const dof = n - 2;
  const slopeStdError = dof > 0 ? Math.sqrt(sse / dof / sxx) : 0;
  const r2 = syy > 0 ? Math.max(0, 1 - sse / syy) : 0;

  return { slope, intercept, slopeStdError, r2, n };
}

/**
 * Erro padrão aproximado de um coeficiente de Spearman.
 *
 * 1/√(n−3) é a aproximação de Fisher. Para n = 101 dá 0,10 — o que quer
 * dizer que dois Spearman medidos na mesma amostra só se distinguem a
 * partir de cerca de 0,28 de diferença. O backtest tinha uma diferença de
 * 0,018.
 */
export function spearmanStdError(n: number): number {
  return n > 3 ? 1 / Math.sqrt(n - 3) : 0;
}

export type EvidenceVerdict =
  | "insuficiente"
  | "inconclusivo"
  | "bate a base"
  | "pior que a base";

export interface EvidenceCall {
  verdict: EvidenceVerdict;
  /** Frase em português a explicar o veredicto. */
  explanation: string;
  /** Diferença medida entre o Spearman do modelo e o da base. */
  spearmanGap: number;
  /** Diferença que seria precisa para o resultado ser distinguível de zero. */
  spearmanGapNeeded: number;
  /** Quantas jornadas foram medidas. */
  events: number;
}

/** Abaixo disto, uma jornada não chega para nada — nem sequer para o
 * modelo ter dados com que trabalhar. */
export const MIN_EVENTS_FOR_A_VERDICT = 4;
/** E abaixo disto a amostra é pequena de mais para o erro padrão fazer
 * sentido. */
export const MIN_ROWS_FOR_A_VERDICT = 200;

/**
 * Traduz uma medição num veredicto que se pode ler sem ser estatístico —
 * incluindo o veredicto mais importante e o que mais falta costuma fazer:
 * "ainda não dá para saber".
 */
export function callTheEvidence(input: {
  n: number;
  events: number;
  spearman: number;
  baselineSpearman: number;
}): EvidenceCall {
  const gap = input.spearman - input.baselineSpearman;
  // Diferença entre duas medidas na MESMA amostra: o erro padrão da
  // diferença é ~√2 vezes o de cada uma, e exige-se ~2 desses para a
  // diferença deixar de ser compatível com zero.
  const needed = 2 * Math.SQRT2 * spearmanStdError(input.n);

  if (input.events < MIN_EVENTS_FOR_A_VERDICT || input.n < MIN_ROWS_FOR_A_VERDICT) {
    return {
      verdict: "insuficiente",
      explanation:
        `${input.events} jornada${input.events === 1 ? "" : "s"} e ${input.n} observações não chegam para julgar o modelo. ` +
        `São precisas pelo menos ${MIN_EVENTS_FOR_A_VERDICT} jornadas e ${MIN_ROWS_FOR_A_VERDICT} observações. ` +
        "Os números abaixo são reais, mas ainda não distinguem um modelo bom de um mau.",
      spearmanGap: gap,
      spearmanGapNeeded: needed,
      events: input.events,
    };
  }
  if (Math.abs(gap) < needed) {
    return {
      verdict: "inconclusivo",
      explanation:
        `O modelo ordena os jogadores ${gap >= 0 ? "melhor" : "pior"} do que a base por ${Math.abs(gap).toFixed(3)}, ` +
        `mas com esta amostra seria preciso ${needed.toFixed(3)} para a diferença não ser compatível com o acaso. ` +
        "Ou seja: não se distingue de zero.",
      spearmanGap: gap,
      spearmanGapNeeded: needed,
      events: input.events,
    };
  }
  return {
    verdict: gap > 0 ? "bate a base" : "pior que a base",
    explanation:
      `O modelo ordena os jogadores ${gap > 0 ? "melhor" : "PIOR"} do que a base simples por ${Math.abs(gap).toFixed(3)}, ` +
      `acima do limiar de ${needed.toFixed(3)} que esta amostra exige. O resultado é real.`,
    spearmanGap: gap,
    spearmanGapNeeded: needed,
    events: input.events,
  };
}

/**
 * O fator de encolhimento que a calibração medida sugere.
 *
 * Devolve null enquanto a medição não for firme, e isso é o principal
 * serviço que presta. Uma inclinação de 0,33 medida numa jornada convida a
 * multiplicar todas as previsões por 0,33 — o que seria trocar uma
 * intuição por um número igualmente inventado, só que com ar de ciência.
 *
 * Só devolve um valor quando a inclinação está a mais de dois erros padrão
 * de 1, ou seja, quando a descalibração é ela própria mensurável.
 */
export function suggestedShrinkage(
  reg: Regression,
  events: number
): number | null {
  if (events < MIN_EVENTS_FOR_A_VERDICT) return null;
  if (reg.n < MIN_ROWS_FOR_A_VERDICT) return null;
  if (!(reg.slopeStdError > 0)) return null;
  if (Math.abs(1 - reg.slope) < 2 * reg.slopeStdError) return null;
  // Encolher para além de metade, ou expandir, sai do que esta correção
  // pretende ser. Um modelo que precisasse disso estaria errado de uma
  // forma que um fator multiplicativo não arruma.
  return Math.min(1, Math.max(0.5, reg.slope));
}
