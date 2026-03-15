# Stage 14D Research: ゴール横断ポートフォリオ

## 1. Types in `src/types/cross-portfolio.ts`

All schemas are already defined. No new type work needed for 14D.

### CrossGoalAllocationSchema
```
goal_id: string
priority: number [0,1]
resource_share: number [0,1]
adjustment_reason: string
```

### CrossGoalPortfolioConfigSchema
```
max_concurrent_goals: int [1,20], default 5
priority_rebalance_interval_hours: number min(1), default 168 (1 week)
min_goal_share: number [0,1], default 0.1
synergy_bonus: number [0,2], default 0.2
```
Note: `conflict_penalty` is NOT in the schema (only synergy_bonus). The plan mentions -0.15 penalty but there's no corresponding field in the config. **Implementation decision needed**: hard-code penalty or add config field.

### GoalPriorityFactorsSchema
```
goal_id: string
deadline_urgency: number [0,1]
gap_severity: number [0,1]
dependency_weight: number [0,1]
user_priority: number [0,1]
computed_priority: number [0,1]
```

### StrategyTemplateSchema
```
template_id: string
source_goal_id: string
source_strategy_id: string
hypothesis_pattern: string
domain_tags: string[]
effectiveness_score: number [0,1]
applicable_dimensions: string[]
embedding_id: string | null, default null
created_at: string (datetime)
```

### CrossGoalRebalanceTriggerEnum
`"periodic" | "goal_completed" | "goal_added" | "priority_shift"`

### CrossGoalRebalanceResultSchema
```
timestamp: string (datetime)
allocations: CrossGoalAllocation[]
triggered_by: CrossGoalRebalanceTrigger
```

### Also defined (for Stage 14F, not 14D)
`TransferTypeEnum`, `TransferCandidateSchema`, `TransferResultSchema`, `TransferEffectivenessSchema` — ignore for 14D.

---

## 2. GoalSchema fields added in Stage 14 (`src/types/goal.ts`)
```
decomposition_depth: int min(0), default 0
specificity_score: number [0,1] | null, default null
loop_status: "idle" | "running" | "paused", default "idle"
```

---

## 3. StrategySchema fields added in Stage 14 (`src/types/strategy.ts`)
```
source_template_id: string | null, default null
cross_goal_context: string | null, default null
```

---

## 4. DependencyTypeEnum (`src/types/core.ts`)
**Confirmed**: `"strategy_dependency"` is already in the enum.
```typescript
z.enum(["prerequisite", "resource_conflict", "synergy", "conflict", "strategy_dependency"])
```
No change needed to `DependencyTypeEnum`.

---

## 5. GoalDependencyGraph — Current Interface (`src/goal-dependency-graph.ts`)

### Constructor
```typescript
constructor(stateManager: StateManager, llmClient?: ILLMClient)
```

### Public Methods
```typescript
addEdge(edge: Omit<DependencyEdge, "created_at">): DependencyEdge
removeEdge(fromGoalId: string, toGoalId: string, type: DependencyType): void
updateEdgeStatus(fromGoalId: string, toGoalId: string, status: DependencyEdgeStatus): void
getEdges(goalId: string): DependencyEdge[]
getEdge(fromGoalId: string, toGoalId: string, type?: DependencyType): DependencyEdge | null
detectCycle(fromGoalId: string, toGoalId: string): boolean
getPrerequisites(goalId: string): DependencyEdge[]
isBlocked(goalId: string): boolean
getBlockingGoals(goalId: string): string[]
getResourceConflicts(goalId: string): DependencyEdge[]
getSynergyPartners(goalId: string): string[]
autoDetectDependencies(newGoalId: string, existingGoalIds: string[]): Promise<DependencyEdge[]>
load(): DependencyGraph
save(graph: DependencyGraph): void
getGraph(): DependencyGraph
```

### What 14D needs to add
- `addStrategyDependency(fromStrategyId, toStrategyId, type)` — note: the existing `addEdge` uses goal IDs in `DependencyEdge`. Strategy dependencies use strategy IDs. The `DependencyEdge` schema uses `from_goal_id`/`to_goal_id` — these will need to store strategy IDs in those fields when `type === "strategy_dependency"`, OR a new data structure for strategy edges is needed. **Design decision**: re-use `DependencyEdge` with strategy IDs in the goal ID fields, OR add a separate strategy edges collection.
- `getStrategyDependencies(strategyId): DependencyEdge[]`

---

## 6. PortfolioManager — Current Interface (`src/portfolio-manager.ts`)

### Constructor
```typescript
constructor(strategyManager: StrategyManager, stateManager: StateManager, config?: Partial<PortfolioConfig>)
```

### Public Methods
```typescript
selectNextStrategyForTask(goalId: string): TaskSelectionResult | null
calculateEffectiveness(goalId: string): EffectivenessRecord[]
shouldRebalance(goalId: string): RebalanceTrigger | null
rebalance(goalId: string, trigger: RebalanceTrigger): RebalanceResult
checkTermination(strategy: Strategy, records: EffectivenessRecord[]): boolean
activateStrategies(goalId: string, strategyIds: string[]): void
isWaitStrategy(strategy: Strategy): boolean
handleWaitStrategyExpiry(goalId: string, strategyId: string): RebalanceTrigger | null
recordTaskCompletion(strategyId: string): void
getRebalanceHistory(goalId: string): RebalanceResult[]
```

### What 14D needs to add
- `selectNextStrategyAcrossGoals(goalIds: string[]): TaskSelectionResult | null` — use CrossGoalPortfolio allocations to determine which goal's strategy to run next.

---

## 7. CoreLoop — Current Interface (`src/core-loop.ts`)

### Constructor
```typescript
constructor(deps: CoreLoopDeps, config?: LoopConfig)
```

### CoreLoopDeps interface (relevant fields)
```typescript
stateManager, observationEngine, gapCalculator, driveScorer,
taskLifecycle, satisficingJudge, stallDetector, strategyManager,
reportingEngine, driveSystem, adapterRegistry,
knowledgeManager?, capabilityDetector?, portfolioManager?,
curiosityEngine?, goalDependencyGraph?, goalTreeManager?,
stateAggregator?, treeLoopOrchestrator?
```

### LoopConfig
```typescript
maxIterations?: number        // default 100
maxConsecutiveErrors?: number // default 3
delayBetweenLoopsMs?: number  // default 1000
adapterType?: string          // default "claude_api"
treeMode?: boolean            // default false — enables tree mode iteration
```

### Existing public methods
```typescript
run(goalId: string): Promise<LoopResult>
runOneIteration(goalId: string, loopIndex: number): Promise<LoopIterationResult>
runTreeIteration(rootId: string, loopIndex: number): Promise<LoopIterationResult>
stop(): void
isStopped(): boolean
```

### What 14D needs to add
- `runMultiGoalIteration(goalIds: string[]): Promise<LoopIterationResult>` — 3-stage selection: goal → strategy → task.
- Also needs `multiGoalMode?: boolean` in `LoopConfig` to activate this path (parallel to `treeMode`).
- `CrossGoalPortfolio` reference in `CoreLoopDeps` (optional).

---

## 8. VectorIndex Interface (`src/vector-index.ts`)

### Constructor
```typescript
constructor(indexPath: string, embeddingClient: IEmbeddingClient)
```

### Public Methods
```typescript
add(id: string, text: string, metadata?: Record<string, unknown>): Promise<EmbeddingEntry>
search(query: string, topK?: number, threshold?: number): Promise<VectorSearchResult[]>
searchByVector(queryVector: number[], topK?: number, threshold?: number): VectorSearchResult[]
remove(id: string): boolean
getEntry(id: string): EmbeddingEntry | undefined
clear(): void
size: number  // getter
```

### VectorSearchResult (from types/embedding.ts)
```
id: string
text: string
similarity: number
metadata: Record<string, unknown>
```

---

## 9. IEmbeddingClient Interface (`src/embedding-client.ts`)
```typescript
interface IEmbeddingClient {
  embed(text: string): Promise<number[]>
  batchEmbed(texts: string[]): Promise<number[][]>
  cosineSimilarity(a: number[], b: number[]): number
}
```

**Implementations**: `MockEmbeddingClient(dimensions?: number)`, `OllamaEmbeddingClient(model?, baseUrl?)`, `OpenAIEmbeddingClient(apiKey, model?, baseUrl?)`

---

## 10. DriveScorer — Key Functions for deadline_urgency (`src/drive-scorer.ts`)

All pure functions. For `deadline_urgency` calculation:

```typescript
scoreDeadline(
  normalizedWeightedGap: number,
  timeRemainingHours: number | null,
  config?: DriveConfig
): DeadlineScore
// Returns: { dimension_name, normalized_weighted_gap, urgency, score }
// urgency = exp(urgency_steepness × (1 - T/deadline_horizon_hours))
// urgency null deadline → 0; overdue → capped at T=0 value
```

```typescript
scoreAllDimensions(gapVector: GapVector, context: DriveContext, config?: unknown): DriveScore[]
rankDimensions(scores: DriveScore[]): DriveScore[]
```

**For CrossGoalPortfolio**: `deadline_urgency` factor = max urgency across all dimensions of a goal. Access via `scoreDeadline(gap, hoursRemaining)` for each dimension, take max.

---

## 11. ILLMClient Interface (`src/llm-client.ts`)
```typescript
interface ILLMClient {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>
  parseJSON<T>(content: string, schema: ZodSchema<T>): T
}
```

**LLMRequestOptions**: `{ model?, max_tokens?, system?, temperature? }`
**LLMResponse**: `{ content: string, usage: { input_tokens, output_tokens }, stop_reason: string }`

Used by `StrategyTemplateRegistry.applyTemplate()` and `registerTemplate()` for LLM-based hypothesis generalization.

---

## 12. Test Pattern Summary

From `tests/goal-tree-manager.test.ts` and `tests/helpers/mock-llm.ts`:

### Setup pattern
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// Real StateManager on temp dir
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-XXX-test-"));
}
// Cleanup in afterEach: fs.rmSync(tempDir, { recursive: true, force: true })
```

### Mock LLM pattern
```typescript
import { createMockLLMClient } from "./helpers/mock-llm.js";
// Sequential responses by call index:
const mock = createMockLLMClient(["response1", "response2", ...]);
// Access call count: mock.callCount
```

### Goal fixture pattern
```typescript
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return GoalSchema.parse({ id: crypto.randomUUID(), ...defaults, ...overrides });
}
```

### Mock embedding for VectorIndex tests
```typescript
import { MockEmbeddingClient } from "../src/embedding-client.js";
const embClient = new MockEmbeddingClient(768); // deterministic vectors
const vectorIndex = new VectorIndex(path.join(tempDir, "index.json"), embClient);
```

---

## 13. Current exports in `src/index.ts` Relevant to 14D

Already exported:
- `GoalDependencyGraph` (line 69)
- `PortfolioManager` (line 42)
- `CoreLoop`, `CoreLoopDeps`, `LoopConfig`, `LoopResult` (lines 43-44)
- `VectorIndex` (line 93)
- `IEmbeddingClient`, `MockEmbeddingClient`, etc. (line 92)
- All of `./types/cross-portfolio.js` via `export * from "./types/cross-portfolio.js"` (line 102)
- Stage 14 modules: `GoalTreeManager`, `StateAggregator`, `TreeLoopOrchestrator` (lines 106-108)

**14D needs to add exports**:
- `CrossGoalPortfolio` from `./cross-goal-portfolio.js`
- `StrategyTemplateRegistry` from `./strategy-template-registry.js`

---

## 14. Key Design Decisions from `docs/design/portfolio-management.md` Phase 3

### Priority formula
```
goal_priority_score =
  w1 × deadline_urgency +
  w2 × gap_severity +
  w3 × dependency_weight_normalized +
  w4 × user_priority_normalized

Default weights: w1=0.35, w2=0.25, w3=0.25, w4=0.15
→ Normalize to [0, 1]
```

### Dependency bonuses/penalties
- `synergy` pair → both goals +0.1 bonus
- `conflict` pair → lower priority goal -0.15 penalty
- `synergy_bonus` (0.2) is in config, but conflict penalty is hard-coded in design (no config field)

### Rebalance triggers
4 triggers: `periodic` (default 1 week), `goal_completed`, `goal_added`, `priority_shift` (30%+ change in deadline_urgency or gap_severity)

### Concurrent goal limit
- `max_concurrent_goals` (default 5): excess goals move to `waiting` status
- Waiting goals auto-activate when higher-priority goals complete

### Template registration conditions
- `effectiveness_score >= 0.5` AND `state === "completed"`
- LLM generalizes hypothesis_pattern (abstract domain-specific language)
- Embed and store in VectorIndex with `domain_tags`

### Template recommendation flow
1. Before strategy generation for a new goal
2. Search VectorIndex by goal definition
3. Filter: `domain_tags` overlap >= 1
4. Pass top 3 to strategy generation prompt
5. LLM decides whether to apply/adapt

### Strategy dependencies (via GoalDependencyGraph extension)
- `prerequisite`: source must complete → target suspended, allocation=0
- `enhances`: soft dependency → target can run but rebalance triggered after source completes
- Uses existing `DependencyEdge` schema with `type = "strategy_dependency"`
- `from_goal_id`/`to_goal_id` fields will store strategy IDs (naming is misleading but re-use avoids new schema)

### CoreLoop multi-goal mode
3-stage selection per iteration:
1. `CrossGoalPortfolio.allocateResources()` → select which goal runs next
2. `PortfolioManager.selectNextStrategyForTask()` → select strategy within that goal
3. `TaskLifecycle.runTaskCycle()` → generate and execute task

---

## Gaps / Open Questions

1. **conflict_penalty config field**: Design says -0.15 penalty for conflict pairs, but `CrossGoalPortfolioConfigSchema` has no `conflict_penalty` field. Implementation should add it or hard-code.
2. **Strategy dependency edge schema**: `DependencyEdge` uses `from_goal_id`/`to_goal_id`. For strategy dependencies, these fields will hold strategy IDs. This re-use is intentional per design doc but may be confusing. Consider if a separate `StrategyDependencyEdge` type is cleaner.
3. **user_priority source**: `GoalPriorityFactorsSchema` has `user_priority` [0,1] but `GoalSchema` has no user_priority field. Where does this value come from? Likely needs a separate user config/annotation mechanism or a default of 0.5.
4. **`deadline_urgency` for CrossGoalPortfolio**: Design says to use DriveScorer's deadline component, but CoreLoop's `buildDriveContext()` works per-dimension. CrossGoalPortfolio needs goal-level urgency, not dimension-level. Approach: compute max urgency across all dimensions, or use goal.deadline directly.
5. **StrategyTemplateRegistry persistence path**: Not specified. Likely `~/.motiva/strategy-templates.json` or a VectorIndex at `~/.motiva/template-index.json`.
