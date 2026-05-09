# Database State Slice 7: Runtime Evidence, Strategy, Dream State

## Scope

- Move runtime evidence entries and summary indexes from JSONL/sidecar files into `pulseed-control.sqlite`.
- Move strategy portfolio/history/wait metadata/rebalance history behind typed SQLite state via `StrategyDreamStateStore` and the `StateManager` raw compatibility facade.
- Move Dream iteration/session/event logs, importance entries, watermarks, schedule suggestions, playbooks, activation artifacts, and workflows into typed SQLite tables.
- Keep reproducibility manifests, postmortem reports, Dream reports, learning files, memory/Soil files, user artifacts, and explicit exports file-backed.

## Storage Ownership Changes

- Added migration version 7: `runtime-evidence-strategy-dream-state`.
- Added typed stores:
  - `RuntimeEvidenceStateStore`
  - `StrategyDreamStateStore`
  - `ProcessSessionStateStore`
- Runtime evidence normal reads/writes now use `runtime_evidence_entries` and `runtime_evidence_summary_indexes`.
- Dream and strategy normal reads/writes now use typed DB tables. Legacy files are handled only by explicit import/repair migration code.
- Runtime evidence refs surfaced by daemon/session paths now use `control-db://runtime-evidence/...` or `runtime-evidence://...` identifiers instead of JSONL paths.
- Process session snapshots used by strategy wait observation and runtime session projection now use the control DB instead of `runtime/process-sessions/*.json` sidecars. Workspace/debug artifacts may still contain exported process snapshots.

## Legacy Migration Boundary

- `importLegacyRuntimeEvidenceStrategyDreamState()` imports legacy runtime evidence, strategy state, and Dream state files into the control DB.
- `pulseed doctor --repair` invokes the explicit import boundary and records `control_legacy_imports` metadata.
- Normal runtime paths do not dual-write legacy JSON/JSONL state.
- Review blocker follow-up moved process-session wait metadata to `metadata_ref` and expanded legacy import coverage for Dream schedule suggestions, playbooks, activation artifacts, and workflows.
- Review blocker follow-up made `importLegacyRuntimeEvidenceStrategyDreamState()` idempotent by skipping already imported/retired legacy sources through `control_legacy_imports`, preventing duplicate Dream session/event rows on repeated `doctor --repair` runs.
- Review blocker follow-up imports legacy `runtime/process-sessions/*.json` snapshots into `process_session_snapshots` so imported wait metadata can still satisfy `process_session_exited` through the DB-backed production evaluator.
- Review blocker follow-up links runtime report artifacts to persisted DB process-session snapshots when the live in-memory manager no longer has the session after restart.

## Validation

- `npm run typecheck` passed.
- `npm run lint:boundaries` passed with existing repository warnings and 0 errors.
- `npm run build` passed.
- `git diff --check` passed.
- `npx vitest run --config vitest.integration.config.ts src/runtime/store/__tests__/runtime-evidence-strategy-dream-state-store.test.ts src/platform/dream/__tests__/dream-log-collector.test.ts src/platform/dream/__tests__/dream-schedule-suggestions.test.ts src/platform/dream/__tests__/dream-activation-artifacts.test.ts src/platform/dream/__tests__/playbook-memory.test.ts src/platform/dream/__tests__/dream-event-workflows.test.ts src/platform/dream/__tests__/dream-consolidator-fs-metrics.test.ts` passed, 21 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/runtime-evidence-ledger.test.ts src/runtime/__tests__/memory-quarantine.test.ts src/runtime/__tests__/runtime-evidence-answer.test.ts src/platform/dream/__tests__/dream-analyzer.test.ts src/platform/dream/__tests__/dream-consolidator.test.ts src/platform/dream/__tests__/dream-soil-sync.test.ts src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts` passed, 103 tests.
- `npx vitest run --config vitest.unit.config.ts src/tools/system/ProcessSessionTool/__tests__/ProcessSessionTool.test.ts` passed, 7 tests.
- After rebasing onto the latest `origin/main`, `npm run test:unit` passed, 489 files / 7814 tests.
- After rebasing onto the latest `origin/main`, `npm run test:integration` passed, 212 files / 2228 tests.
- Review blocker fix validation:
  - `npm run typecheck` passed.
  - `npm run lint:boundaries` passed with existing repository warnings and 0 errors.
  - `npm run build` passed.
  - `git diff --check` passed.
  - `npx vitest run --config vitest.unit.config.ts src/tools/system/ProcessSessionTool/__tests__/ProcessSessionTool.test.ts src/tools/runtime/__tests__/LongRunningRuntimeTools.test.ts src/orchestrator/strategy/__tests__/portfolio-manager.test.ts src/orchestrator/loop/__tests__/core-loop-integrations.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-gateway-runtime-control.test.ts src/runtime/__tests__/dream-sidecar-review.test.ts src/orchestrator/execution/agent-loop/__tests__/kaggle-training-benchmark.test.ts` passed, 266 tests.
  - `npx vitest run --config vitest.integration.config.ts src/runtime/store/__tests__/runtime-evidence-strategy-dream-state-store.test.ts` passed, 3 tests.
  - `npx vitest run --config vitest.integration.config.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/interface/tui/__tests__/app.test.ts` passed, 73 tests.
  - `npm run test:unit` passed, 492 files / 7829 tests; 3 skipped files / 3 skipped tests.
  - `npm run test:integration` passed, 212 files / 2228 tests; 3 skipped files / 7 skipped tests.
  - After the idempotent migration fix, `npm run typecheck`, `npm run lint:boundaries`, `npm run build`, `git diff --check`, `npm run test:unit`, and `npm run test:integration` passed again.
  - After rebasing onto `origin/main` at `b200f3c9`, `npm run typecheck`, `git diff --check`, and `npx vitest run --config vitest.integration.config.ts src/runtime/store/__tests__/runtime-evidence-strategy-dream-state-store.test.ts` passed.
  - After the persisted-only process-session artifact link fix, `npm run typecheck`, `git diff --check`, and `npx vitest run --config vitest.unit.config.ts src/tools/runtime/__tests__/LongRunningRuntimeTools.test.ts src/tools/system/ProcessSessionTool/__tests__/ProcessSessionTool.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts` passed.
  - Final review agent reported no high-confidence material blockers after the process-session fixes.
  - Final validation after all blocker fixes:
    - `npm run typecheck` passed.
    - `npm run lint:boundaries` passed with existing repository warnings and 0 errors.
    - `npm run build` passed.
    - `git diff --check` passed.
    - `npx vitest run --config vitest.unit.config.ts src/tools/system/ProcessSessionTool/__tests__/ProcessSessionTool.test.ts src/tools/runtime/__tests__/LongRunningRuntimeTools.test.ts src/orchestrator/strategy/__tests__/portfolio-manager.test.ts src/orchestrator/loop/__tests__/core-loop-integrations.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-gateway-runtime-control.test.ts src/runtime/__tests__/dream-sidecar-review.test.ts src/orchestrator/execution/agent-loop/__tests__/kaggle-training-benchmark.test.ts` passed, 267 tests.
    - `npx vitest run --config vitest.integration.config.ts src/runtime/store/__tests__/runtime-evidence-strategy-dream-state-store.test.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/interface/tui/__tests__/app.test.ts` passed, 76 tests.
    - `npm run test:unit` passed, 495 files / 7846 tests; 3 skipped files / 3 skipped tests.
    - `npm run test:integration` passed, 212 files / 2228 tests; 3 skipped files / 7 skipped tests.
