# Database-First State Refactor Slice 5

## Target Design

Chat sessions, cross-platform chat session info, AgentLoop session state, and
AgentLoop trace events are owned by Control DB typed stores. Legacy JSON/JSONL
files are explicit migration inputs only.

## Scope

- Added Control DB schema version 5 for chat sessions, cross-platform sessions,
  AgentLoop state, and AgentLoop trace events.
- Added typed stores for chat session data and AgentLoop session/trace data.
- Moved normal ChatHistory, ChatSessionCatalog, cross-platform session info,
  native AgentLoop persistence, and runtime-session projection reads onto DB
  stores.
- Added an explicit legacy import helper for `chat/sessions/*.json`,
  `chat/cross-platform-sessions/*.json`, `chat/agentloop/*.state.json`, and
  `traces/agentloop/**/*.jsonl`.
- Wired the explicit legacy import helper into `pulseed doctor --repair` so
  existing chat/AgentLoop state is imported at the compatibility boundary.

## Validation Notes

- First fresh review found a material blocker: legacy chat/AgentLoop import was
  not reachable from production doctor/repair. Fixed by wiring importer into
  `cmdDoctor(["--repair"])` and adding CLI repair coverage.
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/chat/__tests__/chat-agentloop-state-migration.test.ts src/interface/chat/__tests__/chat-history.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-policy.test.ts src/interface/chat/__tests__/chat-runner-runtime.test.ts src/interface/chat/__tests__/chat-session-store.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/cross-platform-session-normalization.test.ts src/interface/chat/__tests__/chat-boundary-contract.test.ts src/orchestrator/execution/agent-loop/__tests__/agent-loop-session-factory.test.ts` passed: 11 files, 324 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/runtime/session-registry/__tests__/registry-helpers.test.ts` passed: 2 files, 20 tests.
- `npm run typecheck` passed.
- `npm run lint:boundaries` passed with existing warnings only.
- `npm run build` passed.
- `git diff --check` passed.
- Second fresh review found no high-confidence material blockers after the
  doctor repair migration hook was added.
- Final pre-PR sync to `origin/main` included `a1b17d30` and reran the same
  focused unit tests, runtime-session integration tests, `npm run typecheck`,
  `npm run lint:boundaries`, `npm run build`, and `git diff --check`
  successfully.
- PR CI initially failed because broad-lane tests still seeded/asserted legacy
  `chat/sessions/*.json` and `chat/agentloop/*.json` files. Fixed those
  fixtures to seed typed Control DB stores and updated production usage,
  RunSpec handoff, runtime-session tools, and run-spec source refs to avoid
  normal-path chat-session JSON ownership.
- Post-CI-fix validation passed: `npm run test:unit`, `npm run
  test:integration`, `npm run typecheck`, `npm run lint:boundaries` (existing
  warnings only), `npm run build`, and `git diff --check`.
