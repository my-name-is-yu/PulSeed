# Stage 14C 実装リサーチ: TreeLoopOrchestrator（各ノードの独立ループ実行）

作成日: 2026-03-15
対象: Stage 14C実装チーム全員

---

## 調査済みファイル一覧

1. `src/goal-tree-manager.ts` — 14B実装済み新規ファイル
2. `src/state-aggregator.ts` — 14B実装済み新規ファイル
3. `src/core-loop.ts` — 現在の実装（14B変更済み）
4. `src/cli-runner.ts` — 現在の実装
5. `src/reporting-engine.ts` — 現在の実装
6. `src/index.ts` — 現在のexport一覧
7. `tests/goal-tree-manager.test.ts` — 既存テストパターン（参照）
8. `tests/state-aggregator.test.ts` — 既存テストパターン（参照）
9. `tests/core-loop.test.ts` — 既存テストパターン（参照）
10. `tests/helpers/mock-llm.ts` — MockLLMClientファクトリ

---

## 1. src/goal-tree-manager.ts — 14B実装済みAPI

### 完全なクラスシグネチャ

```typescript
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { GoalDependencyGraph } from "./goal-dependency-graph.js";
import type { GoalNegotiator } from "./goal-negotiator.js";
import { GoalSchema } from "./types/goal.js";
import type { Goal } from "./types/goal.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
  GoalTreeState,
  PruneDecision,
  PruneReason,
} from "./types/goal-tree.js";

export class GoalTreeManager {
  constructor(
    private readonly stateManager: StateManager,
    private readonly llmClient: ILLMClient,
    private readonly ethicsGate: EthicsGate,
    private readonly goalDependencyGraph: GoalDependencyGraph,
    private readonly goalNegotiator?: GoalNegotiator
  ) {}

  // Public methods:
  async decomposeGoal(goalId: string, config: GoalDecompositionConfig): Promise<DecompositionResult>
  async validateDecomposition(result: DecompositionResult): Promise<boolean>
  pruneGoal(goalId: string, reason: PruneReason): PruneDecision
  addSubgoal(parentId: string, goal: Goal): Goal
  async restructureTree(goalId: string): Promise<void>
  getTreeState(rootId: string): GoalTreeState
}
```

### GoalTreeState型（`getTreeState()` の戻り値）

```typescript
{
  root_id: string;
  total_nodes: number;
  max_depth_reached: number;
  active_loops: string[];   // loop_status === "running" のゴールID群
  pruned_nodes: string[];   // status === "cancelled" のゴールID群
}
```

### Goal.loop_status フィールド（14Aで追加済み）

```typescript
loop_status: "idle" | "running" | "paused"  // default: "idle"
```

`getTreeState()` は `goal.loop_status === "running"` のゴールIDを `active_loops` に収集する。
TreeLoopOrchestrator が `loop_status` を `"running"` / `"paused"` / `"idle"` に更新することで、ツリーの実行状態を管理する。

### _collectAllDescendantIds() — プライベートだが参考に

```typescript
private _collectAllDescendantIds(goalId: string): string[]
// goalId以下の全サブゴールIDを再帰収集（goalId自体は含まない）
// goalIdも含めたい場合: [goalId, ..._collectAllDescendantIds(goalId)]
```

### GoalDecompositionConfig型

```typescript
{
  max_depth: number;                // default 5
  min_specificity: number;          // default 0.7
  auto_prune_threshold: number;     // default 0.3
  parallel_loop_limit: number;      // default 3
}
```

`parallel_loop_limit` がTreeLoopOrchestratorの同時実行数制御に使用される。

---

## 2. src/state-aggregator.ts — 14B実装済みAPI

### 完全なクラスシグネチャ

```typescript
import { StateManager } from "./state-manager.js";
import { SatisficingJudge, aggregateValues } from "./satisficing-judge.js";
import { computeRawGap, normalizeGap } from "./gap-calculator.js";
import type { Goal, Dimension } from "./types/goal.js";
import type { SatisficingAggregation } from "./types/goal.js";
import type { StateAggregationRule } from "./types/goal-tree.js";

export interface AggregatedState {
  parent_id: string;
  aggregated_gap: number;
  aggregated_confidence: number;
  child_gaps: Record<string, number>;
  child_completions: Record<string, boolean>;
  aggregation_method: SatisficingAggregation;
  timestamp: string;
}

export class StateAggregator {
  constructor(stateManager: StateManager, satisficingJudge: SatisficingJudge)

  // Public methods:
  registerAggregationRule(rule: StateAggregationRule): void
  aggregateChildStates(parentId: string): AggregatedState  // throws if parent not found
  propagateStateDown(parentId: string): void               // throws if parent not found
  checkCompletionCascade(goalId: string): string[]         // bottom-up list of newly completable ancestors
}
```

### checkCompletionCascade() の動作

- `goalId`を「完了済み」として扱い、親チェーンを遡る
- 全子が `completed` or `cancelled` なら親IDをリストに追加
- bottom-up順（最も近い祖先が先頭）で返す
- **goalの状態をmutateしない**（呼び出し元が状態変更を判断する）

---

## 3. src/core-loop.ts — 現在の実装（14B変更済み）

### CoreLoopDeps（14B変更済み）

```typescript
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
  goalTreeManager?: GoalTreeManager;      // 14Bで追加済み
  stateAggregator?: StateAggregator;       // 14Bで追加済み
}
```

### 14C で CoreLoopDeps に追加が必要

```typescript
treeLoopOrchestrator?: TreeLoopOrchestrator;  // 14C新規
```

### runOneIteration() の現在の重要なステップ

ステップ1b（TreeAggregation、14B追加済み — line 387-398）:
```typescript
if (this.deps.stateAggregator && goal.children_ids.length > 0) {
  try {
    this.deps.stateAggregator.aggregateChildStates(goalId);
    const reloaded = this.deps.stateManager.loadGoal(goalId);
    if (reloaded) { goal = reloaded; }
  } catch {
    // non-fatal
  }
}
```

ステップ5 完了チェック（14B追加済み — line 536-551）:
```typescript
const judgment = goal.children_ids.length > 0
  ? this.deps.satisficingJudge.judgeTreeCompletion(goalId)
  : this.deps.satisficingJudge.isGoalComplete(goal);
```

### 14Cで追加する runTreeIteration() — 実装指針

```typescript
/**
 * Tree-mode iteration: select one node via TreeLoopOrchestrator, run a
 * normal observe→gap→score→task cycle on that node, then aggregate upward.
 *
 * Called by run() when treeMode=true.
 */
async runTreeIteration(rootId: string, loopIndex: number): Promise<LoopIterationResult>
```

**内部フロー**:
1. `TreeLoopOrchestrator.selectNextNode(rootId)` でノード選択
2. ノードがnull（全ノード完了/停止）→ rootIdの完了判定を返してループ終了シグナル
3. 選択されたノードIDで通常の `runOneIteration()` を実行
4. 実行後 `TreeLoopOrchestrator.onNodeCompleted(nodeId)` でコールバック（完了時）
5. `StateAggregator.aggregateChildStates()` を親チェーンで実行（根に向かって集約）
6. LoopIterationResultのgoalIdを選択されたnodeIdに設定して返す

### 既存 run() メソッドへの変更

`run()` の現在の引数: `async run(goalId: string): Promise<LoopResult>`

14Cでは `run()` は変更しない — `runTreeIteration()` への分岐はCLIRunnerの `cmdRun()` 内で制御するか、または `run()` のシグネチャを変えずに `LoopConfig` に `treeMode?: boolean` を追加する方が後方互換性を保てる。

**推奨**: `LoopConfig` に `treeMode?: boolean` を追加し、`run()` 内で分岐:

```typescript
// run()内のメインループ
for (let loopIndex = 0; ...) {
  const iterationResult = this.config.treeMode && this.deps.treeLoopOrchestrator
    ? await this.runTreeIteration(goalId, loopIndex)
    : await this.runOneIteration(goalId, loopIndex);
  ...
}
```

---

## 4. src/cli-runner.ts — 現在の実装

### `run()` メソッドの "run" サブコマンド処理（line 826-860）

現在のフラグパース:
```typescript
parseArgs({
  args: argv.slice(1),
  options: {
    goal: { type: "string" },
    "max-iterations": { type: "string" },
    adapter: { type: "string" },
  },
  strict: false,
})
```

### 14C での変更箇所（line 826-860）

`--tree` フラグの追加:
```typescript
parseArgs({
  args: argv.slice(1),
  options: {
    goal: { type: "string" },
    "max-iterations": { type: "string" },
    adapter: { type: "string" },
    tree: { type: "boolean" },           // ← 14C追加
  },
  strict: false,
})
```

`LoopConfig` への伝達:
```typescript
if (values.tree) {
  loopConfig.treeMode = true;
}
```

### `buildDeps()` メソッドへの変更（line 106-171）

GoalTreeManagerとStateAggregatorのインスタンスを作成してCoreLoopに渡す:

```typescript
private buildDeps(apiKey: string | undefined, config?: LoopConfig, approvalFn?: ...) {
  // ... 既存のインスタンス生成コード ...

  // 14C: TreeLoopOrchestrator追加
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);
  const ethicsGate = new EthicsGate(stateManager, llmClient);
  const goalTreeManager = new GoalTreeManager(
    stateManager, llmClient, ethicsGate, goalDependencyGraph
  );
  const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const treeLoopOrchestrator = new TreeLoopOrchestrator(
    stateManager, goalTreeManager, stateAggregator, satisficingJudge
  );

  const coreLoop = new CoreLoop({
    stateManager,
    ...// 既存deps
    goalTreeManager,        // ← 14B: 追加
    stateAggregator,         // ← 14B: 追加
    treeLoopOrchestrator,    // ← 14C: 追加
  }, config);
}
```

**注意**: 現在のbuildDeps()はGoalDependencyGraph, EthicsGate, GoalTreeManager, StateAggregatorを作成していない。14Cで追加が必要。

### `cmdRun()` のツリーモード表示（line 175-268）

ツリーモード時の追加表示:
```typescript
if (loopConfig.treeMode) {
  console.log("Tree mode enabled — iterating across all nodes");
}
```

### printUsage() への追記（line 1029-1085）

```
Options (motiva run):
  --tree                              Enable tree mode (iterate across all tree nodes)
```

---

## 5. src/reporting-engine.ts — 現在の実装

### 公開メソッド一覧

```typescript
export class ReportingEngine {
  constructor(
    stateManager: StateManager,
    notificationDispatcher?: INotificationDispatcher,
    characterConfig?: CharacterConfig
  )

  generateExecutionSummary(params: ExecutionSummaryParams): Report
  generateDailySummary(goalId: string): Report
  generateWeeklyReport(goalId: string): Report
  saveReport(report: Report): void
  getReport(reportId: string): Report | null
  listReports(goalId?: string): Report[]
  formatForCLI(report: Report): string
  generateNotification(type: NotificationType, context: NotificationContext): Report
  async deliverReport(report: Report): Promise<void>
}
```

### ExecutionSummaryParams型

```typescript
export type ExecutionSummaryParams = {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: { taskId: string; action: string; dimension: string } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
};
```

### ツリーレポートの追加方針

**14C設計書指定**:
- ツリー構造のビジュアライゼーション（テキストベース）
- 各ノードの進捗サマリー

**追加メソッドのシグネチャ**（新規追加）:
```typescript
generateTreeReport(rootId: string): Report
```

**内部実装パターン**:
- `stateManager.loadGoal(rootId)` でrootを取得
- `children_ids` を再帰的に辿ってツリー構造を文字列に組み立てる
- 各ノードの `loop_status`、`status`、`specificity_score` を表示
- `report_type: "execution_summary"` を使う（新規ReportTypeは不要）か、既存の `"weekly_report"` 流用

**Report.report_type の有効値**（`src/types/core.ts` ReportTypeEnumより）:
```
"daily_summary" | "weekly_report" | "urgent_alert" | "approval_request" |
"stall_escalation" | "goal_completion" | "strategy_change" |
"capability_escalation" | "execution_summary"
```
ツリーレポートは `"execution_summary"` として生成するのが最もシンプル（新しい型は不要）。

---

## 6. src/index.ts — 現在のexport

### 14B で追加済み（line 106-107）

```typescript
// --- Stage 14 modules ---
export { GoalTreeManager } from "./goal-tree-manager.js";
export { StateAggregator, type AggregatedState } from "./state-aggregator.js";
```

### 14C で追加が必要

```typescript
export { TreeLoopOrchestrator } from "./tree-loop-orchestrator.js";
export type { TreeLoopConfig } from "./tree-loop-orchestrator.js";  // もし型をexportする場合
```

また、`LoopConfig` に `treeMode` を追加するので、既存の export は変わらない:
```typescript
export type { CoreLoopDeps, LoopConfig, LoopResult } from "./core-loop.js";  // 変更不要
```

---

## 7. 新規ファイル: src/tree-loop-orchestrator.ts（~300行）

### 必要なimport

```typescript
import type { StateManager } from "./state-manager.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type { StateAggregator } from "./state-aggregator.js";
import type { SatisficingJudge } from "./satisficing-judge.js";
import type { GoalDecompositionConfig } from "./types/goal-tree.js";
import type { Goal } from "./types/goal.js";
```

### クラスシグネチャ（設計書 §14C §1より）

```typescript
export class TreeLoopOrchestrator {
  constructor(
    stateManager: StateManager,
    goalTreeManager: GoalTreeManager,
    stateAggregator: StateAggregator,
    satisficingJudge: SatisficingJudge
  )

  // Public methods:

  /**
   * ツリー全体の実行開始。leafノードから優先的にループ開始。
   * parallel_loop_limit に従い同時実行数を制御。
   */
  async startTreeExecution(rootId: string, config: GoalDecompositionConfig): Promise<void>

  /**
   * 次にループを回すノードの選択。
   * 選択基準: gap × 深度の重み × 依存関係の制約
   * Returns null if all active nodes have reached limit or are completed.
   */
  selectNextNode(rootId: string): string | null

  /**
   * 特定ノードのループ一時停止（loop_status を "paused" に更新）。
   */
  pauseNodeLoop(goalId: string): void

  /**
   * ループ再開（loop_status を "running" に更新）。
   */
  resumeNodeLoop(goalId: string): void

  /**
   * ノード完了時のコールバック:
   * - 兄弟ノードへの影響評価
   * - 親ノードの集約更新トリガー (stateAggregator.aggregateChildStates)
   * - 完了したノードのリソースを再配分 (loop_status を "idle" に)
   * - checkCompletionCascade を実行して連鎖完了を検出
   */
  onNodeCompleted(goalId: string): void
}
```

### selectNextNode() の実装アルゴリズム

```
1. GoalTreeManager.getTreeState(rootId) でツリー状態取得
2. active_loops の数が parallel_loop_limit に達していればnullを返す
3. 全ゴールIDを収集（GoalTreeManager._collectAllDescendantIds相当）
4. 各ゴールをフィルタ:
   - status === "active"
   - loop_status !== "running" (既に実行中はスキップ)
   - loop_status !== "paused" (一時停止もスキップ)
   - node_type === "leaf" を優先（leafでないゴールも対象だが低優先）
5. スコアリング（優先度計算）:
   - leafノード: +高スコア（基準 1.0）
   - decomposition_depth が深い: 軽微なボーナス（目的: 深いleafを優先）
   - GoalDependencyGraph.isBlocked(goalId) === true: 除外
6. スコア最大のゴールIDを返す
```

**MVPでの简略版**（ラウンドロビン + leaf優先）:
```
- leafノード（node_type === "leaf"）でactive + idleなものをリストアップ
- 空なら非leafで active + idleなものをリストアップ
- リストが空ならnullを返す
- リストの先頭を返す（キューとして扱う）
```

### startTreeExecution() の役割

14Cの設計書では `startTreeExecution()` は「ツリー全体の実行開始」だが、実際のメインループはCoreLoop.run()が担当する。`startTreeExecution()` は **初期化** のみ行う:
- ルートゴールとその子孫の `loop_status` を `"idle"` に初期化（デフォルト値なので通常何もしない）
- GoalDecompositionConfigをインスタンス変数に保存

### onNodeCompleted() の内部処理

```typescript
onNodeCompleted(goalId: string): void {
  const now = new Date().toISOString();

  // 1. loop_status を "idle" に更新
  const goal = this.stateManager.loadGoal(goalId);
  if (goal) {
    this.stateManager.saveGoal({ ...goal, loop_status: "idle", updated_at: now });
  }

  // 2. 親ゴールへの集約更新（bottom-upで親チェーンを集約）
  let parentId = goal?.parent_id ?? null;
  while (parentId !== null) {
    try {
      this.stateAggregator.aggregateChildStates(parentId);
    } catch { break; }
    const parent = this.stateManager.loadGoal(parentId);
    parentId = parent?.parent_id ?? null;
  }

  // 3. 完了連鎖チェック
  const cascadeIds = this.stateAggregator.checkCompletionCascade(goalId);
  for (const ancestorId of cascadeIds) {
    const ancestor = this.stateManager.loadGoal(ancestorId);
    if (ancestor && ancestor.status !== "completed") {
      this.stateManager.saveGoal({
        ...ancestor,
        status: "completed",
        updated_at: now,
      });
    }
  }
}
```

---

## 8. LoopConfig の変更

**ファイル**: `src/core-loop.ts` （line 68-73）

```typescript
// 現在:
export interface LoopConfig {
  maxIterations?: number;
  maxConsecutiveErrors?: number;
  delayBetweenLoopsMs?: number;
  adapterType?: string;
}

// 14C追加後:
export interface LoopConfig {
  maxIterations?: number;
  maxConsecutiveErrors?: number;
  delayBetweenLoopsMs?: number;
  adapterType?: string;
  treeMode?: boolean;            // ← 14C追加: ツリーモードフラグ
}
```

**DEFAULT_CONFIG** には `treeMode: false` を追加:
```typescript
const DEFAULT_CONFIG: Required<LoopConfig> = {
  maxIterations: 100,
  maxConsecutiveErrors: 3,
  delayBetweenLoopsMs: 1000,
  adapterType: "claude_api",
  treeMode: false,               // ← 14C追加
};
```

---

## 9. SatisficingJudge.judgeTreeCompletion() — 14B実装済み確認

`judgeTreeCompletion` は **既に** `src/satisficing-judge.ts` に実装済み（line 350-387）。
CoreLoopからも既に呼び出されている（line 537, 789）。14Cでは変更不要。

---

## 10. 既存テストパターン — 詳細

### tests/helpers/mock-llm.ts の使い方

```typescript
import { createMockLLMClient } from "./helpers/mock-llm.js";

// 順番に返すレスポンス配列を渡す
const mockLLM = createMockLLMClient([
  JSON.stringify({ specificity_score: 0.9, reasoning: "concrete" }),
  JSON.stringify([{ hypothesis: "...", dimensions: [], constraints: [] }]),
]);

// callCount でLLM呼び出し回数を確認
expect(mockLLM.callCount).toBe(2);
```

### goal-tree-manager.test.ts のパターン

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal-dependency-graph.js";
import { GoalTreeManager } from "../src/goal-tree-manager.js";
import { GoalSchema } from "../src/types/goal.js";
import type { Goal } from "../src/types/goal.js";
import type { GoalDecompositionConfig } from "../src/types/goal-tree.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// テンプレート用フィクスチャ文字列
const PASS_VERDICT = JSON.stringify({
  verdict: "pass", category: "safe", reasoning: "Safe.", risks: [], confidence: 0.95,
});
const HIGH_SPECIFICITY = JSON.stringify({ specificity_score: 0.9, reasoning: "Concrete" });
const LOW_SPECIFICITY = JSON.stringify({ specificity_score: 0.4, reasoning: "Abstract" });

// テスト内でGoalを作る
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return GoalSchema.parse({
    id: `goal-${Math.random().toString(36).slice(2)}`,
    title: "Test Goal",
    description: "A test goal",
    status: "active",
    dimensions: [],
    // ... GoalSchemaの全フィールドをデフォルト値で埋める
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

// GoalTreeManager のインスタンス作成パターン
let tempDir: string;
let stateManager: StateManager;
let mockLLM: ReturnType<typeof createMockLLMClient>;
let ethicsGate: EthicsGate;
let depGraph: GoalDependencyGraph;
let manager: GoalTreeManager;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-tree-test-"));
  stateManager = new StateManager(tempDir);
  mockLLM = createMockLLMClient([/* responses */]);
  ethicsGate = new EthicsGate(stateManager, mockLLM);
  depGraph = new GoalDependencyGraph(stateManager, mockLLM);
  manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, depGraph);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
```

### state-aggregator.test.ts のパターン

```typescript
import { StateAggregator } from "../src/state-aggregator.js";
import type { StateAggregationRule } from "../src/types/goal-tree.js";

// 最小依存のインスタンス作成
let aggregator: StateAggregator;
beforeEach(() => {
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
  aggregator = new StateAggregator(stateManager, judge);
});

// AggregationRule の登録方法
aggregator.registerAggregationRule({
  parent_id: "parent",
  child_ids: ["child-0", "child-1"],
  aggregation: "avg",   // "min" | "avg" | "max" | "all_required"
  propagation_direction: "up",
});

// 基本的なGoalのヘルパー（必須フィールド）
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `goal-${Math.random().toString(36).slice(2)}`,
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "",
    status: "active",
    dimensions: [makeDimension()],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,    // 14Aで追加済み
    specificity_score: null,   // 14Aで追加済み
    loop_status: "idle",       // 14Aで追加済み
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
```

### core-loop.test.ts のパターン（MockDeps作成）

```typescript
import { CoreLoop, buildDriveContext, type LoopConfig, type CoreLoopDeps } from "../src/core-loop.js";
import { vi } from "vitest";

function createMockDeps(tmpDir: string): { deps: CoreLoopDeps; mocks: { ... } } {
  const stateManager = new StateManager(tmpDir);

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
    // 14B追加済み:
    // judgeTreeCompletion: vi.fn().mockReturnValue(makeCompletionJudgment()),
  };

  // ... その他のmock ...

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as unknown as ObservationEngine,
    // ...
    // 14C追加: treeLoopOrchestrator は optional なのでテストによって追加する
  };
  return { deps, mocks: { ... } };
}
```

**14Cのテストで TreeLoopOrchestrator をモックする場合**:
```typescript
const treeLoopOrchestratorMock = {
  selectNextNode: vi.fn().mockReturnValue("node-id-1"),
  pauseNodeLoop: vi.fn(),
  resumeNodeLoop: vi.fn(),
  onNodeCompleted: vi.fn(),
  startTreeExecution: vi.fn(),
};

const deps: CoreLoopDeps = {
  ...baseDeps,
  treeLoopOrchestrator: treeLoopOrchestratorMock as unknown as TreeLoopOrchestrator,
};
const loop = new CoreLoop(deps, { treeMode: true });
```

---

## 11. 14C新規テストファイル: tests/tree-loop-orchestrator.test.ts（~80テスト）

### テスト構成（設計書より）

1. **ノード選択ロジック**
   - leafノードが非leafより優先される
   - parallel_loop_limitに達したらnullを返す
   - ブロックされたノード（依存関係）は選択されない
   - 全ノード完了でnullを返す
   - running/pausedノードはスキップされる
   - 単一ノードツリーで正しく選択される

2. **並列実行数制御**
   - parallel_loop_limit=1 で同時実行1ノードのみ
   - parallel_loop_limit=3 で最大3ノード同時実行
   - limitに達したらselectNextNodeがnullを返す

3. **ノード完了時の連鎖**
   - onNodeCompleted後にloop_statusがidleになる
   - 兄弟ノードへの影響評価（兄弟が残っていれば親は完了しない）
   - 全兄弟完了後の親集約更新
   - checkCompletionCascadeが正しく呼び出される
   - 3層ツリーで葉の完了が根まで伝播

4. **pause/resume**
   - pauseNodeLoopがloop_statusを"paused"にする
   - resumeNodeLoopがloop_statusを"running"にする
   - paused中はselectNextNodeに選択されない

5. **エッジケース**
   - 全ノード完了（selectNextNodeがnullを返す）
   - 単一ノードツリー
   - 深いツリー（5層）でleafから正しく開始
   - rootが唯一のノード（childrenなし、nodeTypeが"leaf"でない場合）

### テストのインスタンス作成パターン

```typescript
import { TreeLoopOrchestrator } from "../src/tree-loop-orchestrator.js";
import { StateManager } from "../src/state-manager.js";
import { SatisficingJudge } from "../src/satisficing-judge.js";
import { StateAggregator } from "../src/state-aggregator.js";
import { GoalTreeManager } from "../src/goal-tree-manager.js";
import { EthicsGate } from "../src/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal-dependency-graph.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

let tempDir: string;
let stateManager: StateManager;
let satisficingJudge: SatisficingJudge;
let stateAggregator: StateAggregator;
let goalTreeManager: GoalTreeManager;
let orchestrator: TreeLoopOrchestrator;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-tlo-test-"));
  stateManager = new StateManager(tempDir);
  satisficingJudge = new SatisficingJudge(stateManager);
  stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const mockLLM = createMockLLMClient([]);
  const ethicsGate = new EthicsGate(stateManager, mockLLM);
  const depGraph = new GoalDependencyGraph(stateManager, mockLLM);
  goalTreeManager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, depGraph);
  orchestrator = new TreeLoopOrchestrator(stateManager, goalTreeManager, stateAggregator, satisficingJudge);
});
```

---

## 12. 既存テストへの影響と変更点

### tests/core-loop.test.ts への変更

**追加が必要なテスト（~10テスト）**:

1. `runTreeIteration()` — LoopConfig.treeMode=trueでrunTreeIterationが呼ばれること
2. `selectNextNode()` が null を返したときにツリーループが終了すること
3. `treeLoopOrchestrator` なしでtreeMode=trueを指定した場合のフォールバック（通常モードで動作）
4. ツリーモードでのLoopResultのfinalStatus確認
5. `onNodeCompleted()` が実行後に呼ばれること

**既存テストへの影響**:
- `makeGoal()` に `decomposition_depth`, `specificity_score`, `loop_status` フィールドが既に追加されている（state-aggregator.testと同じパターン）
- `satisficingJudge` モックに `judgeTreeCompletion` の追加が必要な場合がある（現在はchildren_ids=[]のためisGoalCompleteが呼ばれ問題ない）

**satisficingJudge のモックを更新する場合**:
```typescript
const satisficingJudge = {
  isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
  judgeTreeCompletion: vi.fn().mockReturnValue(makeCompletionJudgment()), // ← 追加
  // ... 他メソッド
};
```

### tests/cli-runner.test.ts への変更（もし存在すれば）

- `motiva run --tree` フラグのパースが正しいことを検証するテストを追加
- treeMode=trueがLoopConfigに伝達されることを確認

---

## 13. 変更ファイル一覧と変更箇所サマリー

### 新規ファイル

| ファイル | 行数目安 | 内容 |
|---------|--------|------|
| `src/tree-loop-orchestrator.ts` | ~300行 | TreeLoopOrchestratorクラス |
| `tests/tree-loop-orchestrator.test.ts` | ~80テスト | TreeLoopOrchestratorのユニットテスト |

### 変更ファイル

| ファイル | 変更箇所 | 内容 |
|---------|---------|------|
| `src/core-loop.ts` | L68-73: LoopConfig型 | `treeMode?: boolean` 追加 |
| `src/core-loop.ts` | L75-80: DEFAULT_CONFIG | `treeMode: false` 追加 |
| `src/core-loop.ts` | L111-130: CoreLoopDeps | `treeLoopOrchestrator?: TreeLoopOrchestrator` 追加 |
| `src/core-loop.ts` | L1-20: import | `TreeLoopOrchestrator` の `import type` 追加 |
| `src/core-loop.ts` | L235-303: run()メインループ | treeMode分岐で `runTreeIteration()` か `runOneIteration()` を選択 |
| `src/core-loop.ts` | 末尾に新規追加 | `runTreeIteration()` メソッド実装 |
| `src/cli-runner.ts` | L826-860: run()の"run"サブコマンド | `tree: { type: "boolean" }` フラグ追加 |
| `src/cli-runner.ts` | L848-858: loopConfig組み立て | `if (values.tree) loopConfig.treeMode = true;` 追加 |
| `src/cli-runner.ts` | L106-171: buildDeps() | GoalDependencyGraph, EthicsGate, GoalTreeManager, StateAggregator, TreeLoopOrchestrator のインスタンス化と CoreLoop への注入 |
| `src/cli-runner.ts` | L215-218: cmdRun() | ツリーモード表示メッセージ追加 |
| `src/cli-runner.ts` | L1029-1085: printUsage() | `--tree` オプションの説明追加 |
| `src/reporting-engine.ts` | 末尾に新規追加 | `generateTreeReport(rootId: string): Report` メソッド |
| `src/index.ts` | L107-108の後 | `TreeLoopOrchestrator` のexport追加 |
| `tests/core-loop.test.ts` | 既存テストのsatisficingJudgeモック | `judgeTreeCompletion` の追加（オプション） |
| `tests/core-loop.test.ts` | 末尾 | ツリーモード関連テスト追加（~10テスト） |

---

## 14. 実装上の重要注意点

### 1. run() の後方互換性

`run(goalId: string)` のシグネチャは変えない。`treeMode` は `LoopConfig` に追加する。
`treeMode: false`（デフォルト）では既存の `runOneIteration()` が呼ばれ、既存テストは全通過するはず。

### 2. treeMode=true でも goalId は root ゴールのID

`coreLoop.run(rootId)` でtreeModeが有効なとき、`rootId` はツリーのルートゴールを表す。
`runTreeIteration()` 内で `selectNextNode(rootId)` を呼び出して実際に実行するノードを決定する。

### 3. loop_status の更新責務

- `selectNextNode()` が選択したノードのloop_statusを "running" に更新するのは **TreeLoopOrchestrator** の責務
- `onNodeCompleted()` がそのノードのloop_statusを "idle" に戻す
- `pauseNodeLoop()` / `resumeNodeLoop()` もTreeLoopOrchestratorが更新する

```typescript
// selectNextNode()の内部で実行するloop_status更新:
const goal = this.stateManager.loadGoal(selectedId);
if (goal) {
  this.stateManager.saveGoal({
    ...goal,
    loop_status: "running",
    updated_at: new Date().toISOString(),
  });
}
```

### 4. parallel_loop_limit の読み込み

TreeLoopOrchestratorはコンストラクタかstartTreeExecution()でGoalDecompositionConfigを受け取るか、または内部でGoalTreeStateのactive_loops.lengthを確認して制限する。

**推奨**: `startTreeExecution()` で config を受け取り、インスタンス変数 `this.config` に保存する:
```typescript
private config: GoalDecompositionConfig = {
  max_depth: 5,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,  // デフォルト
};

async startTreeExecution(rootId: string, config: GoalDecompositionConfig): Promise<void> {
  this.config = config;
  // ...
}

selectNextNode(rootId: string): string | null {
  const treeState = this.goalTreeManager.getTreeState(rootId);
  if (treeState.active_loops.length >= this.config.parallel_loop_limit) return null;
  // ...
}
```

### 5. runTreeIteration() でのLoopIterationResult.goalId

`runOneIteration()` の戻り値の `goalId` は元のrootIdになっている。
`runTreeIteration()` では選択されたnodeのIDに上書きして返すか、rootIdのままにするか決定が必要。

**推奨**: 選択されたnodeIdに上書きして返す。これによりCallerがどのノードが実行されたか把握できる:
```typescript
const result = await this.runOneIteration(selectedNodeId, loopIndex);
// result.goalId は selectedNodeId になっているはず（runOneIterationが設定）
return result;
```

### 6. 全ノード完了時の LoopResult.finalStatus

`selectNextNode()` が null を返した場合（全ノード完了、または全ノードがpaused/blocked）:
- ルートゴールの完了判定を実行
- 完了なら `finalStatus: "completed"`
- 完了でないなら `finalStatus: "stopped"` または `"stalled"`（全ノードがブロックされた場合）

### 7. buildDeps() での新インスタンス生成

現在の `buildDeps()` は `GoalDependencyGraph` と `EthicsGate` を生成していない。
CLIRunner.buildDeps()の変更時に注意:

```typescript
// 既存コードにない — 14Cで追加が必要
const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);
const ethicsGate = new EthicsGate(stateManager, llmClient);
const goalTreeManager = new GoalTreeManager(
  stateManager, llmClient, ethicsGate, goalDependencyGraph
);
const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
const treeLoopOrchestrator = new TreeLoopOrchestrator(
  stateManager, goalTreeManager, stateAggregator, satisficingJudge
);
```

`GoalDependencyGraph` のコンストラクタ:
```typescript
new GoalDependencyGraph(stateManager: StateManager, llmClient: ILLMClient)
```
（`src/goal-dependency-graph.ts` から確認）

---

## 15. 参照ファイルパス（絶対パス）

- `/Users/yuyoshimuta/Documents/dev/Motiva/src/goal-tree-manager.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/state-aggregator.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/core-loop.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/cli-runner.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/reporting-engine.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/index.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/satisficing-judge.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/goal-tree.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/types/goal.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/tests/helpers/mock-llm.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/tests/goal-tree-manager.test.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/tests/state-aggregator.test.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/tests/core-loop.test.ts`
- `/Users/yuyoshimuta/Documents/dev/Motiva/memory/stage14-plan.md`
- `/Users/yuyoshimuta/Documents/dev/Motiva/memory/stage14b-research.md`
- `/Users/yuyoshimuta/Documents/dev/Motiva/docs/design/goal-tree.md`
