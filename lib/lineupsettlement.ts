/**
 * Preview settlement against completed FPL live event data.
 * This is a what-if calculation, not an execution of transfers or chips.
 * No actual-points information is used to CHOOSE the squad before deadline.
 */
export interface SimulatedPlayer {
  id: number;
  position: 1 | 2 | 3 | 4;
  minutes: number;
  points: number;
}

export interface SimulatedLineup {
  points: number;
  captainUsed: number | null;
  subs: { inId: number; outId: number }[];
  counted: number[];
  reliable: boolean;
  reason: string;
}

const minByPosition: Record<number, number> = { 1: 1, 2: 3, 3: 2, 4: 1 };
const maxByPosition: Record<number, number> = { 1: 1, 2: 5, 3: 5, 4: 3 };

/** FPL's bench order must be given as published: the reserve GK and then
 * three ordered outfield substitutes. It is okay if reserve GK is last in
 * the array: we identify by player position, never list index. */
export function simulateLineup(input: {
  xi: number[];
  bench: number[];
  captain: number | null;
  vice: number | null;
  chip?: string | null;
  hitCost?: number;
  players: Map<number, SimulatedPlayer>;
}): SimulatedLineup {
  const { xi, bench, captain, vice, players } = input;
  const invalid = (reason: string): SimulatedLineup => ({
    points: 0, captainUsed: null, subs: [], counted: [], reliable: false, reason,
  });
  if (xi.length !== 11 || bench.length !== 4 ||
      new Set([...xi, ...bench]).size !== 15) return invalid("Plantel incompleto ou duplicado");
  const all = [...xi, ...bench].map((id) => players.get(id));
  if (all.some((p) => !p || !Number.isFinite(p.minutes) ||
      !Number.isFinite(p.points) || p.minutes < 0)) return invalid("Estatísticas de minutos/pontos indisponíveis");
  const byId = new Map(all.map((p) => [p!.id, p!] as const));
  const position = (id: number) => byId.get(id)!.position;
  const played = (id: number) => byId.get(id)!.minutes > 0;
  const active = [...xi];
  const formation = (ids: number[]) => {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const id of ids) {
      const pos = position(id);
      if (![1, 2, 3, 4].includes(pos)) return false;
      counts[pos]++;
    }
    return [1, 2, 3, 4].every((pos) =>
      counts[pos as 1 | 2 | 3 | 4] >= minByPosition[pos] &&
      counts[pos as 1 | 2 | 3 | 4] <= maxByPosition[pos]
    );
  };
  if (!formation(active)) return invalid("Formação de titulares inválida");
  const subs: SimulatedLineup["subs"] = [];

  if (input.chip !== "bboost") {
    // Reserve GK only replaces an absent starting GK.
    const reserveKeeper = bench.find((id) => position(id) === 1);
    const starterKeeper = active.find((id) => position(id) === 1);
    if (reserveKeeper && starterKeeper && !played(starterKeeper) && played(reserveKeeper)) {
      active[active.indexOf(starterKeeper)] = reserveKeeper;
      subs.push({ inId: reserveKeeper, outId: starterKeeper });
    }
    // FPL considers outfield substitutes in bench order. Each may take the
    // place of a starter with zero minutes only if the resulting XI is legal.
    for (const candidate of bench) {
      if (position(candidate) === 1 || !played(candidate)) continue;
      const missing = active.filter((id) => !played(id) && position(id) !== 1);
      for (const absent of missing) {
        const trial = active.map((id) => id === absent ? candidate : id);
        if (!formation(trial)) continue;
        active.splice(active.indexOf(absent), 1, candidate);
        subs.push({ inId: candidate, outId: absent });
        break;
      }
    }
  }

  const captainUsed = captain && played(captain)
    ? captain : vice && played(vice) ? vice : null;
  // A reserve substituted in for a player who did not appear remains eligible
  // for captaincy only if the FPL vice logic picks them and they played.
  let points = active.reduce((s, id) => s + byId.get(id)!.points, 0);
  if (input.chip === "bboost") {
    points += bench.reduce((s, id) => s + byId.get(id)!.points, 0);
  }
  if (captainUsed) {
    const mult = input.chip === "3xc" ? 3 : 2;
    points += (mult - 1) * (byId.get(captainUsed)?.points ?? 0);
  }
  points -= input.hitCost ?? 0;
  return { points, captainUsed, subs, counted: active, reliable: true,
    reason: "Simulação após o jogo; sujeita a regras e dados oficiais dos chips" };
}
