import { NextResponse } from "next/server";
import { getMinuteABHistory, judgeMinuteExperiment } from "@/lib/minutebenchmark";
import { getForwardHistory } from "@/lib/forwardbenchmark";
import { getDecisionHistory } from "@/lib/decisions";

/** Public, aggregate-only evidence status: no manager identifiers, player
 * picks, notes, credentials or private team state. */
export const dynamic = "force-dynamic";
export async function GET() {
  const [minutes,forward,decisions] = await Promise.all([
    getMinuteABHistory(),getForwardHistory(),getDecisionHistory(),
  ]);
  const verdict=judgeMinuteExperiment(minutes.results);
  const captain=forward.rows.filter(r=>
    r.captain.model && r.captain.ppg && r.captain.fpl
  );
  const sum=(key:"model"|"ppg"|"fpl")=>
    captain.reduce((s,r)=>s+(r.captain[key]?.points??0),0);
  const reliable=decisions.rows.filter(r=>
    r.outcome?.settlement &&
    Math.abs(r.outcome.settlement.officialDelta)<=1
  );
  return NextResponse.json({
    status:"experimental",
    minutes:{
      pairedGameweeks:verdict.events,
      promotionStatus:verdict.status,
      meanMAEImprovement:Math.round(verdict.meanGainMinutes*100)/100,
      intervalLow:verdict.confidenceLow,
      intervalHigh:verdict.confidenceHigh,
      participationBrierImprovement:verdict.meanGainBrier,
      pendingGWs:minutes.pending,
      note:verdict.rationale,
    },
    captain:{
      pairedGameweeks:captain.length,
      modelBasePoints:sum("model"),
      fplBaselineBasePoints:sum("fpl"),
      ppgBaselineBasePoints:sum("ppg"),
      verifiedAdvantage:captain.length>=12 ? "requires-practical-and-statistical-review" : "insufficient-data",
    },
    transfers:{
      verifiedSimulationGameweeks:reliable.length,
      totalSimulatedGainAgainstUser:decisions.totalDiff,
      verdict:"not-causal-proof",
      note:"Simulações contrafactuais não certificam viabilidade de todas as decisões futuras.",
    },
    source:"frozen-predeadline-experiments",
    updatedAt:new Date().toISOString(),
  },{headers:{"Cache-Control":"no-store"}});
}
