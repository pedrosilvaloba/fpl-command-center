import { NextRequest, NextResponse } from "next/server";
import {
  processInsightSubmission,
  MAX_PAYLOAD_CHARS,
} from "@/lib/insightsintake";

/**
 * The GET-shaped write path for the weekly tactical research.
 *
 * Read the header comment in lib/insightsintake.ts first — it explains why a
 * mutating GET exists here at all, and what it costs. The short version: the
 * scheduled research session runs behind a proxy that refuses every host
 * except a small allowlist, so it physically cannot POST to this app. The one
 * network capability it does have issues GET requests. Every weekly run since
 * this feature shipped died at that wall and had no way to say so.
 *
 * Usage (from a scheduled session, via its web-fetch tool):
 *
 *   https://<app>/api/insights/push?token=<INSIGHTS_API_TOKEN>&payload=<url-encoded JSON>
 *
 * where the JSON is the same body the POST path takes:
 *
 *   {"note":"...","insights":[ ... ]}
 *
 * An empty `insights` array is a valid, useful submission — it records that
 * the research ran and found nothing, which is the exact distinction the
 * panel could not make before.
 */

// This route writes. It must never be cached, prerendered, or deduplicated.
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.INSIGHTS_API_TOKEN;
  // No token configured means writes are disabled, not that anything goes.
  if (!expected) return false;
  const provided = req.nextUrl.searchParams.get("token") ?? "";
  return provided.length > 0 && provided === expected;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      {
        error:
          "não autorizado — falta o parâmetro 'token' ou não corresponde a INSIGHTS_API_TOKEN",
      },
      { status: 401 }
    );
  }

  const payload = req.nextUrl.searchParams.get("payload");
  if (!payload) {
    return NextResponse.json(
      {
        error:
          "falta o parâmetro 'payload' — JSON codificado para URL, no formato {\"note\":\"...\",\"insights\":[...]}",
      },
      { status: 400 }
    );
  }
  if (payload.length > MAX_PAYLOAD_CHARS) {
    return NextResponse.json(
      {
        error: `payload demasiado longo (${payload.length} caracteres, máx ${MAX_PAYLOAD_CHARS}) — envia menos notas por pedido`,
      },
      { status: 413 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return NextResponse.json(
      { error: "payload não é JSON válido depois de descodificado" },
      { status: 400 }
    );
  }

  const result = await processInsightSubmission(
    parsed as { note?: unknown; insights?: unknown }
  );
  return NextResponse.json(result.body, { status: result.status });
}
