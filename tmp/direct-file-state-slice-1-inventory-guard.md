# Slice 1: Direct File Owner Inventory And Guard Expansion

## Evidence

- Preflight confirmed #1827 is merged and present on origin/main.
- Baseline guard: `findings=[]`, `debtReport=[]`.
- Direct filesystem search found candidate owners in RunSpec, DriveSystem schedule/events, StrategyTemplateRegistry, VectorIndex, KnowledgeGraph, runtime reports/postmortems/reproducibility artifacts, setup/config/plugin/gateway/channel files, workspace/Kaggle/tool artifacts, TUI/debug logs, and Soil import/publish/build surfaces.

## Plan

1. Add direct-file state categories to the guard report without migrating durable owners in this slice.
2. Inventory every non-test direct filesystem state owner surfaced by the baseline scan.
3. Mark unresolved durable owners as debt for their later slices.
4. Keep artifact/config/workspace/migration/spool boundaries explicit and non-debt.
5. Add guard tests for representative unclassified direct file runtime JSON, cache JSON, queue JSON/JSONL, and state directory writes.

## Implementation Notes

- Added direct file categories and `directFileOwnerReport` / `directFileDebtReport` to `scripts/check-database-first-legacy-stores.mjs`.
- Added rule-level allowlist resolution so mixed files such as `DriveSystem` can classify schedule state and event spool separately.
- Added typed-store debt for RunSpec, DriveSystem schedule, strategy templates, VectorIndex, and KnowledgeGraph.
- Added typed-store debt for reflection reports after fallback review identified `reflections/*.json` as a missed authoritative runtime input.
- Added bounded IPC/spool classification for DriveSystem event queue, runtime event server, file ingestion, MCP event tool, and daemon event callers.
- Added tests for representative bad direct file owners: runtime state JSON, cache JSON, queue JSONL, and state directory writes.

## Validation

- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`: passed, 11 tests
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0
- `npm run typecheck`: passed
- `npm run lint:boundaries`: passed with existing warnings, 0 errors
- `git diff --check`: passed
