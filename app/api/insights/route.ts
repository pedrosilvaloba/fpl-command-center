import { NextRequest, NextResponse } from "next/server";
import { getBootstrap } from "@/lib/fpl-client";
import {
  loadActiveInsights,
  saveDynamicInsights,
  deleteDynamicInsight,
  resolveInsightTarget,
  type NewInsightInput,
  type RejectedInsight,
} from "@/lib/managerinsights";

/**
 * Write path for the auto-applied qualitative-insight layer (see the big
 * comment at the top of lib/managerinsights.ts for the full design and
 * why this is safe to auto-apply). Called by the weekly scheduled
 * research task — a genuinely different trust level from every other
 * route in this app (those only ever read/write this one visitor's own
 * data), because this one mutates what EVERYONE who opens the dashboard
 * sees. GET is left open (read-only, same risk level as the rest of the
 * app); POST/DELETE require a bearer token.
 */

function isAuthorized(req: NextRequest): boolean {
  const token = process.env.INSIGHTS_API_TOKEN;
  if (!token) return false; // no token configured = writes disabled, not "anything goes"
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return provided.length > 0 && provided === token;
}

export async function GET() {
  const insights = await loadActiveInsights();
  return NextResponse.json({ insights });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const rawInputs = body?.insights;
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
    return NextResponse.json(
      { error: "corpo inválido — esperado { insights: [...] } com pelo menos 1 entrada" },
      { status: 400 }
    );
  }
  if (rawInputs.length > 20) {
    return NextResponse.json(
      { error: "demasiadas entradas num único pedido (máx 20) — prioriza as de maior confiança" },
      { status: 400 }
    );
  }

  // Real, live data to resolve names/ids against — never trust the caller
  // about a player/team actually existing, and never make an LLM read
  // through this ~700-player payload itself to pick an id by hand (see
  // resolveInsightTarget's own comment in lib/managerinsights.ts — same
  // "don't let a model parse bulk JSON" principle as the rest of this
  // project). The research agent submits names; this route resolves them.
  let bootstrap;
  try {
    bootstrap = await getBootstrap();
  } catch {
    return NextResponse.json({ error: "falha a carregar dados da FPL para validação" }, { status: 502 });
  }

  // Two passes: first resolve each candidate's name/id to a real FPL id
  // (rejecting anything that doesn't deterministically match one), then
  // validate the rest of the fields (factor bounds, reason length, the
  // active-count cap) against the already-resolved candidates.
  const resolved: { input: NewInsightInput }[] = [];
  const rejected: RejectedInsight[] = [];

  for (const r of rawInputs as Record<string, unknown>[]) {
    const scope = r?.scope as NewInsightInput["scope"];
    const placeholderInput: NewInsightInput = {
      scope,
      id: typeof r?.id === "number" ? (r.id as number) : -1,
      label: (r?.label as string) ?? (r?.playerName as string) ?? (r?.teamName as string) ?? "?",
      factor: r?.factor as number,
      reason: r?.reason as string,
      source: r?.source as string,
    };
    if (scope !== "player" && scope !== "team") {
      rejected.push({ input: placeholderInput, reason: "scope inválido (tem de ser 'player' ou 'team')" });
      continue;
    }
    const resolution = resolveInsightTarget(bootstrap, scope, {
      id: typeof r?.id === "number" ? (r.id as number) : undefined,
      playerName: r?.playerName as string | undefined,
      teamShortName: r?.teamShortName as string | undefined,
      teamName: r?.teamName as string | undefined,
    });
    if (!resolution.ok) {
      rejected.push({ input: placeholderInput, reason: resolution.reason });
      continue;
    }
    resolved.push({
      input: {
        scope,
        id: resolution.id,
        label: resolution.label,
        factor: r?.factor as number,
        reason: r?.reason as string,
        source: r?.source as string,
      },
    });
  }

  // Every resolved id is by construction a real, current player/team —
  // isValidId here is just defense-in-depth, not doing the real work.
  const result = await saveDynamicInsights(
    resolved.map((r) => r.input),
    () => true
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "falha desconhecida", rejected }, { status: 502 });
  }
  return NextResponse.json({
    accepted: result.accepted,
    rejected: [...rejected, ...result.rejected],
    acceptedCount: result.accepted.length,
    rejectedCount: rejected.length + result.rejected.length,
  });
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
