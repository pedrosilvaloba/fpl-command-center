import { NextResponse } from "next/server";
import { getJobHealth, getJobLog, mergeResearchHealth } from "@/lib/joblog";
import { getLastResearchRun } from "@/lib/managerinsights";
import { readExternalResearch } from "@/lib/externalresearch";
import { isStorageConfigured } from "@/lib/kv";

/**
 * What the automation actually did, and when it last worked.
 *
 * Open, like the rest of the read paths here: it exposes timestamps and
 * aggregate model-accuracy numbers about this app's own jobs, nothing about
 * anyone's team. Deliberately readable by a machine as well as a person, so a
 * scheduled session can check whether it is even needed before doing work.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const storage = isStorageConfigured();
  const [health, log, research, editorial] = await Promise.all([
    getJobHealth(),
    getJobLog(15),
    getLastResearchRun(),
    readExternalResearch(),
  ]);

  // Reported, never echoed. Whether the secret EXISTS is the thing that
  // silently breaks the daily job; its value is nobody's business.
  const cronSecretConfigured = (process.env.CRON_SECRET ?? "").trim().length > 0;

  return NextResponse.json({
    storageConfigured: storage,
    cronSecretConfigured,
    // Editorial RSS monitoring is autonomous. The 2026-09-08 note was a
    // manually delivered qualitative observation, not a current agent run.
    research: {
      mode: "editorial-feeds",
      status: !editorial ? "not-run" :
        (Date.now() - Date.parse(editorial.at) <= 48 * 3_600_000 ? "fresh" : "stale"),
      at: editorial?.at ?? null,
      sourcesChecked: editorial?.sourcesChecked.length ?? 0,
      sourcesFailed: editorial?.sourcesFailed ?? [],
      findings: editorial?.findings.length ?? 0,
      affectsModel: false,
    },
    legacyManualExpertResearch: research
      ? { at: research.at, acceptedCount: research.acceptedCount, rejectedCount: research.rejectedCount }
      : null,
    jobs: mergeResearchHealth(health, research),
    log,
    hint: !storage
      ? "Sem armazenamento configurado não há registo nenhum de execuções — nem sucessos nem falhas."
      : !cronSecretConfigured
        ? "CRON_SECRET não está definida: a tarefa diária da Vercel vai receber 401 todos os dias sem dizer nada. Define-a nas Environment Variables e faz Redeploy."
        : null,
  });
}
