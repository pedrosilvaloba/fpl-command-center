import type { ManagerInsight } from "./managerinsights";

/**
 * QUANDO É QUE UMA NOTA TÁTICA AINDA VALE — O ÚNICO SÍTIO QUE DECIDE ISSO.
 *
 * ═══ O DEFEITO, E PORQUE É QUE NUNCA MORRIA ═══
 *
 * O Pedro pediu várias vezes para deixar de ver notas de antes da GW1. De
 * cada vez, o arranjo foi na camada dinâmica — a que vem da investigação
 * semanal, tem prazo de 14 dias e sempre funcionou. As notas que ele via
 * nunca estiveram lá: estavam ESCRITAS NO CÓDIGO, em
 * `MANAGER_INSIGHT_SEEDS`, e a camada estática foi desenhada para nunca
 * expirar, com este comentário a justificá-lo:
 *
 *     "static, hand-curated entries have no expiry
 *      (a human already committed to them)"
 *
 * O raciocínio parece sólido e está errado. Um humano ter escrito uma nota
 * não a torna verdadeira para sempre — torna-a verdadeira NAQUELE momento.
 * "Só jogou 45 minutos desde 1 de agosto" era um facto a 21 de agosto e é
 * ruído a 8 de setembro, quando existem três jornadas de minutos reais.
 *
 * ═══ A REGRA NOVA, E É UMA SÓ ═══
 *
 * NENHUMA NOTA SOBREVIVE POR OMISSÃO.
 *
 * Antes, um campo em falta significava "para sempre". Passa a significar
 * "não se aplica". Toda a nota tem de dizer explicitamente para que jornada
 * foi escrita e durante quantas vale; uma nota que não o diga é tratada
 * como expirada, e aparece no ecrã marcada como tal em vez de desaparecer
 * em silêncio.
 *
 * A inversão do valor por omissão é o coração desta correção. Um sistema
 * cujo modo de falha é "aplicar demais" acumula erro invisível para sempre.
 * Um cujo modo de falha é "aplicar de menos" perde alguma informação e
 * dá-se por isso. Só o segundo é recuperável.
 *
 * ═══ PORQUE É QUE O PRAZO É EM JORNADAS E NÃO EM DIAS ═══
 *
 * O prazo antigo eram 14 dias. Entre a GW6 e a GW7 desta época passam-se
 * três semanas de paragem para seleções, e entre a GW13 e a GW14 passam-se
 * três dias. Uma notícia de equipa vale para o jogo a que diz respeito, não
 * para um número de dias — e só a jornada sabe isso.
 */

/** Quantas jornadas uma notícia de equipa vale, por omissão: a dela, e mais
 * nenhuma. Team news é sobre um jogo. */
export const DEFAULT_NEWS_LIFESPAN_EVENTS = 1;

/**
 * Quantas jornadas vale um traço de papel ou de função — "é ele que marca os
 * penáltis", "joga como ala numa linha de três". Muda mais devagar do que
 * uma lesão, mas MUDA: um treinador sai, um titular chega, o executor de
 * penáltis falha dois e perde o posto. Seis jornadas é meia dúzia de jogos,
 * tempo suficiente para o próprio modelo já ver o efeito nos dados.
 */
export const DEFAULT_ROLE_LIFESPAN_EVENTS = 6;

export type InsightKind = "noticia" | "papel" | "duradoura";

export type InsightState =
  | "ativa"
  | "expirada"
  | "fora-de-jornada"
  | "sem-prazo";

export interface InsightStatus {
  /** Só as `true` podem tocar no modelo. */
  applies: boolean;
  state: InsightState;
  /** Frase curta para o ecrã, sempre preenchida. */
  detail: string;
  /** Há quantas jornadas foi escrita, quando se sabe. */
  ageInEvents: number | null;
  /** Última jornada em que ainda se aplica, quando se sabe. */
  lastEvent: number | null;
}

/**
 * Uma nota com o tempo de vida declarado. Os campos são opcionais no tipo
 * porque registos antigos não os têm — e é precisamente esse caso que passa
 * a ser tratado como expirado em vez de eterno.
 */
export interface TimedInsight extends ManagerInsight {
  /** A jornada para a qual a nota foi escrita. */
  writtenForEvent?: number;
  /** Que tipo de afirmação é. Determina o tempo de vida por omissão. */
  kind?: InsightKind;
  /** Sobrepõe o tempo de vida por omissão, em jornadas. */
  lifespanEvents?: number;
}

function lifespanOf(note: TimedInsight): number {
  if (typeof note.lifespanEvents === "number" && note.lifespanEvents > 0) {
    return Math.floor(note.lifespanEvents);
  }
  if (note.kind === "papel") return DEFAULT_ROLE_LIFESPAN_EVENTS;
  // "duradoura" é tratada abaixo, antes de chegar aqui.
  return DEFAULT_NEWS_LIFESPAN_EVENTS;
}

/**
 * Decide se uma nota se aplica à jornada que está a ser planeada.
 *
 * É a ÚNICA função que responde a esta pergunta. Havia antes duas respostas
 * espalhadas — o prazo em dias na camada dinâmica e o "nunca expira" na
 * estática — e é por existirem duas que uma delas nunca foi corrigida.
 */
export function insightStatus(
  note: TimedInsight,
  currentEvent: number,
  now: Date = new Date()
): InsightStatus {
  // ═══ A ORDEM DESTAS DUAS VERIFICAÇÕES É O PONTO ═══
  //
  // A primeira versão desta função tratava "duradoura" ANTES do prazo, e
  // por isso uma nota marcada como duradoura sobrevivia à sua própria data
  // de validade. Ou seja: eu tinha reintroduzido, dentro da correção, a
  // mesma ideia que a correção existe para eliminar — uma etiqueta que
  // dispensa a verificação.
  //
  // O prazo é verificado SEMPRE, e primeiro. Nada o dispensa. Foi um teste
  // desta suite que apanhou isto, e é para isso que ela serve.
  if (note.expiresAt) {
    const t = new Date(note.expiresAt).getTime();
    if (Number.isFinite(t) && t <= now.getTime()) {
      return {
        applies: false,
        state: "expirada",
        detail: `prazo terminou a ${note.expiresAt.slice(0, 10)}`,
        ageInEvents:
          typeof note.writtenForEvent === "number"
            ? currentEvent - note.writtenForEvent
            : null,
        lastEvent: null,
      };
    }
  }

  // Só DEPOIS do prazo é que a etiqueta de duradoura tem efeito. É um traço
  // que alguém se comprometeu a manter — e só vale se disser QUE é isso. O
  // que não pode acontecer é uma nota ser duradoura por não ter dito nada.
  if (note.kind === "duradoura") {
    return {
      applies: true,
      state: "ativa",
      detail: "traço duradouro, declarado como tal",
      ageInEvents:
        typeof note.writtenForEvent === "number"
          ? currentEvent - note.writtenForEvent
          : null,
      lastEvent: null,
    };
  }

  // ═══ A INVERSÃO ═══
  // Sem jornada declarada não há forma de saber se ainda vale. Antes isto
  // significava "para sempre". Passa a significar "não se aplica".
  if (typeof note.writtenForEvent !== "number") {
    return {
      applies: false,
      state: "sem-prazo",
      detail:
        "não diz para que jornada foi escrita — sem isso não é possível saber se ainda vale, e o modelo não a aplica",
      ageInEvents: null,
      lastEvent: null,
    };
  }

  const age = currentEvent - note.writtenForEvent;
  const span = lifespanOf(note);
  const lastEvent = note.writtenForEvent + span - 1;

  // Uma nota escrita para uma jornada FUTURA ainda não se aplica. Acontece
  // com notícias antecipadas ("suspenso na GW22") e aplicá-las já seria tão
  // errado como aplicá-las tarde de mais.
  if (age < 0) {
    return {
      applies: false,
      state: "fora-de-jornada",
      detail: `escrita para a GW${note.writtenForEvent}, ainda não chegou`,
      ageInEvents: age,
      lastEvent,
    };
  }

  // O campo `events` continua a mandar quando existe: uma nota que nomeia
  // as jornadas a que se refere é mais precisa do que qualquer prazo.
  if (Array.isArray(note.events) && note.events.length > 0) {
    const inWindow = note.events.includes(currentEvent);
    return {
      applies: inWindow,
      state: inWindow ? "ativa" : "fora-de-jornada",
      detail: inWindow
        ? `aplica-se à GW${currentEvent}`
        : `só se aplica a ${note.events.map((e) => `GW${e}`).join(", ")}`,
      ageInEvents: age,
      lastEvent: Math.max(...note.events),
    };
  }

  if (age >= span) {
    return {
      applies: false,
      state: "expirada",
      detail: `escrita para a GW${note.writtenForEvent}, válida até à GW${lastEvent} — já passaram ${age} jornadas`,
      ageInEvents: age,
      lastEvent,
    };
  }

  return {
    applies: true,
    state: "ativa",
    detail:
      age === 0
        ? "escrita para esta jornada"
        : `escrita para a GW${note.writtenForEvent}, válida até à GW${lastEvent}`,
    ageInEvents: age,
    lastEvent,
  };
}

export interface TriagedInsights {
  /** As que o modelo pode usar. */
  active: TimedInsight[];
  /** As que existem e NÃO se aplicam, com o motivo. Mostradas na mesma —
   * uma nota que desaparece em silêncio é indistinguível de uma nota que
   * nunca existiu, e foi assim que este problema durou três semanas. */
  inactive: { note: TimedInsight; status: InsightStatus }[];
}

export function triageInsights(
  notes: TimedInsight[],
  currentEvent: number,
  now: Date = new Date()
): TriagedInsights {
  const active: TimedInsight[] = [];
  const inactive: { note: TimedInsight; status: InsightStatus }[] = [];
  for (const note of notes) {
    const status = insightStatus(note, currentEvent, now);
    if (status.applies) active.push(note);
    else inactive.push({ note, status });
  }
  return { active, inactive };
}
