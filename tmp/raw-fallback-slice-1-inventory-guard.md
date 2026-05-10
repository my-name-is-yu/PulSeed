# Raw Fallback Slice 1: Inventory And Guard Expansion

Updated: 2026-05-10 16:03 JST

## Scope

Slice 1 classifies non-test `StateManager.readRaw` / `StateManager.writeRaw`
callers and expands `scripts/check-database-first-legacy-stores.mjs` so
unclassified raw callers fail even when their durable JSON path is dynamic or
not covered by the older filename rules.

## Baseline

- Base commit: `92ee98cd Add Seedy presence surface policy (#1784)`.
- Dependency PR #1782 is merged into `origin/main`.
- Baseline guard before this slice: `ok=true`, `findings=0`, `debtReport=[]`.

## Caller Inventory

### Typed-store migrate now

- `src/orchestrator/goal/goal-negotiator.ts`
  - `goals/<goalId>/negotiation-log.json`
  - Slice 2: move to goal negotiation typed store/control DB ownership.
- `src/orchestrator/goal/goal-dependency-graph.ts`
  - `dependency-graph.json`
  - Slice 2: move to dependency graph typed store/control DB ownership.
- `src/platform/drive/stall-detector.ts`
  - `stalls/<goalId>.json`
  - Slice 3: replace raw path compatibility with typed stall state API.
- `src/platform/knowledge/learning/learning-pipeline.ts`
  - `learning/<goalId>_logs.json`
  - `learning/<goalId>_patterns.json`
  - `learning/<goalId>_feedback.json`
  - Slice 4: move learning runtime state to typed DB/Soil ownership.
- `src/platform/knowledge/learning/learning-feedback.ts`
  - `learning/<goalId>_structural_feedback.json`
  - Slice 4: move structural feedback state to typed DB/Soil ownership.
- `src/platform/knowledge/transfer/knowledge-transfer.ts`
  - `knowledge-transfer/snapshot.json`
  - `meta-patterns/last_aggregated_at.json`
  - Slice 5: move transfer snapshot and aggregation watermark to typed store APIs.
- `src/platform/knowledge/transfer/transfer-trust.ts`
  - `transfer-trust/*.json`
  - `transfer-trust-history/*.json`
  - `transfer-trust/_index.json`
  - Slice 6: move trust score/history/index to typed DB/Soil store.
- `src/platform/observation/capability-dependencies.ts`
  - `capability_dependencies.json`
  - Slice 7: move to typed capability dependency/registry ownership.
- `src/grounding/providers/task-state-provider.ts`
  - `tasks/<goalId>/<entry>`
  - Slice 8: replace raw task path compatibility with typed task listing/loading APIs.

### Config / user-authored content

- `src/platform/traits/character-config.ts`
  - `character-config.json`
  - Explicit user-editable configuration.
- `src/runtime/capability-execution-resolver.ts`
  - `mcp-servers.json`, `mcpServers.json`
  - MCP server configuration.
- `src/interface/cli/commands/operator-binding-status.ts`
  - `mcp-servers.json`, `mcpServers.json`
  - MCP server configuration.

### Workspace / debug / export artifact

- `src/reporting/reporting-engine.ts`
  - `reports/<goalId>/<reportId>.json`
  - Generated report artifact boundary. Soil projection is derived from this artifact.

### Migration-only fixture

- No non-test `readRaw` / `writeRaw` callers are migration-only fixtures in this inventory.

### Product decision needed

- None for this slice. The requested slice plan already assigns learning and
  transfer state to typed DB/Soil ownership follow-up slices.

### Not a persistence caller

- `src/interface/chat/chat-runner-runtime.ts`
  - Interface type only.

## Guard Impact

- Added a deterministic `state-manager-raw-call` rule that catches
  `.readRaw(...)` and `.writeRaw(...)` calls.
- Added specific raw JSON state rules for negotiation logs, dependency graphs,
  stall state, learning state, knowledge transfer snapshots, transfer trust,
  capability dependencies, reports, and MCP config.
- Classified current known callers through precise file allowlist entries.
- `migrate now` classifications are emitted as `debtReport` entries only when
  matching lines are present.
- Config and report artifact classifications are visible in `allowlistReport`
  but do not count as debt.

## Validation Plan

- `npm exec vitest -- run src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`
- `node scripts/check-database-first-legacy-stores.mjs --json`
- `npm run typecheck`
- `npm run lint:boundaries`
- `git diff --check`

## Validation Results

- `npm ci` with Node 24.15.0 completed in the slice worktree.
- Fresh review found one material blocker: `state-manager-raw-call` was still suppressed on config-shaped raw-call lines.
- Fixed the blocker by applying config-line suppression per rule and never suppressing the raw-call rule.
- Added a regression test for unclassified raw calls to `mcp-servers.json` / `config.json`.
- `npm exec vitest -- run src/interface/cli/__tests__/database-first-legacy-store-check.test.ts` -> 10 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json` -> `ok=true`, `findings=0`, `debtReport` contains 8 active `migrate now` raw-caller entries.
- `npm run typecheck` -> passed.
- `npm run lint:boundaries` -> passed with existing warnings, 0 errors.
- `git diff --check` -> passed.
