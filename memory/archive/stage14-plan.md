# Stage 14 実装計画: ゴール横断ポートフォリオと学習

**ステータス**: 計画策定済み、未着手
**前提**: Stage 1-13 完了（~1919+テスト、~40テストファイル）
**ビジョン対応**: 9. 再帰的Goal Tree + ポートフォリオ

---

## 概要

Stage 14はMotivaの「ゴール追求能力」を単一ゴールから複数ゴールの統合管理へ進化させる。4つの柱がある:

1. **再帰的Goal Tree** — 曖昧なゴールをN層に自動分解し、各ノードで独立したタスク発見ループを実行
2. **ゴール横断ポートフォリオ** — 複数ゴール間のリソース配分最適化と優先度動的調整
3. **学習パイプライン Phase 2** — 全トリガー・全4ステップへの構造的フィードバック
4. **知識・戦略転移** — ゴール間の学習自動適用とドメイン横断パターン認識

---

## サブステージ構成（6パート、順次実装）

依存グラフに基づき、型基盤 → ゴールツリー → ポートフォリオ横断 → 学習 → 転移の順で実装する。

```
14A: 型定義・設計ドキュメント拡張                ← 全パートの前提
14B: 再帰的Goal Tree（分解・集約・剪定）          ← 14A依存
14C: 各ノードの独立ループ実行                     ← 14B依存
14D: ゴール横断ポートフォリオ                     ← 14B依存、14Cと並行可
14E: 学習パイプライン Phase 2                     ← 14B, 14D依存
14F: ゴール間の知識・戦略転移                     ← 14D, 14E依存
```

```
14A ──┬── 14B ──┬── 14C
      │         │
      │         └── 14D ──┬── 14E ── 14F
      │                   │
      └───────────────────┘
```

---

## 事前準備: 設計ドキュメントの拡張

Stage 14着手前に以下の設計ドキュメントを作成または拡張する。

| ドキュメント | 対応 | 内容 |
|------------|------|------|
| `docs/design/goal-tree.md`（新規） | 14.2 | N層分解ロジック、具体性閾値、深度制御、状態集約・伝播ルール、剪定条件 |
| `docs/design/portfolio-management.md` Phase 3 追記 | 14.1 | ゴール横断リソース配分、優先度動的調整、戦略テンプレート推薦 |
| `docs/design/learning-pipeline.md`（新規） | 14.3 | 学習トリガー、分析パイプライン、フィードバック先、パターン蓄積フォーマット |
| `docs/design/knowledge-transfer.md`（新規） | 14.4 | 転移条件、ドメイン類似度判定、自動適用ルール、安全弁 |

**設計ドキュメントは各サブステージの着手前に該当部分を完成させる。14A実装時に全ドキュメントのドラフトを作成し、後続サブステージで詳細化する。**

---

## 14A: 型定義・設計ドキュメント基盤

**スコープ**: Stage 14全体の型定義、設計ドキュメントのドラフト作成
**ロードマップ対応**: 14.1-14.4の型基盤
**サイズ**: Multi-file（3-4ファイル新規 + 3-4既存変更）
**依存**: なし

### 実装内容

#### 新規型定義

1. **`src/types/goal-tree.ts`**（新規、~120行）— 再帰的Goal Tree関連のZodスキーマ
   ```
   GoalDecompositionConfig {
     max_depth: number              // 最大分解深度（デフォルト: 5）
     min_specificity: number        // 具体性閾値 [0,1]（これ以上具体的なら分解停止）
     auto_prune_threshold: number   // 進捗なし判定閾値（剪定トリガー）
     parallel_loop_limit: number    // 同時実行ループ数上限
   }

   DecompositionResult {
     parent_id: string
     children: Goal[]
     depth: number
     specificity_scores: Record<string, number>  // 各子ゴールの具体性スコア
     reasoning: string
   }

   GoalTreeState {
     root_id: string
     total_nodes: number
     max_depth_reached: number
     active_loops: string[]         // 現在タスク発見ループが回っているノードID群
     pruned_nodes: string[]
   }

   PruneDecision {
     goal_id: string
     reason: "no_progress" | "superseded" | "merged" | "user_requested"
     replacement_id: string | null
   }

   StateAggregationRule {
     parent_id: string
     child_ids: string[]
     aggregation: SatisficingAggregation
     propagation_direction: "up" | "down" | "both"
   }
   ```

2. **`src/types/cross-portfolio.ts`**（新規、~100行）— ゴール横断ポートフォリオ関連
   ```
   CrossGoalAllocation {
     goal_id: string
     priority: number               // [0,1] 正規化済み優先度
     resource_share: number          // [0,1] リソース配分比率
     adjustment_reason: string
   }

   CrossGoalPortfolioConfig {
     max_concurrent_goals: number    // 同時アクティブゴール数上限
     priority_rebalance_interval_hours: number
     min_goal_share: number          // ゴールの最小リソース配分
     synergy_bonus: number           // synergy依存関係のボーナス係数
   }

   GoalPriorityFactors {
     goal_id: string
     deadline_urgency: number        // 締切駆動スコア
     gap_severity: number            // 最大ギャップの深刻度
     dependency_weight: number       // 他ゴールへの依存度
     user_priority: number           // ユーザー指定優先度
     computed_priority: number       // 統合優先度
   }

   StrategyTemplate {
     template_id: string
     source_goal_id: string
     source_strategy_id: string
     hypothesis_pattern: string
     domain_tags: string[]
     effectiveness_score: number
     applicable_dimensions: string[]
     embedding_id: string | null
     created_at: string
   }

   CrossGoalRebalanceResult {
     timestamp: string
     allocations: CrossGoalAllocation[]
     triggered_by: "periodic" | "goal_completed" | "goal_added" | "priority_shift"
   }
   ```

3. **`src/types/learning.ts`**（新規、~100行）— 学習パイプライン関連
   ```
   LearningTriggerType = "milestone_reached" | "stall_detected" | "periodic_review" | "goal_completed"

   LearningTrigger {
     type: LearningTriggerType
     goal_id: string
     context: string
     timestamp: string
   }

   LearnedPattern {
     pattern_id: string
     type: "observation_accuracy" | "strategy_selection" | "scope_sizing" | "task_generation"
     description: string
     confidence: number             // [0,1]
     evidence_count: number
     source_goal_ids: string[]
     applicable_domains: string[]
     embedding_id: string | null
     created_at: string
     last_applied_at: string | null
   }

   FeedbackEntry {
     feedback_id: string
     pattern_id: string
     target_step: "observation" | "gap" | "strategy" | "task"
     adjustment: string
     applied_at: string
     effect_observed: "positive" | "negative" | "neutral" | null
   }

   LearningPipelineConfig {
     min_confidence_threshold: number    // パターン登録の最低信頼度（デフォルト: 0.6）
     periodic_review_interval_hours: number
     max_patterns_per_goal: number
     cross_goal_sharing_enabled: boolean
   }
   ```

#### 既存型の拡張

4. **`src/types/goal.ts`** — 以下のフィールド追加
   - `GoalSchema` に `decomposition_depth: z.number().default(0)` — このノードの分解深度
   - `GoalSchema` に `specificity_score: z.number().nullable().default(null)` — 具体性スコア
   - `GoalSchema` に `loop_status: z.enum(["idle", "running", "paused"]).default("idle")` — このノードのループ実行状態
   - `GoalNodeTypeEnum` に `"leaf"` 追加（分解停止ノード）

5. **`src/types/strategy.ts`** — 以下のフィールド追加
   - `StrategySchema` に `source_template_id: z.string().nullable().default(null)` — テンプレート由来の場合のID
   - `StrategySchema` に `cross_goal_context: z.string().nullable().default(null)` — ゴール横断コンテキスト

6. **`src/types/dependency.ts`** — 以下追加
   - `DependencyTypeEnum` に `"strategy_dependency"` がなければ追加（戦略間依存）

7. **`src/index.ts`** — 新規型エクスポート追加

#### 設計ドキュメント

8. `docs/design/goal-tree.md`（新規ドラフト）
9. `docs/design/learning-pipeline.md`（新規ドラフト）
10. `docs/design/knowledge-transfer.md`（新規ドラフト）
11. `docs/design/portfolio-management.md` — Phase 3セクション詳細化

### テスト

- `tests/types/goal-tree.test.ts`（新規）— スキーマバリデーション、デフォルト値、エッジケース（~30テスト）
- `tests/types/cross-portfolio.test.ts`（新規）— スキーマバリデーション（~20テスト）
- `tests/types/learning.test.ts`（新規）— スキーマバリデーション（~20テスト）
- 既存型テストの更新（goal.ts, strategy.ts拡張分）（~10テスト）

### 推定テスト数: ~80

### 受入基準

- [ ] 全新規Zodスキーマがparse/safeParse通過
- [ ] 既存テスト全通過（型拡張が破壊的変更でないこと）
- [ ] 設計ドキュメント4件のドラフトが存在
- [ ] `npm run build` 成功

### 設計判断（着手前に決定）

1. **具体性閾値のデフォルト値**: 0.7が適切か？LLMによる具体性判定のプロンプト設計が必要
2. **並列ループ上限**: リソース制約との兼ね合い。デフォルト3が妥当か
3. **ゴール横断の最小配分**: 単一ゴール内の0.1と同じにするか

---

## 14B: 再帰的Goal Tree（分解・集約・剪定）

**スコープ**: N層ゴール自動分解、状態集約と伝播、動的追加・剪定・再構成
**ロードマップ対応**: 14.2（ループ並列実行を除く）
**サイズ**: Large（5-7ファイル）
**依存**: 14A完了

### 実装内容

1. **`src/goal-tree-manager.ts`**（新規、~400行）— GoalTreeManager クラス
   - `decomposeGoal(goalId, config): Promise<DecompositionResult>` — LLMによるN層自動分解
     - 入力: ゴール、制約、既存次元、ドメイン知識
     - 出力: サブゴール群（各サブゴールに次元・閾値・具体性スコア付き）
     - 具体性閾値チェック: スコア >= threshold → 分解停止（leaf）
     - 深度チェック: depth >= max_depth → 強制停止
   - `validateDecomposition(result): Promise<boolean>` — 分解結果の検証
     - サブゴール群が親ゴールをカバーしているか（LLM検証）
     - 次元の整合性（サブゴール次元が親次元にマッピング可能か）
     - 循環参照チェック
   - `pruneGoal(goalId, reason): PruneDecision` — サブゴールの剪定
     - 進捗なし（N回ループで改善なし）→ 剪定候補
     - 上位ゴールの方針変更 → 下位ツリー全体の剪定
     - 剪定されたノードは `status: "cancelled"` + 理由記録
   - `addSubgoal(parentId, goal): Goal` — 動的サブゴール追加
   - `restructureTree(goalId): Promise<void>` — ツリーの再構成（LLM提案ベース）
   - `getTreeState(rootId): GoalTreeState` — ツリー状態の取得

2. **`src/state-aggregator.ts`**（新規、~200行）— StateAggregator クラス
   - `aggregateChildStates(parentId): AggregatedState` — 下位ゴール群の状態を上位に集約
     - 集約方式: SatisficingAggregation（min/avg/max/all_required）
     - 各次元の `dimension_mapping` に基づいてマッピング
     - confidence は子ゴール群の最小値を採用（保守的）
   - `propagateStateDown(parentId): void` — 上位ゴールの変更を下位に伝播
     - 制約の追加・変更
     - 締切の更新（親の締切変更 → 子の締切比例調整）
   - `checkCompletionCascade(goalId): string[]` — 完了の連鎖チェック
     - 全子ゴール完了 → 親ゴール完了判定のトリガー

3. **`src/goal-negotiator.ts`** 変更 — 分解ロジックの拡張
   - 既存の次元分解プローブをGoalTreeManagerと連携
   - `decomposeIntoSubgoals()` メソッド追加（交渉完了後に自動分解）
   - 分解深度に応じた交渉の簡略化（深い階層では交渉を省略し自動受諾）

4. **`src/satisficing-judge.ts`** 変更 — ツリー対応
   - `judgeTreeCompletion(rootId)` — ツリー全体の完了判定
   - 子ゴール完了 → 親の次元更新 → 親の完了判定の連鎖

5. **`src/state-manager.ts`** 変更 — ツリー操作のCRUD
   - `getGoalTree(rootId): GoalTree` — ツリー全体取得
   - `getSubtree(goalId): Goal[]` — サブツリー取得
   - `updateGoalInTree(goalId, updates)` — ツリー内ゴール更新 + 集約トリガー

6. **`src/core-loop.ts`** 変更（最小限）
   - ループ開始時に `StateAggregator.aggregateChildStates()` を呼び出す
   - 完了判定で `judgeTreeCompletion()` を使用

7. **`src/index.ts`** — 新規クラスエクスポート

### テスト

- `tests/goal-tree-manager.test.ts`（新規、~100テスト）
  - 1層分解、2層分解、N層分解（N=3,4,5）
  - 具体性閾値による停止判定
  - 深度上限による強制停止
  - 分解結果の検証（カバレッジ、次元整合性）
  - 剪定（進捗なし、方針変更、ユーザー要求）
  - 動的サブゴール追加
  - ツリー再構成
  - エッジケース: 単一次元ゴール、空の分解結果、循環参照

- `tests/state-aggregator.test.ts`（新規、~60テスト）
  - 4種集約（min/avg/max/all_required）
  - confidence伝播
  - 締切の比例調整
  - 完了連鎖
  - 3層以上のネスト集約
  - エッジケース: 子なし、単一子、不均等な深さ

- 既存テスト更新（goal-negotiator, satisficing-judge, state-manager, core-loop）（~20テスト）

### 推定テスト数: ~180

### 受入基準

- [ ] 3層のゴールツリーを自動分解し、各ノードに次元・閾値が設定される
- [ ] 具体性閾値に基づいて分解が自動停止する
- [ ] 子ゴールの状態変化が親ゴールに正しく集約される
- [ ] 親ゴールの制約変更が子ゴールに伝播される
- [ ] 全子ゴール完了時に親ゴール完了が連鎖的に判定される
- [ ] 剪定されたノードが適切に `cancelled` される
- [ ] 既存テスト全通過

### 設計判断（着手前に決定）

1. **LLM分解プロンプト設計**: ゴールをサブゴールに分解する際の入力/出力フォーマット。`GoalNegotiator.decomposeIntoSubgoals()` との責務分離
2. **集約デフォルト**: ツリーレベルでのデフォルト集約方式。既存の `gap_aggregation: "max"` と整合させるか、ツリー用に別のデフォルトにするか
3. **剪定の自動化レベル**: 全自動 vs ユーザー承認必須。リスクフラグ「N層Goal Tree分解の品質」への対応

### リスクと対策

| リスク | 対策 |
|--------|------|
| LLM分解の品質ばらつき | 分解結果の検証ループ（`validateDecomposition`）。検証失敗時はリトライ（最大2回）→ 失敗時はユーザーにエスカレーション |
| 深い分解による計算コスト増大 | `max_depth` と `parallel_loop_limit` で制御。デフォルト値は保守的に設定 |
| 状態集約の整合性 | 集約結果のスナップショットを保存し、不整合検知時にロールバック可能にする |

---

## 14C: 各ノードの独立ループ実行

**スコープ**: Goal Treeの各ノードで独立したタスク発見ループの並列実行
**ロードマップ対応**: 14.2の「各ノードで独立したタスク発見ループの並列実行」
**サイズ**: Multi-file（3-4ファイル）
**依存**: 14B完了

### 実装内容

1. **`src/tree-loop-orchestrator.ts`**（新規、~300行）— TreeLoopOrchestrator クラス
   - `startTreeExecution(rootId, config): Promise<void>` — ツリー全体の実行開始
     - leafノードから優先的にループ開始
     - `parallel_loop_limit` に従い同時実行数を制御
   - `selectNextNode(rootId): string | null` — 次にループを回すノードの選択
     - 選択基準: ギャップの大きさ × 深度の重み × 依存関係の制約
     - 親ゴールのdriveスコアを子に伝播（高ギャップの親の子が優先）
   - `pauseNodeLoop(goalId): void` — 特定ノードのループ一時停止
   - `resumeNodeLoop(goalId): void` — ループ再開
   - `onNodeCompleted(goalId): void` — ノード完了時のコールバック
     - 兄弟ノードへの影響評価
     - 親ノードの集約更新トリガー
     - 完了したノードのリソースを再配分

2. **`src/core-loop.ts`** 変更 — ツリーモード対応
   - `runTreeIteration(rootId): Promise<LoopIterationResult>` — ツリーモードの1イテレーション
     - TreeLoopOrchestrator.selectNextNode() でノード選択
     - 選択されたノードに対して通常の observe → gap → score → task → execute → verify を実行
     - 実行後に StateAggregator で親への集約を実行
   - 既存の `runIteration()` はそのまま維持（単一ゴールモード）

3. **`src/cli-runner.ts`** 変更 — ツリー実行オプション
   - `motiva run --tree` オプション追加
   - ツリー実行時のステータス表示（どのノードのループが回っているか）

4. **`src/reporting-engine.ts`** 変更 — ツリーレポート
   - ツリー構造のビジュアライゼーション（テキストベース）
   - 各ノードの進捗サマリー

### テスト

- `tests/tree-loop-orchestrator.test.ts`（新規、~80テスト）
  - ノード選択ロジック（ギャップベース、深度ベース、依存制約）
  - 並列実行数制御
  - ノード完了時の連鎖（兄弟影響、親集約、リソース再配分）
  - pause/resume
  - エッジケース: 全ノード完了、単一ノードツリー、深いツリー

- 既存テスト更新（core-loop, cli-runner, reporting-engine）（~20テスト）

### 推定テスト数: ~100

### 受入基準

- [ ] 3層ツリーで各leafノードが独立にタスク発見ループを実行
- [ ] 同時実行ループ数が `parallel_loop_limit` 以下
- [ ] ノード完了時に親の状態が自動更新される
- [ ] 全ノード完了時にルートゴールが完了判定される
- [ ] `motiva run --tree` でツリーモード実行可能
- [ ] 既存の単一ゴールモード（`motiva run`）が影響を受けない

### 設計判断

1. **並列 vs 逐次**: 実際の並列実行（Promise.all）か、ラウンドロビン式の擬似並列か。MVP=ラウンドロビン（1イテレーションで1ノード）が安全
2. **ノード選択のdriveスコア伝播**: 親のdriveスコアをそのまま使うか、子ノード固有のスコアも加味するか

---

## 14D: ゴール横断ポートフォリオ

**スコープ**: 複数ゴール間のリソース配分、優先度動的調整、戦略間依存、テンプレート推薦
**ロードマップ対応**: 14.1
**サイズ**: Large（5-6ファイル）
**依存**: 14B完了（GoalTreeの状態情報が必要）、14Cと並行可

### 実装内容

1. **`src/cross-goal-portfolio.ts`**（新規、~450行）— CrossGoalPortfolio クラス
   - `calculateGoalPriorities(goalIds): GoalPriorityFactors[]` — ゴール優先度計算
     - 4因子: 締切駆動（deadline_urgency）、ギャップ深刻度（gap_severity）、依存重み（dependency_weight）、ユーザー優先度（user_priority）
     - 統合優先度: weighted_sum(因子群) → [0,1] に正規化
     - GoalDependencyGraph の `synergy` 依存はボーナス付与、`conflict` 依存はペナルティ
   - `allocateResources(priorities): CrossGoalAllocation[]` — リソース配分
     - 優先度に比例した配分（最小配分保証）
     - `max_concurrent_goals` 超過時: 低優先度ゴールを `waiting` に
   - `rebalanceGoals(trigger): CrossGoalRebalanceResult` — ゴール間リバランス
     - トリガー: 定期、ゴール完了、ゴール追加、優先度シフト
     - 既存PortfolioManager のリバランスロジックをゴールレベルに適用
   - `getRecommendedTemplates(goalId): StrategyTemplate[]` — テンプレート推薦
     - VectorIndex でゴールの埋め込みと過去の成功戦略の埋め込みを比較
     - `effectiveness_score` が高い戦略をテンプレート化して推薦

2. **`src/strategy-template-registry.ts`**（新規、~200行）— StrategyTemplateRegistry クラス
   - `registerTemplate(strategy, goalId): StrategyTemplate` — 成功戦略のテンプレート登録
     - 登録条件: `effectiveness_score >= 0.5` かつ `state === "completed"`
     - 仮説パターンの抽象化（LLMでドメイン固有部分を汎化）
     - 埋め込み生成と VectorIndex への登録
   - `searchTemplates(query, limit): StrategyTemplate[]` — テンプレート検索
     - セマンティック検索（VectorIndex経由）
     - ドメインタグフィルタリング
   - `applyTemplate(templateId, goalId): Strategy` — テンプレートから戦略を生成
     - テンプレートの仮説パターンを新ゴールのコンテキストに適応（LLM）

3. **`src/goal-dependency-graph.ts`** 変更 — 戦略間依存の追加
   - `addStrategyDependency(fromStrategyId, toStrategyId, type)` — 戦略間の依存関係
   - `getStrategyDependencies(strategyId)` — 戦略の依存関係取得
   - 戦略間依存が `prerequisite` の場合、前提戦略完了まで後続戦略のタスク生成を抑制

4. **`src/portfolio-manager.ts`** 変更 — ゴール横断対応
   - `selectNextStrategyAcrossGoals(goalIds): TaskSelectionResult` — ゴール横断の次戦略選択
     - CrossGoalPortfolio の配分比率に従い、どのゴールの戦略を次に実行するか選択
   - 既存の単一ゴール内ロジックはそのまま維持

5. **`src/core-loop.ts`** 変更 — マルチゴールモード
   - `runMultiGoalIteration(goalIds): Promise<LoopIterationResult>` — 複数ゴール同時管理
   - ゴール選択 → そのゴール内の戦略選択 → タスク実行の3段階選択

6. **`src/index.ts`** — 新規クラスエクスポート

### テスト

- `tests/cross-goal-portfolio.test.ts`（新規、~90テスト）
  - 優先度計算（4因子、正規化、依存ボーナス/ペナルティ）
  - リソース配分（比例配分、最小保証、上限制御）
  - リバランス（4種トリガー、配分調整）
  - テンプレート推薦（セマンティック検索、スコアフィルタ）
  - エッジケース: 単一ゴール、全ゴール同優先度、依存循環

- `tests/strategy-template-registry.test.ts`（新規、~50テスト）
  - テンプレート登録（条件チェック、汎化、埋め込み）
  - テンプレート検索（セマンティック、タグフィルタ）
  - テンプレート適用（コンテキスト適応）

- 既存テスト更新（goal-dependency-graph, portfolio-manager, core-loop）（~20テスト）

### 推定テスト数: ~160

### 受入基準

- [ ] 3つのゴールに対してリソース配分が正しく計算される
- [ ] 締切の近いゴールが自動的に高優先度になる
- [ ] GoalDependencyGraph の synergy/conflict が優先度に反映される
- [ ] 成功戦略がテンプレートとして登録され、新ゴールに推薦される
- [ ] ゴール横断のリバランスが4種トリガーで正しく発動する
- [ ] 戦略間依存が尊重される（prerequisite完了までタスク生成抑制）
- [ ] 既存の単一ゴールモードが影響を受けない

### 設計判断

1. **優先度の重み配分**: 4因子のデフォルト重み。deadline_urgency が最も高いか、均等か
2. **テンプレート汎化の粒度**: LLMにどこまで抽象化させるか。過度な汎化は無意味、過少な汎化は転用不可
3. **ゴール横断リバランスの頻度**: 単一ゴール内より長い間隔が妥当（デフォルト: 1週間）

### リスクと対策

| リスク | 対策 |
|--------|------|
| ゴール横断の複雑性爆発 | `max_concurrent_goals` で上限制御。MVP=3ゴールから開始 |
| テンプレート推薦の精度 | effectiveness_score閾値（0.5）でフィルタ。低品質テンプレートは推薦しない |
| 既存PortfolioManagerとの責務重複 | CrossGoalPortfolioはゴール間の配分のみ。ゴール内の戦略管理は既存PortfolioManagerに委譲 |

---

## 14E: 学習パイプライン Phase 2

**スコープ**: 全トリガーからの学習、全4ステップへの構造的フィードバック、クロスゴールパターン共有
**ロードマップ対応**: 14.3
**サイズ**: Large（4-5ファイル）
**依存**: 14B, 14D完了

### 実装内容

1. **`src/learning-pipeline.ts`**（新規、~400行）— LearningPipeline クラス
   - `analyzeLogs(trigger): Promise<LearnedPattern[]>` — 経験ログのバッチ分析
     - 入力: LearningTrigger + 対応する経験ログ群
     - LLMによるパターン抽出（状態→行動→結果トリプレット）
     - 信頼度計算（出現頻度 × 結果の一貫性）
     - `min_confidence_threshold` 以上のパターンのみ登録
   - `generateFeedback(patterns): FeedbackEntry[]` — パターンからフィードバック生成
     - 各パターンを4ステップのいずれかにマッピング
     - フィードバックの具体性チェック（「もっと良くする」は却下、「見積もりを1.5倍にする」は採用）
   - `applyFeedback(goalId, step): string[]` — フィードバックの適用
     - SessionManagerのコンテキストに注入するフィードバック文字列を返す
     - 適用済みマーク + 効果追跡
   - `sharePatternAcrossGoals(patternId): void` — クロスゴール共有
     - KnowledgeManager.searchAcrossGoals() で類似ゴールを検索
     - VectorIndex で類似パターンを検索し、重複を除外
     - 共有先ゴールの SessionManager コンテキストに注入

2. **`src/learning-pipeline.ts`** 内のトリガー統合
   - `onMilestoneReached(goalId, milestoneId)` — マイルストーン到達時
   - `onStallDetected(goalId, stallInfo)` — 停滞検知時
   - `onPeriodicReview(goalId)` — 定期レビュー時
   - `onGoalCompleted(goalId)` — ゴール完了時

3. **`src/core-loop.ts`** 変更 — 学習パイプライン統合
   - ループ完了時にLearningPipelineのトリガーチェック
   - マイルストーン到達時の自動学習
   - 定期レビューのスケジューリング（`periodic_review_interval_hours` に基づく）

4. **`src/session-manager.ts`** 変更 — フィードバック注入
   - `injectLearningFeedback(goalId, step, feedback)` — 学習フィードバックをコンテキストに追加
   - 4ステップそれぞれのプロンプトにフィードバックを含める

5. **`src/stall-detector.ts`** 変更 — 学習トリガー連携
   - 停滞検知時に LearningPipeline.onStallDetected() を呼び出す

### テスト

- `tests/learning-pipeline.test.ts`（新規、~120テスト）
  - パターン抽出（成功パターン、失敗パターン、信頼度計算）
  - フィードバック生成（4ステップへのマッピング、具体性チェック）
  - フィードバック適用（コンテキスト注入、効果追跡）
  - クロスゴール共有（類似検索、重複除外）
  - 4種トリガー（マイルストーン、停滞、定期、完了）
  - エッジケース: ログ不足、全パターン低信頼度、共有先なし

- 既存テスト更新（core-loop, session-manager, stall-detector）（~15テスト）

### 推定テスト数: ~135

### 受入基準

- [ ] マイルストーン到達時に学習パイプラインが自動発動する
- [ ] 停滞検知時に原因パターンが抽出される
- [ ] 抽出されたパターンが4ステップのいずれかにフィードバックとして適用される
- [ ] フィードバックがSessionManagerのコンテキストに正しく注入される
- [ ] クロスゴールパターン共有が動作する（VectorIndex経由）
- [ ] 信頼度が閾値未満のパターンは登録されない
- [ ] 定期レビューが設定間隔で発動する

### 設計判断

1. **パターン抽出のLLMプロンプト設計**: 抽出精度と一般化のバランス
2. **フィードバックの適用優先度**: 複数のフィードバックがある場合の優先順位
3. **定期レビューの間隔**: ゴール種別ごとのデフォルト値（短期: 3日、中期: 1週間、長期: 2週間）

---

## 14F: ゴール間の知識・戦略転移

**スコープ**: ゴールAでの学習をゴールBに自動適用、ドメイン横断パターン認識
**ロードマップ対応**: 14.4
**サイズ**: Multi-file（3-4ファイル）
**依存**: 14D, 14E完了

### 実装内容

1. **`src/knowledge-transfer.ts`**（新規、~300行）— KnowledgeTransfer クラス
   - `detectTransferOpportunities(goalId): TransferCandidate[]` — 転移候補検出
     - KnowledgeManager.searchAcrossGoals() で関連知識を検索
     - VectorIndex でゴールの埋め込み類似度を計算
     - LearnedPattern のドメインタグマッチング
     - 候補のランキング（類似度 × 元パターンの信頼度 × effectiveness_score）
   - `applyTransfer(candidateId, targetGoalId): Promise<TransferResult>` — 転移の適用
     - 元ゴールのパターン/知識を対象ゴールのコンテキストに適応（LLM）
     - 適用前の安全チェック: ドメイン制約の互換性、倫理ゲート通過
     - 適用結果の記録（効果追跡用）
   - `evaluateTransferEffect(transferId): TransferEffectiveness` — 転移効果の評価
     - 転移適用前後のギャップ変化を比較
     - 効果があれば転移パターンの信頼度を上げ、なければ下げる
   - `buildCrossGoalKnowledgeBase(): void` — ゴール横断ナレッジベースの構築
     - 全ゴールの LearnedPattern を集約
     - ドメイン横断のメタパターン抽出（LLM）
     - メタパターンの VectorIndex への登録

2. **`src/types/cross-portfolio.ts`** 追加型
   ```
   TransferCandidate {
     candidate_id: string
     source_goal_id: string
     target_goal_id: string
     type: "knowledge" | "strategy" | "pattern"
     source_item_id: string         // KnowledgeEntry, StrategyTemplate, or LearnedPattern ID
     similarity_score: number
     estimated_benefit: string
   }

   TransferResult {
     transfer_id: string
     candidate_id: string
     applied_at: string
     adaptation_description: string
     success: boolean
   }

   TransferEffectiveness {
     transfer_id: string
     gap_delta_before: number
     gap_delta_after: number
     effectiveness: "positive" | "negative" | "neutral"
     evaluated_at: string
   }
   ```

3. **`src/curiosity-engine.ts`** 変更 — 転移ベースの好奇心
   - 転移候補が見つかった場合、好奇心ゴールとして提案
   - 「ゴールAで成功したパターンをゴールBにも適用してみませんか？」

4. **`src/core-loop.ts`** 変更 — 転移チェック統合
   - ループ開始時に `detectTransferOpportunities()` を低頻度で実行（5イテレーションに1回）
   - 転移候補がある場合、ユーザーに提案（自動適用は Phase 3）

### テスト

- `tests/knowledge-transfer.test.ts`（新規、~100テスト）
  - 転移候補検出（類似度、タグマッチ、ランキング）
  - 転移適用（コンテキスト適応、安全チェック、結果記録）
  - 転移効果評価（ギャップ変化比較、信頼度更新）
  - ゴール横断ナレッジベース（集約、メタパターン抽出）
  - エッジケース: 転移先ドメイン不適合、倫理ゲート拒否、効果なし

- 既存テスト更新（curiosity-engine, core-loop）（~10テスト）

### 推定テスト数: ~110

### 受入基準

- [ ] ゴールAの成功パターンがゴールBの転移候補として検出される
- [ ] 転移適用時にLLMがコンテキスト適応を行う
- [ ] 倫理ゲートを通過しない転移は拒否される
- [ ] 転移効果が追跡され、信頼度が更新される
- [ ] ゴール横断ナレッジベースにメタパターンが蓄積される
- [ ] 転移候補が好奇心エンジンと連携する

### リスクと対策

| リスク | 対策 |
|--------|------|
| 不適切な転移（ドメイン不一致） | 類似度閾値（0.7以上）+ LLMによる互換性チェック |
| 転移のノイズ（効果なしパターンの増殖） | 効果追跡 + 信頼度の自動減衰。3回連続 neutral/negative で自動無効化 |
| LLMコスト増大 | 転移チェックの実行頻度を制限（5イテレーションに1回）。バッチ処理優先 |

---

## 全体見積もり

| Part | 新規ファイル | 変更ファイル | 新規テストファイル | 推定テスト数 | 依存 |
|------|------------|------------|-----------------|------------|------|
| 14A  | 3          | 4          | 3               | ~80        | なし |
| 14B  | 2          | 5          | 2               | ~180       | 14A  |
| 14C  | 1          | 3          | 1               | ~100       | 14B  |
| 14D  | 2          | 4          | 2               | ~160       | 14B  |
| 14E  | 1          | 4          | 1               | ~135       | 14B, 14D |
| 14F  | 1          | 3          | 1               | ~110       | 14D, 14E |

**合計**: 新規ファイル10、変更ファイル~15（重複あり実質10-12）、新規テストファイル10、推定テスト数 ~765

### 新規ファイル一覧

| ファイル | Part | 推定行数 |
|---------|------|---------|
| `src/types/goal-tree.ts` | 14A | ~120 |
| `src/types/cross-portfolio.ts` | 14A, 14F | ~150 |
| `src/types/learning.ts` | 14A | ~100 |
| `src/goal-tree-manager.ts` | 14B | ~400 |
| `src/state-aggregator.ts` | 14B | ~200 |
| `src/tree-loop-orchestrator.ts` | 14C | ~300 |
| `src/cross-goal-portfolio.ts` | 14D | ~450 |
| `src/strategy-template-registry.ts` | 14D | ~200 |
| `src/learning-pipeline.ts` | 14E | ~400 |
| `src/knowledge-transfer.ts` | 14F | ~300 |

**新規コード合計**: ~2,620行

### 変更ファイル一覧

| ファイル | 変更Part | 変更内容 |
|---------|---------|---------|
| `src/types/goal.ts` | 14A | フィールド追加（3フィールド + enum値1） |
| `src/types/strategy.ts` | 14A | フィールド追加（2フィールド） |
| `src/types/dependency.ts` | 14A | enum値追加 |
| `src/goal-negotiator.ts` | 14B | 分解メソッド追加 |
| `src/satisficing-judge.ts` | 14B | ツリー完了判定 |
| `src/state-manager.ts` | 14B | ツリーCRUD |
| `src/core-loop.ts` | 14B, 14C, 14D, 14E, 14F | ツリーモード、マルチゴール、学習、転移 |
| `src/cli-runner.ts` | 14C | `--tree` オプション |
| `src/reporting-engine.ts` | 14C | ツリーレポート |
| `src/goal-dependency-graph.ts` | 14D | 戦略間依存 |
| `src/portfolio-manager.ts` | 14D | ゴール横断選択 |
| `src/session-manager.ts` | 14E | フィードバック注入 |
| `src/stall-detector.ts` | 14E | 学習トリガー連携 |
| `src/curiosity-engine.ts` | 14F | 転移ベース好奇心 |
| `src/index.ts` | 14A, 14B, 14C, 14D, 14E, 14F | エクスポート追加 |

---

## 全体リスクと対策

| リスク | 深刻度 | 対策 |
|--------|--------|------|
| **N層Goal Tree分解のLLM品質** | 高 | 分解結果の検証ループ、リトライ、エスカレーション。テストではMockLLMClient |
| **ゴール横断ポートフォリオの複雑性** | 高 | `max_concurrent_goals` で上限制御。段階的に上限を上げる |
| **core-loop.tsの肥大化** | 中 | ツリーモード・マルチゴールモードのロジックはOrchestrator/Portfolioに委譲。CoreLoopは薄いディスパッチャに留める |
| **テスト爆発** | 中 | MockLLMClientの活用。統合テストは最小限にし、ユニットテストで網羅 |
| **既存テストの破壊** | 中 | 型拡張は全てoptional/default付き。既存インターフェースの変更は避ける |
| **LLMコスト増大** | 低 | 分解・学習・転移の実行頻度を制御パラメータで管理 |

---

## 推奨実装順序

```
Week 1:    14A（型定義 + 設計ドキュメント）
Week 2-3:  14B（Goal Tree分解・集約・剪定）— 最大のパート
Week 4:    14C（ループ並列実行）
Week 4-5:  14D（ゴール横断ポートフォリオ）— 14Cと一部並行可
Week 6:    14E（学習パイプライン）
Week 7:    14F（知識・戦略転移）
```

各パート完了時に `npm run build` と `npx vitest run` で全テスト通過を確認してからコミットする。

---

## 着手前の未確定事項

1. **具体性スコアの算出方法** — LLMプロンプト設計が必要。14B着手前にスパイク実施を推奨
2. **ゴール横断リバランスの初期重み** — 4因子の重み配分。14D着手前に設計ドキュメントで確定
3. **学習パイプラインの分析粒度** — ログエントリ数の閾値（少なすぎると意味がない、多すぎるとLLMコスト増大）。14E着手前に決定
4. **転移の自動適用レベル** — Phase 2 = ユーザー提案のみ、Phase 3 = 自動適用。14Fでは提案のみに留めるか。14F着手前に決定
5. **core-loop.ts のモード分離** — ツリーモード/マルチゴールモードをCoreLoop内に実装するか、別クラスに分離するか。14B着手前に決定

---

## ドキュメント更新計画

Stage 14完了時に以下を更新する:

- `docs/status.md` — Stage 14完了記録
- `docs/mechanism.md` — 学習パイプライン Phase 2 の実装状況更新（§4）
- `docs/vision.md` — 再帰的Goal Tree実装状況の注記
- `docs/architecture-map.md` — Layer 14の追加
- `CLAUDE.md` — 実装済みモジュール・Layer追加
- `memory/MEMORY.md` — Stage 14完了記録
