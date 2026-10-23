import type { ChipStatus } from "./squadstate";
import type { EventProjection } from "./chipschedule";

/**
 * O CALENDÁRIO DE CHIPS: USAR OU PERDER.
 *
 * O planeador de chips (lib/chipplan.ts) pergunta, semana a semana, se o
 * chip vale mais agora do que esperar por uma semana melhor — e espera por
 * jornadas duplas. Na primeira metade de 2026/27 não há duplas previstas e o
 * primeiro conjunto de chips CADUCA no deadline da GW19. Resultado medido:
 * o top 50 usou em média 3,3 chips até à GW7; o Pedro usou 1, e a app
 * aconselhava esperar.
 *
 * Este módulo não decide se um chip vale a pena esta semana; distribui os
 * chips que restam pelas jornadas que restam, para nenhum caducar:
 *
 *   - Wildcard: já, se o plantel está longe do núcleo da elite (ou se o
 *     planeador o aconselha); senão na jornada seguinte.
 *   - Bench Boost: na jornada a seguir ao Wildcard, quando os 15 estão
 *     escolhidos para jogar; sem Wildcard, na melhor semana de banco vista.
 *   - Triple Captain: na melhor semana de capitão vista que não colida.
 *   - Free Hit: guardado para a última janela antes da GW19, onde serve de
 *     socorro (lesões, castigos) e não é desperdiçado.
 */

export const FIRST_HALF_LAST_EVENT = 19;

export interface CalendarSlot {
  chip: "wildcard" | "bboost" | "3xc" | "freehit";
  label: string;
  event: number;
  why: string;
}

export interface ChipCalendar {
  applies: boolean;
  deadlineEvent: number;
  weeksLeft: number;
  slots: CalendarSlot[];
  note: string;
}

const LABEL: Record<CalendarSlot["chip"], string> = {
  wildcard: "Wildcard",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
  freehit: "Free Hit",
};

export function planChipCalendar(input: {
  currentEvent: number;
  chips: ChipStatus[];
  projections: EventProjection[];
  /** O planeador de transferências aconselha o Wildcard agora. */
  wildcardAdvised: boolean;
  /** Quantos jogadores com posse ≥70% na elite te faltam. */
  eliteGaps: number;
}): ChipCalendar {
  const { currentEvent, chips, projections } = input;
  const deadlineEvent = FIRST_HALF_LAST_EVENT;
  if (currentEvent > deadlineEvent) {
    return {
      applies: false,
      deadlineEvent,
      weeksLeft: 0,
      slots: [],
      note: "Segunda metade da época: os chips guardam-se para as jornadas duplas e em branco, que o planeador de chips trata.",
    };
  }
  const has = (name: string) => (chips.find((c) => c.name === name)?.remaining ?? 0) > 0;
  // Na 1.ª metade cada chip tem 1 uso; `remaining` conta os dois do ano.
  const usedThisHalf = (name: string) =>
    (chips.find((c) => c.name === name)?.usedAtEvents ?? []).some((e) => e <= deadlineEvent);
  const available = (name: string) => has(name) && !usedThisHalf(name);
  const taken = new Set<number>();
  const slots: CalendarSlot[] = [];
  const within = (e: number) => e >= currentEvent && e <= deadlineEvent;

  let wcEvent: number | null = null;
  if (available("wildcard")) {
    // IMPORTANT: being absent from today's top-ranked squads is NOT proof
    // that spending a Wildcard now increases future expected points. Ranking
    // leaders after GW7 conditions on their past returns (survivorship).
    // Elite ownership remains diagnostic; only the transfer planner's
    // explicit, threshold-tested signal can recommend an immediate Wildcard.
    const now = input.wildcardAdvised;
    // A provisional calendar slot is NOT a call to play the chip.
    // Avoid prescribing "next week" without any positive evidence.
    wcEvent = now
      ? currentEvent
      : Math.min(deadlineEvent, currentEvent + Math.max(1, Math.ceil((deadlineEvent - currentEvent) / 2)));
    taken.add(wcEvent);
    slots.push({
      chip: "wildcard",
      label: LABEL.wildcard,
      event: wcEvent,
      why: now
        ? "O planeador de transferências aconselha o Wildcard. Confirma a vantagem líquida, o orçamento e as notícias antes do deadline."
        : "Reserva provisória, não uma recomendação para jogar nessa GW. A falta de jogadores populares na elite não justifica por si só um Wildcard; rever quando houver evidência de ganhos reais.",
    });
  }

  const bestWeek = (pick: (p: EventProjection) => number) =>
    [...projections]
      .filter((p) => within(p.event) && !taken.has(p.event))
      .sort((a, b) => pick(b) - pick(a))[0] ?? null;

  if (available("bboost")) {
    const after = wcEvent !== null ? wcEvent + 1 : null;
    const ev =
      after !== null && within(after) && !taken.has(after)
        ? after
        : (bestWeek((p) => p.benchBoost)?.event ?? Math.min(deadlineEvent, currentEvent + 2));
    taken.add(ev);
    const proj = projections.find((p) => p.event === ev);
    slots.push({
      chip: "bboost",
      label: LABEL.bboost,
      event: ev,
      why:
        after === ev
          ? "Logo a seguir ao Wildcard: os 15 foram escolhidos para jogar."
          : `A melhor semana de banco que se vê${proj ? ` (${proj.benchBoost.toFixed(1)} pts)` : ""}.`,
    });
  }

  if (available("3xc")) {
    const best = bestWeek((p) => p.tripleCaptain);
    const ev = best?.event ?? Math.min(deadlineEvent, currentEvent + 3);
    taken.add(ev);
    slots.push({
      chip: "3xc",
      label: LABEL["3xc"],
      event: ev,
      why: best
        ? `A melhor semana de capitão que se vê${best.captainName ? ` (${best.captainName}, ${best.tripleCaptain.toFixed(1)} pts)` : ""}. Revê-la quando o calendário para lá da GW${currentEvent + 4} ficar visível.`
        : "Sem projeção visível; escolher a melhor semana do capitão em casa antes da GW19.",
    });
  }

  if (available("freehit")) {
    let ev = deadlineEvent;
    while (taken.has(ev) && ev > currentEvent) ev--;
    taken.add(ev);
    slots.push({
      chip: "freehit",
      label: LABEL.freehit,
      event: ev,
      why: "Reserva de socorro até ao fim da janela: usa-o antes se uma jornada te deixar com três ou mais titulares fora.",
    });
  }

  slots.sort((a, b) => a.event - b.event);
  const weeksLeft = deadlineEvent - currentEvent + 1;
  return {
    applies: true,
    deadlineEvent,
    weeksLeft,
    slots,
    note:
      slots.length === 0
        ? "Já usaste todos os chips da primeira metade."
        : `Os chips da primeira metade caducam no deadline da GW${deadlineEvent}: restam ${weeksLeft} jornadas e ${slots.length} chip${slots.length === 1 ? "" : "s"}. Este calendário é uma reserva de datas para não deixar chips caducar, não uma ordem para os jogar: reavaliar valor, calendário e notícias antes de cada deadline.`,
  };
}
