# FPL Command Center — Strategic development block (2026-10-25)

## Scope and results
- **3/5/8-GW sequential planner**: bounded beam search explicitly carries 15-player roster, budget, original selling prices, acquired-player hypothetical selling price, free transfer accumulation, legal positions and club limits, and 4-point hit costs. Uses fresh per-event projections from the SAME existing model. It is not a guaranteed global optimum. Maximum two transfers in a GW, no chip decision tree, no future price changes.
- **Recent minutes variant**: nightly official GW live minutes (latest six finished events) stored in Redis through official scout refresh. Conservative recency-weighted estimates of P(start), P(appear), reaching 60 and expected minutes; available in Simular as explicit experimental toggle. Baseline forecasts, official decisions and backtests remain independent; do NOT promote without prospective validation.
- **Contextual consultant**: read-only deterministic Q&A powered by actual captain, transfers, Wildcard, risk flags and multiperiod path. This is deliberately NOT an LLM and cannot invent external facts. No extra paid inference service, and public visitors cannot execute transfers.
- **Personal confirmation**: voluntary self-reported decision log in browser localStorage, keyed by team and GW. No login or private server writes; clearly separate from genuine FPL API verification or immutable prediction records.
- **FPL bootstrap caching**: compressed 5-minute Redis live cache instead of failed Next.js >2MB Data Cache, existing 30-hour snapshot remains as fallback on API outage and is labelled stale.
- **Regression coverage**: multigameweek legal actions, no-balance overspend, FT history, 0 and invalid GW paths, recent-minutes missing starts and sparse sample, contextual Q&A.

## Critical limits and next validation gates
1. True 8-week global MILP with chip positioning, stochastic late injuries and budget appreciation is NOT implemented; bounded sequential search is a real multi-period approximation, explicit and feasible with minimal infrastructure.
2. Recency minutes is a shadow experiment. We must store prospective baseline and recent forecasts and score Brier/MAE over multiple deadlines before promoting.
3. The contextual Q&A is not a paid AI analyst. Full LLM chat needs owner authentication, capped spend, and approved gateway credentials; current Vercel environment has no AI gateway key.
4. Personal confirmation is browser-local, self-reported. Strong auth and cross-device persistence require a private account flow; no false claims of verified official actions.
5. Model performance and edge over benchmarks remains unproven. More mathematical sophistication alone cannot guarantee better FPL points.
6. Before advertising production success, check Vercel READY on the primary fpl-command-center-od2z project, /api/health SHA and simular route with horizons 3/5/8; inspect function timeout/errors and any cache warnings.

## Safety
- Does not authenticate to FPL or submit transfers/chips.
- Explicitly keeps higher-variance forecasts out of official snapshots.
- No private secrets added to frontend; RSS research remains sources-only; no hidden LLM costs.
- No deletion of existing Redis keys, historical snapshots or manager data.

## Acceptance checklist
- CI full TypeScript + lint + regression + perf clean.
- Plan has exactly one row per GW, legal roster and nonnegative bank after every simulated change.
- All 4 app views render after deployment, Team ID remains stable, simulated minute mode labelled.
- Reduced bootstrap cache noise in Vercel logs after first request in 5min.
