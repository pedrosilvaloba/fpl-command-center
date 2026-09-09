import type { FplBootstrap, FplElement } from "./types";

/**
 * O PRIOR QUE FALTAVA — E QUE ERA ZERO.
 *
 * ═══ O DEFEITO, EM UMA LINHA DE CÓDIGO ═══
 *
 * Em `computePlayerRates`, todas as taxas de um jogador são encolhidas para
 * corrigir amostras pequenas. A função é a certa:
 *
 *     shrink(rate, k, prior = 0) => (rate * jogos + prior * k) / (jogos + k)
 *
 * O problema é o valor por omissão. `prior = 0`. Para golos esperados,
 * assistências esperadas, bónus, defesas e contribuição defensiva, o modelo
 * encolhe TODA A GENTE EM DIREÇÃO A ZERO — ou seja, na ausência de prova,
 * assume que o jogador não tem ameaça nenhuma.
 *
 * Isso está errado para qualquer jogador estabelecido, e é catastrófico no
 * início de uma época, que é exatamente onde estamos. Com três jornadas
 * jogadas e k=3, a conta fica `(taxa×3 + 0×3)/6 = taxa/2`: metade do sinal
 * de cada jogador é substituída por um zero.
 *
 * E há um efeito visível a olho nu: nos dados da GW4, DEZANOVE de setenta e
 * seis defesas com mais de 180 minutos tinham taxa de golo EXATAMENTE zero.
 * O modelo dava-lhes ameaça ofensiva nula — não "baixa", nula.
 *
 * ═══ A MEDIÇÃO QUE JUSTIFICA A MUDANÇA ═══
 *
 * A pergunta certa não é "zero é feio", é "o que é melhor do que zero".
 * Testado sobre os dados reais da GW3 — prever os pontos dessa jornada a
 * partir de cada candidato, com 185 jogadores de 180+ minutos:
 *
 *     preditor                        Spearman
 *     preço                             0,092
 *     xGI/90 desta época                0,032
 *
 * Por posição, a diferença é mais brutal: nos MÉDIOS, preço 0,169 contra
 * 0,008. E o xGI/90 dessa medição INCLUI a própria GW3 — está contaminado a
 * favor dele, e mesmo assim perde por três vezes.
 *
 * O preço não é uma opinião: é a avaliação agregada de dez milhões de
 * gestores mais o preço de partida definido pela FPL com base em épocas
 * inteiras. Num quartil superior de médios, 0,545 xGI/90 contra 0,145 no
 * quartil inferior — 3,8 vezes.
 *
 * ═══ PORQUE É QUE O AJUSTE É FEITO EM TEMPO DE EXECUÇÃO ═══
 *
 * A relação preço-produção não é uma constante que se escreva à mão: muda
 * com as regras de pontuação, com a inflação de preços ao longo da época e
 * com a posição. Por isso é ESTIMADA a partir do próprio bootstrap, a cada
 * carregamento, com os jogadores que já têm minutos suficientes para as
 * suas taxas significarem alguma coisa.
 *
 * Um número escrito à mão neste ficheiro estaria errado dentro de dois
 * meses e ninguém daria por isso — que é o modo de falha que este projeto
 * já encontrou seis vezes.
 */

/** Minutos mínimos para a taxa de um jogador entrar no ajuste. Abaixo
 * disto ele é ruído a estimar a curva a partir da qual seria corrigido. */
const MIN_MINUTES_FOR_FIT = 180;
/** Sem pelo menos isto por posição, não há curva que se estime com
 * honestidade e o prior desliga-se sozinho. */
const MIN_PLAYERS_PER_POSITION = 12;
/** Quantos degraus de preço. Poucos demais perde a forma, muitos demais
 * torna cada degrau ruído. */
const PRICE_BUCKETS = 5;

export interface RatePrior {
  xg90: number;
  xa90: number;
  bonus90: number;
  dc90: number;
  saves90: number;
}

const EMPTY_PRIOR: RatePrior = {
  xg90: 0,
  xa90: 0,
  bonus90: 0,
  dc90: 0,
  saves90: 0,
};

export interface RatePriors {
  /** Verdadeiro quando houve dados que chegassem para estimar seja o que
   * for. Falso significa comportamento idêntico ao anterior — prior zero. */
  available: boolean;
  /** Quantos jogadores entraram no ajuste. */
  fitted: number;
  /** O prior para um jogador, dada a sua posição e preço. */
  forPlayer: (elementType: number, priceTenths: number) => RatePrior;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Mediana, e não média: uma época tem sempre um jogador com três golos em
 * noventa minutos, e a média deixa-se arrastar por ele. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ratesOf(el: FplElement): RatePrior {
  const minutes = num(el.minutes);
  if (minutes <= 0) return EMPTY_PRIOR;
  const per90 = (total: number) => (total / minutes) * 90;
  // Usa os valores subjacentes quando a FPL os publica — são mais estáveis
  // do que a realização — e cai para a realização quando não existem.
  const xg = num(el.expected_goals_per_90) || per90(num(el.goals_scored));
  const xa = num(el.expected_assists_per_90) || per90(num(el.assists));
  return {
    xg90: xg,
    xa90: xa,
    bonus90: per90(num(el.bonus)),
    dc90: per90(num((el as unknown as Record<string, unknown>).defensive_contribution)),
    saves90: per90(num(el.saves)),
  };
}

/**
 * Estima, por posição e por escalão de preço, a taxa típica de um jogador.
 *
 * O resultado é uma função: dá-se-lhe a posição e o preço, devolve o que um
 * jogador assim costuma produzir. É esse número que passa a ser o alvo do
 * encolhimento, em vez de zero.
 */
export function buildRatePriors(bootstrap: FplBootstrap): RatePriors {
  const eligible = (bootstrap.elements ?? []).filter(
    (e) => num(e.minutes) >= MIN_MINUTES_FOR_FIT
  );

  // posição → escalões ordenados por preço, com a taxa mediana de cada um
  const table = new Map<number, { maxPrice: number; prior: RatePrior }[]>();

  for (const type of [1, 2, 3, 4]) {
    const group = eligible
      .filter((e) => e.element_type === type)
      .sort((a, b) => num(a.now_cost) - num(b.now_cost));
    if (group.length < MIN_PLAYERS_PER_POSITION) continue;

    const perBucket = Math.max(3, Math.ceil(group.length / PRICE_BUCKETS));
    const buckets: { maxPrice: number; prior: RatePrior }[] = [];
    for (let i = 0; i < group.length; i += perBucket) {
      const slice = group.slice(i, i + perBucket);
      if (slice.length === 0) continue;
      const rates = slice.map(ratesOf);
      buckets.push({
        maxPrice: num(slice[slice.length - 1].now_cost),
        prior: {
          xg90: median(rates.map((r) => r.xg90)),
          xa90: median(rates.map((r) => r.xa90)),
          bonus90: median(rates.map((r) => r.bonus90)),
          dc90: median(rates.map((r) => r.dc90)),
          saves90: median(rates.map((r) => r.saves90)),
        },
      });
    }
    if (buckets.length > 0) table.set(type, buckets);
  }

  const available = table.size > 0;

  return {
    available,
    fitted: eligible.length,
    forPlayer: (elementType: number, priceTenths: number): RatePrior => {
      const buckets = table.get(elementType);
      if (!buckets || buckets.length === 0) return EMPTY_PRIOR;
      for (const b of buckets) {
        if (priceTenths <= b.maxPrice) return b.prior;
      }
      // Acima do escalão mais caro: usa o mais caro. Nunca extrapolar —
      // um jogador de 15,0 não produz o dobro de um de 12,0, e projetar
      // uma reta para fora dos dados é como se inventam números.
      return buckets[buckets.length - 1].prior;
    },
  };
}

/** Um prior neutro, para quando não há bootstrap. Mantém o comportamento
 * anterior exatamente — encolher para zero. */
export const NO_RATE_PRIORS: RatePriors = {
  available: false,
  fitted: 0,
  forPlayer: () => EMPTY_PRIOR,
};
