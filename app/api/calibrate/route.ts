import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/kv";
import { checkApiToken, unauthorizedBody } from "@/lib/apitoken";
import { runCalibrationJob, CALIBRATION_CACHE_KEY } from "@/lib/jobs";
import { startJobRun, finishJobRun } from "@/lib/joblog";
import { PARAM_GRIDS, type TunableParam } from "@/lib/modelparams";
import type { CalibrationReport } from "@/lib/calibration";

/**
 * Manual entry point for the calibration sweep. The work lives in
 * lib/jobs.ts, shared with the daily scheduled run at /api/cron/refresh.
 *
 * COST. This is the most expensive thing in the project by a wide margin: one
 * full replay of every gameweek per candidate value per parameter. Twelve
 * tunable parameters with five or six candidates each is roughly sixty
 * replays, which does not fit in one serverless function. Hence the time
 * budget and the four-parameter cap — and hence the ROTATING CURSOR in
 * lib/jobs.ts, so the unattended run covers a different slice each day
 * instead of measuring the same four parameters forever.
 *
 * `?params=underlyingBlend,shrinkXg` overrides the rotation for a manual run
 * without disturbing it. `?cached=1` reads the last report and needs no token.
 */

export const dynamic = "force-dynamic";
// 300 is the ceiling on Vercel's Hobby plan. Setting it higher does not give
// a longer function — the DEPLOYMENT is rejected outright
// ("invalid_max_duration"), which is how the v1.30 deploy died.
export const maxDuration = 300;

/** Leave headroom for fetching histories and serialising the reply. */
const SWEEP_BUDGET_MS = 210_000;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (params.get("cached") === "1") {
    const redis = getRedis();
    const cached = redis ? await redis.get<CalibrationReport>(CALIBRATION_CACHE_KEY) : null;
    if (!cached) {
      return NextResponse.json(
        { error: "ainda não há calibração guardada", configured: !!redis },
        { status: 404 }
      );
    }
    return NextResponse.json(cached);
  }

  const auth = checkApiToken(params.get("token"));
  if (!auth.ok) {
    return NextResponse.json(unauthorizedBody(auth), { status: 401 });
  }

  const int = (name: string): number | undefined => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  const requested = (params.get("params") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s in PARAM_GRIDS) as TunableParam[];

  const entry = await startJobRun("calibration", "manual");
  try {
    const out = await runCalibrationJob({
      fromEvent: int("from"),
      toEvent: int("to"),
      sampleSize: int("sample"),
      params: requested.length > 0 ? requested : undefined,
      deadlineMs: Date.now() + SWEEP_BUDGET_MS,
      rotate: false,
    });
    await finishJobRun(entry, {
      ok: out.ok,
      summary: out.ok ? out.summary : out.error,
      detail: out.ok ? out.detail : { error: out.error },
    });
    if (!out.ok) {
      return NextResponse.json({ error: out.error }, { status: out.retryable ? 502 : 409 });
    }
    // `run` is nested, not spread: the detail carries a REDUCED
    // `recommendations` shape for the log, and spreading it would silently
    // replace the full report's own field with the summary version.
    return NextResponse.json({ ...out.result, run: out.detail });
  } catch (err) {
    const message = err instanceof Error ? err.message : "falha a calibrar";
    await finishJobRun(entry, { ok: false, summary: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
