import { NextResponse } from "next/server";
import { getJobHealth, getJobLog, mergeResearchHealth } from "@/lib/joblog";
import { getLastResearchRun } from "@/lib/managerinsights";
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
  const [health, log, research] = await Promise.all([
    getJobHealth(),
    getJobLog(15),
    getLastResearchRun(),
  ]);

  // Reported, never echoed. Whether the secret EXISTS is the thing that
  // silently breaks the daily job; its value is nobody's business.
  const cronSecretConfigured = (process.env.CRON_SECRET ?? "").trim().length > 0;

  return NextResponse.json({
    storageConfigured: storage,
    cronSecretConfigured,
    // The research job writes its own record through a different path
    // (lib/managerinsights), because it predates the run log and because it
    // records what it FOUND, not just that it ran. Surfaced alongside so one
    // request answers "is anything silently dead".
    research: research
      ? {
          at: research.at,
          daysAgo: Math.floor((Date.now() - new Date(research.at).getTime()) / 86_400_000),
          acceptedCount: research.acceptedCount,
          rejectedCount: research.rejectedCount,
        }
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
