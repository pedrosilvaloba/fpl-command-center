import type { FplBootstrap, FplEntry, FplEntryHistoryEntry } from "./types";
import { getEntry, getEntryHistory, getEntryPicks } from "./fpl-client";

/**
 * The real state of a running team — the thing every recommendation in this
 * app should have been built on from the start, and was not.
 *
 * WHAT WAS WRONG
 * --------------
 * Until v1.25 the "Equipa Sugerida" panel built the mathematically optimal
 * fifteen players for £100.0m, from scratch, every gameweek. That answers a
 * question nobody in a running season can act on. FPL is a game of
 * CONTINUITY: you start with the squad you already have, you get one free
 * transfer a week (bankable up to five), each extra one costs four points,
 * and your budget is not £100m — it is whatever your squad is worth today
 * plus whatever is in the bank.
 *
 * So a panel showing eleven perfect players was, at best, a north star, and
 * at worst actively misleading: it silently assumed a budget the manager
 * does not have and a freedom of movement the rules do not allow.
 *
 * WHAT THIS MODULE ESTABLISHES
 * ----------------------------
 * Everything the transfer planner needs to work inside the real rules:
 * which fifteen players are owned, what each would actually SELL for, how
 * much is in the bank, how many free transfers are available, and which
 * chips are still unused.
 *
 * THE TWO HONEST APPROXIMATIONS
 * -----------------------------
 * 1. SELLING PRICE. FPL sells a player for what you paid plus half of any
 *    rise since (rounded down), so a player who has gone up £0.3m since you
 *    bought him sells for £0.1m less than his listed price. The public API
 *    does not publish purchase prices — only the authenticated `my-team`
 *    endpoint does, and this app deliberately does not log in.
 *
 *    What the public API DOES publish is `last_deadline_value`: the sum of
 *    all fifteen SELLING prices. That is enough to recover the total
 *    discount exactly, and to distribute it across the squad in proportion
 *    to how much each player has risen since the season started — capped per
 *    player at the most FPL's rule could possibly take. The total is
 *    therefore right; the split between players is an estimate, and is
 *    labelled as one.
 *
 * 2. WHICH SQUAD. FPL only serves a manager's picks for a gameweek whose
 *    deadline has passed, so the freshest public squad is last gameweek's.
 *    Transfers already made for the coming deadline are invisible. The
 *    planner therefore starts from last gameweek's squad unless the manager
 *    has told the app otherwise (see the Shadow Team), and says which it
 *    used.
 */

/** Free transfers cap under the 2025/26 rules onwards. */
const MAX_FREE_TRANSFERS = 5;
/** Points charged per transfer beyond the free allowance. */
export const HIT_COST_POINTS = 4;

/** Chips that make a gameweek's transfers free, so they consume no
 * accumulated free transfers. */
const UNLIMITED_TRANSFER_CHIPS = new Set(["wildcard", "freehit"]);

export interface OwnedPlayer {
  elementId: number;
  /** Listed price today, £m. */
  priceM: number;
  /** What FPL would actually pay you for him today, £m. */
  sellingPriceM: number;
  wasStarter: boolean;
  wasCaptain: boolean;
  wasViceCaptain: boolean;
}

export interface ChipStatus {
  name: string;
  label: string;
  usedAtEvents: number[];
  /** How many of this chip remain. */
  remaining: number;
}

export interface SquadState {
  available: boolean;
  reason: string | null;
  /** Gameweek the picks were read from. Always one whose deadline passed. */
  fromEvent: number | null;
  owned: OwnedPlayer[];
  bankM: number;
  /** Sum of the fifteen SELLING prices — i.e. FPL's `last_deadline_value`
   * with the bank taken back out of it. See the note in `buildSquadState`. */
  squadValueM: number;
  /** What the planner may spend in total: the squad's sale value plus the
   * bank. This is FPL's `last_deadline_value` unchanged, because that figure
   * already contains the bank. */
  totalBudgetM: number;
  sellingPriceIsEstimated: boolean;
  sellingPriceNote: string;
  freeTransfers: number;
  freeTransfersNote: string;
  chips: ChipStatus[];
  entryName: string | null;
  overallPoints: number;
  overallRank: number;
}

export const EMPTY_SQUAD_STATE: SquadState = {
  available: false,
  reason:
    "A FPL só publica o plantel de um gestor depois de uma jornada fechar — antes disso não há plantel real de onde partir.",
  fromEvent: null,
  owned: [],
  bankM: 0,
  squadValueM: 0,
  totalBudgetM: 100,
  sellingPriceIsEstimated: false,
  sellingPriceNote: "",
  freeTransfers: 1,
  freeTransfersNote:
    "Antes da primeira jornada fechar não há histórico de transferências para reconstruir — assumida uma transferência livre.",
  chips: [],
  entryName: null,
  overallPoints: 0,
  overallRank: 0,
};

// --------------------------------------------------------------------------
// Free transfers
// --------------------------------------------------------------------------

export interface FreeTransferResult {
  freeTransfers: number;
  note: string;
}

/**
 * Reconstructs how many free transfers are available for `forEvent`.
 *
 * FPL never publishes this number for another manager, but it is fully
 * determined by public history: you gain one free transfer per gameweek up
 * to a cap of five, and each transfer you make either spends one or costs
 * four points. `event_transfers_cost / 4` is exactly how many were paid for,
 * so `event_transfers − paid` is exactly how many free ones were spent.
 *
 * The two cases that would otherwise get this wrong are handled explicitly:
 * gameweek one (the initial squad is not a set of transfers) and any
 * gameweek where a Wildcard or Free Hit was played (transfers are unlimited
 * and free, and your saved transfers carry over untouched).
 */
export function reconstructFreeTransfers(
  history: FplEntryHistoryEntry[],
  chips: { name: string; event: number }[],
  forEvent: number
): FreeTransferResult {
  const chipByEvent = new Map(chips.map((c) => [c.event, c.name.toLowerCase()]));
  const played = [...history]
    .filter((h) => h.event < forEvent)
    .sort((a, b) => a.event - b.event);

  if (played.length === 0) {
    return {
      freeTransfers: 1,
      note: "Sem jornadas jogadas ainda — uma transferência livre por omissão.",
    };
  }

  // Free transfers available at the START of a gameweek. Gameweek 1 is the
  // initial squad; the first free transfer exists for gameweek 2.
  let ft = 1;
  const spent: string[] = [];
  for (const row of played) {
    if (row.event === 1) continue;
    const chip = chipByEvent.get(row.event);
    if (chip && UNLIMITED_TRANSFER_CHIPS.has(chip)) {
      // Chip gameweek: transfers are free and unlimited, saved ones survive.
      spent.push(`GW${row.event}: ${chip} (transferências não contaram)`);
    } else {
      const paid = Math.max(0, Math.round((row.event_transfers_cost ?? 0) / HIT_COST_POINTS));
      const usedFree = Math.max(0, (row.event_transfers ?? 0) - paid);
      if (usedFree > 0 || paid > 0) {
        spent.push(
          `GW${row.event}: ${row.event_transfers} transferência${row.event_transfers === 1 ? "" : "s"}` +
            (paid > 0 ? ` (${paid} paga${paid === 1 ? "" : "s"}, -${paid * HIT_COST_POINTS}pts)` : "")
        );
      }
      ft = Math.max(0, ft - usedFree);
    }
    // Next gameweek's allowance.
    ft = Math.min(MAX_FREE_TRANSFERS, ft + 1);
  }

  const recent = spent.slice(-4);
  const note =
    `Reconstruído a partir do histórico público: ganhas 1 por jornada (máx. ${MAX_FREE_TRANSFERS}), ` +
    `e cada transferência ou gasta uma ou custa ${HIT_COST_POINTS} pontos. ` +
    (recent.length > 0 ? `Últimas: ${recent.join(" · ")}.` : "Sem transferências registadas até agora.");

  return { freeTransfers: Math.min(MAX_FREE_TRANSFERS, Math.max(0, ft)), note };
}

// --------------------------------------------------------------------------
// Budget
// --------------------------------------------------------------------------

export interface BudgetBreakdown {
  bankM: number;
  squadValueM: number;
  totalBudgetM: number;
}

/**
 * Splits FPL's two money figures into the three numbers the planner needs.
 *
 * `last_deadline_value` INCLUDES THE BANK. Until v1.28.2 this file asserted
 * the opposite — in a comment, never checked — and then added the bank on top,
 * so the transfer planner was handed money that does not exist.
 *
 * The proof is in one real account's gameweek-1 data, before any transfer had
 * been made: value = 1000, bank = 15. Every manager starts with exactly
 * £100.0m. If `value` excluded the bank, the fifteen players would be worth
 * £100.0m and the total £101.5m — which nobody has ever had. So the squad is
 * worth £98.5m, and `value` is squad + bank.
 *
 * The consequence was reported from production: the planner believed it had
 * £101.5m against a real £100.0m and recommended a transfer that could not be
 * executed. That is the worst class of bug this project can have — advice you
 * cannot act on is worse than no advice, because it costs trust in everything
 * beside it.
 *
 * The same error fed `estimateSellingPrices` below, which reconciles listed
 * prices against the squad's true sale value: measuring the shortfall against
 * a total £1.5m too high understated every player's sale discount by exactly
 * the bank.
 *
 * This lives in its own exported function purely so it can be tested. The
 * arithmetic was wrong for as long as it was, in part, because it was three
 * lines buried inside a network call with no seam a test could reach.
 */
export function deriveBudget(
  lastDeadlineValueTenths: number | null | undefined,
  lastDeadlineBankTenths: number | null | undefined
): BudgetBreakdown {
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const total = Number.isFinite(lastDeadlineValueTenths as number)
    ? (lastDeadlineValueTenths as number) / 10
    : 100;
  const bank = Number.isFinite(lastDeadlineBankTenths as number)
    ? Math.max(0, (lastDeadlineBankTenths as number) / 10)
    : 0;
  const totalBudgetM = round1(total);
  // A bank larger than the reported total would mean the squad had negative
  // value, which is impossible; clamp rather than propagate nonsense.
  const bankM = round1(Math.min(bank, totalBudgetM));
  return {
    bankM,
    squadValueM: round1(totalBudgetM - bankM),
    totalBudgetM,
  };
}

// --------------------------------------------------------------------------
// Selling prices
// --------------------------------------------------------------------------

export interface SellingPriceResult {
  sellingPriceM: Map<number, number>;
  estimated: boolean;
  note: string;
}

/**
 * Splits FPL's published total squad value across the fifteen players.
 *
 * The total is exact (`last_deadline_value`). The split is not knowable
 * without purchase prices, so the shortfall against today's listed prices is
 * distributed in proportion to how much each player has risen since the
 * season began — the only public signal of who could be carrying a discount
 * at all — and capped per player at the largest discount FPL's rule could
 * produce for that rise.
 */
export function estimateSellingPrices(
  ownedIds: number[],
  priceByIdM: Map<number, number>,
  costChangeStartById: Map<number, number>,
  squadValueM: number
): SellingPriceResult {
  const sellingPriceM = new Map<number, number>();
  const listedTotal =
    Math.round(ownedIds.reduce((s, id) => s + (priceByIdM.get(id) ?? 0), 0) * 10) / 10;

  for (const id of ownedIds) sellingPriceM.set(id, priceByIdM.get(id) ?? 0);

  const shortfallM = Math.round((listedTotal - squadValueM) * 10) / 10;
  if (!(shortfallM > 0) || !(squadValueM > 0)) {
    return {
      sellingPriceM,
      estimated: false,
      note:
        "O valor publicado pela FPL coincide com a soma dos preços atuais — nenhum jogador está a carregar desconto de venda.",
    };
  }

  // Maximum discount FPL's own rule could apply to each player: half of the
  // rise since the season started, rounded up, in units of £0.1m.
  const capTenths = new Map<number, number>();
  let totalCap = 0;
  for (const id of ownedIds) {
    const rise = Math.max(0, costChangeStartById.get(id) ?? 0); // already in tenths
    const cap = Math.ceil(rise / 2);
    capTenths.set(id, cap);
    totalCap += cap;
  }

  let remainingTenths = Math.round(shortfallM * 10);
  if (totalCap > 0) {
    // Proportional first pass, then hand out any rounding remainder to the
    // players with the most room left, so the total lands exactly.
    const order = [...ownedIds].sort(
      (a, b) => (capTenths.get(b) ?? 0) - (capTenths.get(a) ?? 0)
    );
    for (const id of order) {
      if (remainingTenths <= 0) break;
      const cap = capTenths.get(id) ?? 0;
      if (cap <= 0) continue;
      const share = Math.min(
        cap,
        Math.round((cap / totalCap) * Math.round(shortfallM * 10))
      );
      const take = Math.min(share, remainingTenths);
      if (take > 0) {
        sellingPriceM.set(
          id,
          Math.round(((priceByIdM.get(id) ?? 0) - take / 10) * 10) / 10
        );
        remainingTenths -= take;
      }
    }
    for (const id of order) {
      if (remainingTenths <= 0) break;
      const cap = capTenths.get(id) ?? 0;
      const current = sellingPriceM.get(id) ?? 0;
      const alreadyTaken = Math.round(((priceByIdM.get(id) ?? 0) - current) * 10);
      const room = cap - alreadyTaken;
      if (room <= 0) continue;
      const take = Math.min(room, remainingTenths);
      sellingPriceM.set(id, Math.round((current - take / 10) * 10) / 10);
      remainingTenths -= take;
    }
  }

  return {
    sellingPriceM,
    estimated: true,
    note:
      `A FPL publica o valor total do plantel (£${squadValueM.toFixed(1)}m) mas não os preços de compra, ` +
      `por isso o desconto total de venda (£${shortfallM.toFixed(1)}m) é conhecido mas a divisão por jogador é estimada — ` +
      "repartida na proporção da subida de cada um desde o início da época, com o limite máximo que a regra da FPL permitiria. " +
      "O total está certo; a atribuição individual pode variar £0.1m.",
  };
}

// --------------------------------------------------------------------------
// Chips
// --------------------------------------------------------------------------

/** 2025/26 onwards: two of each chip, one usable in each half of the season. */
const CHIP_ALLOWANCE: Record<string, { label: string; total: number }> = {
  wildcard: { label: "Wildcard", total: 2 },
  freehit: { label: "Free Hit", total: 2 },
  bboost: { label: "Bench Boost", total: 2 },
  "3xc": { label: "Triple Captain", total: 2 },
};

export function summariseChips(chips: { name: string; event: number }[]): ChipStatus[] {
  const usedByName = new Map<string, number[]>();
  for (const c of chips) {
    const key = c.name.toLowerCase();
    usedByName.set(key, [...(usedByName.get(key) ?? []), c.event]);
  }
  return Object.entries(CHIP_ALLOWANCE).map(([name, meta]) => {
    const used = (usedByName.get(name) ?? []).sort((a, b) => a - b);
    return {
      name,
      label: meta.label,
      usedAtEvents: used,
      remaining: Math.max(0, meta.total - used.length),
    };
  });
}

// --------------------------------------------------------------------------
// Assembly
// --------------------------------------------------------------------------

/**
 * Loads everything needed to plan transfers inside the real rules. Never
 * throws — a failure here degrades to "no squad state", which the planner
 * reports honestly instead of quietly falling back to a £100m fantasy.
 */
export async function loadSquadState(
  teamId: number,
  bootstrap: FplBootstrap,
  lastFinishedEvent: number
): Promise<SquadState> {
  if (!Number.isFinite(teamId) || teamId <= 0 || lastFinishedEvent < 1) {
    return EMPTY_SQUAD_STATE;
  }
  let entry: FplEntry;
  let history: { current: FplEntryHistoryEntry[]; chips: { name: string; event: number }[] };
  let picks: Awaited<ReturnType<typeof getEntryPicks>>;
  try {
    [entry, history, picks] = await Promise.all([
      getEntry(teamId),
      getEntryHistory(teamId) as Promise<{
        current: FplEntryHistoryEntry[];
        chips: { name: string; event: number }[];
        past: unknown[];
      }>,
      getEntryPicks(teamId, lastFinishedEvent),
    ]);
  } catch {
    return {
      ...EMPTY_SQUAD_STATE,
      reason:
        "Não foi possível carregar o teu plantel na FPL neste momento. Sem ele, qualquer sugestão de transferência seria inventada.",
    };
  }

  if (!picks?.picks?.length) {
    return EMPTY_SQUAD_STATE;
  }

  const priceByIdM = new Map<number, number>();
  const costChangeStartById = new Map<number, number>();
  for (const el of bootstrap.elements) {
    priceByIdM.set(el.id, el.now_cost / 10);
    costChangeStartById.set(el.id, el.cost_change_start ?? 0);
  }

  const ownedIds = picks.picks.map((p) => p.element);
  const { bankM, squadValueM, totalBudgetM } = deriveBudget(
    entry.last_deadline_value,
    entry.last_deadline_bank
  );

  const selling = estimateSellingPrices(
    ownedIds,
    priceByIdM,
    costChangeStartById,
    squadValueM
  );

  const owned: OwnedPlayer[] = picks.picks.map((p) => ({
    elementId: p.element,
    priceM: priceByIdM.get(p.element) ?? 0,
    sellingPriceM: selling.sellingPriceM.get(p.element) ?? priceByIdM.get(p.element) ?? 0,
    wasStarter: p.multiplier > 0,
    wasCaptain: p.is_captain,
    wasViceCaptain: p.is_vice_captain,
  }));

  const ft = reconstructFreeTransfers(
    history.current ?? [],
    history.chips ?? [],
    lastFinishedEvent + 1
  );

  return {
    available: true,
    reason: null,
    fromEvent: lastFinishedEvent,
    owned,
    bankM,
    squadValueM,
    totalBudgetM,
    sellingPriceIsEstimated: selling.estimated,
    sellingPriceNote: selling.note,
    freeTransfers: ft.freeTransfers,
    freeTransfersNote: ft.note,
    chips: summariseChips(history.chips ?? []),
    entryName: entry.name ?? null,
    overallPoints: entry.summary_overall_points ?? 0,
    overallRank: entry.summary_overall_rank ?? 0,
  };
}
