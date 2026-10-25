# FPL Command Center — Quality Gates and Measured Completion (2026-10-25)

## Problem being solved
An optimization engine can select optimistic forecast errors and produce apparently decisive transfer and chip recommendations. Having many functions or passing TypeScript tests is not evidence of a real FPL advantage.

## Delivered in this change
- Scored player exposes pStart and pPlay60 alongside pPlay and expectedMinutesNext, with no change to the production scoring weights.
- Immutable predeadline minute A/B snapshots for the original and recency-weighted models on identical players. No post-deadline mutation and no preview writes.
- Daily settlement from the completed FPL GW feed, retaining real zero-minute players; Brier for appearance and 60 minutes, conditional starts Brier only when actual starts are published, and MAE minutes.
- Evaluation by distinct gameweeks. Promotion gate requires at least 12 completed paired GWs, evidence of MAE improvement with a positive indicative interval, and participation Brier improvement. Even a passing gate triggers review of FPL points and actual transfer decisions before any model replacement.
- Prospective captain benchmark compares actual accumulated points for model captain, FPL's predeadline ep_next choice and PPG choice, all restricted to the archived 15-player squad.
- Short 120s Redis cache for bounded 3/5/8-GW search, keyed by every scenario forecast, entry price, original selling prices, budget, free transfers and horizon.
- Regression cases for actual zero minutes, missing starts, immutable predeadline time boundaries, event-level intervals and cache invalidation.

## Current facts and unknowns
- No prospective A/B weeks have yet been settled in this new scheme. It is impossible to claim which minutes model is better today.
- The historical replay cannot replace the frozen predeadline experiment. The gateway is not configured for paid AI, and the app has no secure private sign-in; no general paid LLM endpoint is exposed.
- The multi-GW solver is a limited beam search, not a global stochastic chip optimizer. The reported future advantage must be treated as experimental.
- User decisions recorded in localStorage are self-reported, not authenticated/verifiable. Existing public FPL reads and official completed-GW transfer records remain read-only.
- A second Vercel project, fpl-command-center, is legacy and had blocked deployments; the canonical production project is fpl-command-center-od2z.

## Criteria for an evidence-based recommendation
1. One model snapshot must be frozen before the GW deadline, with provenance, timestamp and settings, never reconstructed afterward.
2. Use the same player cohort for both models, preserving actual zero-minute and zero-point players. Exclude unavailable fields rather than invent starts.
3. Score by gameweek, not by pretending hundreds of correlated players are independent samples. Report paired error and time coverage.
4. Keep production weights unchanged until out-of-sample results beat a simple reference by a practically relevant amount, not just a nice-looking p-value.
5. Measure realised net FPL decisions: own-squad captain, legal lineup including autosubs, hits, chips, free-transfer option value and alternative of doing nothing.
6. No new UI badge may claim statistical superiority without completed and comparable evidence.

## Release validation
- GitHub Actions: TypeScript, ESLint, required tests and synthetic planner performance.
- Production Vercel SHA must equal merged main commit; health endpoint HTTP 200; Today, Simular (3 and 8), Analisar and System pages HTTP 200.
- /api/research shows current official and editorial sources; /api/automation shows job health.
- Monitor Vercel runtime errors and bootstrap-cache warnings after release.
