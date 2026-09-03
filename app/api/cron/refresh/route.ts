import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/apitoken";
import { runBacktestJob, runCalibrationJob } from "@/lib/jobs";
import { startJobRun, finishJobRun } from "@/lib/joblog";

/**
 * THE SCHEDULED RUN. Vercel calls this once a day; nothing else has to.
 *
 * WHY THIS EXISTS. The backtest and the calibration sweep were scheduled as
 * assistant sessions, and assistant sessions were the wrong instrument for
 * them in three separate ways:
 *
 *   1. Neither job needs judgement. One is arithmetic over match history,
 *      the other is a grid search. The assistant's entire contribution was
 *      calling a URL.
 *   2. The sessions run in a sandbox that cannot reach *.vercel.app except
 *      through one specific tool, so even a healthy session was one proxy
 *      rule away from doing nothing.
 *   3. When they failed they failed silently — a run lasted eight and a half
 *      minutes, returned FAILED, and left no trace anywhere in this app.
 *
 * A cron job inside the deployment has none of those problems. It runs in the
 * same process as the code it is testing, with the app's own network access,
 * and it writes to the run log before it starts as well as after it ends, so
 * even being killed mid-run leaves evidence.
 *
 * AUTHENTICATION. Vercel sends `Authorization: Bearer $CRON_SECRET` on every
 * scheduled invocation. That is the primary check. `?token=` with
 * INSIGHTS_API_TOKEN is accepted as well, so the job can be fired by hand
 * from a browser or from a tool that can only issue plain GETs — the same
 * constraint that shaped /api/insights/push.
 *
 * If NEITHER secret is configured the route refuses. An open endpoint that
 * runs the most expensive computation in the project is a denial-of-service
 * button, and "it is only my little app" is how those get found.
 */

export const dynamic = "force-dynamic";
// 300 is the hard ceiling on Vercel's Hobby plan. Setting it higher does not
// buy a longer function — the DEPLOYMENT is rejected outright
// ("invalid_max_duration"), which is how the v1.30 deploy died.
export const maxDuration = 300;

/** Wall for the whole request, leaving room to serialise a reply and write
 * the log even when the sweep uses everything it is given. */
const TOTAL_BUDGET_MS = 250_000;
/** Never start a calibration sweep with less than this left. A sweep that
 * cannot finish one parameter produces nothing and costs everything. */
const MIN_CALIBRATION_MS = 60_000;

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(
    req.headers.get("authorization"),
    req.nextUrl.searchParams.get("token")
  );
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const trigger = auth.via === "cron" ? "cron" : "manual";
  const only = req.nextUrl.searchParams.get("only");
  const ran: Record<string, unknown> = {};

  // ---- Backtest --------------------------------------------------------
  // First because it is the cheaper of the two and because the calibration
  // sweep reuses exactly the histories it just warmed into the cache.
  if (only !== "calibration") {
    const entry = await startJobRun("backtest", trigger);
    try {
      const out = await runBacktestJob();
      await finishJobRun(entry, {
        ok: out.ok,
        summary: out.ok ? out.summary : out.error,
        detail: out.ok ? out.detail : { error: out.error, retryable: out.retryable },
      });
      ran.backtest = out.ok ? { ok: true, summary: out.summary } : { ok: false, error: out.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : "falha desconhecida";
      await finishJobRun(entry, { ok: false, summary: message });
      ran.backtest = { ok: false, error: message };
    }
  }

  // ---- Calibration -----------------------------------------------------
  if (only !== "backtest") {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALIBRATION_MS) {
      // Skipped on purpose is a different state from failed, and saying so
      // keeps tomorrow's run from looking like a regression.
      ran.calibration = { ok: null, skipped: `só restavam ${Math.round(remaining / 1000)}s` };
    } else {
      const entry = await startJobRun("calibration", trigger);
      try {
        const out = await runCalibrationJob({
          deadlineMs: deadline,
          rotate: trigger === "cron",
        });
        await finishJobRun(entry, {
          ok: out.ok,
          summary: out.ok ? out.summary : out.error,
          detail: out.ok ? out.detail : { error: out.error, retryable: out.retryable },
        });
        ran.calibration = out.ok
          ? { ok: true, summary: out.summary }
          : { ok: false, error: out.error };
      } catch (err) {
        const message = err instanceof Error ? err.message : "falha desconhecida";
        await finishJobRun(entry, { ok: false, summary: message });
        ran.calibration = { ok: false, error: message };
      }
    }
  }

  return NextResponse.json({
    ok: true,
    trigger,
    durationMs: Date.now() - startedAt,
    ran,
  });
}

/** Vercel Cron issues GET, but a POST here should do the same thing rather
 * than 405 — the commonest way a scheduler is reconfigured by hand. */
export const POST = GET;
