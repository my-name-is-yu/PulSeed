# Hierarchical Context Memory Design

> Status: Public design reference. This page explains PulSeed design intent and architecture rationale; exact runtime behavior is owned by current source code, tests, and operating docs.

Primary map: [Memory Model](./memory-model-map.md).

> Applies the hierarchical memory model (core/recall/archival) pioneered by MemGPT/Letta to PulSeed's ContextProvider and MemoryLifecycle, improving the quality of context selection.

> Related: `memory-lifecycle.md`, `session-and-context.md`, `knowledge-acquisition.md`

---

## 1. Problem Statement

The current ContextProvider operates with a fixed top-4 selection. Memory entries have no notion of importance, so "information absolutely required in this loop" and "information that would be nice to have" are treated as equals. As a result:

- The active goal's current Gap and strategy can be crowded out by other information
- Knowledge from completed goals constantly occupies context budget
- The context budget is used inefficiently

The MemGPT/Letta approach is a three-tier model where "the LLM autonomously decides what to page in and out of the context window." Within PulSeed's scope, the default behavior implements this with rule-based classification; LLM-autonomous decision-making is deferred to extended behavior.

---

## 2. Three-Tier Memory Model

| Tier | Definition | Context Allocation | Storage |
|------|------------|-------------------|---------|
| **core** | Always in context. Information essential to the current loop | 50% | ShortTermEntry / ContextProvider |
| **recall** | Searchable medium-term memory. Surfaced when highly relevant | 35% | ShortTermEntry / MemoryIndexEntry |
| **archival** | Completed goals and old lessons. Retrieved via semantic search | 15% | MemoryIndexEntry (archive) |

### Mapping to the Existing Three-Tier Model

This design does **not replace** the three tiers (Working/Short-term/Long-term) defined in `memory-lifecycle.md`. It adds a prioritization layer to context selection.

| memory-lifecycle.md | Classification in This Design |
|--------------------|-------------------------------|
| Working Memory | — (the output of context assembly itself) |
| Short-term Memory | core or recall |
| Long-term Memory | recall or archival |
| Archive | archival |

---

## 3. Classification Rules (default behavior: Rule-Based)

### Entries Classified as core

- Observations and experience logs from the active goal within the last 5 loops
- The current strategy entry (active strategy)
- The current Gap calculation result

### Entries Classified as recall

- Older observations, task results, and knowledge entries for the active goal (older than the last 5 loops)
- Strategy history (non-active entries)
- Long-term lessons related to the active goal

### Entries Classified as archival

- All data from completed or cancelled goals
- Old lessons and statistics from Long-term memory (not referenced in the last 50+ loops)
- Knowledge entries marked as superseded

### Default Value

Existing data without a `memory_tier` field is treated as `"recall"` (backward compatibility).

---

## 4. Context Budget Allocation

This functions as an upper layer on top of the priority 1–6 rules in `session-and-context.md` §4.

```
Context Budget (50% of model window)
  └─ core tier:     50%  — Always included. Eviction prohibited
  └─ recall tier:   35%  — Filled in descending relevance score order
  └─ archival tier: 15%  — Semantic search results added if budget remains (extended behavior)
                           In the default behavior, added alongside recall if budget allows
```

The core tier is **never evicted**. If the budget is insufficient, recall and archival entries are reduced.

---

## 5. Integration Points

### 5.1 ShortTermEntry / MemoryIndexEntry (Type Definitions)

Add a `memory_tier` field to `src/types/memory-lifecycle.ts` (default: `"recall"`).

- `ShortTermEntrySchema`: `memory_tier: MemoryTierSchema.default("recall")`
- `MemoryIndexEntrySchema`: `memory_tier: MemoryTierSchema.default("recall")`

### 5.2 MemorySelection Changes (default behavior)

In `selectForWorkingMemory()` in `src/knowledge/memory-selection.ts`, split entries by tier and select them in order: core → recall → archival, filling up to each tier's budget allocation.

### 5.3 ContextBudget (default behavior)

Add a `TierBudget` type (`{ core, recall, archival }`) so that ContextProvider can reference the budget allocation.

### 5.4 ContextProvider (default behavior)

Assign a tier to each collected workspace context entry.

- Active goal dimensions + current Gap → `core`
- Past observations and strategy history → `recall`
- Knowledge from completed goals → `archival`

---

## 6. Default behavior and extensions

| Feature | default behavior | extended behavior |
|---------|---------------|---------|
| Tier classification | Rule-based (loop_number, goal status) | LLM-autonomous (page in/out) |
| Archival search | Fills remaining budget alongside recall | Semantic search via VectorIndex |
| Tier promotion | None | Auto-promotion recall→core (on similar goal detection) |
| Tier demotion | None | Auto-demotion core→recall (on satisficing judgment) |
| Budget allocation | Fixed ratio (50/35/15) | Dynamic allocation tied to DriveScorer |

---

## 7. Storage Changes

The existing directory structure is not changed. The `memory_tier` field is simply added to each entry's JSON.

```json
// Example ShortTermEntry (added field only)
{
  "id": "entry_abc",
  "memory_tier": "core",
  ...
}
```

Backward compatibility: `.default("recall")` ensures existing entries receive `"recall"` when parsed with `Zod.parse()`.

---

## Summary of Design Principles

| Principle | Specific Design Decision |
|-----------|--------------------------|
| Never evict core | Reduce recall/archival when budget is exceeded |
| Do not break existing design | Keep the three tiers from memory-lifecycle.md; add tier as a classification layer |
| Backward compatibility | `memory_tier` uses `.default("recall")` so existing data is not broken |
| Default behavior first | LLM-autonomous decision-making deferred to extended behavior; The default behavior uses simple rule-based classification |
