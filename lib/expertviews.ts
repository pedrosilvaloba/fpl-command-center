import type { ScoredPlayer } from "./recommend";
import type { TimedInsight } from "./insightlife";

/**
 * O QUE OS ESPECIALISTAS DIZEM, E SE ISSO ACRESCENTA ALGUMA COISA.
 *
 * ═══ A ARMADILHA, ANTES DA FUNCIONALIDADE ═══
 *
 * "Ir buscar as opiniões dos especialistas de FPL" parece obviamente bom e
 * tem uma forma de correr muito mal: a opinião dos especialistas JÁ ESTÁ
 * QUASE TODA DENTRO DO MODELO. A percentagem de posse é o consenso agregado
 * de dez milhões de pessoas que leem esses mesmos especialistas. O preço
 * move-se com esse consenso. O `ep_next` da própria FPL é uma previsão que
 * já reflete forma e calendário.
 *
 * Portanto, importar "os especialistas gostam do Salah" e transformá-lo num
 * multiplicador não acrescenta informação: acrescenta a MESMA informação uma
 * segunda vez, empurra o plantel para o template, e faz o modelo parecer
 * mais confiante exatamente onde já estava confiante. É o mesmo erro que
 * este projeto já rejeitou nos chips da liga — prova social vestida de
 * análise.
 *
 * ═══ O QUE VALE MESMO ═══
 *
 * A DISCORDÂNCIA. Um especialista que diz "este vai explodir" sobre um
 * jogador que o modelo tem em 40.º é uma informação real: ou ele sabe
 * qualquer coisa que os números não mostram, ou está enganado. As duas
 * possibilidades são úteis, e a diferença entre elas é MEDÍVEL ao longo da
 * época.
 *
 * Já a concordância também tem valor — mas não como ajuste. Vale como
 * tranquilização ("não estás sozinho nesta escolha") e, sobretudo, como
 * denominador: sem contar as vezes em que concordam, não é possível dizer
 * se as vezes em que discordam significam alguma coisa.
 *
 * ═══ COMO ISSO SE TRADUZ EM CÓDIGO ═══
 *
 * O peso de uma opinião externa é multiplicado pela sua NOVIDADE: quanto
 * mais o modelo já concorda, menos ela mexe. No limite em que o modelo já
 * tem o jogador no topo, um especialista entusiasmado mexe zero.
 *
 * Uma opinião não é, por si, evidência sobre o jogo. É evidência sobre o
 * que uma pessoa pensa. Só passa a ser a primeira coisa quando diz algo que
 * os dados não dizem — e mesmo aí, com moderação.
 */

export type ExpertStance = "sobe" | "desce";

export interface ExpertView extends TimedInsight {
  /** Quem afirmou. Um nome concreto, não "a comunidade". */
  expert?: string;
  /** Direção da opinião. */
  stance?: ExpertStance;
}

export type Agreement =
  | "concorda"
  | "discorda"
  | "neutro"
  | "sem-referencia";

export interface CrossCheck {
  view: ExpertView;
  /** Posição do jogador na ordenação do modelo, 1 = melhor. */
  modelRank: number | null;
  /** Quantos jogadores comparáveis existem — o denominador do percentil. */
  poolSize: number;
  /** 0 a 1, onde 1 = o modelo tem-no no topo. */
  modelPercentile: number | null;
  agreement: Agreement;
  /**
   * 0 a 1. Quanto desta opinião é NOVO para o modelo. Multiplica o efeito:
   * uma opinião que o modelo já partilha não deve mexer em nada.
   */
  novelty: number;
  /** Frase pronta para o ecrã. */
  verdict: string;
}

/** Acima deste percentil, o modelo já considera o jogador uma boa escolha. */
const MODEL_LIKES = 0.85;
/** Abaixo deste, o modelo já o considera dispensável. */
const MODEL_DISLIKES = 0.4;

/**
 * Compara uma opinião externa com o que o modelo pensa do mesmo jogador.
 *
 * A comparação é feita DENTRO DA POSIÇÃO. Um defesa nunca aparece no topo
 * de uma lista dominada por avançados, e classificar como "o modelo
 * discorda" toda a opinião sobre defesas seria uma consequência do formato
 * da lista, não do modelo.
 */
export function crossCheckExpertView(
  view: ExpertView,
  scored: ScoredPlayer[]
): CrossCheck {
  const me = scored.find((p) => p.element.id === view.id);
  if (!me || view.scope !== "player") {
    return {
      view,
      modelRank: null,
      poolSize: 0,
      modelPercentile: null,
      agreement: "sem-referencia",
      novelty: 0.5,
      verdict:
        "Sem jogador correspondente no modelo — a opinião não pode ser cruzada e não é aplicada com peso extra.",
    };
  }

  const pool = scored
    .filter((p) => p.element.element_type === me.element.element_type)
    .sort((a, b) => b.expectedPointsNext - a.expectedPointsNext);
  const rank = pool.findIndex((p) => p.element.id === me.element.id) + 1;
  const poolSize = pool.length;
  // Percentil onde 1 é o melhor da posição.
  const percentile = poolSize > 1 ? 1 - (rank - 1) / (poolSize - 1) : 0.5;

  const bullish = view.stance === "sobe";
  const bearish = view.stance === "desce";

  let agreement: Agreement = "neutro";
  if (bullish && percentile >= MODEL_LIKES) agreement = "concorda";
  else if (bullish && percentile <= MODEL_DISLIKES) agreement = "discorda";
  else if (bearish && percentile <= MODEL_DISLIKES) agreement = "concorda";
  else if (bearish && percentile >= MODEL_LIKES) agreement = "discorda";

  // ═══ A NOVIDADE ═══
  // Quanto mais o modelo já concorda, menos a opinião acrescenta. Uma
  // opinião entusiasta sobre o jogador que o modelo já tem em primeiro é
  // literalmente redundante e não deve mexer em nada.
  const novelty = bullish
    ? Math.min(1, Math.max(0, (MODEL_LIKES - percentile) / MODEL_LIKES))
    : bearish
      ? Math.min(1, Math.max(0, (percentile - MODEL_DISLIKES) / (1 - MODEL_DISLIKES)))
      : 0.5;

  const pos = me.positionShort;
  const where = `${rank}.º de ${poolSize} ${pos} no modelo`;
  const verdict =
    agreement === "concorda"
      ? `O modelo já pensa o mesmo (${where}) — a opinião confirma, mas não acrescenta, e por isso quase não mexe no número.`
      : agreement === "discorda"
        ? `O MODELO DISCORDA: tem-no em ${where}. É aqui que uma opinião externa pode valer alguma coisa — ou estar errada.`
        : `Zona intermédia (${where}). Nem confirmação nem contradição clara.`;

  return {
    view,
    modelRank: rank,
    poolSize,
    modelPercentile: Math.round(percentile * 1000) / 1000,
    agreement,
    novelty: Math.round(novelty * 100) / 100,
    verdict,
  };
}

/**
 * O fator efetivo de uma opinião externa, já descontado pela novidade.
 *
 * Uma opinião sobre um jogador que o modelo já adora vale ~0 de ajuste.
 * Uma sobre um jogador que o modelo despreza vale o seu peso inteiro — que
 * continua a ser pequeno, porque uma opinião não é uma medição.
 */
export function expertAdjustedFactor(check: CrossCheck): number {
  const raw = check.view.factor;
  const confidence =
    typeof check.view.confidence === "number" ? check.view.confidence : 1;
  return 1 + (raw - 1) * confidence * check.novelty;
}

export interface ExpertSummary {
  total: number;
  agree: number;
  disagree: number;
  neutral: number;
  checks: CrossCheck[];
}

/**
 * Cruza todas as opiniões externas de uma vez.
 *
 * A contagem de CONCORDÂNCIAS é guardada de propósito, apesar de não mexer
 * em nada. Sem ela não há denominador: dizer "os especialistas discordaram
 * do modelo três vezes" não significa nada sem saber se discordaram três em
 * quatro ou três em quarenta.
 */
export function crossCheckAll(
  views: ExpertView[],
  scored: ScoredPlayer[]
): ExpertSummary {
  const checks = views.map((v) => crossCheckExpertView(v, scored));
  return {
    total: checks.length,
    agree: checks.filter((c) => c.agreement === "concorda").length,
    disagree: checks.filter((c) => c.agreement === "discorda").length,
    neutral: checks.filter(
      (c) => c.agreement === "neutro" || c.agreement === "sem-referencia"
    ).length,
    checks,
  };
}

/** Só as que trazem alguma coisa nova são candidatas a mexer no modelo. */
export function isExpertView(note: TimedInsight): note is ExpertView {
  const v = note as ExpertView;
  return typeof v.expert === "string" && v.expert.length > 0;
}

/** O mesmo teto de ±20% que governa as notas de facto. Uma opinião não pode
 * ter mais poder sobre o modelo do que uma notícia confirmada. */
const EXPERT_MIN = 0.85;
const EXPERT_MAX = 1.15;

export interface ExpertApplication {
  summary: ExpertSummary;
  /** Quantos jogadores foram efetivamente ajustados. */
  adjusted: number;
}

/**
 * Aplica as opiniões externas a uma pontuação JÁ FEITA.
 *
 * ═══ PORQUE É QUE ISTO ACONTECE DEPOIS, E NÃO DENTRO ═══
 *
 * Para saber se um especialista está a dizer alguma coisa nova, é preciso
 * primeiro saber o que o modelo pensa. Se a opinião entrasse no cálculo
 * desde o início, ela estaria a influenciar a própria referência contra a
 * qual queremos medi-la — e a "novidade" mediria a distância entre a
 * opinião e uma versão do modelo já contaminada por ela.
 *
 * Portanto: o modelo forma a sua visão a partir de FACTOS (dados, notícias
 * verificadas). Só então as opiniões são cruzadas com ela e aplicadas, com
 * o peso descontado pela novidade. A ordem não é uma conveniência de
 * implementação — é o que torna a comparação honesta.
 *
 * Muta os objetos recebidos, como o resto do pipeline de pontuação.
 */
export function applyExpertViews(
  scored: ScoredPlayer[],
  views: ExpertView[],
  windowGameweeks = 5
): ExpertApplication {
  const summary = crossCheckAll(views, scored);
  let adjusted = 0;

  const byPlayer = new Map<number, CrossCheck[]>();
  for (const c of summary.checks) {
    if (c.view.scope !== "player") continue;
    const list = byPlayer.get(c.view.id) ?? [];
    list.push(c);
    byPlayer.set(c.view.id, list);
  }

  for (const [id, checks] of byPlayer) {
    const p = scored.find((x) => x.element.id === id);
    if (!p) continue;

    let combined = 1;
    for (const c of checks) combined *= expertAdjustedFactor(c);
    const clamped = Math.min(EXPERT_MAX, Math.max(EXPERT_MIN, combined));
    // Um ajuste abaixo de meio ponto percentual não é uma opinião a ser
    // ouvida, é ruído a ser mostrado. Não vale a pena mexer no número nem
    // poluir a lista de razões com ele.
    if (Math.abs(clamped - 1) < 0.005) continue;

    p.expectedPointsNext = Math.round(p.expectedPointsNext * clamped * 100) / 100;
    // A janela recebe o mesmo tratamento proporcional que as notas de
    // facto: uma opinião sobre a próxima jornada não vale cinco vezes.
    const windowShare = 1 + (clamped - 1) / windowGameweeks;
    p.expectedPoints = Math.round(p.expectedPoints * windowShare * 100) / 100;
    p.score = p.expectedPoints;
    adjusted += 1;

    for (const c of checks) {
      p.reasons.push(
        `opinião externa (${c.view.expert ?? "?"}, ${c.view.stance ?? "?"}): ${c.verdict}`
      );
    }
  }

  return { summary, adjusted };
}
