import { NextRequest, NextResponse } from "next/server";
import { getBootstrap } from "@/lib/fpl-client";
import {
  loadActiveInsights,
  deleteDynamicInsight,
  getLastResearchRun,
} from "@/lib/managerinsights";
import { processInsightSubmission } from "@/lib/insightsintake";

/**
 * Read and write path for the auto-applied qualitative-insight layer (see the
 * header comment in lib/managerinsights.ts for the design, and
 * lib/insightsintake.ts for why a second, GET-shaped write path exists at
 * /api/insights/push).
 *
 * GET is open — read-only, same risk level as the rest of this single-user
 * app. POST and DELETE require the bearer token, because they mutate what the
 * dashboard shows and what the scoring engine applies.
 */

// Reads live state; must not be served from a build-time snapshot or a stale
// edge cache. A cached response here reported "storage not configured" long
// after storage was working, which sent a debugging session in exactly the
// wrong direction.
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const token = process.env.INSIGHTS_API_TOKEN;
  if (!token) return false; // no token configured = writes disabled
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return provided.length > 0 && provided === token;
}

export async function GET() {
  // Loading WITH a bootstrap matters: the hand-curated notes identify their
  // targets by name and are resolved against live FPL data. Called without
  // one — as this route did until v1.26 — every static note silently
  // disappeared from the response, which made the API look empty while the
  // dashboard showed notes.
  let bootstrap;
  try {
    bootstrap = await getBootstrap();
  } catch {
    bootstrap = undefined;
  }
  const [insights, lastRun] = await Promise.all([
    loadActiveInsights(bootstrap),
    getLastResearchRun(),
  ]);

  // How long the layer has been silent. A research pass that never reaches
  // this app leaves no trace at all, so the absence of a run is the signal
  // — and it needs to be readable by the pass itself, not just by a human
  // looking at the dashboard.
  const daysSinceLastRun = lastRun
    ? Math.floor((Date.now() - new Date(lastRun.at).getTime()) / 86_400_000)
    : null;

  return NextResponse.json({
    insights,
    lastRun,
    daysSinceLastRun,
    storageWorking: true,
    hint:
      lastRun === null
        ? "Nenhuma execução alguma vez registada. Se a tarefa semanal já disparou, falhou antes de conseguir escrever — usa /api/insights/push?token=...&payload=... que funciona com um GET simples."
        : null,
  });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const result = await processInsightSubmission(body);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }
  const key = req.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "parâmetro 'key' em falta" }, { status: 400 });
  }
  const result = await deleteDynamicInsight(key);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "falha desconhecida" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
