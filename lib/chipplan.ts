import type { FplEvent, FplFixture, FplTeam } from "./types";
import type { ScoredPlayer } from "./recommend";
import type { ChipStatus } from "./squadstate";
import { findScheduleAnomalies } from "./schedule";

/**
 * CHIP PLANNER — when to play Bench Boost, Triple Captain and Free Hit.
 *
 * Until now the app modelled exactly one chip, the Wildcard. Bench Boost,
 * Triple Captain and Free Hit existed only as prose in lib/strategy.ts and
 * as counters in the header. Asked directly — "o meu instinto diz-me que
 * podia usar o Bench Boost, o modelo pensa assim?" — the honest answer was
 * no: the model had no opinion at all, because nothing computed one.
 *
 * THE PRINCIPLE THAT MAKES CHIPS DIFFERENT FROM TRANSFERS
 *
 * A transfer is a repeated decision; a chip is a one-shot option. Playing it
 * this week does not merely have to be good — it has to be better than the
 * best week you will otherwise use it in. Almost every chip mistake in FPL
 * is the same mistake: a chip played in a week where it was worth something,
 * forfeiting a week where it was worth much more.
 *
 * So every chip here is priced twice: what it is worth NOW, and the best it
 * is plausibly worth LATER. It is only advised when now beats later by a
 * margin. "Not yet, and here is what I am waiting for" is a real answer, and
 * it is the right one most weeks of a season.
 *
 * WHAT "LATER" MEANS WHEN LATER IS NOT YET KNOWN
 *
 * Doubles and blanks are only confirmed a few weeks out, so early in a
 * season `findScheduleAnomalies` correctly returns nothing. That absence is
 * not evidence that no double is coming — it is evidence that the fixture
 * list has not been rearranged yet. Treating "no known double" as "no future
 * double" would advise burning every chip in September. The planner
 * therefore falls back to a PRIOR value for a chip played in a typical
 * double gameweek, which decays as the season advances and the schedule
 * becomes fully known.
 */

/** A gap this long between deadlines is an international break. FPL does not
 * label them; the calendar does, and the calendar is already fetched. */
const INTERNATIONAL_BREAK_DAYS = 12;

/** What each chip is typically worth when played in a good double gameweek,
 * in points. These are the "later" values the planner protects. They are
 * priors, not measurements — see the module note. */
const DGW_PRIOR = {
  bboost: 22,
  "3xc": 16,
} as const;

/** How much better "now" must be than "later" before spending the option. */
const MARGIN = 1.15;

/** What a Free Hit rescues in a blank gameweek that is already on the
 * calendar: a squad with most of its eleven not playing. */
const KNOWN_BLANK_VALUE = 30;
/** And in a blank that has not been announced yet. Lower than the known one
 * on purpose — it is speculative, and a chip should not be hoarded against a
 * week nobody can see. */
const UNKNOWN_BLANK_PRIOR = 22;
/** Below this, the Free Hit is rescuing a couple of injuries rather than a
 * blank, and a one-shot chip is far too expensive for that. Keeps the old
 * behaviour as a floor beneath the new now-versus-later rule. */
const FREE_HIT_MIN_MISSING = 4;

export interface CalendarContext {
  /** Gameweeks after which an international break follows. */
  breakAfterEvents: number[];
  /** True when a break falls between this gameweek and the next one. */
  breakImminent: boolean;
  /** Events in the horizon known to contain a double for some team. */
  knownDoubleEvents: number[];
  /** Events in the horizon known to contain a blank for some team. */
  knownBlankEvents: number[];
}

/**
 * Reads the season calendar for the two things that change chip and transfer
 * timing: international breaks and fixture anomalies.
 *
 * International breaks matter more than they look. They are the moments the
 * league's information resets — injuries happen on international duty, new
 * signings get two weeks to settle, managers change systems. Rebuilding a
 * squad immediately BEFORE one means committing fifteen picks precisely when
 * the information you have is about to go stale.
 */
export function readCalendar(
  events: FplEvent[],
  teams: FplTeam[],
  fixtures: FplFixture[],
  fromEvent: number,
  horizon = 8
): CalendarContext {
  const sorted = [...events]
    .filter((e) => Number.isFinite(new Date(e.deadline_time).getTime()))
    .sort((a, b) => a.id - b.id);

  const breakAfterEvents: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = new Date(sorted[i].deadline_time).getTime();
    const b = new Date(sorted[i + 1].deadline_time).getTime();
    const days = (b - a) / 86_400_000;
    if (days >= INTERNATIONAL_BREAK_DAYS) breakAfterEvents.push(sorted[i].id);
  }

  const anomalies = findScheduleAnomalies(teams, fixtures, fromEvent, fromEvent + horizon);
  const knownDoubleEvents = [
    ...new Set(anomalies.filter((a) => a.type === "double").map((a) => a.event)),
  ].sort((a, b) => a - b);
  const knownBlankEvents = [
    ...new Set(anomalies.filter((a) => a.type === "blank").map((a) => a.event)),
  ].sort((a, b) => a - b);

  return {
    breakAfterEvents,
    // A break "immediately ahead" is one that starts after the gameweek being
    // planned — i.e. the squad you pick now sits through it.
    breakImminent: breakAfterEvents.includes(fromEvent),
    knownDoubleEvents,
    knownBlankEvents,
  };
}

export type ChipKey = "bboost" | "3xc" | "freehit";
export type ChipVerdict = "jogar" | "esperar" | "indisponível";

export interface ChipAdvice {
  chip: ChipKey;
  label: string;
  verdict: ChipVerdict;
  /** Extra points this chip would earn if played in the coming gameweek. */
  valueNow: number;
  /** Best value plausibly available later, and where it comes from. */
  bestLaterValue: number;
  bestLaterEvent: number | null;
  bestLaterSource: "dupla conhecida" | "dupla típica (ainda não marcada)" | "branca conhecida";
  reason: string;
}

/** How much of the double-gameweek prior still applies. Late in the season
 * the fixture list is known, so an unknown future double is no longer a
 * plausible thing to wait for. */
function unknownDoubleCredit(currentEvent: number): number {
  if (currentEvent >= 30) return 0.2;
  if (currentEvent >= 20) return 0.6;
  return 1;
}

export interface ChipPlanInput {
  currentEvent: number;
  chips: ChipStatus[];
  /** The eleven that will start, and the four on the bench. */
  xi: ScoredPlayer[];
  bench: ScoredPlayer[];
  captain: ScoredPlayer | undefined;
  calendar: CalendarContext;
}

function remaining(chips: ChipStatus[], name: string): number {
  return chips.find((c) => c.name === name)?.remaining ?? 0;
}

export function planChips(input: ChipPlanInput): ChipAdvice[] {
  const { currentEvent, chips, xi, bench, captain, calendar } = input;
  const out: ChipAdvice[] = [];
  const credit = unknownDoubleCredit(currentEvent);
  const nextKnownDouble = calendar.knownDoubleEvents.find((e) => e > currentEvent) ?? null;
  const nextKnownBlank = calendar.knownBlankEvents.find((e) => e >= currentEvent) ?? null;

  // ---- Bench Boost -----------------------------------------------------
  // Worth exactly what the bench scores, because that is what it cashes in.
  {
    const valueNow =
      Math.round(bench.reduce((s, p) => s + p.expectedPointsNext, 0) * 10) / 10;
    const later = nextKnownDouble
      ? DGW_PRIOR.bboost
      : Math.round(DGW_PRIOR.bboost * credit * 10) / 10;
    const laterEvent = nextKnownDouble;
    const available = remaining(chips, "bboost") > 0;
    const verdict: ChipVerdict = !available
      ? "indisponível"
      : valueNow >= later * MARGIN
        ? "jogar"
        : "esperar";
    out.push({
      chip: "bboost",
      label: "Bench Boost",
      verdict,
      valueNow,
      bestLaterValue: later,
      bestLaterEvent: laterEvent,
      bestLaterSource: nextKnownDouble ? "dupla conhecida" : "dupla típica (ainda não marcada)",
      reason: !available
        ? "Já não tens Bench Boost disponível."
        : verdict === "jogar"
          ? `O teu banco vale ${valueNow.toFixed(1)} pts nesta jornada, acima do que uma jornada dupla costuma render (~${later.toFixed(0)}). Vale a pena gastá-lo agora.`
          : `O teu banco vale ${valueNow.toFixed(1)} pts nesta jornada. ${
              nextKnownDouble
                ? `Há uma jornada dupla marcada na ${nextKnownDouble}, onde o mesmo chip vale tipicamente ~${later.toFixed(0)} pts.`
                : `Numa jornada dupla o mesmo chip vale tipicamente ~${DGW_PRIOR.bboost} pts, e ainda não há duplas marcadas — só aparecem no calendário poucas semanas antes. Não haver duplas marcadas não quer dizer que não venham.`
            } Gastá-lo agora troca ${later.toFixed(0)} pontos por ${valueNow.toFixed(1)}.`,
    });
  }

  // ---- Triple Captain --------------------------------------------------
  // Worth one extra copy of the captain's score.
  {
    const valueNow = Math.round((captain?.expectedPointsNext ?? 0) * 10) / 10;
    const later = nextKnownDouble
      ? DGW_PRIOR["3xc"]
      : Math.round(DGW_PRIOR["3xc"] * credit * 10) / 10;
    const available = remaining(chips, "3xc") > 0;
    const verdict: ChipVerdict = !available
      ? "indisponível"
      : valueNow >= later * MARGIN
        ? "jogar"
        : "esperar";
    out.push({
      chip: "3xc",
      label: "Triple Captain",
      verdict,
      valueNow,
      bestLaterValue: later,
      bestLaterEvent: nextKnownDouble,
      bestLaterSource: nextKnownDouble ? "dupla conhecida" : "dupla típica (ainda não marcada)",
      reason: !available
        ? "Já não tens Triple Captain disponível."
        : verdict === "jogar"
          ? `${captain?.element.web_name ?? "O teu capitão"} vale ${valueNow.toFixed(1)} pts esperados nesta jornada — o suficiente para o chip render mais agora do que numa dupla típica.`
          : `${captain?.element.web_name ?? "O teu capitão"} vale ${valueNow.toFixed(1)} pts esperados. O Triple Captain guarda-se para um premium com jornada dupla, onde vale tipicamente ~${DGW_PRIOR["3xc"]} pts${nextKnownDouble ? ` (a próxima dupla marcada é na jornada ${nextKnownDouble})` : ""}.`,
    });
  }

  // ---- Free Hit --------------------------------------------------------
  //
  // ═══ v1.44 — O ÚNICO CHIP QUE NÃO SEGUIA A REGRA DA CASA ═══
  //
  // O cabeçalho deste módulo diz, em letra grande, que cada chip é avaliado
  // DUAS vezes — quanto vale agora e quanto vale na melhor semana futura — e
  // que só é aconselhado quando o agora bate o depois por uma margem. O Bench
  // Boost faz isso. O Triple Captain faz isso. O Free Hit não fazia.
  //
  // O veredicto era `missing >= 4`, e mais nada. O `bestLaterValue` era
  // calculado, guardado no objeto, mostrado ao utilizador — e ignorado pela
  // decisão.
  //
  // Medido: 4 jogadores sem jogo agora (valor 16) com uma jornada em BRANCO
  // conhecida na 15 (valor 30), e o veredicto era "jogar". O modelo mandava
  // queimar o chip na semana pior enquanto reportava, no mesmo cartão, que
  // havia uma melhor à frente.
  //
  // A correção aplica a mesma regra dos outros dois, mas mantém também um
  // PISO absoluto: sem ele, quando não há nenhuma branca conhecida o "depois"
  // seria zero e qualquer jogador em falta bastaria para gastar o chip.
  {
    const playing = xi.filter((p) => (p.expectedPointsNext ?? 0) > 0.5);
    const missing = Math.max(0, 11 - playing.length);

    // ═══ v1.48 — A CONTA IGNORAVA AS SUBSTITUIÇÕES AUTOMÁTICAS ═══
    //
    // O valor era `ausências x 4`: quatro pontos por cada jogador sem jogo,
    // como se cada ausência fosse uma perda total. Não é. A FPL substitui
    // automaticamente por ordem de banco sempre que um titular não joga, e um
    // banco normal cobre até três das ausências sozinho.
    //
    // O que se perde numa ausência COBERTA não é o que o titular valia — é a
    // DIFERENÇA entre ele e o suplente que entrou no lugar dele. Só a partir
    // da quarta ausência é que se perde o jogador inteiro.
    //
    // A conta antiga sobrestimava sistematicamente o que o chip resgata, e a
    // v1.44 compensou isso subindo o limiar de 4 para 7 ausências. Compensar
    // uma fórmula errada com um limiar é aceitável enquanto se sabe que é
    // isso que se está a fazer; agora a fórmula está certa e o limiar volta a
    // significar o que diz.
    const cover = bench
      .filter((b) => (b.expectedPointsNext ?? 0) > 0.5)
      .map((b) => b.expectedPointsNext)
      .sort((a, b) => b - a);

    // O que o teu onze rende SEM o chip: quem joga, mais os suplentes que
    // entram automaticamente, mais zero pelos lugares que ficam vazios.
    const withoutChip =
      playing.reduce((t, q) => t + q.expectedPointsNext, 0) +
      cover.slice(0, missing).reduce((t, v) => t + v, 0);

    // O que rende COM o chip: onze jogadores todos a jogar, ao nível de um
    // titular teu normal. É a mesma aproximação de sempre — um Free Hit não
    // compra estrelas, compra gente que joga — mas agora ancorada no teu
    // plantel em vez de num 4 fixo.
    const typicalStarter =
      playing.length > 0
        ? playing.reduce((t, q) => t + q.expectedPointsNext, 0) / playing.length
        : 4;
    const withChip = 11 * typicalStarter;

    const valueNow = Math.round(Math.max(0, withChip - withoutChip) * 10) / 10;
    const available = remaining(chips, "freehit") > 0;

    // Uma branca ainda não marcada é tão real como uma dupla ainda não
    // marcada — só entram no calendário poucas semanas antes. O prior é mais
    // baixo do que o de uma branca CONHECIDA porque é especulativo: não se
    // sabe que virá a ser pior do que hoje.
    const later = nextKnownBlank
      ? KNOWN_BLANK_VALUE
      : Math.round(UNKNOWN_BLANK_PRIOR * credit * 10) / 10;
    const beatsLater = valueNow >= later * MARGIN;
    const verdict: ChipVerdict = !available
      ? "indisponível"
      : missing >= FREE_HIT_MIN_MISSING && beatsLater
        ? "jogar"
        : "esperar";

    out.push({
      chip: "freehit",
      label: "Free Hit",
      verdict,
      valueNow,
      bestLaterValue: later,
      bestLaterEvent: nextKnownBlank,
      bestLaterSource: "branca conhecida",
      reason: !available
        ? "Já não tens Free Hit disponível."
        : verdict === "jogar"
          ? `Tens ${missing} jogadores do onze sem jogo nesta jornada (${valueNow.toFixed(0)} pts a resgatar). É mais do que uma jornada em branco costuma valer, por isso vale a pena gastá-lo agora.`
          : missing === 0
            ? nextKnownBlank
              ? `O onze está completo nesta jornada. Há uma jornada em branco marcada na ${nextKnownBlank} — é aí que este chip costuma valer mais.`
              : "O onze está completo nesta jornada, por isso o Free Hit não resgata nada. Guarda-o para uma jornada em branco."
            : nextKnownBlank
              ? `Tens ${missing} jogador${missing === 1 ? "" : "es"} sem jogo (${valueNow.toFixed(0)} pts), mas há uma jornada em branco marcada na ${nextKnownBlank} onde este chip vale tipicamente ~${later.toFixed(0)} pts. Gastá-lo agora troca a semana pior pela melhor.`
              : `Tens ${missing} jogador${missing === 1 ? "" : "es"} sem jogo (${valueNow.toFixed(0)} pts) — pouco para queimar um chip de um só uso. Numa jornada em branco a sério ele resgata tipicamente ~${UNKNOWN_BLANK_PRIOR} pts, e as brancas só entram no calendário poucas semanas antes.`,
    });
  }

  return out;
}

/**
 * Extra points the Wildcard must be worth before playing it right before an
 * international break.
 *
 * A wildcard commits all fifteen picks. An international break is when the
 * information behind those picks goes stale fastest: injuries on national
 * duty, new signings finally bedding in, managers changing shape over two
 * weeks of training. Waiting one gameweek costs almost nothing and buys the
 * squad news of an entire break.
 */
export const WILDCARD_BREAK_PREMIUM = 10;
