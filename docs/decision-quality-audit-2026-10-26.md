# Decision quality audit — 2026-10-26 (phase 1)

Status: **initial source-code audit, not a fresh empirical result**. This document is an evidence-based engineering plan; no model parameter or live recommendation changes in this PR.

## Product objective

Optimize **real FPL decision regret**, not number of features, beauty of forecasts, or in-sample xP. The UI should recommend concrete next actions and hide model internals behind optional details. No promise of beating other managers without prospective evidence.

## Findings verified in source

1. `lib/expectedpoints.ts`: `computeMinutesModel` starts from cumulative `starts / teamFinishedFixtures`. This dilutes recent rotation, transfers or changes of manager/role. A recent-minutes experimental path already exists, but it must beat the incumbent prospectively before promotion.
2. `lib/expectedpoints.ts`: `avgMinutesPerStart = min(90, totalMinutes / starts)` includes substitute minutes, which is not a valid estimate of conditional starting minutes. The comment itself acknowledges the bias. Match-by-match starts/minutes or defensible uncertainty bounds are required before stronger confidence claims.
3. `lib/selection.ts`: the optimizer's winner's curse is documented and reproduced in a synthetic equal-quality player pool; a posterior selection advantage is not proven just because the solver returns a positive gain. Treat projected gains from mass player search conservatively.
4. `lib/calibration.ts`: leave-one-GW-out tuning is implemented with guards (6 GW, 900 rows and 2% improvement). These are valuable safeguards but do not replace a forward, chronological holdout for deployment decisions; adjacent GW observations and repeated player selection can remain dependent.
5. `lib/forwardbenchmark.ts` and `tests/forwardbenchmark.test.ts` capture predeadline snapshots, zero-point outcomes and baselines. The owner-cohort integrity guard has tests. A tested pipeline does not itself demonstrate positive prospective skill.
6. README v1.62 reports improvement in bias (-0.70 to -0.26) and Spearman (0.338 to 0.352), with MAE deteriorating by 0.08; no statistically established win over naive PPG is reported. Do not represent this as proven uplift.

## First experiments (keep new logic in shadow mode)

| Experiment | Current baseline | Challenger | Primary outcome |
|---|---|---|---|
| Minutes/availability | existing minutes model | recent starts/minutes with partial pooling and injury/rotation flags | Brier score for start and 60+; minutes MAE |
| Player weekly xP | existing xP | calibrated time-decayed xG/xA and availability model | paired MAE, Spearman, top-k ranking lift |
| Captain | current elite-anchored decision | maximize calibrated captain expectation with uncertainty | incremental actual points vs baseline at frozen deadline |
| Transfers | incumbent solver + retention threshold | risk-aware, cost-aware decision policy incl. hold | GW+3/GW+5 realized net points and decision regret |
| Chips | current optimizer | horizon policy accounting for FTs, expiry and BGW/DGW uncertainty | net expected/realized points on forward snapshots |

## Measurement requirements

- Every comparison must use **the same eligible players, fixtures, team state and time-stamped predeadline inputs**.
- Persist immutable inputs, model version, recommendations, alternatives, projected points, FTs, bank, hits and actual results; never score historical advice from today's injury, price or xP state.
- Stratify performance by position, minutes-risk bucket, price bucket, captain pool and GW; distinguish zero-point absences from missing outcomes.
- Compare against naive PPG, official FPL ep_next where available, and current production model. Separate forecast metrics from **decision** metrics.
- Report sample sizes and interval estimates clustered by gameweek, not independent confidence based on hundreds of correlated player observations.
- Track accepted transfers and held alternatives on equal budget/roster rules; score decisions net of hit costs. Distinguish hypothetical recommendations from user's actual actions.
- No promotion based on a single GW or in-sample improvement. Default to incumbent when intervals overlap or real-world benefit is not demonstrated.

## Acceptance gates for phase 2

1. A reproducible predeadline evaluation report with dates, GW range, cohort, missing-data rates, baseline and model metrics.
2. A deterministic test preventing leakage from live data into frozen comparisons.
3. A decision-level benchmark for *hold vs transfer*, starting XI, captain and chips; include no-action baseline.
4. No production model replacement unless prospective paired results exceed incumbent on the decision metric, with no material worsening of availability calibration.
5. Fail closed: when evidence is weak or stale, say **no confident advantage** rather than fabricate precision.

## UX specification for later phase (do not implement ahead of model evaluation)

Primary screen: single best next action; optional alternative choices for transfer/XI/captain/chip; concise impact and confidence; details behind expandable explanation. Manual what-if remains possible. No uncalibrated percentages presented as probabilities of success.
