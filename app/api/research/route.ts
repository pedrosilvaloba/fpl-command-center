import { NextResponse } from "next/server";
import { readExternalResearch } from "@/lib/externalresearch";
import { readOfficialScout } from "@/lib/officialscout";

/** Read-only, public facts and provenance for operational smoke tests.
 * Never exposes research tokens, user identities, or Redis credentials. */
export const dynamic = "force-dynamic";
export async function GET() {
  const [external, official] = await Promise.all([readExternalResearch(), readOfficialScout()]);
  const now = Date.now();
  const fresh = (at: string | undefined, hours: number) =>
    !!at && Number.isFinite(Date.parse(at)) &&
    now - Date.parse(at) >= 0 && now - Date.parse(at) <= hours * 3_600_000;
  return NextResponse.json({
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
