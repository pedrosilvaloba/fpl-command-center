import type { ForwardResult } from "./forwardbenchmark";

/** Compare only identical, preselected, settled owner-week captain cohorts. */
export function auditCaptainBaselines(rows: ForwardResult[]) {
  const seen = new Set<number>();
  const paired = rows.filter(r => {
    if (seen.has(r.event)) return false;
    seen.add(r.event);
    return Number.isFinite(Date.parse(r.capturedAt)) &&
      Number.isFinite(Date.parse(r.settledAt)) &&
      Date.parse(r.capturedAt) < Date.parse(r.settledAt) &&
      ["model", "ppg", "fpl"].every(k => {
        const c = r.captain[k as "model"|"ppg"|"fpl"];
        return !!c && Number.isSafeInteger(c.id) && Number.isFinite(c.points);
      });
  });
  const difference = (base: "ppg"|"fpl") => paired.map(r =>
    r.captain.model!.points - r.captain[base]!.points);
  const summarize = (base: "ppg"|"fpl") => {
    const diffs = difference(base);
    return { n:diffs.length, totalNetExtraCaptainPoints:diffs.reduce((a,b)=>a+b,0),
      meanNetExtraCaptainPoints:diffs.length?diffs.reduce((a,b)=>a+b,0)/diffs.length:null,
      won:diffs.filter(d=>d>0).length, lost:diffs.filter(d=>d<0).length,
      tied:diffs.filter(d=>d===0).length };
  };
  return {
    pairedGameweeks:paired.length,
    againstPPG:summarize("ppg"), againstOfficialFPL:summarize("fpl"),
    verdict:paired.length<12?"insufficient-data":"descriptive-only",
    note:"Compara o candidato de maior previsao do modelo com PPG e ep_next no plantel arquivado; NAO e necessariamente o capitao recomendado pela interface, nem demonstra causalidade.",
  };
}
