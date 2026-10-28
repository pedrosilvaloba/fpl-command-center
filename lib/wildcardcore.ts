import type { ScoredPlayer } from "./recommend";

/** Default anchor for Wildcard only. A high-scoring premium cannot be silently
 * discarded because the experimental forecasting engine rates him too low.
 * Final inclusion must still pass FPL budget, formation and club constraints. */
export function wildcardCoreHaaland(scored: ScoredPlayer[], owned: Set<number>): number[] {
  const haaland = scored.find(p =>
    p.element.element_type === 4 &&
    /\bhaaland\b/i.test(p.element.web_name) &&
    Number(p.element.total_points) > 0 &&
    !owned.has(p.element.id)
  );
  return haaland ? [haaland.element.id] : [];
}
