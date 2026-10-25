import { NextResponse } from "next/server";
import { readExternalResearch, runExternalResearch } from "@/lib/externalresearch";
import { readOfficialScout, runOfficialScout } from "@/lib/officialscout";
import { getRedis } from "@/lib/kv";
import { startJobRun, finishJobRun } from "@/lib/joblog";

/** Read-only, public facts and provenance for operational smoke tests.
 * Never exposes research tokens, user identities, or Redis credentials. */
export const dynamic = "force-dynamic";
export async function GET() {
  let [external, official] = await Promise.all([readExternalResearch(), readOfficialScout()]);
  const nowForRefresh = Date.now();
  const stale = (at: string | undefined) =>
    !at || !Number.isFinite(Date.parse(at)) || nowForRefresh - Date.parse(at) > 18 * 3_600_000;
  // Public read-through cache for PUBLIC source data only. The lock prevents
  // repeat traffic if a cron stops or a visitor refreshes repeatedly.
  // Does not take user-controlled URLs or notes and never alters FPL advice.
  const redis = getRedis();
  let autoRecovered: string[] = [];
  if (redis && (stale(external?.at) || stale(official?.at))) {
    try {
      const acquired = await redis.set("fpl:research:readthrough-lock:v1", "1", { nx: true, ex: 900 });
      if (acquired === "OK") {
        const work = [
          ...(stale(external?.at) ? [{ job: "research" as const, execute: runExternalResearch }] : []),
          ...(stale(official?.at) ? [{ job: "officialscout" as const, execute: runOfficialScout }] : []),
        ];
        for (const job of work) {
          const run = await startJobRun(job.job, "manual");
          try {
            const result = await job.execute();
            await finishJobRun(run, {
              ok: result.ok,
              summary: result.summary,
              productive: result.ok ? result.productive : false,
              detail: { ...(result.detail ?? {}), via: "public-readthrough-cooldown" },
            });
            if (result.ok) autoRecovered.push(job.job);
          } catch (e) {
            await finishJobRun(run, { ok: false, summary: e instanceof Error ? e.message : "Falha desconhecida" });
          }
        }
        [external, official] = await Promise.all([readExternalResearch(), readOfficialScout()]);
      }
    } catch {
      // Cron remains primary. A failed fallback never breaks monitoring.
    }
  }
  const now = Date.now();
  const fresh = (at: string | undefined, hours: number) =>
    !!at && Number.isFinite(Date.parse(at)) &&
    now - Date.parse(at) >= 0 && now - Date.parse(at) <= hours * 3_600_000;
  return NextResponse.json({
    autoRecovered,
    external: {
      status: !external ? "not-run" : fresh(external.at, 48) ? "fresh" : "stale",
      lastRun: external?.at ?? null,
      mode: external?.mode ?? "editorial-feeds",
      sourcesChecked: external?.sourcesChecked ?? [],
      sourcesFailed: external?.sourcesFailed ?? [],
      findings: external?.findings.length ?? 0,
      // This is editorial discovery, not a synthesized expert judgment.
      changesModel: false,
    },
    official: {
      status: !official ? "not-run" : fresh(official.at, 48) ? "fresh" : "stale",
      lastRun: official?.at ?? null,
      gameweek: official?.event ?? null,
      checkedPlayers: official?.checkedPlayers ?? 0,
      findings: official?.items.length ?? 0,
      changesModel: false,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
