import type { FixtureExpectation } from "./matchmodel";
import { BASE_HOME_GOALS, BASE_AWAY_GOALS } from "./matchmodel";
import type { ScoredPlayer } from "./recommend";

/**
 * EM QUE SEMANA É QUE ESTE CHIP VALE MAIS.
 *
 * ═══ O QUE O PLANEADOR DE CHIPS AINDA NÃO SABIA DIZER ═══
 *
 * Depois da v1.50 o planeador já decide bem QUANDO gastar: compara o valor
 * de hoje com o valor de continuar a guardar, e o prazo da GW19 entra na
 * conta. Mas o "depois" continuava a ser abstrato — um número, sem semana.
 * O ecrã dizia "esperar por uma semana melhor vale 9,2" e não sabia dizer
 * QUAL semana, nem porquê.
 *
 * Isso é insuficiente para decidir de facto. "Guarda" sem um alvo é
 * indistinguível de "não sei", e é a diferença entre um plano e um adiamento.
 *
 * ═══ COMO É QUE ISTO É CALCULADO, E ONDE ESTÁ A APROXIMAÇÃO ═══
 *
 * Reavaliar o modelo inteiro para cada jornada futura custaria cinco vezes
 * o trabalho de pontuação, numa página que já corre um Monte Carlo e um
 * solver dentro de um limite de 60 segundos. Em vez disso, cada jogador é
 * REESCALADO: parte-se dos seus pontos esperados para a próxima jornada e
 * multiplica-se pela razão entre a qualidade do calendário dessa semana
 * futura e a da próxima.
 *
 * A aproximação está aí, e é declarada: assume que a FORMA do jogador não
 * muda, só o adversário. Isso é falso a cinco semanas de distância. Mas as
 * duas coisas que realmente decidem um chip são captadas exatamente:
 *
 *   · JORNADA EM BRANCO — zero jogos, o jogador vale zero nessa semana.
 *   · JORNADA DUPLA     — dois jogos, vale aproximadamente o dobro.
 *
 * E são essas que fazem um Bench Boost valer 8 pontos ou 25.
 *
 * ═══ O QUE ISTO NÃO PODE FAZER ═══
 *
 * As duplas e as brancas só aparecem no calendário poucas semanas antes.
 * Uma projeção sobre um calendário ainda não reorganizado vê semanas
 * uniformes — e "não vejo nada de especial nas próximas cinco" NÃO é o
 * mesmo que "não vem nada". O planeador continua a precisar do prior sobre
 * duplas futuras, e esta projeção não o substitui: complementa-o, dizendo
 * o que se vê no horizonte visível.
 */

/** Média da liga, para normalizar a qualidade de um jogo. */
const LEAGUE_AVG_GOALS_FOR = (BASE_HOME_GOALS + BASE_AWAY_GOALS) / 2;
/** Probabilidade típica de uma equipa não sofrer golos. */
const LEAGUE_AVG_CLEAN_SHEET = 0.28;
/** Quanto do valor de um defesa vem de não sofrer, e quanto de atacar. */
const DEFENDER_CS_WEIGHT = 0.65;

/**
 * Um índice de qualidade para um jogo, do ponto de vista deste jogador.
 * 1,0 é um jogo médio. Acima disso é um bom jogo para ele.
 */
function fixtureIndex(elementType: number, fx: FixtureExpectation): number {
  const attack = Math.max(0, fx.expectedGoalsFor) / LEAGUE_AVG_GOALS_FOR;
  if (elementType >= 3) return attack;
  const clean =
    Math.max(0, fx.cleanSheetProbability) / LEAGUE_AVG_CLEAN_SHEET;
  return DEFENDER_CS_WEIGHT * clean + (1 - DEFENDER_CS_WEIGHT) * attack;
}

/** Um teto e um piso, porque uma razão entre dois números pequenos explode.
 * Nenhum calendário torna um jogador três vezes melhor numa semana. */
const MIN_SCALE = 0;
const MAX_SCALE_PER_FIXTURE = 1.8;

export interface EventProjection {
  event: number;
  /** Quantos jogos tem, no máximo, alguma equipa do plantel nesta jornada. */
  maxFixtures: number;
  /** Quantos jogadores do onze não têm jogo nenhum. */
  blanking: number;
  /** O que o Bench Boost renderia nesta jornada. */
  benchBoost: number;
  /** O que o Triple Captain renderia — os pontos do melhor capitão. */
  tripleCaptain: number;
  /** Quem seria o capitão nessa semana. */
  captainName: string | null;
}

function projectPlayer(
  p: ScoredPlayer,
  event: number,
  expectations: Map<number, FixtureExpectation[]>
): number {
  const base = Number.isFinite(p.expectedPointsNext) ? p.expectedPointsNext : 0;
  if (base <= 0) return 0;
  const all = expectations.get(p.team?.id ?? -1) ?? [];
  const here = all.filter((f) => f.event === event);
  if (here.length === 0) return 0; // jornada em branco para a equipa dele

  // A referência é o jogo mais próximo que a equipa tem, que é aquele sobre
  // o qual `expectedPointsNext` foi calculado.
  const upcoming = all
    .filter((f) => typeof f.event === "number" && (f.event as number) >= 1)
    .sort((a, b) => (a.event ?? 0) - (b.event ?? 0));
  const reference = upcoming[0];
  const refIndex = reference
    ? Math.max(0.15, fixtureIndex(p.element.element_type, reference))
    : 1;

  let scale = 0;
  for (const f of here) {
    const idx = fixtureIndex(p.element.element_type, f) / refIndex;
    scale += Math.min(MAX_SCALE_PER_FIXTURE, Math.max(MIN_SCALE, idx));
  }
  return base * scale;
}

/**
 * Projeta o valor de cada chip em cada jornada do horizonte visível.
 *
 * A jornada corrente entra na lista de propósito: sem ela, "a melhor semana
 * é a GW7" não tem termo de comparação e o utilizador não consegue ver se
 * esperar vale mesmo a pena.
 */
export function projectChipsByEvent(
  xi: ScoredPlayer[],
  bench: ScoredPlayer[],
  expectations: Map<number, FixtureExpectation[]>,
  fromEvent: number,
  horizon = 5
): EventProjection[] {
  const out: EventProjection[] = [];
  for (let e = fromEvent; e < fromEvent + horizon; e += 1) {
    const xiProjected = xi.map((p) => ({
      p,
      pts: projectPlayer(p, e, expectations),
    }));
    const benchPts = bench.reduce(
      (s, p) => s + projectPlayer(p, e, expectations),
      0
    );
    const best = xiProjected.reduce<{ p: ScoredPlayer; pts: number } | null>(
      (b, c) => (!b || c.pts > b.pts ? c : b),
      null
    );
    const maxFixtures = [...xi, ...bench].reduce((m, p) => {
      const n = (expectations.get(p.team?.id ?? -1) ?? []).filter(
        (f) => f.event === e
      ).length;
      return Math.max(m, n);
    }, 0);
    out.push({
      event: e,
      maxFixtures,
      blanking: xiProjected.filter((x) => x.pts === 0).length,
      benchBoost: Math.round(benchPts * 10) / 10,
      tripleCaptain: Math.round((best?.pts ?? 0) * 10) / 10,
      captainName: best?.p.element.web_name ?? null,
    });
  }
  return out;
}

/** A melhor jornada do horizonte para um chip, ignorando a atual. */
export function bestFutureEvent(
  projections: EventProjection[],
  pick: (p: EventProjection) => number
): EventProjection | null {
  const future = projections.slice(1);
  if (future.length === 0) return null;
  return future.reduce((b, c) => (pick(c) > pick(b) ? c : b), future[0]);
}
