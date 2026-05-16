# Runtime State Memory Truth Production Path Audit

## Confirmed Base Facts

- Latest `main`: `1d8263fcc54d117a0f4459e2092a2e0d2d4a4b12`.
- #1996 Interaction Authority Kernel + Evaluation Lab: merged.
- #1997 Runtime Event Log / RuntimeGraph source-of-truth: merged.
- Base contains `src/runtime/store/runtime-event-log.ts`, `RuntimeEventLogStore`, RuntimeGraph source-of-truth event nodes, and product/replay coverage for memory correction event traces.
- `node -v`: `v24.15.0`.

## Required Caller Paths

| Path | Current entrypoint | Current storage path | Required migration |
| --- | --- | --- | --- |
| memory save | `MemorySaveTool.call` -> `KnowledgeManager.saveAgentMemory` -> `saveAgentMemoryEntry` | `KnowledgeMemoryStateStore.saveAgentMemoryStore` into Soil SQLite records | Save typed `MemoryClaim` and `EvidenceRef`; write Soil projection record; no raw StateManager write |
| memory recall | `MemoryRecallTool.call` -> `KnowledgeManager.recallAgentMemory` -> `recallAgentMemoryEntries` | loads AgentMemoryStore from Soil records, filters in memory | Return typed recall provenance/record with mode, evidence, lifecycle, confidence, projection safety; old API adapts entries |
| memory correction | `cmdMemory`, `MemoryCorrectionTool`, `runUserMemoryOperation` -> `applyAgentMemoryCorrection` | typed truth transaction followed by post-commit authority trace | Atomic correction/replacement/tombstone/projection/event-log linkage in typed unit-of-work |
| memory forget | same as correction | status becomes `forgotten`, content retained in store for audit with redaction | Add first-class `ForgetTombstone`; old evidence reimport/rebuild blocked unless operator-restored |
| memory inspect/history/export | `cmdMemory inspect/history/export`, `inspectUserMemory`, `exportAgentMemoryGovernance` | projection built from AgentMemoryStore and corrections | Normal projection redacts internals; operator/debug shows evidence/correction/forget/conflict and recall mode |
| chat/gateway memory use | `ChatRunner`, `runtime/cognition/memory-context`, `KnowledgeManager` where injected | governed memory context from current stores | Production caller path must use typed recall/projection filtering |
| CLI status/report projection | `/status`, TUI status, CLI status tests in product gauntlet | current status paths use redacted normal surface | Add memory-truth scenario ensuring stale facts do not leak |
| Dream/Reflection/AgentLoop planning | reflection modules, durable loop context, Soil query | `KnowledgeManager` and Soil context | Planning gets valid projections only; conflicts are held/uncertain |
| Soil query/open/publish | Soil tools and schedule publish job | Soil SQLite/Markdown artifacts | Soil query/rebuild/fallback context respects claim invalidation; publish/import/debug remain explicit artifacts |
| runtime event/replay | `RuntimeEventLogStore`, `InteractionAuthorityStore`, `PersonalAgentRuntimeStore` | control DB runtime events and RuntimeGraph | Memory truth mutation events/refs link to RuntimeGraph because #1997 is merged |
| product gauntlet | `tests/product-gauntlet/interaction-authority-gauntlet.test.ts` | existing memory correction and replay scenarios | Add truth-maintenance scenario artifacts and invariants |

## Implemented Production Caller Paths

| Path | Implemented owner path | Proof |
| --- | --- | --- |
| memory save | `MemorySaveTool.call` -> `KnowledgeManager.saveAgentMemory` -> `saveAgentMemoryStoreToTruth` -> `memory_claims` / `memory_evidence_refs` / `memory_projection_records` | `tests/product-gauntlet/memory-truth-maintenance-gauntlet.test.ts`; `MemoryRecallTool` production tests |
| memory recall | `MemoryRecallTool.call` -> `KnowledgeManager.recallAgentMemoryWithProvenance` -> typed `RecallRecord` | exact/lexical/semantic/graph caller-path test in `MemoryRecallTool.test.ts` |
| memory correction/forget/retract | `MemoryCorrectionTool` / `cmdMemory` -> `runUserMemoryOperation` -> `commitAgentMemoryCorrectionToTruth` -> `applyCorrectionTransaction`; `KnowledgeManager.correctAgentMemory` uses the same commit hook for dream_lint/runtime callers | `user-memory-operations.test.ts`; `knowledge-manager-lint.test.ts`; store rollback/idempotency test; replay test |
| memory inspect/history/export | `inspectUserMemory` and governance export load typed truth records through KnowledgeManager adapters; inactive corrected/superseded/conflicted content is redacted from CLI export | `user-memory-operations.test.ts`; `src/interface/cli/commands/__tests__/memory.test.ts`; product gauntlet operator evidence |
| knowledge query semantic fallback | `KnowledgeQueryTool.call` -> semantic search availability contract | `KnowledgeQueryTool.test.ts` proves unavailable semantic index reports `semantic_unavailable` and available-empty semantic search does not call keyword fallback |
| Soil projection/rebuild/search | agent-memory save/correction/forget/retract/conflict triggers Soil projection from typed truth store output; inactive memory/correction/conflict records are not active Soil search candidates | replay test and product gauntlet assert Soil page and production Soil lexical/context fallback contain active replacement and exclude stale/forgotten/conflicted facts |
| domain/shared knowledge load fallback | `KnowledgeManager.loadKnowledge`, `querySharedKnowledge`, `KnowledgeMemoryStateStore`, and `rebuildSoilFromRuntime` use typed truth presence before Soil compatibility fallback | `knowledge-memory-state-store.test.ts` and `soil-runtime-rebuild-import.test.ts` prove inactive typed truth blocks stale Soil record resurrection |
| Runtime Event Log / RuntimeGraph | `memory.truth_maintenance.recorded` event and `memory_truth_maintenance_summary` rebuild output, inserted in the same control DB transaction as the truth update | store contract test, runtime-event rollback test, and product gauntlet event evidence |
| guardrail | `check:database-first-legacy-stores` blocks production memory/knowledge/Soil raw `StateManager.writeRaw` | `database-first-legacy-store-check.test.ts` negative fixture and guard command |

## Current StateManager And File Exceptions

Allowed production compatibility/root uses:

- `KnowledgeManager` constructor keeps `StateManager` for baseDir and older dependency signatures.
- `runUserMemoryOperation` accepts `StateManager`; implemented code uses it as baseDir/root boundary and calls typed owner stores for agent-memory truth.
- `SoilRebuildTool` may use `StateManager.getBaseDir()` only.
- `KnowledgeGraph` constructor keeps legacy graph path as compatibility input; normal graph store uses control DB.
- `vector-index-state-migration.ts` and `knowledge-graph-state-migration.ts` read legacy JSON only as doctor/repair migration input.

Explicit file boundaries retained:

- Soil import/publish/Markdown projection artifacts.
- Debug logs and daemon pid/health files.
- Bounded IPC spool under runtime events.
- Reproducibility/postmortem/report artifacts.
- User-authored profile/character content.
- Config/secret/plugin/gateway setup files.

## Tests That Must Prove Boundary

- Contract test: transaction rollback leaves no partial correction, replacement claim, tombstone, conflict, recall, or projection rows. Added in `src/runtime/store/__tests__/memory-truth-maintenance-store.test.ts`.
- Contract test: duplicate correction with same idempotency key is no-op; distinct key with legitimate new correction is saved. Added in `src/runtime/store/__tests__/memory-truth-maintenance-store.test.ts` and `tests/replay/memory-truth-maintenance-replay.test.ts`.
- Contract test: exact, lexical, semantic, semantic unavailable, and graph recall return explicit mode and consistent invalidation filtering. Added in `MemoryRecallTool.test.ts` and semantic recall tests.
- Contract test: knowledge semantic query returns `semantic_unavailable` with explicit keyword fallback metadata when the semantic index is unavailable and does not silently degrade when a semantic index is present but empty. Added in `KnowledgeQueryTool.test.ts`.
- Caller-path test: `KnowledgeManager.correctAgentMemory` uses `MemoryTruthMaintenanceStore.applyCorrectionTransaction` and creates Event Log / RuntimeGraph evidence through the dream_lint auto-repair path. Added in `knowledge-manager-lint.test.ts`.
- Caller-path test: user and dream_lint correction paths retain `runtime_event_ref` and `runtime_graph_refs` after post-transaction Soil projection, proving projection did not overwrite the typed correction row. Added in `user-memory-operations.test.ts` and `knowledge-manager-lint.test.ts`.
- Caller-path test: inactive domain/shared truth rows block stale Soil compatibility fallback from becoming normal knowledge. Added in `knowledge-memory-state-store.test.ts`.
- Caller-path test: active-looking agent-memory entries with `correction_state.active=false` are withheld from `KnowledgeManager` recall, saved as inactive/corrected truth, and written as inactive sanitized Soil records. Added in `knowledge-memory-state-store.test.ts`.
- Caller-path test: `rebuildSoilFromRuntime` rebuilds from typed truth presence and writes zero-active domain/shared projections instead of reprojecting stale Soil records. Added in `soil-runtime-rebuild-import.test.ts`.
- Caller-path test: `cmdMemory export` redacts corrected inactive stale content while leaving the active replacement visible. Added in `src/interface/cli/commands/__tests__/memory.test.ts`.
- Replay test: conflicted agent-memory claims under the real `agent_memory/default` owner survive restart, load through `KnowledgeManager`, are withheld from recall with `safeForNormalProjection=false`, and redact from governance export. Added in `tests/replay/memory-truth-maintenance-replay.test.ts`.
- Caller-path test: `MemorySaveTool`, `MemoryRecallTool`, `MemoryCorrectionTool`, and `cmdMemory` exercise production routing. Tool paths covered directly; CLI command coverage is through existing command tests plus `runUserMemoryOperation` production path.
- Caller-path test: normal projection does not expose corrected/forgotten stale facts or raw internals. Added in product gauntlet normal projection evidence.
- Soil test: rebuild/query/context fallback does not resurrect forgotten/corrected claims. Added in replay and product gauntlet Soil projection plus `SqliteSoilRepository.searchLexical` / `compileSoilContextFromRepository` assertions.
- RuntimeGraph atomicity test: injected runtime-event failure leaves no correction, replacement, tombstone, projection, or event rows. Added in `src/runtime/store/__tests__/memory-truth-maintenance-store.test.ts`.
- Replay test: recreated stores/runtime preserve tombstones, replacements, conflicts, recall records, and idempotency. Added in `tests/replay/memory-truth-maintenance-replay.test.ts`.
- Product gauntlet: failure artifacts include ownership-boundary, memory-claims, evidence-refs, corrections, tombstones, conflict-sets, recall-records, Soil projection, normal projection, operator evidence, replay summary, and candidate fix plan. Added in `tests/harness/product-gauntlet-runner.ts` and `tests/product-gauntlet/memory-truth-maintenance-gauntlet.test.ts`.
- Guardrail negative test: production memory/knowledge raw `StateManager.writeRaw` causes check failure. Added in `database-first-legacy-store-check.test.ts`.
