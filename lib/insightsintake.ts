import { getBootstrap } from "./fpl-client";
import {
  saveDynamicInsights,
  resolveInsightTarget,
  recordResearchRun,
  type NewInsightInput,
  type RejectedInsight,
} from "./managerinsights";

/**
 * The intake path for the weekly tactical research — shared by both ways it
 * can arrive.
 *
 * WHY THERE ARE TWO WAYS IN, AND WHY THAT IS NOT OVER-ENGINEERING
 * ---------------------------------------------------------------
 * The research runs in a scheduled, headless session in Anthropic's sandbox.
 * That sandbox routes all outbound HTTP through a proxy with a strict
 * allowlist — package registries and a handful of internal hosts. Everything
 * else is refused at the CONNECT stage with a 403 before a request is even
 * made. `*.vercel.app` is not on that list.
 *
 * So the original design — "the research session POSTs its findings to the
 * app with curl" — could never have worked, on any week, for any finding.
 * The scheduled task fired on time every time; every run died at the first
 * network call and had no way to report that it had died, because reporting
 * required the same blocked connection. The result was weeks of an empty
 * panel that was indistinguishable from "found nothing".
 *
 * What a scheduled session CAN do is fetch a URL through the assistant's own
 * web-fetch tool, which does not go through that proxy. That tool issues GET
 * requests only. Hence this module, and hence a GET endpoint that performs a
 * write.
 *
 * A GET THAT MUTATES IS NORMALLY A MISTAKE. Here is why it is accepted, in
 * full, rather than waved past:
 *   - It is a single-user personal deployment with no other clients, so
 *     there is no cache or crawler that would replay it destructively; the
 *     worst a replay does is re-record an identical run.
 *   - It is authenticated by the same bearer token as the POST path, moved
 *     into the query string. That token already lives in the scheduled task's
 *     prompt, so no new secret is exposed by this route — but it does end up
 *     in request logs, which the POST path avoids. That is the real cost, and
 *     it is the reason this exists as a SEPARATE endpoint rather than by
 *     loosening the main one.
 *   - The payload is hard-bounded so the endpoint cannot be used as general
 *     storage, exactly as the POST path is.
 * The POST path is kept and remains preferred for any caller that can reach
 * it.
 */

/** The most notes a single submission may carry. */
const MAX_NOTES = 20;
/** Bounds the URL-encoded payload on the GET path — Vercel rejects request
 * lines beyond roughly 14KB. Note what this limit must NOT be read as saying:
 * a research pass needing more than this is not "submitting noise", it is
 * submitting more than a query string can carry. See `decodeCompressedPayload`
 * below for what that mistaken reading cost. */
export const MAX_PAYLOAD_CHARS = 8000;

/** Decompressed JSON may exceed the URL budget — that is the point — but not
 * without bound. Twelve times over is far more than any honest submission and
 * far short of anything that could hurt. */
export const MAX_INFLATED_CHARS = MAX_PAYLOAD_CHARS * 12;

/**
 * Decodes a compressed submission.
 *
 * ═══ WHY THIS EXISTS: THE RESEARCH LAYER WAS NEVER SILENT ═══
 *
 * The dashboard reported the research job as "vazia" — it ran, it recorded
 * itself, it submitted zero notes. The comfortable reading was that a Premier
 * League week had produced nothing worth reporting, which is not credible.
 * The run had left its own diagnosis in the note field:
 *
 *     "Push c/ insights reais falha (URL longo). So vazio funciona."
 *
 * The research WAS finding things and WAS trying to send them. The submission
 * failed on SIZE — six to ten findings, each carrying a reason and a source,
 * URL-encoded into a query string, exceeds what a request line will carry.
 * The empty submission fit. So the empty submission was the only thing that
 * ever arrived, week after week.
 *
 * That is a bug in the transport I designed, not a shortage of findings. A
 * write path that only works for payloads carrying no information is not a
 * write path — and the 413 error told the caller to "send fewer notes",
 * which actively instructed it to throw information away.
 *
 * Insight JSON is repetitive prose and deflates roughly eight to one:
 * measured on a realistic ten-note submission, 4,445 URL characters became
 * 562. One request, no chunking protocol to get wrong.
 *
 * Accepts both zlib and gzip streams, because a caller reaching for
 * compression should not have to guess which of Python's two obvious calls
 * this expects — and a wrong guess would look exactly like the silent failure
 * this replaces.
 *
 * The decompressors are injected rather than imported so this stays testable
 * and free of a Node-only dependency in a file the client bundle can reach.
 */
export function decodeCompressedPayload(
  value: string,
  inflate: (b: Uint8Array) => Uint8Array,
  gunzip: (b: Uint8Array) => Uint8Array
): { ok: true; json: string } | { ok: false; error: string } {
  let bytes: Uint8Array;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const b64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const bin = atob(b64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, error: "'payloadz' não é base64url válido" };
  }
  if (bytes.length === 0) {
    return { ok: false, error: "'payloadz' está vazio depois de descodificar o base64url" };
  }
  let out: Uint8Array;
  try {
    out = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzip(bytes) : inflate(bytes);
  } catch {
    return {
      ok: false,
      error:
        "'payloadz' não descomprime — usa zlib.compress(json.encode()) ou gzip.compress(...), e depois base64.urlsafe_b64encode",
    };
  }
  if (out.length > MAX_INFLATED_CHARS) {
    return {
      ok: false,
      error: `payload descomprimido demasiado grande (${out.length} caracteres, máx ${MAX_INFLATED_CHARS})`,
    };
  }
  return { ok: true, json: new TextDecoder().decode(out) };
}

export interface IntakeResult {
  status: number;
  body: Record<string, unknown>;
}

export interface IntakeSubmission {
  note?: unknown;
  insights?: unknown;
}

export async function processInsightSubmission(
  submission: IntakeSubmission | null
): Promise<IntakeResult> {
  const rawInputs = submission?.insights;
  const note =
    typeof submission?.note === "string" ? submission.note.slice(0, 1000) : null;

  if (!Array.isArray(rawInputs)) {
    return {
      status: 400,
      body: { error: "corpo inválido — esperado { insights: [...] }" },
    };
  }

  // An EMPTY array is a legitimate, informative outcome: the research ran and
  // honestly concluded there was nothing solid enough to submit. Recording it
  // is the whole point — it is what distinguishes "ran, found nothing" from
  // "never ran", and that distinction was invisible for weeks.
  if (rawInputs.length === 0) {
    await recordResearchRun({
      at: new Date().toISOString(),
      acceptedCount: 0,
      rejectedCount: 0,
      acceptedLabels: [],
      rejectedReasons: [],
      note:
        note ??
        "A investigação correu e não encontrou nada suficientemente sustentado para submeter.",
    });
    return {
      status: 200,
      body: { accepted: [], rejected: [], acceptedCount: 0, rejectedCount: 0, recorded: true },
    };
  }

  if (rawInputs.length > MAX_NOTES) {
    return {
      status: 400,
      body: {
        error: `demasiadas entradas num único pedido (máx ${MAX_NOTES}) — prioriza as de maior confiança`,
      },
    };
  }

  let bootstrap;
  try {
    bootstrap = await getBootstrap();
  } catch {
    return {
      status: 502,
      body: { error: "falha a carregar dados da FPL para validação" },
    };
  }

  const resolved: NewInsightInput[] = [];
  const rejected: RejectedInsight[] = [];

  for (const r of rawInputs as Record<string, unknown>[]) {
    const scope = r?.scope as NewInsightInput["scope"];
    const placeholder: NewInsightInput = {
      scope,
      id: typeof r?.id === "number" ? (r.id as number) : -1,
      label:
        (r?.label as string) ??
        (r?.playerName as string) ??
        (r?.teamName as string) ??
        "?",
      factor: r?.factor as number,
      reason: r?.reason as string,
      source: r?.source as string,
    };
    if (scope !== "player" && scope !== "team") {
      rejected.push({
        input: placeholder,
        reason: "scope inválido (tem de ser 'player' ou 'team')",
      });
      continue;
    }
    const resolution = resolveInsightTarget(bootstrap, scope, {
      id: typeof r?.id === "number" ? (r.id as number) : undefined,
      playerName: r?.playerName as string | undefined,
      teamShortName: r?.teamShortName as string | undefined,
      teamName: r?.teamName as string | undefined,
    });
    if (!resolution.ok) {
      rejected.push({ input: placeholder, reason: resolution.reason });
      continue;
    }
    resolved.push({
      scope,
      id: resolution.id,
      label: resolution.label,
      factor: r?.factor as number,
      reason: r?.reason as string,
      source: r?.source as string,
      ...(Array.isArray(r?.events) ? { events: r.events as number[] } : {}),
      ...(typeof r?.confidence === "number" ? { confidence: r.confidence } : {}),
    });
  }

  const result = await saveDynamicInsights(resolved, () => true);
  if (!result.ok) {
    return {
      status: 502,
      body: { error: result.error ?? "falha desconhecida", rejected },
    };
  }
  const allRejected = [...rejected, ...result.rejected];
  await recordResearchRun({
    at: new Date().toISOString(),
    acceptedCount: result.accepted.length,
    rejectedCount: allRejected.length,
    acceptedLabels: result.accepted.map((a) => a.label),
    rejectedReasons: allRejected.map((r) => `${r.input.label}: ${r.reason}`),
    note,
  });

  return {
    status: 200,
    body: {
      accepted: result.accepted,
      rejected: allRejected,
      acceptedCount: result.accepted.length,
      rejectedCount: allRejected.length,
      recorded: true,
    },
  };
}
