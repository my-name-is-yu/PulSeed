# Stage 14B 実装リサーチ: 再帰的Goal Tree（分解・集約・剪定）

作成日: 2026-03-15
対象: Stage 14B実装チーム全員

---

## 調査済みファイル一覧

1. `src/types/goal-tree.ts` — 14A型定義
2. `src/types/goal.ts` — GoalSchema（14Aフィールド追加済み）
3. `src/types/strategy.ts` — StrategySchema（14Aフィールド追加済み）
4. `src/types/satisficing.ts` — SatisficingAggregationEnum
5. `src/types/core.ts` — コアEnum群
6. `src/goal-negotiator.ts` — GoalNegotiator クラス
7. `src/satisficing-judge.ts` — SatisficingJudge クラス
8. `src/state-manager.ts` — StateManager クラス
9. `src/core-loop.ts` — CoreLoop クラス
10. `src/llm-client.ts` — ILLMClient / MockLLMClient
11. `src/index.ts` — 現在のexport一覧
12. `docs/design/goal-tree.md` — 14Bの設計ドキュメント
13. `src/gap-calculator.ts` — GapCalculator 純粋関数群
14. `tests/goal-tree-manager.test.ts` — **存在しない**（14Bで新規作成）

---

## src/types/goal-tree.ts

### Structure
14Aで新規作成済み。`SatisficingAggregationEnum`を`./goal.js`からimport。

### Key Schemas
| Schema | Type (inferred) | Key Fields |
|--------|----------------|-----------|
| `GoalDecompositionConfigSchema` | `GoalDecompositionConfig` | `max_depth: int(1-10, default=5)`, `min_specificity: float(0-1, default=0.7)`, `auto_prune_threshold: float(0-1, default=0.3)`, `parallel_loop_limit: int(1-10, default=3)` |
| `DecompositionResultSchema` | `DecompositionResult` | `parent_id: string`, `children: any[]`（注意: `z.any()`なのでGoal[]として扱う）, `depth: int>=0`, `specificity_scores: Record<string, number>`, `reasoning: string` |
| `GoalTreeStateSchema` | `GoalTreeState` | `root_id: string`, `total_nodes: int>=0`, `max_depth_reached: int>=0`, `active_loops: string[]`, `pruned_nodes: string[]` |
| `PruneReasonEnum` | `PruneReason` | `"no_progress" \| "superseded" \| "merged" \| "user_requested"` |
| `PruneDecisionSchema` | `PruneDecision` | `goal_id: string`, `reason: PruneReason`, `replacement_id: string \| null (default null)` |
| `AggregationDirectionEnum` | `AggregationDirection` | `"up" \| "down" \| "both"` |
| `StateAggregationRuleSchema` | `StateAggregationRule` | `parent_id: string`, `child_ids: string[]`, `aggregation: SatisficingAggregationEnum`, `propagation_direction: AggregationDirectionEnum` |

### Relevant Details for 14B
- `DecompositionResult.children` は `z.any()` — GoalをpushするときZodバリデーションが走らない。GoalTreeManagerでGoalSchemaで個別パースすること。
- `StateAggregationRule` は `SatisficingAggregationEnum`（`"min" | "avg" | "max" | "all_required"`）を使用。`GapAggregationEnum`（`"max" | "weighted_avg" | "sum"`）とは別物なので混同注意。
- 全スキーマは`src/index.ts`の`export * from "./types/goal-tree.js"`で一括export済み。

---

## src/types/goal.ts

### Structure
`GoalSchema`が主体。`SatisficingAggregationEnum`もここで定義されており（`./core.js`ではなく`./goal.ts`）、goal-tree.tsがimportしている。

### GoalSchema フィールド（完全版）

```typescript
{
  id: string
  parent_id: string | null (default null)       // 親ゴールのID（nullはroot）
  node_type: "goal" | "subgoal" | "milestone" | "leaf" (default "goal")  // ← 14Aでleaf追加済み
  title: string
  description: string (default "")
  status: "active" | "completed" | "cancelled" | "waiting" | "archived" (default "active")

  dimensions: Dimension[]
  gap_aggregation: "max" | "weighted_avg" | "sum" (default "max")  // GapAggregationEnum
  dimension_mapping: DimensionMapping | null (default null)  // サブゴール→親次元マッピング

  constraints: string[] (default [])
  children_ids: string[] (default [])

  // Milestone fields
  target_date: string | null (default null)
  origin: "negotiation" | "decomposition" | "manual" | "curiosity" | null (default null)
  pace_snapshot: PaceSnapshot | null (default null)

  deadline: string | null (default null)
  confidence_flag: "high" | "medium" | "low" | null (default null)
  user_override: boolean (default false)
  feasibility_note: string | null (default null)
  uncertainty_weight: number (default 1.0)

  // Stage 14: Goal tree decomposition fields（14Aで追加済み）
  decomposition_depth: int >= 0 (default 0)
  specificity_score: float(0-1) | null (default null)
  loop_status: "idle" | "running" | "paused" (default "idle")

  created_at: string
  updated_at: string
}
```

### GoalTreeSchema
```typescript
{
  root_id: string,
  goals: Record<string, Goal>  // キーはgoal ID
}
```

### Key Details for 14B
- `children_ids: string[]`でツリー構造を表現。GoalTreeManagerはここを操作する。
- `loop_status`で各ノードのループ実行状態を管理（14C向けだが14Bで設定が必要）。
- `specificity_score`をGoalTreeManagerが設定してleaf判定に使用。
- `decomposition_depth`は分解時に手動でインクリメントして設定。
- `origin: "decomposition"`を分解で生成したサブゴールに設定すること（GoalNegotiatorのdecomposeメソッドと同様）。
- **GoalTreeSchemaはStateManagerにsaveGoalTree/loadGoalTreeとして実装済み**（後述）。

### DimensionSchema（サブゴール次元マッピング用）
```typescript
dimension_mapping: {
  parent_dimension: string,
  aggregation: SatisficingAggregationEnum  // "min" | "avg" | "max" | "all_required"
} | null (default null)
```
SatisficingJudge.propagateSubgoalCompletion()がこれを使用して集約する。

### SatisficingAggregationEnum（`./goal.ts`に定義）
```typescript
z.enum(["min", "avg", "max", "all_required"])
```
StateAggregationRuleとGoalのdimension_mapping両方で使用。

---

## src/types/strategy.ts

### StrategySchema（14Aフィールド追加済み）

```typescript
{
  id: string
  goal_id: string
  target_dimensions: string[]
  primary_dimension: string
  hypothesis: string
  expected_effect: ExpectedEffect[]
  resource_estimate: ResourceEstimate
  state: "candidate" | "active" | "evaluating" | "suspended" | "completed" | "terminated" (default "candidate")
  allocation: float(0-1) (default 0)
  created_at: string
  started_at: string | null (default null)
  completed_at: string | null (default null)
  gap_snapshot_at_start: number | null (default null)
  tasks_generated: string[] (default [])
  effectiveness_score: number | null (default null)
  consecutive_stall_count: number (default 0)

  // Stage 14フィールド（14Aで追加済み）
  source_template_id: string | null (default null)  // テンプレート由来の場合のID（14D用）
  cross_goal_context: string | null (default null)   // ゴール横断コンテキスト（14D用）
}
```

### Relevant Details for 14B
- 14B自体でStrategySchemaの変更は不要（14A完了済み）。
- GoalTreeManagerが生成するサブゴールのPortfolioはPortfolioManagerに委任（各leafが独立PortfolioをもつのはGoalDependencyGraphの設計原則）。

---

## src/types/satisficing.ts

### SatisficingAggregation（`./goal.ts`で定義、`./satisficing.ts`でも参照）

`src/types/goal.ts`に定義:
```typescript
export const SatisficingAggregationEnum = z.enum(["min", "avg", "max", "all_required"]);
export type SatisficingAggregation = z.infer<typeof SatisficingAggregationEnum>;
```
**注意**: `src/types/core.ts`の`AggregationTypeEnum`は`["min", "weighted_avg", "max", "all_required"]`（`weighted_avg`あり）で別物。

### CompletionJudgmentSchema
```typescript
{
  is_complete: boolean
  blocking_dimensions: string[] (default [])
  low_confidence_dimensions: string[] (default [])
  needs_verification_task: boolean (default false)
  checked_at: string
}
```
→ 14B実装の`judgeTreeCompletion()`の戻り値型として使用できる。

### MappingProposalSchema（次元マッピング提案）
```typescript
{
  subgoal_dimension: string
  parent_dimension: string
  similarity_score: float(0-1)
  suggested_aggregation: "min" | "avg" | "max" | "all_required"
  confidence: float(0-1)
  reasoning: string
}
```

---

## src/types/core.ts

### GoalNodeTypeEnum（`./goal.ts`で定義、coreには無い）
`core.ts`には`GoalNodeTypeEnum`は**ない**。`goal.ts`に定義:
```typescript
export const GoalNodeTypeEnum = z.enum(["goal", "subgoal", "milestone", "leaf"]);
```
"leaf"は14Aで追加済み。

### DependencyTypeEnum（`core.ts`に定義）
```typescript
z.enum(["prerequisite", "resource_conflict", "synergy", "conflict", "strategy_dependency"])
```
"strategy_dependency"は14Aで追加済み。

### GapAggregationEnum（`core.ts`に定義）
```typescript
z.enum(["max", "weighted_avg", "sum"])
```
GoalのGap集約用（SatisficingAggregationEnumとは別）。

---

## src/goal-negotiator.ts

### Class Structure
```typescript
export class GoalNegotiator {
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    ethicsGate: EthicsGate,
    observationEngine: ObservationEngine,
    characterConfig?: CharacterConfig,
    satisficingJudge?: SatisficingJudge  // Phase 2: auto-mapping proposals
  )
}
```

### Key Public Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `negotiate()` | `async negotiate(rawGoalDescription, options?) → {goal, response, log}` | 6ステップ交渉フロー（倫理チェック→次元分解→ベースライン→実現可能性→応答生成→ゴール保存） |
| `decompose()` | `async decompose(goalId, parentGoal) → {subgoals, rejectedSubgoals}` | 既存ゴールをサブゴールに分解。LLM生成→倫理チェック→dimension_mapping提案（satisficingJudge使用時） |
| `renegotiate()` | `async renegotiate(goalId, trigger, context?) → {goal, response, log}` | 既存ゴールの再交渉 |
| `getNegotiationLog()` | `getNegotiationLog(goalId) → NegotiationLog \| null` | 交渉ログ読み込み |

### GoalNegotiator.decompose() 詳細

LLMへ送るプロンプト（`buildSubgoalDecompositionPrompt`）の出力フォーマット:
```json
[
  {
    "title": "Subgoal Title",
    "description": "What to achieve",
    "dimensions": [
      {
        "name": "dimension_name",
        "label": "Dimension Label",
        "threshold_type": "min",
        "threshold_value": 50,
        "observation_method_hint": "How to measure"
      }
    ]
  }
]
```
サブゴールには`parent_id: goalId`、`node_type: "subgoal"`、`origin: "decomposition"`が設定される。

### Relevant Details for 14B

1. **GoalTreeManager.decomposeGoal()との責務分離**:
   - `GoalNegotiator.decompose()`はサブゴール生成の**倫理チェック**と**次元分解**を担当。
   - `GoalTreeManager.decomposeGoal()`は**具体性スコア評価**と**N層再帰分解**の制御を担当。
   - 14Bの`decomposeGoal()`実装は内部で`GoalNegotiator.decompose()`を呼ぶか、同様のLLMプロンプトパターンを踏襲する。

2. **LLM呼び出しパターン**:
   - `llmClient.sendMessage([{role: "user", content: prompt}], {temperature: 0})`
   - `llmClient.parseJSON(response.content, SomeZodSchema)` でパース+バリデーション
   - 失敗時は保守的フォールバックを返す（`evaluateQualitatively()`参照）

3. **具体性スコア評価プロンプト**:
   - GoalNegotiator側には具体性スコア評価機能がまだない（14B新規）。
   - 設計書§3.1によると「具体性スコア評価（LLM）」→ `specificity_score >= 0.7`でleaf確定。
   - GoalTreeManagerで新規LLMプロンプトを実装する。

---

## src/satisficing-judge.ts

### Class Structure
```typescript
export class SatisficingJudge {
  constructor(
    stateManager: StateManager,
    embeddingClient?: IEmbeddingClient,      // Phase 2: dimension mapping
    onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void
  )
}
```

### Key Public Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `isDimensionSatisfied()` | `isDimensionSatisfied(dim) → DimensionSatisfaction` | 単一次元の満足判定（confidence ceiling適用） |
| `isGoalComplete()` | `isGoalComplete(goal) → CompletionJudgment` | ゴール全体の完了判定（全次元 AND + 低信頼度次元なし） |
| `applyProgressCeiling()` | `applyProgressCeiling(actualProgress, confidence) → number` | confidence tierに応じたprogress ceiling適用 |
| `selectDimensionsForIteration()` | `selectDimensionsForIteration(dimensions, driveScores, constraints?) → string[]` | 次イテレーションで注力すべき次元を選択 |
| `detectThresholdAdjustmentNeeded()` | `detectThresholdAdjustmentNeeded(goal, failureCounts) → ThresholdAdjustmentProposal[]` | 閾値調整提案生成 |
| `proposeDimensionMapping()` | `async proposeDimensionMapping(subgoalDimensions, parentGoalDimensions) → MappingProposal[]` | embedding類似度でdimension_mapping提案（embeddingClient必要） |
| `propagateSubgoalCompletion()` | `propagateSubgoalCompletion(subgoalId, parentGoalId, subgoalDimensions?) → void` | サブゴール完了を親ゴールの次元に伝播 |

### propagateSubgoalCompletion() 詳細

**Phase 2パス（subgoalDimensionsあり + dimension_mappingあり）**:
1. `dimension_mapping`が設定されたdimensionをグルーピング（parent_dimensionでグループ化）
2. `aggregateValues(values, aggregation, thresholds)` で集約（関数は`satisficing-judge.ts`にexport済み）
3. `dimension_mapping`なしのdimensionは名前ベースマッチング（MVPパス）

**MVPパス（subgoalDimensionsなし）**:
- `parentGoal.dimensions`でサブゴールIDと名前が一致する次元を探してsatisfied値を設定

**14Bへの影響**: StateAggregatorはこのメソッドを活用するか、ロジックを再実装するか判断が必要。

### Progress Ceiling Values（重要）
```
high   (confidence >= 0.85): ceiling = 1.0
medium (confidence >= 0.50): ceiling = 0.85
low    (confidence < 0.50):  ceiling = 0.60
```

### aggregateValues() export
```typescript
export function aggregateValues(
  values: number[],
  aggregation: "min" | "avg" | "max" | "all_required",
  thresholds?: number[]
): number
```
StateAggregatorでも直接使用可能（すでにexport済み）。

### judgeTreeCompletion() — 14Bで追加が必要
現状`isGoalComplete(goal)`のみ。14Bで`judgeTreeCompletion(rootId): CompletionJudgment`を追加。
実装方針（設計書§6.2より）:
1. 全子ゴールが`"completed" or "pruned(merged)"`か確認
2. 親ゴールの次元集約ギャップを計算
3. 集約ギャップが閾値を満たすか確認

---

## src/state-manager.ts

### Class Structure
```typescript
export class StateManager {
  constructor(baseDir?: string)  // default: ~/.motiva/
}
```

### ファイルレイアウト
```
<base>/goals/<goal_id>/goal.json
<base>/goals/<goal_id>/observations.json
<base>/goals/<goal_id>/gap-history.json
<base>/goal-trees/<root_id>.json       ← GoalTree永続化（14Aで追加済み）
<base>/events/
<base>/reports/
```

### Key Public Methods（全リスト）

**Goal CRUD**:
| Method | Signature | Description |
|--------|-----------|-------------|
| `saveGoal()` | `saveGoal(goal: Goal): void` | GoalSchema.parseしてからatomicWrite |
| `loadGoal()` | `loadGoal(goalId: string): Goal \| null` | GoalSchema.parseして返す |
| `deleteGoal()` | `deleteGoal(goalId: string): boolean` | ディレクトリごと削除 |
| `listGoalIds()` | `listGoalIds(): string[]` | goals/ディレクトリ下のIDリスト |
| `goalExists()` | `goalExists(goalId: string): boolean` | goal.jsonの存在チェック |

**Goal Tree（14Aで追加済み）**:
| Method | Signature | Description |
|--------|-----------|-------------|
| `saveGoalTree()` | `saveGoalTree(tree: GoalTree): void` | GoalTreeSchema.parseしてatomicWrite |
| `loadGoalTree()` | `loadGoalTree(rootId: string): GoalTree \| null` | GoalTreeSchema.parseして返す |
| `deleteGoalTree()` | `deleteGoalTree(rootId: string): boolean` | ファイル削除 |

**Observation Log**:
- `saveObservationLog(log)`, `loadObservationLog(goalId)`, `appendObservation(goalId, entry)`

**Gap History**:
- `saveGapHistory(goalId, history[])`, `loadGapHistory(goalId): GapHistoryEntry[]`, `appendGapHistoryEntry(goalId, entry)`

**Milestone**:
- `getMilestones(goals[])`, `getOverdueMilestones(goals[])`, `evaluatePace(milestone, achievement)`, `savePaceSnapshot(goalId, snapshot)`, `generateRescheduleOptions(milestone, achievement)`

**Raw Access**:
- `readRaw(relativePath): unknown | null`, `writeRaw(relativePath, data): void`

### Relevant Details for 14B

**GoalTreeのCRUDは14Aで実装済み**。14Bで追加が必要なメソッド（計画書§14B/5より）:
- `getGoalTree(rootId): GoalTree` — `loadGoalTree`のラッパーまたはエイリアス
- `getSubtree(goalId): Goal[]` — goalId以下のサブツリーを返す
- `updateGoalInTree(goalId, updates): void` — ツリー内のゴール更新 + StateAggregatorへの集約トリガー

**GoalTree型**（goal.tsより）:
```typescript
{
  root_id: string,
  goals: Record<string, Goal>  // フラットマップ、キーはgoal ID
}
```
→ ネストではなくフラットマップ。GoalTreeManagerがchildren_idsで親子を解決する。

**AtomicWrite**: `.tmp`ファイルに書いてrenameするパターン。GoalTreeManagerが`StateManager`経由で書く（直接fsアクセスはしない）。

**children_idsの更新**: 親ゴールに子ゴールIDを追加する際、`loadGoal → push to children_ids → saveGoal`のパターン。

---

## src/core-loop.ts

### Class Structure
```typescript
export class CoreLoop {
  constructor(deps: CoreLoopDeps, config?: LoopConfig)
}

export interface CoreLoopDeps {
  stateManager: StateManager;
  observationEngine: ObservationEngine;
  gapCalculator: GapCalculatorModule;
  driveScorer: DriveScorerModule;
  taskLifecycle: TaskLifecycle;
  satisficingJudge: SatisficingJudge;
  stallDetector: StallDetector;
  strategyManager: StrategyManager;
  reportingEngine: ReportingEngine;
  driveSystem: DriveSystem;
  adapterRegistry: AdapterRegistry;
  knowledgeManager?: KnowledgeManager;
  capabilityDetector?: CapabilityDetector;
  portfolioManager?: PortfolioManager;
  curiosityEngine?: CuriosityEngine;
  goalDependencyGraph?: GoalDependencyGraph;
}
```

### Key Public Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `run()` | `async run(goalId: string): Promise<LoopResult>` | フルループ実行（完了/停止条件まで） |
| `runOneIteration()` | `async runOneIteration(goalId, loopIndex): Promise<LoopIterationResult>` | 1イテレーション実行（公開メソッド）|
| `stop()` | `stop(): void` | 外部からの停止シグナル |
| `isStopped()` | `isStopped(): boolean` | 停止チェック |

### runOneIteration() フロー（8ステップ）
```
1. Load goal (StateManager.loadGoal)
2. Observe (ObservationEngine.observe if available)
3. Gap Calculate (GapCalculator.calculateGapVector → aggregateGaps)
4. Drive Scoring (DriveScorer.scoreAllDimensions → rankDimensions)
4b. Knowledge Gap Check (KnowledgeManager.detectKnowledgeGap) — optional
5. Completion Check (SatisficingJudge.isGoalComplete)
5b. Milestone Deadline Check
6. Stall Check (StallDetector.checkDimensionStall + checkGlobalStall)
6b. Dependency Graph Scheduling Control (GoalDependencyGraph.isBlocked)
7. Task Cycle (TaskLifecycle.runTaskCycle)
8. Report (ReportingEngine.generateExecutionSummary)
```

### Relevant Details for 14B

**14B計画書のCoreLoop変更（最小限）**:
1. ループ開始時に`StateAggregator.aggregateChildStates()`を呼び出す
2. 完了判定で`judgeTreeCompletion()`を使用

具体的には`runOneIteration()`の**step 5直前**（または直後）に集約ロジックを差し込む。

**LoopResult.finalStatus**:
```typescript
"completed" | "stalled" | "max_iterations" | "error" | "stopped"
```

**LoopConfig**:
```typescript
{
  maxIterations?: number (default 100)
  maxConsecutiveErrors?: number (default 3)
  delayBetweenLoopsMs?: number (default 1000)
  adapterType?: string (default "claude_api")
}
```

**重要**: CoreLoopのDI `deps`に`goalTreeManager?: GoalTreeManager`と`stateAggregator?: StateAggregator`を追加する必要がある（optionalで後方互換維持）。

---

## src/llm-client.ts

### ILLMClient Interface
```typescript
export interface ILLMClient {
  sendMessage(
    messages: LLMMessage[],       // [{role: "user"|"assistant", content: string}]
    options?: LLMRequestOptions   // {model?, max_tokens?, system?, temperature?}
  ): Promise<LLMResponse>;        // {content: string, usage: {input_tokens, output_tokens}, stop_reason}
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

### MockLLMClient（テスト用）
```typescript
export class MockLLMClient implements ILLMClient {
  constructor(responses: string[])  // 順番に返すレスポンスを配列で渡す
  get callCount(): number
  // sendMessage: responses[callCount]を返し、callCountをインクリメント
  // parseJSON: 実際のextractJSON + Zodバリデーション
}
```

### Key Patterns for 14B Tests
```typescript
// 具体性スコア評価のモック例
const mockClient = new MockLLMClient([
  JSON.stringify({ specificity_score: 0.4, reasoning: "too abstract" }),  // 分解が必要
  JSON.stringify([{ title: "Sub A", description: "...", dimensions: [...] }]),  // サブゴール生成
]);

// JSON with markdown code blocks also supported
const responseWithCodeBlock = '```json\n{"key": "value"}\n```';
```

**parseJSON**はmarkdownコードブロック（` ```json ` ブロック）も自動抽出する（`extractJSON`ヘルパー使用）。テストのモックレスポンスはpure JSONでも、コードブロック形式でも両方可。

---

## src/index.ts（現在のexport）

### 14A追加済みexport
```typescript
// --- Stage 14 types ---
export * from "./types/goal-tree.js";       // GoalDecompositionConfig, DecompositionResult, GoalTreeState, PruneDecision, StateAggregationRule, etc.
export * from "./types/cross-portfolio.js"; // CrossGoalAllocation, etc.
export * from "./types/learning.js";        // LearningTrigger, LearnedPattern, etc.
```

### 14Bで追加が必要なexport
```typescript
export { GoalTreeManager } from "./goal-tree-manager.js";
export { StateAggregator } from "./state-aggregator.js";
```

### 既存の関連export（14Bが依存）
- `SatisficingJudge, aggregateValues` — `./satisficing-judge.js`
- `GoalNegotiator, EthicsRejectedError` — `./goal-negotiator.js`
- `StateManager` — `./state-manager.js`
- `CoreLoop` — `./core-loop.js` （+ `CoreLoopDeps`, `LoopConfig`, `LoopResult`）
- `ILLMClient, MockLLMClient` — `./llm-client.js`
- `GoalDependencyGraph` — `./goal-dependency-graph.js`
- `SatisficingAggregationEnum` — `./types/goal.js`

---

## docs/design/goal-tree.md（設計ドキュメント要約）

### 分解ロジック（§3）

**分解フロー**:
```
ゴールノード(pending)
    ↓
具体性スコア評価（LLM）
    ├── specificity_score >= 0.7 → leafノード確定 → ループ開始
    └── specificity_score < 0.7
            ├── depth < max_depth(5) → LLMによるサブゴール生成
            └── depth >= max_depth → 強制leaf（分解打ち切り）
```

**LLM出力フォーマット（サブゴール）**:
```json
[
  {
    "hypothesis": "このサブゴールが解決すること",
    "dimensions": [Dimension[]],
    "constraints": ["制約"],
    "expected_specificity": 0.85
  }
]
```
→ GoalNegotiatorのdecomposeとフォーマットが異なる点に注意。GoalTreeManagerは独自プロンプトを実装する（GoalNegotiatorの`buildSubgoalDecompositionPrompt`はtitle/descriptionベース、設計書はhypothesis/expected_specificityベース）。

**max_children_per_node**: 5（プロンプトで指定）。
**検証**（§3.3）:
1. カバレッジ検証（LLM再評価）
2. 次元整合性チェック
3. 循環参照チェック（GoalDependencyGraph使用）

### 剪定（§4）

| 条件 | MVP自動化 | Phase 2 |
|------|---------|---------|
| `no_progress` | 自動 | 自動 |
| `user_requested` | 自動 | 自動 |
| `superseded` | 手動 | 自動 |
| `merged` | 手動 | 自動 |

剪定されたノード: `status: "cancelled"` + PruneDecision記録。
配分は兄弟ゴールに再分配、兄弟がすべて剪定済みなら親にエスカレーション。

### 状態集約（§5）

**下位→上位（集約）**:
```
parent_gap = aggregate(children_gaps, method)
  "min" → ボトルネック（最悪の子）
  "avg" → 加重平均
  "max" → 最大ギャップ
  "all_required" → 全子完了必要

parent_confidence = min(children_confidence)  // 保守的
```

**上位→下位（伝播）**:
- 制約追加・変更: 全子に即座に伝播
- 締切変更: `child_new_deadline = child_original_deadline × (parent_new_deadline / parent_original_deadline)`

### 完了判定（§6）

- leafノード: `SatisficingJudge.isGoalComplete()`で通常の完了判定
- 非leafノード: 全子が"completed" or "pruned(merged)"→集約ギャップ確認→完了連鎖
- 伝播方向: leaf → depth N-1 → ... → root（bottom-up）

### GoalDependencyGraphとの統合（§8.1）
- 親子関係は`parent_child`型依存として登録
- クロスブランチ依存は`prerequisite`型で登録可能
- 循環参照検出に既存GoalDependencyGraphを流用

---

## src/gap-calculator.ts（エクスポート関数）

### 純粋関数（全てexport済み）

| Function | Signature | Description |
|----------|-----------|-------------|
| `computeRawGap()` | `computeRawGap(currentValue, threshold) → number` | 生ギャップ計算（5閾値型対応） |
| `normalizeGap()` | `normalizeGap(rawGap, threshold, currentValue) → number [0,1]` | 正規化 |
| `applyConfidenceWeight()` | `applyConfidenceWeight(normalizedGap, confidence, uncertaintyWeight, currentValueIsNull) → number` | confidence加重 |
| `calculateDimensionGap()` | `calculateDimensionGap(input, globalUncertaintyWeight?) → WeightedGap` | 1次元フルパイプライン |
| `calculateGapVector()` | `calculateGapVector(goalId, dimensions, globalUncertaintyWeight?) → GapVector` | ゴール全次元のギャップベクトル |
| `aggregateGaps()` | `aggregateGaps(childGaps, method?, weights?) → number` | 子ギャップ集約（max/weighted_avg/sum） |

### Relevant Details for 14B
- `StateAggregator`は`aggregateGaps()`を使って親ゴールのギャップ集約を行う。
- `aggregateGaps()`のmethodは`GapAggregationEnum`（"max" | "weighted_avg" | "sum"）。
- `SatisficingAggregationEnum`の"all_required"は`aggregateGaps()`では使えない（`aggregateValues()`を使う）。
- 14Bで親ゴールのギャップを計算する際は`calculateGapVector()`→`aggregateGaps()`のパイプラインを使う。

---

## tests/goal-tree-manager.test.ts

**存在しない**（14Bで新規作成）。計画書によると~100テスト:
- 1層/2層/N層分解
- 具体性閾値による停止
- 深度上限による強制停止
- 分解結果検証（カバレッジ、次元整合性）
- 剪定（no_progress、方針変更、ユーザー要求）
- 動的サブゴール追加
- ツリー再構成
- エッジケース: 単一次元ゴール、空の分解結果、循環参照

**テストでのMockLLMClient使用例（重要）**:
```typescript
// 具体性スコア → サブゴール → 検証 の順でmockレスポンスを設定
const mockLLM = new MockLLMClient([
  JSON.stringify({ specificity_score: 0.4 }),  // 1st call: specificity評価
  JSON.stringify([...subgoals]),               // 2nd call: サブゴール生成
  JSON.stringify({ covers_parent: true }),     // 3rd call: カバレッジ検証
]);
```

---

## 実装上の重要注意点

### 1. GoalTree永続化戦略
`GoalTree.goals`はフラットなRecord<string, Goal>。GoalTreeManagerは:
- 個別Goalは`StateManager.saveGoal()`で保存（`<base>/goals/<id>/goal.json`）
- GoalTree全体は`StateManager.saveGoalTree()`で保存（`<base>/goal-trees/<rootId>.json`）
- **両方の永続化が必要**（GoalTreeにはgoalsの全データが入るが、個別GoalのCRUDも使われる）

### 2. parent_id vs children_ids の二重管理
GoalSchemaは`parent_id`（子→親）と`children_ids`（親→子）の両方を持つ。GoalTreeManagerはサブゴール追加時に**両方を更新**する必要がある:
```
subgoal.parent_id = parentId
parentGoal.children_ids.push(subgoalId)
```

### 3. SatisficingAggregation vs GapAggregation の混同防止
| Type | Values | 使用箇所 |
|------|--------|---------|
| `SatisficingAggregationEnum` | min/avg/max/all_required | Dimension.dimension_mapping, StateAggregationRule.aggregation, SatisficingJudge.aggregateValues() |
| `GapAggregationEnum` | max/weighted_avg/sum | Goal.gap_aggregation, GapCalculator.aggregateGaps() |

### 4. GoalNegotiator.decompose() との責務分離
GoalTreeManagerの`decomposeGoal()`は以下をオーバーラップさせない:
- **GoalNegotiator担当**: 倫理チェック、dimension_mapping提案
- **GoalTreeManager担当**: 具体性スコア評価、再帰深度制御、GoalTreeState管理、循環参照チェック（GoalDependencyGraph）

### 5. CoreLoop変更の最小化
計画書指定の変更は2点のみ:
1. `runOneIteration()`内にStateAggregator.aggregateChildStates()呼び出しを追加
2. 完了判定でSatisficingJudge.judgeTreeCompletion()を使用（ツリーモード時のみ）

**既存の`isGoalComplete()`は触らない**（単一ゴールモードの後方互換性維持）。

### 6. MVPの剪定制限
設計書§9（MVP仕様）: `no_progress`と`user_requested`のみ自動剪定。`superseded`と`merged`は手動。

---

## 14B新規ファイル概要（実装者向け）

### `src/goal-tree-manager.ts`（~400行）
依存: StateManager, ILLMClient, EthicsGate, GoalDependencyGraph, GoalNegotiator(optional)

```typescript
export class GoalTreeManager {
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    ethicsGate: EthicsGate,
    goalDependencyGraph: GoalDependencyGraph,
    goalNegotiator?: GoalNegotiator
  )

  async decomposeGoal(goalId: string, config: GoalDecompositionConfig): Promise<DecompositionResult>
  async validateDecomposition(result: DecompositionResult): Promise<boolean>
  pruneGoal(goalId: string, reason: PruneReason): PruneDecision
  addSubgoal(parentId: string, goal: Goal): Goal
  async restructureTree(goalId: string): Promise<void>
  getTreeState(rootId: string): GoalTreeState
}
```

### `src/state-aggregator.ts`（~200行）
依存: StateManager, SatisficingJudge, GapCalculator(純粋関数)

```typescript
export class StateAggregator {
  constructor(
    stateManager: StateManager,
    satisficingJudge: SatisficingJudge
  )

  aggregateChildStates(parentId: string): AggregatedState  // 定義は実装者が決定
  propagateStateDown(parentId: string): void
  checkCompletionCascade(goalId: string): string[]
}
```

---

## 参照ファイルパス（絶対パス）

- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/goal-tree.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/goal.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/strategy.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/satisficing.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/core.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/goal-negotiator.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/satisficing-judge.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/state-manager.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/core-loop.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/llm-client.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/gap-calculator.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/index.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/docs/design/goal-tree.md`
- `/Users/yuyoshimuta/Documents/dev/Motiva/memory/stage14-plan.md`
