/**
 * Avaliação offline do modelo: corre o backtest real com várias
 * configurações e imprime as métricas lado a lado.
 *
 *   npx tsx scripts/eval-model.ts [amostra]
 *
 * Precisa de acesso à API da FPL. Não escreve nada.
 */
import { loadSeason, chooseSample, mapWithLimit } from "../lib/jobs";
import { getElementSummary } from "../lib/fpl-client";
import { runBacktest, type ElementHistoryRow } from "../lib/backtest";
import { ratesFromHistoryPast, type LastSeasonTable } from "../lib/lastseason";
import type { ModelParams } from "../lib/modelparams";

async function main() {
  const sampleSize = Number(process.argv[2] ?? 250);
  const season = await loadSeason();
  const sample = chooseSample(season.bootstrap.elements, sampleSize);
  const history = new Map<number, ElementHistoryRow[]>();
  const last: LastSeasonTable = new Map();
  await mapWithLimit(sample, 8, async (el) => {
    try {
      const s = await getElementSummary(el.id);
      const h = (s.history ?? []) as ElementHistoryRow[];
      if (h.length > 0) history.set(el.id, h);
      const r = ratesFromHistoryPast(s.history_past ?? [], el.element_type);
      if (r) last.set(el.id, r);
    } catch {
      /* ignora */
    }
  });
  console.log(`amostra ${history.size} jogadores, época passada para ${last.size}; jornadas 2-${season.lastFinished}`);
  const variants: [string, Partial<ModelParams>, boolean][] = [
    ["atual", {}, false],
    ["preco 1", { pricePriorWeight: 1 }, false],
    ["epoca 1", { lastSeasonShare: 1 }, true],
    ["preco 1 + epoca 0.8", { pricePriorWeight: 1, lastSeasonShare: 0.8 }, true],
    ["preco 1 + epoca 1", { pricePriorWeight: 1, lastSeasonShare: 1 }, true],
    ["preco1+epoca0.8 k x2", { pricePriorWeight: 1, lastSeasonShare: 0.8, shrinkXg: 6, shrinkXa: 6, shrinkBonus: 9, shrinkDc: 9 }, true],
    ["preco1+epoca0.8 k x3", { pricePriorWeight: 1, lastSeasonShare: 0.8, shrinkXg: 9, shrinkXa: 9, shrinkBonus: 14, shrinkDc: 14 }, true],
  ];
  const f = (x: number) => x.toFixed(3);
  console.log("variante | MAE | base MAE | viés | Spearman | base Sp | inclinação | incl. titulares | lift decil | capitão top10 | MAE confiança alta | Sp conf. alta");
  for (const [name, params, useLast] of variants) {
    const r = runBacktest({
      bootstrap: season.bootstrap,
      fixtures: season.fixtures,
      historyByElement: history,
      fromEvent: 2,
      toEvent: season.lastFinished,
      modelParams: params,
      lastSeason: useLast ? last : undefined,
    });
    const m = r.metrics;
    const h = r.highTrustMetrics;
    console.log(
      [name, f(m.mae), f(m.baselineMae), f(m.bias), f(m.spearman), f(m.baselineSpearman), f(m.regression.slope), f(m.nailedRegression?.slope ?? NaN), f(m.decileLift), f(m.captainTop10Rate), f(h.mae), f(h.spearman)].join(" | ")
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
