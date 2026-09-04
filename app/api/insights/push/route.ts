import { NextRequest, NextResponse } from "next/server";
import { inflateSync, gunzipSync } from "node:zlib";
import {
  processInsightSubmission,
  decodeCompressedPayload,
  MAX_PAYLOAD_CHARS,
} from "@/lib/insightsintake";
import { checkApiToken, unauthorizedBody } from "@/lib/apitoken";

/**
 * The GET-shaped write path for the weekly tactical research.
 *
 * Read the header comment in lib/insightsintake.ts first — it explains why a
 * mutating GET exists here at all. The short version: the scheduled research
 * session runs behind a proxy that refuses every host except a small
 * allowlist, so it physically cannot POST to this app. The one network
 * capability it does have issues GET requests.
 *
 * ═══ v1.39 — WHY THE RESEARCH LAYER HAD BEEN SILENT FOR WEEKS ═══
 *
 * The dashboard showed the research job as "vazia": it ran, it recorded
 * itself, and it submitted zero notes. The temptation was to conclude that a
 * Premier League week had produced nothing worth reporting, which is not
 * credible. The run left its own diagnosis in the note field instead:
 *
 *     "Push c/ insights reais falha (URL longo). So vazio funciona."
 *
 * The research was finding things. It was trying to send them. And the
 * submission was failing ON SIZE — six to ten findings, each with a reason
 * and a source, URL-encoded into a query string, blows past what a request
 * line will carry. The empty submission fit, so the empty submission was the
 * only thing that ever arrived.
 *
 * That is my bug, not the research's. A write path that only works for
 * payloads carrying no information is not a write path.
 *
 * THE FIX: accept the payload COMPRESSED. `payloadz` takes the same JSON,
 * deflated and base64url-encoded. Insight JSON is repetitive prose and
 * compresses four to five times, so a submission that could not fit now fits
 * with room to spare, in one request, with no chunking protocol to get wrong.
 *
 * The uncompressed `payload` still works, because an empty or tiny submission
 * has no reason to compress anything.
 *
 * Sending side (Python, in the scheduled session):
 *
 *     import base64, json, urllib.parse, zlib
 *     raw = json.dumps(payload, ensure_ascii=False).encode()
 *     z = base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode()
 *     url = ".../api/insights/push?" + urllib.parse.urlencode(
 *         {"token": TOKEN, "payloadz": z})
 *
 * WHAT MAKES THIS DIFFERENT FROM THE LAST FIX. The failure was invisible for
 * weeks because a submission that never arrived and a research pass that
 * found nothing look identical from here. The size check now answers with the
 * actual number of characters and the actual limit, and names `payloadz` in
 * the error — so the next time this wall is hit, the wall says what it is.
 */

// This route writes. It must never be cached, prerendered, or deduplicated.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = checkApiToken(req.nextUrl.searchParams.get("token"));
  if (!auth.ok) {
    return NextResponse.json(unauthorizedBody(auth), { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const compressed = params.get("payloadz");
  const plain = params.get("payload");

  if (!compressed && !plain) {
    return NextResponse.json(
      {
        error:
          "falta 'payload' (JSON codificado para URL) ou 'payloadz' (o mesmo JSON comprimido com zlib e em base64url). Para mais do que duas ou três notas usa 'payloadz' — o JSON em bruto não cabe no URL.",
      },
      { status: 400 }
    );
  }

  let json: string;
  if (compressed) {
    const decoded = decodeCompressedPayload(compressed, inflateSync, gunzipSync);
    if (!decoded.ok) {
      return NextResponse.json({ error: decoded.error }, { status: 400 });
    }
    json = decoded.json;
  } else {
    if (plain!.length > MAX_PAYLOAD_CHARS) {
      return NextResponse.json(
        {
          error: `payload demasiado longo (${plain!.length} caracteres, máx ${MAX_PAYLOAD_CHARS}). NÃO envies menos notas por causa disto — comprime-as: manda o mesmo JSON em 'payloadz' (zlib + base64url), que comprime cerca de quatro vezes. Enviar menos informação porque o transporte é estreito foi exatamente o que manteve esta camada em silêncio durante semanas.`,
          limit: MAX_PAYLOAD_CHARS,
          received: plain!.length,
          use: "payloadz",
        },
        { status: 413 }
      );
    }
    json = plain!;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
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
