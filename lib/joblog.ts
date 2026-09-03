import { getRedis } from "./kv";

/**
 * THE RUN LOG — because the real failure was never the failure itself.
 *
 * Three scheduled jobs ran for weeks. Two of them failed every single time.
 * Nobody knew, and nobody could have known, because a job that fails before
 * it writes anything leaves EXACTLY THE SAME TRACE as a job that never ran:
 * none. The dashboard showed old numbers, which look identical to current
 * numbers when nothing tells you when they were computed.
 *
 * That is the actual defect, and it is not fixed by making the jobs more
 * reliable — a more reliable job still fails eventually. It is fixed by
 * making the ABSENCE of a run visible. So every automated run writes here,
 * before and after: an attempt is recorded when it starts and updated when
 * it ends, which means even a run killed by the function wall (the most
 * likely way these die, and the one that writes nothing) leaves a row saying
 * it started and never finished.
 *
 * A log of successes only would have shown nothing wrong for six weeks.
 */

export type JobName = "backtest" | "calibration" | "research";

export interface JobRun {
  job: JobName;
  /** ISO timestamp when the run began. */
  startedAt: string;
  /** ISO timestamp when it ended, or null while still running — which,
   * after the fact, means it was killed without ever finishing. */
  finishedAt: string | null;
  ok: boolean | null;
  durationMs: number | null;
  /** One human sentence. Shown on the dashboard verbatim. */
  summary: string;
  /**
   * Did this run actually PRODUCE anything?
   *
   * Added after the research job reported "OK — 0 notas aceites, 0
   * rejeitadas" and painted its card green. It had run, it had reached the
   * app, it had recorded itself, and it had submitted nothing whatsoever for
   * evaluation. Zero accepted with some rejected is a genuinely quiet week;
   * zero accepted AND zero rejected means nothing was ever proposed.
   *
   * Counting that as a success is the same defect this module was built to
   * end, wearing a new costume: a green light for a job that did nothing. So
   * "finished without error" and "produced something" are now two different
   * facts, recorded separately, and the dashboard distinguishes them.
   *
   * Optional, and absent means "assume it produced something" — runs written
   * before this field existed must not retroactively turn amber.
   */
  productive?: boolean;
  /** Who started it: the scheduler, or a person clicking. */
  trigger: "cron" | "manual";
  detail?: Record<string, unknown>;
}

const LOG_KEY = "automation:log";
const MAX_ENTRIES = 30;

async function readLog(): Promise<JobRun[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    return (await redis.get<JobRun[]>(LOG_KEY)) ?? [];
  } catch {
    return [];
  }
}

async function writeLog(entries: JobRun[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(LOG_KEY, entries.slice(0, MAX_ENTRIES));
  } catch {
    // A log that throws must never take down the job it is logging.
  }
}

/**
 * Records that a run has STARTED. Returns the entry so `finishJobRun` can
 * match it. Writing at the start is the whole point: the failure mode this
 * project actually suffered — an eight-minute run that ended in nothing —
 * writes no completion record at all, and only a start record can show it.
 */
export async function startJobRun(
  job: JobName,
  trigger: JobRun["trigger"]
): Promise<JobRun> {
  const entry: JobRun = {
    job,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    durationMs: null,
    summary: "a correr…",
    trigger,
  };
  const log = await readLog();
  await writeLog([entry, ...log]);
  return entry;
}

export async function finishJobRun(
  entry: JobRun,
  outcome: {
    ok: boolean;
    summary: string;
    /** Whether the run produced anything. Defaults to true for a successful
     * run, because most jobs that finish without error did do work; the
     * callers that can tell the difference say so explicitly. */
    productive?: boolean;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const done: JobRun = {
    ...entry,
    finishedAt,
    ok: outcome.ok,
    durationMs: new Date(finishedAt).getTime() - new Date(entry.startedAt).getTime(),
    summary: outcome.summary,
    productive: outcome.ok ? (outcome.productive ?? true) : false,
    detail: outcome.detail,
  };
  const log = await readLog();
  const idx = log.findIndex(
    (e) => e.job === entry.job && e.startedAt === entry.startedAt
  );
  if (idx >= 0) log[idx] = done;
  else log.unshift(done);
  await writeLog(log);
}

/**
 * Three states, not two.
 *
 * `parada`  — no success inside the expected window (never having run counts).
 * `vazia`   — it ran, it finished cleanly, and it produced nothing. A real
 *             state that deserves its own colour: it is not broken, but
 *             calling it "ok" is how a job that does nothing stays green.
 * `ok`      — ran and produced something inside the window.
 */
export type JobStatus = "ok" | "vazia" | "parada";

export interface JobHealth {
  job: JobName;
  label: string;
  /** The most recent run of any outcome. */
  last: JobRun | null;
  /** The most recent run that actually succeeded. */
  lastSuccess: JobRun | null;
  /** The most recent run that succeeded AND produced something. */
  lastProductive: JobRun | null;
  /** Whole days since the last SUCCESS, not since the last attempt. A job
   * failing daily is not "running daily". */
  daysSinceSuccess: number | null;
  /** Whole days since the last run that actually produced something. */
  daysSinceProductive: number | null;
  /** How many days may pass before silence is a problem. */
  expectedEveryDays: number;
  status: JobStatus;
  stale: boolean;
  /** Consecutive failed or unfinished runs at the head of the log. */
  consecutiveFailures: number;
}

/** A run counts as productive unless it explicitly says otherwise. Entries
 * written before the field existed have no opinion, and inventing one for
 * them would be reporting a fact nobody measured. */
export function wasProductive(run: JobRun): boolean {
  return run.ok === true && run.productive !== false;
}

const JOB_LABEL: Record<JobName, string> = {
  backtest: "Backtest",
  calibration: "Calibração",
  research: "Investigação tática",
};

/** How often each job is supposed to happen. The two computational jobs run
 * on Vercel's own scheduler daily; the research job needs an assistant
 * session and runs weekly, so it is allowed a longer silence before the
 * alarm — 9 days, one week plus slack. */
const EXPECTED_EVERY_DAYS: Record<JobName, number> = {
  backtest: 2,
  calibration: 2,
  research: 9,
};

export async function getJobHealth(): Promise<JobHealth[]> {
  return computeJobHealth(await readLog());
}

/** The health rules, as a pure function of the log, so they can be tested
 * without a Redis and without waiting a week for a job to go stale. */
export function computeJobHealth(log: JobRun[], now = Date.now()): JobHealth[] {
  return (Object.keys(JOB_LABEL) as JobName[]).map((job) => {
    // Sorted rather than trusted: `consecutiveFailures` counts from the head
    // of this list, so an out-of-order log would silently report the wrong
    // number — and reporting a wrong health number is the exact failure this
    // whole module exists to end.
    const runs = log
      .filter((e) => e.job === job)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    const last = runs[0] ?? null;
    const lastSuccess = runs.find((e) => e.ok === true) ?? null;
    const lastProductive = runs.find(wasProductive) ?? null;
    const age = (r: JobRun | null): number | null =>
      r ? Math.floor((now - new Date(r.finishedAt ?? r.startedAt).getTime()) / 86_400_000) : null;
    const daysSinceSuccess = age(lastSuccess);
    const daysSinceProductive = age(lastProductive);
    let consecutiveFailures = 0;
    for (const r of runs) {
      if (r.ok === true) break;
      consecutiveFailures++;
    }
    const expectedEveryDays = EXPECTED_EVERY_DAYS[job];
    // Never having succeeded is the worst case, not an unknown one. It is
    // precisely the state this project sat in for six weeks.
    const stale = daysSinceSuccess === null || daysSinceSuccess > expectedEveryDays;
    const producedRecently =
      daysSinceProductive !== null && daysSinceProductive <= expectedEveryDays;
    return {
      job,
      label: JOB_LABEL[job],
      last,
      lastSuccess,
      lastProductive,
      daysSinceSuccess,
      daysSinceProductive,
      expectedEveryDays,
      // "Ran cleanly" and "produced something" are separate facts. A job that
      // keeps finishing without doing anything is not healthy, and painting it
      // green is exactly the kind of comfortable lie this file exists to stop.
      status: stale ? "parada" : producedRecently ? "ok" : "vazia",
      stale,
      consecutiveFailures,
    };
  });
}

export async function getJobLog(limit = MAX_ENTRIES): Promise<JobRun[]> {
  return (await readLog()).slice(0, limit);
}

/**
 * Folds the research layer's own record into the health list.
 *
 * The research job records itself through lib/managerinsights, which predates
 * this log and stores something richer — what it FOUND, not merely that it
 * ran. Rather than duplicate that write (and risk the two disagreeing), its
 * record is merged in on read. A research run that succeeded before this log
 * existed therefore still counts as a success, which is correct: it happened.
 */
export function mergeResearchHealth(
  health: JobHealth[],
  research: { at: string; acceptedCount: number; rejectedCount: number } | null,
  now = Date.now()
): JobHealth[] {
  if (!research) return health;
  const at = new Date(research.at).getTime();
  if (!Number.isFinite(at)) return health;
  return health.map((h) => {
    if (h.job !== "research") return h;
    // Only promote it if it is NEWER than whatever the log already knows.
    const known = h.lastSuccess
      ? new Date(h.lastSuccess.finishedAt ?? h.lastSuccess.startedAt).getTime()
      : -Infinity;
    if (at <= known) return h;

    // THE CASE THAT ADDED THIS FIELD. Zero accepted AND zero rejected means
    // the pass never submitted anything to be judged — not that it judged
    // things and kept none. A quiet week produces zero accepted with some
    // rejected; zero on both sides is a pass that brought back nothing.
    const proposed = research.acceptedCount + research.rejectedCount;
    const productive = proposed > 0;
    const run: JobRun = {
      job: "research",
      startedAt: research.at,
      finishedAt: research.at,
      ok: true,
      productive,
      durationMs: null,
      summary: productive
        ? `${research.acceptedCount} nota(s) aceite(s), ${research.rejectedCount} rejeitada(s)`
        : "correu, mas não submeteu nenhuma nota — nem aceite nem rejeitada, ou seja, não trouxe nada para avaliar",
      trigger: "manual",
    };
    const daysSinceSuccess = Math.floor((now - at) / 86_400_000);
    const daysSinceProductive = productive ? daysSinceSuccess : h.daysSinceProductive;
    const stale = daysSinceSuccess > h.expectedEveryDays;
    const producedRecently =
      daysSinceProductive !== null && daysSinceProductive <= h.expectedEveryDays;
    return {
      ...h,
      last: h.last && new Date(h.last.startedAt).getTime() > at ? h.last : run,
      lastSuccess: run,
      lastProductive: productive ? run : h.lastProductive,
      daysSinceSuccess,
      daysSinceProductive,
      status: stale ? "parada" : producedRecently ? "ok" : "vazia",
      stale,
      consecutiveFailures: 0,
    };
  });
}
