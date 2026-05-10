# Slice 6: VectorIndex And KnowledgeGraph State

## Evidence

- `VectorIndex` previously read and wrote caller-provided JSON paths, including setup-created `memory/vector-index.json`.
- `KnowledgeGraph` previously read and wrote caller-provided JSON paths, including DurableLoop graph traversal at `knowledge/graph.json`.
- `node scripts/check-database-first-legacy-stores.mjs --json` classified both owners as `typed-store migrate now`.
- Production vector callers use `VectorIndex` as runtime semantic search index state. There is no complete rebuild path in normal startup, so treating it as a file cache would hide authoritative runtime state.
- DurableLoop graph traversal reads graph relationships as runtime context, so graph relationships are authoritative runtime state, not a debug artifact.

## Implementation

- Added control DB schema v26:
  - `vector_index_entries`
  - `knowledge_graph_nodes`
  - `knowledge_graph_edges`
- Added typed stores for vector index entries and knowledge graph nodes/edges.
- Moved `VectorIndex` runtime load/save/remove/clear to `vector_index_entries`.
- Moved `KnowledgeGraph` runtime load/save/remove/clear to typed graph tables.
- Changed setup to create the vector index through the control DB base directory.
- Changed DurableLoop graph traversal to use `KnowledgeGraph.createForControlDb`.
- Added explicit doctor/repair imports for:
  - `memory/vector-index.json`
  - `knowledge/graph.json`
- Repair imports validate legacy records, record `control_legacy_imports`, and retire stale legacy input when typed state already exists.
- Tightened guard and direct owner inventory so normal runtime vector/graph JSON ownership fails outside the explicit migration modules.
- Rebased onto `origin/main @ d533560f` and preserved the latest KnowledgeGraph validation hardening by enforcing non-empty typed graph node IDs/goal IDs and blocking invalid legacy graph import input.

## Validation

- `nvm use 24.15.0 && npm ci`
- `npx vitest run --config vitest.unit.config.ts src/platform/knowledge/__tests__/vector-index.test.ts src/platform/knowledge/__tests__/knowledge-graph.test.ts src/platform/knowledge/__tests__/knowledge-vector-graph-state-migration.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts src/orchestrator/execution/__tests__/task-lifecycle-cycle-helpers.test.ts`
- Combined focused rerun of the five suites above after rebase: 86 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0; remaining direct-file debt is `reflection-reports`.
- `npm run lint:boundaries`
- `npm run build`
- `git diff --check`
- `npm run typecheck`
