# Database-First State Refactor Slice 2

## Scope

Move runtime control-plane state onto `pulseed-control.sqlite` schema v2:

- Runtime control operations and operation events
- Background run ledger records
- Runtime daemon/components health records

Legacy JSON inputs are handled only by `importLegacyRuntimeControlStores()`. Normal store reads and writes use SQLite only.

## Base

- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/database-state-slice-2-runtime-control-stores-20260509215355`
- Branch: `codex/database-state-slice-2-runtime-control-stores-20260509215355`
- Base: `origin/main@219f83ea` after rebasing away from an updated main.

## Validation Log

- `npm ci`: completed with existing audit warnings.
- `npm run typecheck`: passed.
- `npx vitest run --config vitest.integration.config.ts src/runtime/store/control-db/__tests__/control-db.test.ts src/runtime/store/__tests__/runtime-control-store-migration.test.ts src/runtime/__tests__/runtime-store-basics.test.ts src/runtime/__tests__/health-store.test.ts src/runtime/__tests__/runtime-control-result-routing.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts`: passed, 55 tests before configured-root coverage was added.
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-doctor.test.ts`: passed, 53 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/runtime/gateway/__tests__/ingress-runtime-control-contract.test.ts src/runtime/__tests__/daemon-task-success-rate.test.ts src/runtime/__tests__/watchdog.test.ts`: passed, 47 tests.
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-runner-gateway-runtime-control.test.ts src/orchestrator/execution/agent-loop/__tests__/runtime-tool-caller-path.test.ts src/tools/runtime/__tests__/SetupRuntimeControlTools.test.ts src/tools/query/__tests__/runtime-session-tools.test.ts src/interface/cli/__tests__/runtime-command.test.ts`: passed, 52 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/store/control-db/__tests__/control-db.test.ts src/runtime/store/__tests__/runtime-control-store-migration.test.ts src/runtime/__tests__/runtime-store-basics.test.ts src/runtime/__tests__/health-store.test.ts src/runtime/__tests__/runtime-control-result-routing.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/runtime/gateway/__tests__/ingress-runtime-control-contract.test.ts src/runtime/__tests__/daemon-task-success-rate.test.ts src/runtime/__tests__/watchdog.test.ts src/runtime/__tests__/daemon-maintenance.test.ts`: passed, 108 tests.
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/chat/__tests__/chat-runner-gateway-runtime-control.test.ts src/orchestrator/execution/agent-loop/__tests__/runtime-tool-caller-path.test.ts src/tools/runtime/__tests__/SetupRuntimeControlTools.test.ts src/tools/query/__tests__/runtime-session-tools.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/chat/__tests__/tend-command.test.ts`: passed, 135 tests.
- Initial PR CI found remaining legacy JSON test assumptions in RunSpec background-run assertions and daemon health assertions. Those tests now read `BackgroundRunLedger` / `RuntimeHealthStore` and assert the old health JSON is absent from the normal path.
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts`: passed, 196 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/daemon-runner.test.ts`: passed, 34 tests.
- `npm run typecheck`: passed after the CI-test alignment fix.
- `npx vitest run --config vitest.integration.config.ts src/runtime/store/control-db/__tests__/control-db.test.ts src/runtime/store/__tests__/runtime-control-store-migration.test.ts src/runtime/__tests__/runtime-store-basics.test.ts src/runtime/__tests__/health-store.test.ts src/runtime/__tests__/runtime-control-result-routing.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/runtime/gateway/__tests__/ingress-runtime-control-contract.test.ts src/runtime/__tests__/daemon-task-success-rate.test.ts src/runtime/__tests__/watchdog.test.ts src/runtime/__tests__/daemon-maintenance.test.ts src/runtime/__tests__/daemon-runner.test.ts`: passed, 142 tests.
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner-gateway-runtime-control.test.ts src/orchestrator/execution/agent-loop/__tests__/runtime-tool-caller-path.test.ts src/tools/runtime/__tests__/SetupRuntimeControlTools.test.ts src/tools/query/__tests__/runtime-session-tools.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/chat/__tests__/tend-command.test.ts`: passed, 331 tests.
- Follow-up PR CI found wider integration fixtures in `loop-supervisor` and `cli-daemon-status` still polling/writing legacy runtime control JSON. Those tests now use `BackgroundRunLedger` and `RuntimeHealthStore` fixtures instead.
- `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/loop-supervisor.test.ts`: passed, 29 tests.
- `npx vitest run --config vitest.integration.config.ts src/interface/cli/__tests__/cli-daemon-status.test.ts`: passed, 24 tests.
- `npm run test:integration`: passed, 201 files, 2184 tests, 3 skipped files, 7 skipped tests.
- `git diff --check`: passed.
- `npm run lint:boundaries`: passed with existing warnings, 0 errors.
- `npm run build`: passed.

## Review

- Fresh review after initial implementation reported no material blockers.
- A second fresh review was requested after configured-runtime-root control DB centralization changes.
- Fresh review after the PR CI alignment fix reported no material blockers.
- Fresh review after the wider integration fixture migration reported no material blockers.
