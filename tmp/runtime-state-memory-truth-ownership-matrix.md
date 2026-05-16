# Runtime State Memory Truth Ownership Matrix

Base: `main` at `1d8263fcc54d117a0f4459e2092a2e0d2d4a4b12`.

GitHub state confirmed before implementation:

| Item | State | Detail |
| --- | --- | --- |
| #1996 Interaction Authority Kernel + Evaluation Lab | MERGED | Merged `2026-05-16T06:57:03Z` |
| #1997 Runtime Event Log / RuntimeGraph source-of-truth | MERGED | Merged `2026-05-16T14:24:41Z`, merge commit `1d8263fcc54d117a0f4459e2092a2e0d2d4a4b12` |

## Memory / Knowledge / Soil Current Ownership

| Domain | Current production owner | Mutation owner | Projection owner | Transaction boundary | Migration story | Legacy/debug/import/export exception | Proof target |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent memory claims | `KnowledgeManager` -> `KnowledgeMemoryStateStore` -> Soil SQLite generic records | `saveAgentMemoryEntry`, `applyAgentMemoryCorrection`, `saveAgentMemoryStore` | `projectAgentMemoryToSoil`, normal memory inspect projection | Soil `applyMutation` only, not cross-domain claim transaction | Move to `MemoryTruthMaintenanceStore` typed claim/evidence/correction/tombstone/conflict/recall/projection tables; adapt `KnowledgeManager` APIs | Legacy `KnowledgeMemoryStateStore` remains compatibility/migration/debug input | Contract + replay + tool caller tests |
| Domain knowledge | `KnowledgeMemoryStateStore` Soil records | `saveDomainKnowledgeEntry` | `projectDomainKnowledgeToSoil`, vector/graph stores | Soil `applyMutation`, vector rollback by caller | Store domain knowledge as `MemoryClaim` with goal scope and evidence refs; keep `KnowledgeEntry` API as adapter | Legacy knowledge/graph/vector imports stay doctor/repair only | KnowledgeManager caller tests plus graph projection tests |
| Shared knowledge | `KnowledgeMemoryStateStore` Soil records | `saveSharedKnowledgeEntry` | `projectSharedKnowledgeToSoil` | Soil `applyMutation` | Store shared knowledge as scoped `MemoryClaim` records | Export/import artifacts only | Shared knowledge query tests |
| Memory correction / forget / retract | `runUserMemoryOperation` + agent memory store corrections + Runtime Event Log trace | `applyAgentMemoryCorrection`; non-agent `RuntimeEvidenceLedger.appendCorrection` | `projectUserFacingMemoryInspect`, `projectMemoryCorrectionAuthority` | Admission trace before write, no single memory truth transaction | Add `MemoryTruthUnitOfWork` that writes correction, replacement claim, tombstone/conflict, recall/projection, and event-log ref atomically | Operator/debug history remains inspectable; destructive delete stays repair manifest only | rollback, duplicate replay, CLI/tool tests |
| Recall | `recallAgentMemoryEntries` over AgentMemoryStore | Read-only | Raw `AgentMemoryEntry[]` returned to callers | none | Return typed recall record with mode/provenance/invalidation/confidence/projection safety; adapt old callers to entries | exact/lexical protocol lookup remains deterministic | exact/lexical/semantic/graph tests |
| Soil projections | `SqliteSoilRepository` + Markdown artifacts | `applySoilMutation`, `rebuildSoilFromRuntime` | Soil query/open/publish surfaces | Soil DB transaction | Consume memory truth projection records and source claim lifecycle; rebuild blocks invalidated resurrection | Markdown import/publish/debug artifacts remain explicit boundary | Soil query/rebuild/product-gauntlet tests |
| Knowledge graph | `KnowledgeGraphStateStore` control DB | `KnowledgeGraph.addNode/addEdge/remove*` | Graph traversal and RuntimeGraph explanation | graph store transactions | Link claim/evidence/correction/conflict/projection refs into graph records and RuntimeGraph | legacy `knowledge/graph.json` import only | graph recall and event-log graph tests |
| Vector index | `VectorIndexStateStore` control DB | `VectorIndex.add/remove` | semantic search | store transactions | Semantic recall returns `semantic`; unavailable returns `semantic_unavailable` and does not label lexical fallback as semantic | legacy `memory/vector-index.json` import only | MemoryRecallTool semantic available/unavailable tests |

## Repo-Wide Runtime State Ownership 2.0 Inventory

| Domain | Production owner | Typed store | Transaction boundary | Legacy exception | Guardrail status |
| --- | --- | --- | --- | --- | --- |
| Goal | `GoalTaskStateStore` | control DB goal/task rows | `db.transaction` | legacy JSON doctor/test import | existing DB-first guard |
| Task | `GoalTaskStateStore` | control DB task rows | `db.transaction` | legacy JSON doctor/test import | existing DB-first guard |
| Observation | Goal/task/evidence stores | control DB observation/evidence rows | store transactions | `observations.json` migration input | existing DB-first guard |
| Runtime | runtime store family + Runtime Event Log | control DB runtime/event rows | store transactions | bounded IPC spool/debug/repro artifacts | existing DB-first guard |
| Surface | normal-surface + interaction authority stores | control DB projection/authority rows | store transactions | debug/export only | docs/public-contract/gauntlet checks |
| Attention | attention state/metabolism stores | control DB attention rows | store transactions | none for production owner | existing DB-first guard |
| Memory | `MemoryTruthMaintenanceStore` | control DB memory truth tables | `MemoryTruthMaintenanceStore.applyCorrectionTransaction` | import/export/debug/migration compatibility reads | `memory-knowledge-raw-state-manager-write` guard added |
| Soil | `SqliteSoilRepository` plus memory truth projections | Soil SQLite + memory projection rows | Soil tx + memory truth tx | import/publish/debug Markdown artifacts | existing allowlist + memory truth guard |
| Knowledge | `MemoryTruthMaintenanceStore` plus graph/vector stores | control DB claim/graph/vector rows | memory truth unit-of-work + graph/vector tx | graph/vector import only | memory truth guard added |
| Approval | Interaction authority / permission stores | control DB authority/permission rows | store transactions | none for production owner | existing DB-first/event-log checks |
| Schedule | schedule/drive stores | control DB schedule rows | store transactions | schedule JSON import only | existing DB-first guard |
| Notification | Outbox + authority stores | control DB outbox/authority rows | store transactions | bounded transport/debug artifacts | existing DB-first/event-log checks |

## Implemented Ownership Changes In This Branch

- Agent memory, domain knowledge, and shared knowledge now load/save through `MemoryTruthMaintenanceStore` with `MemoryClaim`, `EvidenceRef`, `CorrectionRef`, `ForgetTombstone`, `ConflictSet`, `RecallRecord`, and `ProjectionRecord` rows.
- Agent-memory correction/forget/retract commits now use `MemoryTruthMaintenanceStore.applyCorrectionTransaction`; Soil projection runs after the typed transaction.
- `MemoryRecallTool` returns typed recall provenance with explicit `mode`, semantic index status, evidence refs, lifecycle/invalidation state, trust, and normal-projection safety.
- `RuntimeEventLogStore` now accepts `memory.truth_maintenance.recorded` and exposes `memory_truth_maintenance_summary` during projection rebuild; correction events and RuntimeGraph nodes are inserted in the same control DB transaction as the truth update.
- Soil SQLite records for corrected/forgotten/retracted/quarantined memory and correction audit records are inactive for normal search, carry lifecycle/status metadata, and use sanitized fallback text so production Soil lexical/context fallback cannot surface stale memory as normal truth.
- `KnowledgeManager.correctAgentMemory` now uses the typed correction commit hook, so dream_lint/runtime repair callers use the same transaction/event path as CLI and tool memory corrections.
- Domain/shared knowledge owner loads treat inactive typed truth rows as authoritative truth presence and do not fall back to stale Soil compatibility records when active truth is empty.
- `KnowledgeQueryTool` reports `semantic_unavailable` and `lexicalFallbackUsed=true` for semantic requests without a semantic index; available semantic searches that return no matches do not silently use keyword results.
- `check:database-first-legacy-stores` now has a negative guard for production memory/knowledge/Soil `StateManager.writeRaw`.

Repo-wide completion can only be claimed after a later pass proves every non-memory domain has no production raw owner. This PR's completion target is Memory / Soil / Knowledge.
