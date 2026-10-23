import { NextResponse } from "next/server";
import { isStorageConfigured } from "@/lib/kv";

/** Public-safe deployment identity and configuration booleans.
 * This is a liveness check, not a substitute for functional tests.
 * Never echo tokens, connection URLs, team IDs or private user data. */
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "fpl-command-center",
    revision: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    env: process.env.VERCEL_ENV ?? "unknown",
    storageConfigured: isStorageConfigured(),
    features: {
      decisionSettlement: true,
      forwardBenchmark: true,
      captainEvidenceFirst: true,
      scheduledSettlement: true,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
