# ゴールツリー設計

> 関連: `portfolio-management.md`, `gap-calculation.md`, `satisficing.md`, `drive-scoring.md`, `session-and-context.md`

---

## 1. 概要

ゴールツリーは**N層ゴール自動分解システム**だ。曖昧な上位ゴールを具体的なサブゴールに再帰的に分解し、各ノードで独立したタスク発見ループを実行する。

```
ユーザーゴール（root）
  │
  ├── サブゴールA（depth 1）
  │     ├── サブゴールA-1（depth 2 / leaf）
  │     └── サブゴールA-2（depth 2 / leaf）
  │
  └── サブゴールB（depth 1）
        └── サブゴールB-1（depth 2 / leaf）
```

**分解の目的**: 抽象的な上位ゴールをそのままタスク発見ループに渡すと、LLMが具体的なタスクを生成できない。ゴールツリーは「ゴールの曖昧さ」をコアループの外で解消し、leafノードに至るまで各レベルが独立して追跡可能な形に変換する。

---

## 2. データモデル

### 2.1 ゴールノード

```
GoalNode {
  id: string                        // 一意識別子
  parent_id: string | null          // 親ゴールのID（nullはroot）
  root_id: string                   // ルートゴールのID
  depth: number                     // ツリーの深さ（rootは0）

  goal_definition: GoalDefinition   // 次元・閾値・制約
  specificity_score: number         // 具体性スコア（0.0〜1.0）
  is_leaf: boolean                  // 子ノードが存在しないか

  state: GoalNodeState              // 現在の状態（§2.2）
  pruned_reason: PrunedReason | null // 剪定理由（§4）

  created_at: DateTime
  decomposed_at: DateTime | null
  completed_at: DateTime | null

  children: string[]                // 子ゴールIDリスト
  loop_state: LoopState | null      // leafノードのループ状態（§5）
}
```

### 2.2 ノードの状態遷移

```
pending → decomposing → active → completed
                     → pruned
```

| 状態 | 意味 |
|------|------|
| `pending` | 作成されたが、具体性評価・分解がまだ |
| `decomposing` | LLMによる分解中 |
| `active` | 追跡中（leafは独立ループ実行中、非leafは子ゴールの状態集約中） |
| `completed` | 完了判定済み |
| `pruned` | 剪定済み（§4参照） |

---

## 3. 分解ロジック（Phase 1 / Stage 14B）

### 3.1 分解フロー

```
ゴールノード（pending）
    │
    ↓
具体性スコア評価（LLM）
    │
    ├── specificity_score >= min_specificity (0.7)
    │     → leafノードとして確定。ループ開始
    │
    └── specificity_score < min_specificity (0.7)
          │
          ↓
    depth < max_depth (5) ?
          │
          ├── Yes → LLMによるサブゴール生成（§3.2）
          │
          └── No  → 強制的にleafとして確定（分解打ち切り）
```

### 3.2 LLMへの入力

分解プロンプトに含める情報:

**必須入力**:
- 分解対象ゴールの定義（仮説・文脈・制約）
- 親ゴールの定義（rootまで遡った制約の連鎖）
- 既存の次元リスト（重複サブゴールを防ぐ）
- 現在の depth と max_depth（「あと何段階まで分解できるか」をLLMに伝える）

**出力フォーマット**:

```
[
  {
    hypothesis: string,         // このサブゴールが解決しようとすること
    dimensions: Dimension[],    // 次元と閾値
    constraints: Constraint[],  // このサブゴールに固有の制約
    expected_specificity: number // 分解後の想定具体性スコア
  }
]
```

### 3.3 分解結果の検証

LLM出力を受け取った後、以下の検証を実施する。

**カバレッジ検証**: 生成されたサブゴール群を合わせると、親ゴールの全次元をカバーするか（LLMに再評価させる）。

**次元整合性チェック**: 子ゴールの次元が親ゴールの次元と整合しているか（方向・スケールの一致）。

**循環参照チェック**: GoalDependencyGraph を使用し、新しいサブゴールが既存のゴールと循環依存しないことを確認する。

### 3.4 設計上の決定

| パラメータ | デフォルト値 | 理由 |
|-----------|------------|------|
| `min_specificity` | 0.7 | LLMの出力品質を考慮した保守的な値。0.6以下では具体的なタスクが生成できないケースが多い |
| `max_depth` | 5 | 過分解を防ぐ。深さ5を超えると各ノードの意味が失われる傾向がある |
| `max_children_per_node` | 5 | LLMが生成するサブゴールの上限。5以上は相互依存が複雑になる |

---

## 4. 剪定

### 4.1 剪定条件

| 剪定理由 | 定義 |
|---------|------|
| `no_progress` | Nループ（デフォルト: ゴールの性質による、3〜10）以上ギャップが改善しない |
| `superseded` | 上位ゴールの方針変更により、このノードの追求が不要になった |
| `merged` | 他のサブゴールと実質的に同一と判断され、統合された |
| `user_requested` | ユーザーが明示的に削除を指示した |

### 4.2 剪定の影響

剪定されたノードの allocation は、同一親ノードの兄弟ゴールに再分配される。兄弟ノードがすべて剪定済みの場合、親ノードにエスカレーションする。

剪定はログに記録され、好奇心エンジンのフィードバック（`curiosity.md` §4.2）の材料になる。

---

## 5. 状態集約と伝播

### 5.1 下位→上位（集約）

leafノードの完了・進捗状態を親ノードに集約する。

**ギャップ集約**: `satisficing.md` の SatisficingAggregation 方式に従う。デフォルトはボトルネック集約（min）。

```
parent_gap = aggregate(children_gaps, method)

method:
  "min"          → 最も進んでいない子ゴールのギャップ（ボトルネック）
  "avg"          → 全子ゴールの加重平均
  "max"          → 最もギャップが大きい子ゴール
  "all_required" → 全子ゴールが完了しなければ親も完了しない
```

**confidence集約**: 子ゴール群の confidence の最小値を採用する（保守的）。

```
parent_confidence = min(children_confidence)
```

### 5.2 上位→下位（伝播）

親ゴールの変更を子ゴールに伝播する。

**制約の追加・変更**: 親ゴールの制約が更新された場合、全子ゴールに即座に伝播する。子ゴールのタスク生成前に制約チェックを再実行する。

**締切の比例調整**: 親ゴールの締切が変更された場合、子ゴールの締切を比例調整する。

```
child_new_deadline =
  child_original_deadline × (parent_new_deadline / parent_original_deadline)
```

---

## 6. 完了判定

### 6.1 leafノードの完了

leafノードは `satisficing.md` の通常の完了判定フロー（threshold達成 + SatisficingJudgeの確認）によって完了する。

### 6.2 非leafノードの完了

```
全子ゴールが "completed" or "pruned(merged)" 状態
    │
    ↓
親ゴールの各次元の集約ギャップを計算
    │
    ↓
集約ギャップが閾値を満たすか確認
    │
    ├── Yes → 親ゴールの完了判定トリガー
    └── No  → 追加のサブゴール生成を検討
```

完了判定は leaf から root に向かって連鎖的に伝播する（leaf → depth N-1 → ... → root）。

---

## 7. ループ並列実行（Phase 1 / Stage 14C）

### 7.1 leafノードのループ起動

leafノードが確定した時点で、独立したタスク発見ループを起動する。各leafノードは独立したループ状態（LoopState）を持つ。

```
leafノード確定
    │
    ↓
LoopState 初期化
    │
    ├── loop_iteration: 0
    ├── last_gap_snapshot: null
    ├── last_task_completed_at: null
    └── stall_count: 0
```

### 7.2 並列実行の制御

同時に実行するループ数を `parallel_loop_limit`（デフォルト: 3）で制御する。

**ノード選択アルゴリズム**:

```
1. 全 active leaf ノードを収集
2. 各ノードのスコアを計算:
     score = gap_magnitude × depth_weight × (1 / dependency_penalty)
     depth_weight = 1 / (depth + 1)  // 深いノードほど優先度を下げる
     dependency_penalty = blocked_by_count + 1  // 依存ブロック数
3. スコア上位 parallel_loop_limit 個のノードをアクティブ実行
4. 残りは waiting 状態で待機
```

### 7.3 MVP: ラウンドロビン式の擬似並列

MVP では真の並列実行ではなく、1イテレーションで1ノードを処理するラウンドロビン式を採用する。

```
loop iteration:
  1. active_nodes のうち、最も長く待たされているノードを選択
  2. そのノードの1サイクル（observe → gap → score → task）を実行
  3. 次のノードへ
```

これにより、並列実行の複雑さ（レースコンディション・状態競合）を避けながら、複数ノードを均等に進行させる。

### 7.4 設計上の決定

| パラメータ | デフォルト値 | 理由 |
|-----------|------------|------|
| `parallel_loop_limit` | 3 | リソース制約（LLMコスト・エージェントセッション）と品質のバランス |

---

## 8. 既存設計との統合

### 8.1 GoalDependencyGraph との関係

`goal-dependency.md` の GoalDependencyGraph を、ゴールツリーのノード間依存管理に使用する。

- ゴールツリーの親子関係は `parent_child` 型の依存として登録する
- クロスブランチの依存（例: サブゴールA-1 が サブゴールB-1 の完了を前提とする）も `prerequisite` 型で登録できる
- 循環参照検出は GoalDependencyGraph の既存ロジックを流用する

### 8.2 PortfolioManager との関係

各leafノードは独立した Portfolio を持つ（戦略管理の単位が leafゴール）。非leafノードはポートフォリオを持たず、子ゴールの状態集約のみを行う。

### 8.3 KnowledgeManager との関係

ゴール分解の結果（どのサブゴールが生成されたか、どの分解が効果的だったか）は KnowledgeManager に記録される。類似ゴールの分解時に参照される（`learning-pipeline.md` §3 参照）。

---

## 9. MVP vs Phase 2

### MVP（Phase 1 / Stage 14B-C）

| 項目 | MVP仕様 |
|------|---------|
| 分解の自動化 | LLMによる自動分解（ユーザー確認付き） |
| 並列実行 | ラウンドロビン式（真の並列なし） |
| 状態集約 | ボトルネック集約（min）固定 |
| 剪定 | `no_progress` と `user_requested` のみ自動。その他は手動 |
| ループ並列上限 | 3 |

### Phase 2

| 項目 | Phase 2仕様 |
|------|------------|
| 並列実行 | 真の並列実行（非同期ループ） |
| 状態集約 | 集約メソッドをノードごとに設定可能 |
| 剪定 | 全4条件の自動判断 |
| ダイナミックリバランス | leafノードのスコア変化に応じてラウンドロビンの配分を動的調整 |

---

## 設計原則のまとめ

| 原則 | 具体的な設計決定 |
|------|----------------|
| 分解は具体性が出るまで | min_specificity 未満ならLLMが分解。max_depth で強制停止 |
| 集約は保守的に | confidence は最小値、デフォルト集約はボトルネック（min） |
| 完了は連鎖的に | leaf から root へ順番に完了を伝播 |
| 並列は制限付きで | parallel_loop_limit でリソース消費を制御 |
| MVPは擬似並列 | ラウンドロビンで複雑さを回避しながら複数ノードを進める |
