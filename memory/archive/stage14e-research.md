# Stage 14E リサーチ — 学習パイプライン Phase 2

## 1. learning.ts の型一覧

### LearningTriggerType（enum）
値: `"milestone_reached" | "stall_detected" | "periodic_review" | "goal_completed"`

### LearningTrigger（Schema）
```
type: LearningTriggerType
goal_id: string
context: string
timestamp: string (datetime)
```

### LearnedPatternType（enum）
値: `"observation_accuracy" | "strategy_selection" | "scope_sizing" | "task_generation"`

### LearnedPattern（Schema）
```
pattern_id: string
type: LearnedPatternType
description: string
confidence: number (0-1)
evidence_count: int (>= 0)
source_goal_ids: string[]
applicable_domains: string[]
embedding_id: string | null  (default: null)
created_at: string (datetime)
last_applied_at: string | null  (default: null)
```

### FeedbackTargetStep（enum）
値: `"observation" | "gap" | "strategy" | "task"`

### FeedbackEffect（enum）
値: `"positive" | "negative" | "neutral"`

### FeedbackEntry（Schema）
```
feedback_id: string
pattern_id: string
target_step: FeedbackTargetStep
adjustment: string
applied_at: string (datetime)
effect_observed: FeedbackEffect | null  (default: null)
```

### LearningPipelineConfig（Schema）
```
min_confidence_threshold: number (0-1, default: 0.6)
periodic_review_interval_hours: number (>= 1, default: 72)
max_patterns_per_goal: int (>= 1, default: 50)
cross_goal_sharing_enabled: boolean (default: true)
```

### 注意点
- `applicable_condition` フィールドが設計ドキュメント §5.1 に記載されているが **learning.ts に存在しない**。LearnedPattern.description で代用するか、Phase 2 で追加するか判断が必要。
- `injected_from_goal_id` も設計ドキュメント §6.1 に記載されているが型定義にない。`source_goal_ids` 配列で代用可能（転移元ゴールIDを配列で保持）。

---

## 2. 設計ドキュメントの要点（learning-pipeline.md）

### 学習トリガー（§2）
| トリガー | 条件 |
|---------|------|
| milestone_reached | ゴールの次元がマイルストーン閾値を通過 |
| stall_detected | stall-detection.md の第1・第2検知 |
| periodic_review | 最後の学習分析から定期インターバル経過 |
| goal_completed | satisficing.md の完了判定通過 |

**定期インターバルの目安（§2.3）**:
- 短期（1ヶ月以内）: 72時間（LearningPipelineConfig.periodic_review_interval_hours のデフォルトと一致）
- 中期（1〜6ヶ月）: 168時間（1週間）
- 長期（6ヶ月以上）: 336時間（2週間）
- 実装では`periodic_review_interval_hours`は固定値（型定義済み）。ゴール種別による動的変更はPhase 2以降。

### 分析パイプライン（§3）
1. LLMに状態→行動→結果トリプレットを抽出させる
2. `confidence = occurrence_frequency × result_consistency` で信頼度計算
3. `min_confidence_threshold`（デフォルト0.6）未満は却下
4. 具体性チェック: 行動が特定できる記述のみ採用

### パターンタイプ（§4）
- `observation_accuracy`: ObservationEngineへの confidence 補正係数
- `strategy_selection`: 戦略生成プロンプトへの制約追加
- `scope_sizing`: タスク生成プロンプトへのスコープ指示
- `task_generation`: タスク生成プロンプトへのフォーマット指示

### フィードバック適用（§5）
- SessionManager の context_slots に注入（新しいスロットとして追加）
- 効果追跡: positive → +0.1、negative → -0.15、neutral → 変更なし
- `min_confidence_threshold` 未満になったパターンは無効化

### クロスゴール共有（§6、MVP対象: goal_completedトリガーのみ）
1. goal_completed 時に VectorIndex で類似ゴールを検索（類似度 >= 0.7）
2. 互換性確認（LLM）
3. 転移時の信頼度割引: `original_confidence × 0.7`

### MVP スコープ（§7、Stage 14E の範囲）
- 分析対象: 同一ゴール内のみ
- クロスゴール共有: goal_completed トリガー時のみ（手動確認付き）
- フィードバック適用: SessionManager への注入のみ
- パターン数上限: 50 / ゴール

---

## 3. 変更対象ファイルの現状

### src/core-loop.ts（~999行）

**クラス構造**: `CoreLoop`

**コンストラクタ**:
```typescript
constructor(deps: CoreLoopDeps, config?: LoopConfig)
```

**publicメソッド**:
- `run(goalId: string): Promise<LoopResult>` — メインループ
- `runOneIteration(goalId, loopIndex): Promise<LoopIterationResult>` — 単一イテレーション
- `runTreeIteration(rootId, loopIndex): Promise<LoopIterationResult>` — ツリーモード
- `runMultiGoalIteration(loopIndex): Promise<LoopIterationResult>` — マルチゴールモード
- `stop(): void`
- `isStopped(): boolean`

**CoreLoopDeps インターフェース**（src/core-loop.ts L119-140）:
```typescript
interface CoreLoopDeps {
  stateManager, observationEngine, gapCalculator, driveScorer,
  taskLifecycle, satisficingJudge, stallDetector, strategyManager,
  reportingEngine, driveSystem, adapterRegistry,
  knowledgeManager?, capabilityDetector?, portfolioManager?,
  curiosityEngine?, goalDependencyGraph?,
  goalTreeManager?, stateAggregator?, treeLoopOrchestrator?,
  crossGoalPortfolio?
}
```

**拡張ポイント**:
1. `CoreLoopDeps` にオプションフィールド `learningPipeline?: LearningPipeline` を追加
2. `run()` メソッドの末尾（L318-340の curiosityEngine ブロックの後）に学習パイプライントリガー呼び出しを追加
3. `runOneIteration()` の step 5b（マイルストーンチェック L565-605）でマイルストーン到達時の学習トリガー
4. `runOneIteration()` の step 6（ストール検知 L607-714）でストール時の学習トリガー
5. 定期レビュー: `run()` の各ループ末尾でインターバルチェック

**既存パターン**: すべてのオプション依存は `if (this.deps.X) { try { ... } catch { // non-fatal } }` パターンで統一。学習パイプラインも同様に実装すること。

### src/session-manager.ts（~430行）

**クラス構造**: `SessionManager`

**既存 context 注入パターン**:
```typescript
// injectKnowledgeContext(slots, entries): ContextSlot[] — 既存（L292-319）
// injectSemanticKnowledgeContext(slots, query, vectorIndex, topK): Promise<ContextSlot[]> — 既存（L325-353）
```

**追加するメソッド**: `injectLearningFeedback(slots, feedback: string[]): ContextSlot[]`

**拡張ポイント**:
- 既存の `injectKnowledgeContext` と同じパターン: `maxPriority + 1` の優先度でスロット追加
- ラベルは `"learning_feedback"` （`domain_knowledge` や `semantic_knowledge_N` と区別）
- 複数フィードバック文字列は 1 スロットにまとめるか別スロットにするかの判断が必要（1スロット推奨: 既存パターンと一致）

**注意**: SessionManager は LearningPipeline を直接知らなくてよい。注入用の `ContextSlot[]` 変換メソッドのみ追加する。

### src/stall-detector.ts（~389行）

**クラス構造**: `StallDetector`

**検知メソッド（StallReport を返す4種）**:
```typescript
checkDimensionStall(goalId, dimensionName, gapHistory, feedbackCategory?): StallReport | null
checkTimeExceeded(task): StallReport | null
checkConsecutiveFailures(goalId, dimensionName, consecutiveFailureCount): StallReport | null
checkGlobalStall(goalId, allDimensionGaps, loopThreshold?): StallReport | null
```

**拡張ポイント**: StallDetector 自体を変更するのではなく、CoreLoop の stall_check ブロック（L629-631、L665-667）で、`stallReport` が返ったタイミングで `LearningPipeline.onStallDetected(goalId, stallReport)` を呼び出す。StallDetector は純粋な検知責務を維持する。

**代替案**: StallDetector に `onStallCallback?: (goalId, stallInfo) => void` を追加。ただし既存コードの一貫性からすると CoreLoop 側での呼び出しが自然。

---

## 4. 依存先（14B, 14D）の利用可能 API

### GoalTreeManager（src/goal-tree-manager.ts）

LearningPipeline が使う可能性があるメソッド:
```typescript
getTreeState(rootId: string): GoalTreeState
// GoalTreeState = { root_id, total_nodes, max_depth_reached, active_loops, pruned_nodes }
```

マイルストーン判定はGoalTreeManagerの責務ではなく、StateManagerの `getMilestones()` と `evaluatePace()` を使う（既にCoreLoopのL575-605で実装済み）。

### CrossGoalPortfolio（src/cross-goal-portfolio.ts）

クロスゴール共有の類似ゴール検索に使う可能性:
```typescript
// vectorIndex経由での類似ゴール検索は CrossGoalPortfolio が内部で行うが
// LearningPipeline は直接 VectorIndex を使う方が適切（CrossGoalPortfolioは
// リソース配分専用であり、学習パターン共有の責務は持たない）
getAllocationMap(goalIds: string[]): Map<string, number>
calculateGoalPriorities(goalIds: string[]): GoalPriorityFactors[]
```

**学習パイプラインからの利用**: CrossGoalPortfolio は不要。クロスゴール共有には VectorIndex を直接使う（設計ドキュメント §6.1 の記述と一致）。

### StrategyTemplateRegistry（src/strategy-template-registry.ts）

LearningPipeline が使う可能性があるメソッド:
```typescript
searchTemplates(query: string, limit?: number, domainTags?: string[]): Promise<StrategyTemplate[]>
// 類似パターンの検索・重複除外に使える
getTemplate(templateId: string): StrategyTemplate | undefined
size: number  (getter)
```

**注意**: `strategy_selection` パターンを検出したとき、StrategyTemplateRegistry のテンプレートと重複していないかチェックするために `searchTemplates` を使える。ただし設計ドキュメントには明示されていないため、MVP では省略可。

---

## 5. 実装上の注意点

### 型の整合性

1. **applicable_condition の欠如**: 設計ドキュメント §5.1 では `applicable_condition: string` があるが `learning.ts` にない。`LearnedPattern.description` に集約して扱う（`description` を "pattern + applicable_condition" の複合記述として使う）。

2. **パターン永続化**: `LearnedPattern` は `VectorIndex` のエントリとして保存することでセマンティック検索が可能。ただし型定義上 `embedding_id` がオプション（nullable）なので、埋め込み失敗時も登録できる。

3. **FeedbackEntry.adjustment**: これが SessionManager に注入する文字列そのもの。`applyFeedback()` は `FeedbackEntry.adjustment` をそのまま返す実装が自然。

4. **LearningTrigger.context**: フリーテキスト。`stall_detected` の場合は `StallReport` の JSON、`milestone_reached` の場合はどの次元がどの値を通過したかを含める。

### 既存パターンとの一貫性

- **オプション依存のDI**: CoreLoopDeps への追加は `learningPipeline?: LearningPipeline` として optional。他の optional 依存（curiosityEngine、goalDependencyGraph など）と同様。
- **エラーハンドリング**: `try { ... } catch { // non-fatal }` パターンを踏襲。学習失敗でメインループを止めてはいけない。
- **LLMプロンプト**: 他のファイル（goal-tree-manager.ts など）に倣い、ファイル先頭にプロンプトビルダー関数を集約し、Zodスキーマでレスポンス検証。
- **Mock対応**: テストでは `MockLLMClient`（src/llm-client.ts）を使う。14Eのテストでは `analyzeLogs` の LLM 呼び出しに対して事前に `setNextResponse()` でモック応答を設定する。

### MockLLMClient 利用方法

既存テストでの使用パターン:
```typescript
const llm = new MockLLMClient();
llm.setNextResponse(JSON.stringify({ ... }));  // 次の sendMessage() への応答を設定
const result = await llm.sendMessage([...], {});
const parsed = llm.parseJSON(result.content, SomeSchema);
```

### VectorIndex の利用

クロスゴール共有の類似ゴール検索:
```typescript
const results = await vectorIndex.search(goalText, 10, 0.7);
// 第3引数が minSimilarity (>= 0.7 が設計ドキュメントの閾値)
```

---

## 6. 未確定事項（計画 §14E「設計判断」への推奨回答）

### 設計判断1: パターン抽出のLLMプロンプト設計（抽出精度と一般化のバランス）

**推奨**: 2段階アプローチを採用。

第1段階（トリプレット抽出、具体的）:
```
入力: task_results[], gap_history[], strategy_history[]
出力: { state_context, action_taken, outcome, gap_delta }[]
```

第2段階（パターン化、一般化）:
```
入力: 同一 action_taken を持つトリプレット群
出力: { description, pattern_type, applicable_condition, confidence }
```

具体性チェックはプロンプト内に例示する（採用例/却下例を表形式で提示）。これは goal-tree-manager.ts の buildSpecificityPrompt の手法と一致。

**根拠**: goal-tree-manager.ts は LLM の specificity_score評価と subgoal生成を分離している。同様に抽出と一般化を分離するとエラー伝播を抑えられる。信頼度計算（occurrence_frequency × result_consistency）は LLM の外（TypeScript側）で行い、LLM は純粋にパターン記述の生成のみ担当する。

### 設計判断2: フィードバックの適用優先度（複数フィードバックがある場合）

**推奨**: パターンの `confidence` 降順でソート。同信頼度の場合は `evidence_count` 降順。最大注入数は3件（SessionManager のコンテキスト予算を圧迫しないため）。

**根拠**: SessionManager の `filterSlotsByBudget()` は priority 順にスロットを切り捨てる。学習フィードバックスロットは `maxPriority + 1` に配置されるため、元々低優先。数を絞ることで確実に注入されるようにする。4ステップ（observation/gap/strategy/task）それぞれについて最上位1件のみ渡すという案もあるが、実装がシンプルになる confidence 降順の方が保守性が高い。

### 設計判断3: 定期レビューの間隔（ゴール種別ごとのデフォルト値）

**推奨**: `LearningPipelineConfig.periodic_review_interval_hours` は固定値（デフォルト72時間）のまま MVP では使用。ゴール種別（短期/中期/長期）の判定は `goal.target_date` から導出可能だが、学習パイプライン初期化時に設定するより、CoreLoop が呼び出し側でゴールの残期間を見てインターバルを計算する方がシンプル。

**具体的な実装**: `run()` のループ内で `lastLearningAnalysisAt` を記録し、現在時刻との差が `periodic_review_interval_hours × 3600 * 1000` ms を超えたら `onPeriodicReview()` を呼ぶ。ゴール種別は `if (goal.target_date)` の残日数で `72h / 168h / 336h` を選択（CoreLoop 内の小さなヘルパー関数として実装）。

**根拠**: 現在 `LearningPipelineConfigSchema` は `periodic_review_interval_hours` を単一値で持つ。設計ドキュメント §2.3 のゴール種別ごとの間隔は「デフォルト値の目安」であり、型定義を変更せずに CoreLoop 呼び出し側で動的に決定するのが最小変更で実現できる。

---

## 7. 実装順序の推奨

1. `src/learning-pipeline.ts` 新規作成（LearningPipeline クラス）
   - コンストラクタ: `llmClient, vectorIndex, stateManager, config?`
   - `analyzeLogs(trigger): Promise<LearnedPattern[]>`
   - `generateFeedback(patterns): FeedbackEntry[]`
   - `applyFeedback(goalId, step): string[]`
   - `sharePatternAcrossGoals(patternId): Promise<void>`
   - 4種トリガーハンドラ（onMilestoneReached, onStallDetected, onPeriodicReview, onGoalCompleted）
   - パターン永続化: `~/.motiva/learning/<goalId>.json`

2. `src/session-manager.ts` に `injectLearningFeedback(slots, feedback: string[]): ContextSlot[]` を追加

3. `src/core-loop.ts` の変更
   - `CoreLoopDeps` に `learningPipeline?: LearningPipeline` 追加
   - ストール検知後のトリガー呼び出し（step 6）
   - マイルストーン到達後のトリガー呼び出し（step 5b）
   - ゴール完了後のトリガー呼び出し（`run()` の finalStatus === "completed" チェック後）
   - 定期レビューのスケジューリング

4. `src/index.ts` に `LearningPipeline` のエクスポート追加

5. `src/types/index.ts` は `"./learning.js"` が既に追加済みのため変更不要

6. `tests/learning-pipeline.test.ts` 新規作成（~120テスト）

7. 既存テスト更新（core-loop, session-manager）（~15テスト）
