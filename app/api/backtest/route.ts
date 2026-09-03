import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/kv";
import { checkApiToken, unauthorizedBody } from "@/lib/apitoken";
import { runBacktestJob, BACKTEST_CACHE_KEY } from "@/lib/jobs";
import { startJobRun, finishJobRun } from "@/lib/joblog";
import type { BacktestResult } from "@/lib/backtest";

/**
 * Manual entry point for the backtesting harness.
 *
 * THE WORK ITSELF NOW LIVES IN lib/jobs.ts, because the same job also runs
 * unattended from /api/cron/refresh. This route is the "run it now" button:
 * same code, same sample, same cache key, so a manual run and a scheduled run
 * can never disagree about what was measured. Before this, each route carried
 * its own copy of the sampling rule — and a calibration tuned on one sample
 * and validated against another measures the difference between the samples.
 *
 * `?cached=1` reads the last result and needs no token: it exposes aggregate
 * accuracy numbers about this app's own model and nothing about anyone's
 * team. Running a fresh one costs ~150 HTTP requests, so it does.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (params.get("cached") === "1") {
    const redis = getRedis();
    const cached = redis ? await redis.get<BacktestResult>(BACKTEST_CACHE_KEY) : null;
    if (!cached) {
      return NextResponse.json(
        { error: "ainda não há backtest guardado", configured: !!redis },
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

  const entry = await startJobRun("backtest", "manual");
  try {
    const out = await runBacktestJob({
      fromEvent: int("from"),
      toEvent: int("to"),
      sampleSize: int("sample"),
    });
    await finishJobRun(entry, {
      ok: out.ok,
      summary: out.ok ? out.summary : out.error,
      detail: out.ok ? out.detail : { error: out.error },
    });
    if (!out.ok) {
      return NextResponse.json({ error: out.error }, { status: out.retryable ? 502 : 409 });
    }
    return NextResponse.json({ ...out.result, run: out.detail });
  } catch (err) {
    const message = err instanceof Error ? err.message : "falha a correr o backtest";
    await finishJobRun(entry, { ok: false, summary: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
