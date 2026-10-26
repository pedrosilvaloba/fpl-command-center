import { NextResponse } from "next/server";
import { getMinuteABHistory, judgeMinuteExperiment } from "@/lib/minutebenchmark";
import { getForwardHistory } from "@/lib/forwardbenchmark";
import { getDecisionHistory } from "@/lib/decisions";
import { auditFrozenDecisions } from "@/lib/decisionquality";
import { getBootstrap } from "@/lib/fpl-client";

/** Public, aggregate-only evidence status: no manager identifiers, player
 * picks, notes, credentials or private team state. */
export const dynamic = "force-dynamic";
export async function GET() {
  const [minutes,forward,decisions] = await Promise.all([
    getMinuteABHistory(),getForwardHistory(),getDecisionHistory(),
  ]);
  // Use FPL deadlines exclusively to validate archived predeadline advice.
  // A missing upstream deadline never authorizes a comparison.
  let deadlines = new Map<number, string>();
  try {
    const bootstrap = await getBootstrap();
    deadlines = new Map(bootstrap.events
      .filter(e => typeof e.deadline_time === "string")
      .map(e => [e.id, e.deadline_time]));
  } catch { /* fail closed */ }
  const decisionAudit = auditFrozenDecisions(decisions.rows.flatMap(r => {
    const deadlineIso = deadlines.get(r.event);
    return r.advice && r.outcome && deadlineIso
      ? [{ advice: r.advice, outcome: r.outcome, deadlineIso }]
      : [];
  }));
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
    decisionQuality: {
      inspected: decisionAudit.inspected,
      eligibleGameweeks: decisionAudit.eligible,
      excluded: decisionAudit.excluded,
      meanGainVsHold: decisionAudit.meanGainVsHold,
      totalGainVsHold: decisionAudit.totalGainVsHold,
      positiveWeeks: decisionAudit.positiveWeeks,
      negativeWeeks: decisionAudit.negativeWeeks,
      verdict: decisionAudit.verdict,
      missingDeadlineOrRecord: decisions.rows.length - decisionAudit.inspected,
      note: "Contrafactual descritivo contra manter a equipa; nao prova superioridade estatistica nem a legalidade historica de todas as transferencias.",
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
