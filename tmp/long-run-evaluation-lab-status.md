# Long-run Evaluation Lab Status

Branch: `yu/long-run-evaluation-lab`
Base: `origin/main` at `09b374f9f55be35820f3314f6683c92a1800e618`

## Target Design

Build a reusable deterministic eval lab under `tests/eval-lab` that acts as a second
runtime for long-run companion-quality regression discovery. The lab must expose a
typed scenario DSL, reusable runner, typed persisted artifacts, thresholded metrics,
failure artifact export, and scenario coverage that crosses production caller paths
where practical.

## Completion Gates

- `npm run test:eval-lab` runs deterministic local scenarios with no network,
  provider keys, Telegram, or external services.
- At least 10 scenario cases cover memory, correction, stale rejection, schedule wake,
  restart/approval, replay dedupe, tool failure/recovery, quiet/proactivity hold,
  feedback calibration, missed-help detection, stale action binding rejection, and
  gateway/Telegram projection consistency.
- Eval artifacts include runtime/event-log refs, RuntimeGraph refs where available,
  surface/operator projections, transcript, replay summary, metrics, failures, and
  reproduction command.
- Eval replay is connected to the existing event-log replay/rebuild path instead of a
  parallel fake-only replay.
- Docs classify the lab as operator/developer quality infrastructure without
  overclaiming user-facing autonomy.

## Progress

- [x] Synced worktree to latest `origin/main`.
- [x] Created `yu/long-run-evaluation-lab`.
- [ ] Open draft PR before broad implementation.
- [ ] Inventory existing harness/replay/gauntlet/runtime pieces.
- [ ] Implement eval lab runtime, scenarios, artifacts, metrics, and docs.
- [ ] Run local verification.
- [ ] Run sub-agent completeness review and fix material findings.
- [ ] Mark PR ready and request/fix GitHub Codex review.
