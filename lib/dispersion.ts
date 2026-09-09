import type { ScoredPlayer } from "./recommend";
import type { Regression } from "./evidence";

/**
 * O MODELO ESPALHA AS PREVISÕES AO DOBRO DO QUE A REALIDADE JUSTIFICA.
 *
 * ═══ O QUE FOI MEDIDO, E COM QUE DADOS ═══
 *
 * Isto não sai de um raciocínio: sai do backtest desta app, que reconstrói
 * o mundo tal como estava no fecho de cada jornada, corre o PIPELINE REAL
 * contra essa reconstrução e compara com o que aconteceu. Nada nele vê o
 * futuro. Corrido sobre as GW2 e GW3:
 *
 *     previsto 0-2  →  real 2,40   (n=124)
 *     previsto 2-3  →  real 4,35   (n=71)
 *     previsto 3-4  →  real 3,70   (n=20)
 *     previsto 4-5  →  real 3,70   (n=23)
 *     previsto 5-6  →  real 4,22   (n=23)
 *     previsto 6-8  →  real 4,50   (n=24)
 *     previsto 8+   →  real 4,64   (n=14)
 *
 * A coluna da esquerda varia de 1 a 9. A da direita varia de 2,4 a 4,6. O
 * modelo separa os jogadores num intervalo de oito pontos; a realidade
 * separa-os em dois.
 *
 * A medida disto é a inclinação da regressão do real sobre o previsto:
 *
 *     incondicional (inclui quem não jogou, com zero)   0,454 ± 0,055
 *     condicional   (só quem jogou)                     0,298 ± 0,076
 *     só titulares indiscutíveis                        0,075   (r² 0,002)
 *
 * Um modelo calibrado tem inclinação 1. A primeira está a DEZ erros padrão
 * de 1. E a terceira é a mais dura de todas: entre jogadores praticamente
 * garantidos de jogar — n=197 — a ordenação do modelo explica dois
 * milésimos da variação. Zero, dentro do ruído.
 *
 * ═══ O DIAGNÓSTICO QUE ISTO PERMITE ═══
 *
 * O mesmo backtest dá `decileLift` 2,24: o décimo superior das previsões
 * marcou mais do dobro da média. O modelo DISCRIMINA. Mas cruzando com a
 * regressão dos titulares indiscutíveis, vê-se de onde vem essa
 * discriminação: de acertar QUEM JOGA. Entre os que jogam de certeza, a
 * ordenação não carrega quase informação nenhuma — e mesmo assim o modelo
 * espalha esses jogadores de 1 a 9 pontos.
 *
 * ═══ PORQUE É QUE ISTO IMPORTA MESMO SENDO ORDEM-NEUTRO ═══
 *
 * Comprimir todas as previsões não muda a ORDEM de ninguém, e portanto não
 * muda quem o modelo gosta. Muda outra coisa, que é onde este projeto perde
 * pontos de verdade: TODAS as decisões que comparam um ganho PREVISTO com
 * um custo EXATO.
 *
 *   - O hit de -4 é um número real, sem incerteza nenhuma. O ganho previsto
 *     de uma transferência estava a ser lido com o dobro da largura. Um
 *     ganho anunciado de 4,5 pontos que na verdade vale 2,2 faz o
 *     planeador pagar quatro pontos por dois.
 *   - Os limiares dos chips comparam o ganho de uma jornada excecional com
 *     o valor de esperar. Se a cauda de cima do modelo está inflacionada,
 *     as duas pontas da comparação mentem, e não na mesma medida.
 *   - O banco: a diferença entre o 11.º e o 12.º melhor também vinha
 *     inflacionada.
 *
 * ═══ E PORQUE É QUE A CAMADA DE CALIBRAÇÃO QUE JÁ EXISTIA NÃO CHEGA ═══
 *
 * `lib/strategylearning.ts` já corrige previsões — mas com UM MULTIPLICADOR
 * POR POSIÇÃO, estimado sobre os quinze jogadores do plantel do Pedro.
 * Multiplicar todos os médios por 0,8 baixa o NÍVEL da posição; não toca na
 * LARGURA. O defeito medido acima é de largura: em cima prevê 9 e sai 4,6,
 * em baixo prevê 1 e sai 2,4. Nenhum multiplicador único faz as duas
 * coisas ao mesmo tempo — para arrumar o topo teria de piorar a base.
 *
 * São correções ortogonais e as duas ficam. Esta trata da largura.
 */

/**
 * O alvo da compressão não é a média geral — é o que um jogador com AQUELES
 * minutos costuma valer naquela posição.
 *
 * A distinção é o coração desta correção. A prova diz que a discriminação
 * do modelo vive nos MINUTOS e não nos pontos por aparição. Comprimir para
 * a média geral puxaria um lesado de 0 pontos para cima, contra a única
 * parte do modelo que a medição diz estar a funcionar. Comprimir para
 * `minutos × média da posição por jogo completo` deixa o eixo dos minutos
 * intacto e aperta só o eixo onde a prova diz que quase tudo é ruído.
 */
export interface PositionalBaseline {
  /** Pontos que um jogador médio desta posição faz num jogo completo. */
  pointsPerFullMatch: number;
  /** Quantos jogadores entraram na média. */
  n: number;
}

export interface DispersionEvidence {
  /** Inclinação do real sobre o previsto, agregada sobre todas as jornadas. */
  regression: Regression;
  /** A mesma inclinação medida jornada a jornada, quando existe. */
  perEventSlopes: number[];
}

export interface DispersionCorrection {
  /** O fator finalmente aplicado à LARGURA. 1 = nada muda. */
  factor: number;
  /** Quanto peso a medição levou, de 0 a 1. */
  weight: number;
  /** A inclinação medida, antes de qualquer encolhimento. */
  measuredSlope: number | null;
  /** O erro padrão que foi efetivamente usado. */
  stdError: number | null;
  /** Erro padrão entre jornadas, quando há jornadas que cheguem. */
  clusterStdError: number | null;
  events: number;
  n: number;
  /** Frase pronta para o ecrã, sempre preenchida. */
  explanation: string;
}

export const NO_DISPERSION_CORRECTION: DispersionCorrection = {
  factor: 1,
  weight: 0,
  measuredSlope: null,
  stdError: null,
  clusterStdError: null,
  events: 0,
  n: 0,
  explanation:
    "Ainda não há backtest guardado, por isso a largura das previsões fica como o modelo a produz.",
};

/**
 * Quão longe de 1 é plausível que a inclinação esteja, ANTES de medir.
 *
 * Este é o único número desta correção que não sai de uma medição, e é
 * dito às claras. Um modelo construído sobre as regras de pontuação reais
 * do jogo devia estar aproximadamente calibrado; um desvio de 20% para
 * cada lado é o que me parece plausível à partida. Quanto mais firme for a
 * medição, menos este número pesa — com erro padrão pequeno o prior é
 * esmagado pelos dados, que é exatamente o que se quer dele.
 */
export const PRIOR_SLOPE_SPREAD = 0.2;

/**
 * A partir de quantas jornadas a medição vale por inteiro.
 *
 * Não é um limiar arbitrário: abaixo de três jornadas não existe estimativa
 * possível da variação ENTRE jornadas, e a partir de seis a inflação que a
 * distribuição t impõe a essa estimativa já desceu para ~1,3. Entre uma
 * coisa e outra, a medição é real mas o seu erro padrão ao nível da linha
 * subestima — e esta rampa é o reconhecimento honesto disso.
 *
 * É uma decisão de engenharia e não uma dedução. Fica escrita aqui para
 * poder ser discutida em vez de descoberta.
 */
export const FULL_EVIDENCE_EVENTS = 6;

/** Abaixo disto não se estima variação entre jornadas — com duas jornadas
 * há um grau de liberdade e a estimativa não tem significado. */
export const MIN_EVENTS_FOR_CLUSTER_SE = 3;

/** Nunca comprimir para além de metade. Um modelo que precisasse disso
 * estaria errado de uma maneira que um fator não arruma. */
export const MIN_DISPERSION_FACTOR = 0.5;

/**
 * Erro padrão da inclinação estimado ENTRE jornadas.
 *
 * O erro padrão ao nível da linha trata 440 observações como 440 provas
 * independentes. Não são: dentro de uma jornada todos os jogadores
 * partilham o mesmo calendário, o mesmo fim de semana, os mesmos árbitros.
 * A pergunta honesta é quanto é que a inclinação varia DE JORNADA PARA
 * JORNADA, e a resposta é o desvio padrão dessas inclinações a dividir pela
 * raiz do número delas.
 */
export function clusterStdError(perEventSlopes: number[]): number | null {
  const k = perEventSlopes.length;
  if (k < MIN_EVENTS_FOR_CLUSTER_SE) return null;
  const mean = perEventSlopes.reduce((s, v) => s + v, 0) / k;
  const varSum = perEventSlopes.reduce((s, v) => s + (v - mean) ** 2, 0);
  const sd = Math.sqrt(varSum / (k - 1));
  return sd / Math.sqrt(k);
}

/**
 * Do que foi medido para o que se aplica.
 *
 * A inclinação medida NÃO é aplicada tal e qual. É encolhida para 1 em
 * proporção à sua própria incerteza — uma inclinação de 0,45 com erro
 * padrão de 0,3 quase não mexe; a mesma com erro padrão de 0,03 mexe quase
 * toda. Não há limiar, não há degrau: há uma medição a ganhar peso à medida
 * que se torna firme.
 *
 * É a diferença entre esta correção e o `suggestedShrinkage` que já existia
 * em `lib/evidence.ts` e que nunca chegou a ser aplicada a nada: aquele
 * devolve `null` até a prova ser firme, e `null` na prática significa
 * "assume inclinação 1" — que é a hipótese que a medição rejeita com mais
 * força do que qualquer alternativa. Não corrigir não é neutro.
 */
export function computeDispersionCorrection(
  evidence: DispersionEvidence | null,
  events: number
): DispersionCorrection {
  if (!evidence || evidence.regression.n < 3 || !(evidence.regression.slopeStdError > 0)) {
    return { ...NO_DISPERSION_CORRECTION, events };
  }

  const { slope, slopeStdError, n } = evidence.regression;
  const cluster = clusterStdError(evidence.perEventSlopes);
  // O maior dos dois, sempre. Se as jornadas discordam entre si mais do que
  // as linhas sugerem, é a discordância entre jornadas que manda.
  const se = cluster !== null ? Math.max(slopeStdError, cluster) : slopeStdError;

  const tau2 = PRIOR_SLOPE_SPREAD ** 2;
  const statWeight = tau2 / (tau2 + se * se);
  const eventsWeight = Math.min(1, events / FULL_EVIDENCE_EVENTS);
  const weight = statWeight * eventsWeight;

  // Nunca ALARGAR. Uma inclinação medida acima de 1 sobre poucas jornadas é
  // um convite a amplificar o erro do modelo, e nada do que foi medido até
  // hoje aponta nessa direção. A correção só aperta.
  const raw = 1 + (slope - 1) * weight;
  const factor = Math.min(1, Math.max(MIN_DISPERSION_FACTOR, raw));

  const pct = Math.round((1 - factor) * 100);
  const explanation =
    factor >= 0.999
      ? `Inclinação medida ${slope.toFixed(2)} (±${se.toFixed(2)}) sobre ${events} jornada${events === 1 ? "" : "s"}, mas a prova ainda não pesa o suficiente para mexer na largura das previsões.`
      : `A regressão do real sobre o previsto dá inclinação ${slope.toFixed(2)} (±${se.toFixed(2)}) em ${n} observações de ${events} jornada${events === 1 ? "" : "s"}: o modelo espalha as previsões mais do que a realidade. As diferenças entre jogadores foram comprimidas ${pct}% — a ordem não muda, o que muda é quanto vale a pena PAGAR por uma diferença.`;

  return {
    factor: Math.round(factor * 1000) / 1000,
    weight: Math.round(weight * 1000) / 1000,
    measuredSlope: Math.round(slope * 1000) / 1000,
    stdError: Math.round(se * 1000) / 1000,
    clusterStdError: cluster === null ? null : Math.round(cluster * 1000) / 1000,
    events,
    n,
    explanation,
  };
}

/** A fração de um jogo completo que se espera deste jogador, já descontada
 * a disponibilidade. É o eixo que NÃO é comprimido. */
function matchShare(p: ScoredPlayer): number {
  const mins =
    typeof p.expectedMinutesNext === "number"
      ? p.expectedMinutesNext
      : // Sem o campo (chamadores antigos, objetos de teste), a
        // probabilidade de aparecer é a melhor aproximação disponível, e
        // um valor em falta significa "joga" — que é o que esses
        // chamadores já assumiam.
        (typeof p.pPlay === "number" ? p.pPlay : 1) * 90;
  return Math.min(1, Math.max(0, mins / 90));
}

/**
 * A média da posição, medida em pontos por jogo completo.
 *
 * Somar previsões e dividir por jogadores daria um número contaminado pelos
 * suplentes: uma posição cheia de jogadores com 20 minutos esperados tem
 * média baixa por causa dos minutos, não da qualidade. Dividir a soma das
 * previsões pela soma das FRAÇÕES DE JOGO devolve a quantidade certa.
 */
export function positionalBaselines(
  scored: ScoredPlayer[]
): Map<string, PositionalBaseline> {
  const acc = new Map<string, { points: number; share: number; n: number }>();
  for (const p of scored) {
    const share = matchShare(p);
    if (share <= 0) continue;
    const cur = acc.get(p.positionShort) ?? { points: 0, share: 0, n: 0 };
    cur.points += p.expectedPointsNext;
    cur.share += share;
    cur.n += 1;
    acc.set(p.positionShort, cur);
  }
  const out = new Map<string, PositionalBaseline>();
  for (const [pos, v] of acc) {
    if (v.share <= 0) continue;
    out.set(pos, { pointsPerFullMatch: v.points / v.share, n: v.n });
  }
  return out;
}

export interface DispersionApplication {
  /** O plantel já com a largura corrigida. Quando nada mudou, é o mesmo
   * array que entrou. */
  applied: ScoredPlayer[];
  correction: DispersionCorrection;
  /** Quantos jogadores mudaram de número. */
  adjusted: number;
  /** A maior redução aplicada, em pontos, para dar escala ao que aconteceu. */
  largestCut: number;
  baselines: Map<string, PositionalBaseline>;
}

/**
 * Aplica a compressão. Devolve um array novo; o de entrada não é mutado.
 *
 * A janela de cinco jornadas segue a MESMA proporção da próxima, e não uma
 * compressão própria. Se as duas fossem comprimidas em separado, a razão
 * entre elas mudava — e é essa razão que o planeador de transferências lê
 * para decidir entre gastar agora e guardar. Corrigir uma métrica ao ponto
 * de estragar a relação com outra é como se trocam defeitos por defeitos.
 */
export function applyDispersionCorrection(
  scored: ScoredPlayer[],
  correction: DispersionCorrection
): DispersionApplication {
  const baselines = positionalBaselines(scored);
  if (correction.factor >= 0.999 || baselines.size === 0) {
    return { applied: scored, correction, adjusted: 0, largestCut: 0, baselines };
  }

  const f = correction.factor;
  let adjusted = 0;
  let largestCut = 0;

  const out = scored.map((p) => {
    const base = baselines.get(p.positionShort);
    if (!base) return p;
    const target = matchShare(p) * base.pointsPerFullMatch;
    const nextRaw = target + f * (p.expectedPointsNext - target);
    // Nunca negativo: comprimir não pode inventar uma previsão impossível.
    const next = Math.max(0, Math.round(nextRaw * 100) / 100);
    if (Math.abs(next - p.expectedPointsNext) < 0.01) return p;

    const ratio = p.expectedPointsNext > 0 ? next / p.expectedPointsNext : 1;
    const window = Math.round(p.expectedPoints * ratio * 100) / 100;
    adjusted += 1;
    largestCut = Math.max(largestCut, p.expectedPointsNext - next);

    return {
      ...p,
      expectedPointsNext: next,
      expectedPoints: window,
      score: window,
      reasons: [
        ...p.reasons,
        `largura calibrada: a diferença face a um ${p.positionShort} médio com estes minutos foi comprimida para ${Math.round(f * 100)}% — o backtest mostra que o modelo separa os jogadores mais do que a realidade`,
      ],
    };
  });

  return {
    applied: out,
    correction,
    adjusted,
    largestCut: Math.round(largestCut * 100) / 100,
    baselines,
  };
}
