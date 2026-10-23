# Release audit — 2026-10-23: decision integrity, performance, security

## Delivered
1. New `lib/lineupsettlement.ts` calculates **hypothetical** FPL XI outcomes with formation-valid automatic substitutions in bench order, reserve GK substitution, vice-captain fallback, Triple Captain, Bench Boost, and hit costs. It does not perform actual transfers.
2. A new post-GW comparison in `lib/decisions.ts` uses archived pre-deadline advice, complete live minutes/points, final API multipliers, and official-score crosschecks. Historic approximate rows are retained but omitted from the validated aggregate. Ineligible and missing data do not silently count.
3. The same pre-deadline advice now saves a **do-nothing / hold** squad, XI and captain, so the system will measure real net differences between advice and doing nothing when a GW finishes.
4. Captains are chosen using prospective model predictions; the previous GW's elite captain is contextual evidence, **not** a mandatory default on close calls. Uncertain differences are explicitly labelled.
5. A provisional Wildcard does not automatically trigger a Bench Boost in the following GW.
6. Completed-GW tracking has moved from every server-rendered homepage request to the existing daily cron. A slow planner now emits a bounded timing warning to Vercel logs.
7. `GET /api/health` exposes safe status, connected-storage boolean and Vercel Git SHA, with no credentials.
8. Security upgrade: Next.js **16.4.1**, React and React DOM **19.2.9**, eslint-config-next **16.4.1**, with registry-generated lockfile. Advisory: https://nextjs.org/blog/nextjs-security-update-october-14-2026. Temporary write-enabled workflow removed.
9. Regression and CI verification updated with new real-scoring scenarios.

## What is not proven or done
- One GW cannot validate a recommendation model. The prospective benchmark must collect multiple completed weeks.
- The "realised gain vs hold" is a **what-if** result under historical player outcomes, not a causally proven gain: alternative transfers can change ownership, bank, chips and future opportunities. It does not verify every FPL transfer-price rule. The app should not automatically execute anything.
- A Free Hit or Wildcard result is **not** promoted to validated unless an independent chip-specific, budget-legal team was actually archived. The current release explicitly abstains from these comparisons.
- Independent tactical-news ingestion is still dependent on an external researcher and has been stale. The existing health panel reports this honestly; it cannot be fixed by fabricated insights.
- Every build passing tests does not guarantee an actual successful Vercel deployment; production requires verifying `/api/health` and the updated dashboard.

## Deployment checklist
- Required: PR CI green; merge into `main`; verify main commit CI green.
- Check deployment of `https://fpl-command-center-od2z.vercel.app/api/health` or the correct production alias and compare `revision` with main SHA.
- Inspect Vercel deployment logs, production 200 response, UI of new decision comparison, automation GET status and Redis configuration.
- Near deadline, do NOT execute speculative transfers/chips based solely on these changes.

## Operator actions
- If no Vercel automation is connected to the GitHub repository, deploy through the Vercel project using the branch `main`; never report deployment complete from GitHub CI alone.
- Rotate any token previously passed in URL query strings if found in public logs.
- Re-enable private Shadow Team syncing only after authenticated access is in place.
