# Runtime State Memory Truth Migration And Verification Plan

## Target Design

`StateManager` remains a compatibility/root/bootstrap boundary for baseDir and legacy import/export/debug paths. Production memory, Soil, and knowledge truth moves to a typed owner store:

- `MemoryTruthMaintenanceStore` owns claims, evidence refs, corrections, forget tombstones, conflict sets, recall records, projection records, Soil projection metadata, and knowledge graph projection metadata.
- `MemoryTruthUnitOfWork` wraps multi-table truth updates in a real SQLite transaction.
- `KnowledgeManager` keeps its public API but becomes an adapter over the typed truth store.
- Soil and knowledge graph consume typed claim/projection lifecycle records. Soil Markdown and publish/import files stay explicit boundary artifacts.
- Runtime Event Log / RuntimeGraph integration is mandatory because #1997 is merged on the base branch.

## Implementation Steps

1. Add control DB migration for memory truth-maintenance tables. Status: complete in schema version 40.
2. Add Zod schemas and a typed store/service for:
   - `MemoryClaim`
   - `EvidenceRef`
   - `CorrectionRef`
   - `ForgetTombstone`
   - `ConflictSet`
   - `ProcedureMemory`
   - `PreferenceMemory`
   - `RelationshipMemory`
   - `RecallRecord`
   - `ProjectionRecord`
   Status: complete in `src/runtime/store/memory-truth-maintenance-store.ts`.
3. Add transaction APIs for correction, replacement claim, tombstone/conflict, recall/projection updates, RuntimeGraph/event-log refs, and failure injection tests. Status: complete with rollback/idempotency tests, including runtime-event insertion failure rollback inside the same control DB transaction.
4. Adapt `KnowledgeManager` agent memory save/recall/list/correct/history/export to use the typed truth store as production truth. Status: complete for save/recall/correction/forget/retract/history/inspect/export.
5. Adapt domain/shared knowledge save/load/query to the typed truth store. Status: complete through `memory-truth-adapter.ts` and KnowledgeManager store/search callers.
6. Keep `KnowledgeMemoryStateStore` as compatibility/migration/debug and Soil projection helper, not production truth for `KnowledgeManager`. Status: complete; legacy store is fallback/import compatibility when truth store is empty.
7. Add Soil projection consumption of memory truth projection metadata and block corrected/forgotten/conflicted source claims during rebuild/query/publish. Status: complete for agent memory Soil projection caller paths and production Soil lexical/context fallback retrieval; import/publish artifacts stay explicit boundaries.
8. Add Runtime Event Log/RuntimeGraph event payload support for memory truth maintenance or link memory truth rows through existing authority/source refs. Status: complete with `memory.truth_maintenance.recorded`, rebuild summary, and same-transaction event/runtime graph insertion for correction commits.
9. Add guardrails that fail on new production memory/knowledge raw `StateManager.writeRaw`, direct file truth writes, or untyped JSON truth tables without an owned allowlist entry. Status: complete for raw StateManager memory/knowledge/Soil writes; existing direct-file guard remains active.
10. Update docs after tests prove behavior. Status: complete after verification pass.

## Fresh Audit Remediation

- Fresh audit blocker: inactive agent-memory entries were still written to Soil chunks with active search eligibility. Fix: corrected/forgotten/retracted/quarantined memory and correction audit records now write `is_active=false`, sanitized normal-search text, lifecycle/status metadata, and product-gauntlet coverage through `SqliteSoilRepository.searchLexical` plus `compileSoilContextFromRepository`.
- Fresh audit blocker: memory truth correction rows committed before Event Log / RuntimeGraph insertion. Fix: `MemoryTruthMaintenanceStore.applyCorrectionTransaction` now inserts the memory truth event and RuntimeGraph nodes inside the same control DB transaction and proves rollback with `failureAfterStep: "runtime_event"`.
- Fresh audit blocker: `KnowledgeManager.correctAgentMemory` could fall back to owner snapshots instead of the correction transaction. Fix: `KnowledgeManager.agentMemoryHost()` now provides `commitAgentMemoryCorrection`, and `knowledge-manager-lint.test.ts` proves the dream_lint production caller path writes `memory_correction_refs` plus a `memory.truth_maintenance.recorded` event.
- Fresh audit blocker: domain/shared knowledge loads could fall back to stale Soil rows when typed truth contained only inactive claims. Fix: `hasDomainKnowledgeTruth` and `hasSharedKnowledgeTruth` make inactive truth authoritative for owner loads, and `knowledge-memory-state-store.test.ts` proves old Soil rows are not resurrected.
- Fresh audit blocker: `KnowledgeQueryTool` semantic requests could silently return keyword fallback results. Fix: semantic queries now return `mode=semantic_unavailable`, `semanticIndexStatus=unavailable`, and `lexicalFallbackUsed=true` when no semantic index exists; when an index exists, empty semantic results remain empty and do not call keyword fallback.
- Fresh audit blocker: `rebuildSoilFromRuntime` could reproject stale domain/shared knowledge through direct `KnowledgeMemoryStateStore` fallback. Fix: the compatibility store now treats inactive typed truth as authoritative, lists typed truth goal scopes, and runtime rebuild writes empty shared/domain projections when only inactive truth remains.
- Fresh audit blocker: corrected agent memory was exportable through `cmdMemory export`. Fix: governance export redacts all inactive agent-memory statuses and the CLI command test proves corrected stale key/value content is absent while the active replacement remains visible.
- Fresh audit blocker: conflicted agent-memory truth could not load through production memory APIs. Fix: typed correction state, agent-memory status, Soil status, recall records, and inspect projection now represent `conflicted`; replay coverage proves conflicted claims restart, load, stay withheld from normal recall, and redact from export.
- Fresh audit blocker: correction commits could be followed by a truth snapshot from Soil projection or a later owner snapshot, overwriting `runtime_event_ref` and `runtime_graph_refs` on `CorrectionRef`. Fix: correction hooks call `projectAgentMemory(..., { persistTruth: false })`, and `MemoryTruthMaintenanceStore.upsertCorrection` preserves existing event/graph refs when later snapshots carry correction entries without those refs. `user-memory-operations.test.ts` and `knowledge-manager-lint.test.ts` assert the real user and dream_lint caller paths retain those refs; `user-memory-operations.test.ts` also proves a later `KnowledgeManager.saveAgentMemory` snapshot does not erase them.
- Fresh audit blocker: `correction_state.active=false` with an otherwise active agent-memory status could still be considered recallable/projectable. Fix: agent-memory active/safe projection predicates now require active correction state across recall, truth snapshots, Soil projection, dream duplicate grouping, dream Soil mutation, and planning projection. `knowledge-memory-state-store.test.ts` proves a compiled entry with inactive correction state is withheld from recall, stored as `lifecycle=corrected`, and inactive in Soil search.

## Verification Plan

Targeted first:

- `npx vitest run src/runtime/store/__tests__/memory-truth-maintenance-store.test.ts`
- `npx vitest run --config vitest.replay.config.ts tests/replay/memory-truth-maintenance-replay.test.ts`
- `npx vitest run --config vitest.product-gauntlet.config.ts tests/product-gauntlet/memory-truth-maintenance-gauntlet.test.ts`
- `npx vitest run src/platform/corrections/__tests__/user-memory-operations.test.ts src/platform/knowledge/__tests__/knowledge-manager-semantic-recall.test.ts src/tools/query/MemoryRecallTool/__tests__/MemoryRecallTool.test.ts src/tools/execution/MemoryCorrectionTool/__tests__/MemoryCorrectionTool.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/platform/knowledge/__tests__/knowledge-manager-lint.test.ts src/platform/knowledge/__tests__/knowledge-memory-state-store.test.ts src/tools/query/KnowledgeQueryTool/__tests__/KnowledgeQueryTool.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/commands/__tests__/memory.test.ts src/platform/soil/__tests__/soil-runtime-rebuild-import.test.ts`
- `npx vitest run --config vitest.replay.config.ts tests/replay/memory-truth-maintenance-replay.test.ts`

Full required lane before final report:

- `npm run check:database-first-legacy-stores`
- `npm run check:docs`
- `npm run typecheck`
- `npm run lint:boundaries`
- `npm run test:contracts`
- `npm run test:golden-traces`
- `npm run test:replay`
- `npm run test:integration`
- `npm run test:smoke`
- `npm run test:product-gauntlet`
- `npm run test:changed`
- `npm run check:public-contracts`
- `git diff --check`

## Completion Blockers To Avoid

- No docs-only or inventory-only completion.
- No helper-only tests as completion evidence.
- No production memory/knowledge raw `StateManager.writeRaw`.
- No direct file-backed truth owner for memory/knowledge production writes.
- No semantic recall result that silently uses lexical fallback.
- No transaction wrapper without rollback/partial-failure proof.
- No replay tests that only repeat calls in the same process.
- No docs claim without production caller-path tests.
