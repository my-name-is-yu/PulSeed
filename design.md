# Motive Layer アーキテクチャ設計書

## 1. システム概要

### 1.1 コンポーネント図

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code Process                   │
│                                                         │
│  ┌──────────┐    Hook Events     ┌───────────────────┐ │
│  │ Claude    │ ──────────────────>│ Hook Dispatcher   │ │
│  │ Code      │ <──────────────── │ (Python CLI)      │ │
│  │ Runtime   │  Modified input/  │                   │ │
│  │           │  block/approve    └────────┬──────────┘ │
│  └──────────┘                             │            │
└───────────────────────────────────────────┼────────────┘
                                            │ stdin/stdout (JSON)
                                            ▼
┌───────────────────────────────────────────────────────────┐
│                 Motive Layer Core (Python)                 │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ State Manager │  │ Gap Analysis │  │ Priority       │ │
│  │ (CRUD +      │  │ Engine       │  │ Scoring Engine │ │
│  │  persistence)│  └──────────────┘  └────────────────┘ │
│  └──────────────┘                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Task         │  │ Stall        │  │ Satisficing    │ │
│  │ Generation   │  │ Detection    │  │ Engine         │ │
│  │ Engine       │  │ Engine       │  │                │ │
│  └──────────────┘  └──────────────┘  └────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Curiosity    │  │ Trust &      │  │ Context        │ │
│  │ Engine       │  │ Collaboration│  │ Injector       │ │
│  │              │  │ Manager      │  │ (.md rewriter) │ │
│  └──────────────┘  └──────────────┘  └────────────────┘ │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │              File-Based State Store                 │  │
│  │  .motive/state.json  .motive/log.jsonl             │  │
│  │  .motive/goals/*.json  .motive/config.yaml         │  │
│  └────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

### 1.2 データフロー（1セッション中）

```
SessionStart
  → Hook: state.json を読み込み → 現在のゴール・ギャップサマリーを
    .claude/rules/motive.md に書き出し（Context Injector）
  → Claude Code が motive.md を読み込んで動機コンテキストを取得

UserPromptSubmit
  → Hook: ユーザー入力を受け取り、現在のアクティブゴールと照合
  → ゴール外の要求 → 警告メッセージ注入 or ブロック（設定次第）
  → ゴール内 → 優先度スコア付きのタスクコンテキストを注入

PreToolUse
  → Hook: ツール呼び出しが制約に違反しないか検査
  → 不可逆アクション検出 → exit 2（ブロック）+ 人間承認要求
  → 制約範囲内 → 通過（exit 0）

PostToolUse
  → Hook: ツール結果から状態ベクトルを更新
  → Gap Analysis Engine でギャップ再計算
  → Satisficing Engine で完了判定
  → Stall Detection Engine でメトリクス更新

PostToolUseFailure
  → Hook: 失敗カウンタ加算 → 閾値超過で停滞判定
  → 停滞時: 回復戦略をコンテキストに注入

Stop / SessionEnd
  → Hook: 最終状態スナップショット永続化
  → 行動ログ (state→action→result) を log.jsonl に追記
  → 信頼残高の更新（成功/失敗に応じて）
```

---

## 2. 状態モデル

### 2.1 トップレベル状態 (`.motive/state.json`)

```json
{
  "version": "1.0.0",
  "session_id": "uuid",
  "last_updated": "2026-03-09T10:30:00Z",
  "active_goal_ids": ["goal-001", "goal-002"],
  "global_constraints": {},
  "trust_balance": {
    "global": 0.7,
    "per_goal": {}
  },
  "meta_motivation": {
    "curiosity_targets": [],
    "exploration_budget": 3,
    "activation_conditions": {
      "idle_threshold_seconds": 30,
      "anomaly_threshold": 0.7,
      "retry_failed_after_hours": 24
    }
  },
  "stall_state": {}
}
```

### 2.2 ゴールスキーマ (`.motive/goals/{goal_id}.json`)

```json
{
  "id": "goal-001",
  "title": "認証モジュールの実装",
  "description": "JWT認証をsrc/authに実装する",
  "type": "deadline | dissatisfaction | opportunity",

  "achievement_thresholds": {
    "progress": 0.9,
    "quality_score": 0.8,
    "open_issues": 2
  },

  "deadline": "2026-03-15T18:00:00Z",

  "state_vector": {
    "progress": {"value": 0.3, "confidence": 0.85, "observed_at": "...", "source": "tool_output", "observation_method": "file_count"},
    "quality_score": {"value": 0.5, "confidence": 0.6, "observed_at": "...", "source": "llm_estimate", "observation_method": "test_run"},
    "open_issues": {"value": 5, "confidence": 0.9, "observed_at": "...", "source": "tool_output", "observation_method": "grep_match"}
  },

  "gaps": [
    {
      "dimension": "progress",
      "current": 0.3,
      "target": 0.9,
      "magnitude": 0.67,
      "confidence": 0.85
    }
  ],

  "motivation_score": 0.73,
  "motivation_breakdown": {
    "deadline_pressure": 0.4,
    "dissatisfaction": 0.8,
    "opportunity": 0.2
  },

  "constraints": {
    "max_generation_depth": 3,
    "max_subtasks": 10,
    "distance_filter": 0.7
  },

  "status": "active",
  "created_at": "...",
  "parent_goal_id": null
}
```

### 2.3 状態ベクトル要素の確信度ベースライン

| source | 確信度範囲 | 説明 |
|--------|-----------|------|
| `tool_output` | 0.8-1.0 | テスト結果、grepカウント等の機械的観測 |
| `llm_estimate` | 0.3-0.6 | LLMの自己評価 |
| `user_input` | 0.9-1.0 | 人間の明示的入力 |

### 2.4 動機スコア計算式

```python
# 締切駆動スコア
def deadline_score(deadline, now, created_at, progress):
    if deadline is None:
        return 0.0
    remaining_ratio = (deadline - now) / (deadline - created_at)
    gap = 1.0 - progress
    urgency = (1.0 - remaining_ratio) ** 2  # 指数的に急上昇
    return urgency * gap

# 不満駆動スコア
def dissatisfaction_score(gaps, last_action_time, now):
    max_gap = max(g.magnitude * g.confidence for g in gaps)
    staleness = min(1.0, (now - last_action_time).hours / 24.0)
    decay = 1.0 - (staleness * 0.3)  # 最大30%減衰（慣れ）
    return max_gap * decay

# 機会駆動スコア
def opportunity_score(opportunity_events, now):
    if not opportunity_events:
        return 0.0
    freshest = max(opportunity_events, key=lambda e: e.detected_at)
    age_hours = (now - freshest.detected_at).hours
    freshness = max(0.0, 1.0 - age_hours / 12.0)  # 12時間で消滅
    return freshest.value * freshness

# 総合スコア: 最も高い動機が支配的
def motivation_score(goal):
    return max(deadline_score(...), dissatisfaction_score(...), opportunity_score(...))
```

### 2.5 信頼残高

更新ルール（非対称）:
- 成功完了: `+0.05`
- 失敗: `-0.15`
- 不可逆アクション成功: `+0.1`
- 不可逆アクション失敗: `-0.3`

---

## 3. Hook アーキテクチャ

### 3.1 Hook設定 (`.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [
      {"type": "command", "command": "python -m motive_layer.hooks.session_start"}
    ],
    "UserPromptSubmit": [
      {"type": "command", "command": "python -m motive_layer.hooks.user_prompt"}
    ],
    "PreToolUse": [
      {"type": "command", "command": "python -m motive_layer.hooks.pre_tool_use"}
    ],
    "PostToolUse": [
      {"type": "command", "command": "python -m motive_layer.hooks.post_tool_use"}
    ],
    "PostToolUseFailure": [
      {"type": "command", "command": "python -m motive_layer.hooks.post_tool_failure"}
    ],
    "Stop": [
      {"type": "command", "command": "python -m motive_layer.hooks.stop"}
    ]
  }
}
```

### 3.2 各Hook仕様

#### SessionStart
- **入力**: `{"session_id": "...", "project_path": "..."}`
- **処理**: state.json読み込み → 動機スコア再計算 → `.claude/rules/motive.md` 生成
- **出力**: exit 0
- **性能目標**: < 200ms

#### UserPromptSubmit
- **入力**: `{"prompt": "ユーザーの入力テキスト"}`
- **処理**: アクティブゴールとの関連度判定 → コンテキスト注入 or 警告
- **出力**: `{"prompt": "元のプロンプト + 注入コンテキスト"}` or そのまま
- **注意**: ブロック(exit 2)はデフォルトOFF。`config.yaml` の `strict_goal_alignment: true` で有効化

#### PreToolUse
- **入力**: `{"tool_name": "Write", "tool_input": {"file_path": "..."}}`
- **処理**: 不可逆アクション検出 → 制約チェック → 発散防止チェック
- **出力**: exit 0（通過）/ exit 2 + stderr（ブロック）/ stdout修正JSON

#### PostToolUse
- **入力**: `{"tool_name": "Bash", "tool_input": {...}, "tool_output": "..."}`
- **処理**: state vector更新 → ギャップ再計算 → 完了判定 → ログ追記
- **出力**: exit 0
- **性能目標**: < 300ms

#### PostToolUseFailure
- **入力**: `{"tool_name": "...", "error": "..."}`
- **処理**: 失敗カウンタ加算 → 3回連続で停滞判定 → 回復戦略注入
- **出力**: 停滞時のみstdoutに回復指示

#### Stop
- **入力**: `{"session_id": "...", "stop_reason": "end_turn"}`
- **処理**: 最終スコアリング → 完了判定 → 信頼残高更新 → 状態保存 → パターン分析 → 好奇心ターゲット更新
- **出力**: exit 0

### 3.3 Hook間協調

- 全Hookは `.motive/state.json` をファイルI/Oで共有
- 各Hookは独立Pythonプロセス（Claude Codeの仕様）
- 原子的書き込み: temp file → rename パターン
- ローカルHTTPサーバー不要（オーバーキル）

---

## 4. コアエンジン

### 4.1 Gap Analysis Engine

```python
class GapAnalysisEngine:
    def compute_gaps(self, goal: Goal) -> list[Gap]:
        gaps = []
        for dim, threshold in goal.achievement_thresholds.items():
            sv = goal.state_vector[dim]
            if dim == "open_issues":  # 逆方向（低いほど良い）
                magnitude = max(0, (sv.value - threshold)) / max(sv.value, 1)
            else:  # 正方向（高いほど良い）
                magnitude = max(0, (threshold - sv.value)) / threshold
            gaps.append(Gap(
                dimension=dim, current=sv.value, target=threshold,
                magnitude=magnitude, confidence=sv.confidence
            ))
        return sorted(gaps, key=lambda g: g.magnitude * g.confidence, reverse=True)
```

### 4.2 Task Generation Engine

```python
class TaskGenerationEngine:
    def generate_tasks(self, gaps: list[Gap], goal: Goal, constraints: Constraints) -> list[Task]:
        tasks = []
        for gap in gaps:
            if gap.magnitude < 0.05:
                continue
            task = Task(
                goal_id=goal.id,
                target_dimension=gap.dimension,
                description=self._describe_task(gap, goal),
                priority=gap.magnitude * gap.confidence,
                generation_depth=0
            )
            if task.generation_depth >= constraints.max_generation_depth:
                continue
            if len(tasks) >= constraints.max_subtasks:
                break
            tasks.append(task)
        return sorted(tasks, key=lambda t: t.priority, reverse=True)
```

### 4.3 Stall Detection Engine

```python
class StallDetectionEngine:
    CONSECUTIVE_FAILURE_THRESHOLD = 3
    TIME_OVERRUN_FACTOR = 2.0

    def on_failure(self, tool_name: str) -> StallResult | None:
        self.consecutive_failures[tool_name] += 1
        if self.consecutive_failures[tool_name] >= self.CONSECUTIVE_FAILURE_THRESHOLD:
            return self._classify_and_recover(tool_name)
        return None

    def on_success(self, tool_name: str):
        self.consecutive_failures[tool_name] = 0

    def _classify_and_recover(self, tool_name: str) -> StallResult:
        # 原因分類: information_deficit / permission_deficit / capability_deficit / external_dependency
        # 回復戦略:
        #   information_deficit → 調査タスク生成
        #   permission_deficit → 人間にエスカレーション
        #   capability_deficit → ゴール再定義を要請
        #   external_dependency → 別タスクに切り替え
        ...
```

### 4.4 Satisficing Engine

```python
class SatisficingEngine:
    def judge_completion(self, goal: Goal) -> CompletionJudgment:
        all_below = all(g.magnitude <= 0.05 for g in goal.gaps)
        avg_confidence = mean(g.confidence for g in goal.gaps)

        if all_below and avg_confidence >= 0.7:
            return CompletionJudgment("completed", "mark_done")
        elif all_below and avg_confidence < 0.7:
            return CompletionJudgment("needs_verification", "generate_verification_tasks")
        else:
            return CompletionJudgment("in_progress", "continue")
```

### 4.5 Priority Scoring Engine

全アクティブゴールのスコアを再計算し、最高スコアのゴールを選択。
タスク切り替えの振動防止: 直前のゴールに +0.1 ヒステリシスボーナス。

### 4.6 Curiosity Engine

```python
class CuriosityEngine:
    def check_activation(self, state: MotiveState) -> list[Goal]:
        new_goals = []
        # 条件1: タスクキュー空 → パターンから探索
        if not self._get_active_tasks(state):
            new_goals.extend(self._explore_from_patterns(state))
        # 条件2: 想定外の結果 → 調査ゴール生成
        for anomaly in self._detect_anomalies(state.log):
            if anomaly.deviation > state.meta_motivation.anomaly_threshold:
                new_goals.append(self._create_investigation_goal(anomaly))
        # 条件3: 過去の失敗領域の再試行
        new_goals.extend(self._find_retryable_failures(state))
        return new_goals[:state.meta_motivation.exploration_budget]
```

---

## 5. 人間との協調

### 5.1 確信度 × 信頼残高マトリクス

| 信頼残高 | 確信度 | 振る舞い |
|----------|--------|----------|
| 高 (≥0.6) | 高 (≥0.7) | 自律実行 |
| 高 (≥0.6) | 低 (<0.7) | タスク生成するが人間に確認 |
| 低 (<0.6) | 高 (≥0.7) | タスク生成するが人間に確認 |
| 低 (<0.6) | 低 (<0.7) | 現在地確認タスクを先に生成 |

**不可逆アクションは信頼残高・確信度に関わらず常に人間承認。**

### 5.2 不可逆アクション検出パターン

```python
IRREVERSIBLE_PATTERNS = [
    r"git push", r"rm -rf",
    r"curl -X (POST|PUT|DELETE|PATCH)",
    r"docker (push|rm)", r"npm publish",
    r"deploy", r"DROP TABLE", r"DELETE FROM",
]
```

---

## 6. 学習とフィードバック

### 6.1 行動ログ (`.motive/log.jsonl`)

```json
{
  "timestamp": "2026-03-09T10:30:00Z",
  "session_id": "...",
  "goal_id": "goal-001",
  "state_before": {"progress": 0.3, "quality_score": 0.5},
  "action": {"tool": "Write", "target": "src/auth/jwt.py"},
  "state_after": {"progress": 0.35, "quality_score": 0.5},
  "state_delta": {"progress": 0.05},
  "outcome": "success"
}
```

### 6.2 パターン蓄積 (`.motive/patterns.json`)

Stopフック時に log.jsonl を分析して更新。好奇心エンジンがこれを参照して探索方向を決定。

```json
{
  "patterns": [
    {"context": "テスト失敗後にソースコード修正", "avg_state_delta": 0.15, "success_rate": 0.8, "sample_count": 12}
  ],
  "failure_areas": [
    {"area": "型定義の不整合", "failure_count": 3, "last_attempted": "2026-03-08", "retry_eligible": true}
  ]
}
```

---

## 7. ファイル構造

### 7.1 プロジェクト側

```
<project-root>/
├── .motive/
│   ├── config.yaml          # プロジェクト固有設定
│   ├── state.json           # 現在の状態
│   ├── goals/
│   │   └── *.json           # 個別ゴール
│   ├── log.jsonl            # 行動ログ
│   └── patterns.json        # 学習パターン
├── .claude/
│   ├── settings.json        # Hook設定
│   └── rules/
│       └── motive.md        # 動的コンテキスト注入
└── .gitignore               # .motive/ を追加推奨
```

### 7.2 パッケージ側

```
motive-layer/
├── pyproject.toml
├── src/
│   └── motive_layer/
│       ├── __init__.py
│       ├── cli.py                    # CLI (motive init/status/add-goal/gc)
│       ├── hooks/
│       │   ├── __init__.py
│       │   ├── session_start.py
│       │   ├── user_prompt.py
│       │   ├── pre_tool_use.py
│       │   ├── post_tool_use.py
│       │   ├── post_tool_failure.py
│       │   └── stop.py
│       ├── engines/
│       │   ├── __init__.py
│       │   ├── gap_analysis.py
│       │   ├── task_generation.py
│       │   ├── stall_detection.py
│       │   ├── satisficing.py
│       │   ├── priority_scoring.py
│       │   └── curiosity.py
│       ├── state/
│       │   ├── __init__.py
│       │   ├── manager.py            # StateManager (原子的永続化)
│       │   ├── models.py             # Pydantic models
│       │   └── migration.py          # スキーママイグレーション
│       ├── collaboration/
│       │   ├── __init__.py
│       │   ├── trust.py
│       │   ├── behavior.py
│       │   └── irreversible.py
│       ├── context/
│       │   ├── __init__.py
│       │   └── injector.py           # motive.md 生成
│       └── learning/
│           ├── __init__.py
│           ├── logger.py
│           └── pattern_analyzer.py
└── tests/
    ├── test_engines/
    ├── test_hooks/
    ├── test_state/
    └── test_collaboration/
```

### 7.3 設定ファイル (`.motive/config.yaml`)

```yaml
version: "1.0"

goals:
  max_active: 5
  default_achievement_threshold: 0.85
  max_generation_depth: 3
  max_subtasks_per_goal: 10

constraints:
  divergence:
    distance_filter: 0.7
    max_task_budget: 50
  uncertainty:
    low_confidence_threshold: 0.5
    verification_threshold: 0.7
  resource:
    max_session_duration_minutes: 120
    warn_at_context_usage: 0.8

stall_detection:
  consecutive_failure_threshold: 3
  time_overrun_factor: 2.0
  output_variance_window: 5

collaboration:
  strict_goal_alignment: false
  irreversible_always_approve: true
  trust_recovery_rate: 0.05
  trust_decay_rate: 0.15

curiosity:
  enabled: true
  exploration_budget_per_session: 3
  idle_threshold_seconds: 30
  anomaly_threshold: 0.7
  retry_failed_after_hours: 24

logging:
  retention_days: 30
  max_log_size_mb: 50
```

---

## 8. 技術スタック

### 言語: Python 3.11+

### 依存ライブラリ（最小構成）

```toml
[project]
name = "motive-layer"
requires-python = ">=3.11"
dependencies = [
    "pydantic>=2.0",
    "pyyaml>=6.0",
    "click>=8.0",
]
```

LLM SDKは不要（Claude Codeから呼び出される側）。

### CLIコマンド

```
motive init          # .motive/ と .claude/settings.json を初期化
motive add-goal      # 対話的にゴールを追加
motive status        # 現在の状態サマリー表示
motive goals         # 全ゴール一覧
motive log           # 直近の行動ログ表示
motive gc            # 古いログの刈り込み
motive reset         # 状態のリセット
```

---

## 9. ビルド順序

### Phase 1: 基盤（並行可能）

1. **状態モデル** — `state/models.py`, `state/manager.py`（Pydantic, JSON読み書き, 原子的永続化）
2. **Gap Analysis Engine** — `engines/gap_analysis.py`
3. **CLI基盤** — `cli.py`（`motive init`, `motive status`）

### Phase 2: コアエンジン群（Phase 1に依存）

4. **Priority Scoring Engine** — 3類型スコア計算
5. **Task Generation Engine** — ギャップ→タスク変換
6. **Satisficing Engine** — 完了判定
7. **Stall Detection Engine** — 失敗カウンタ、停滞判定

### Phase 3: Hook統合（Phase 1-2に依存）

8. **SessionStart + Stop hooks**
9. **PostToolUse + PostToolUseFailure hooks**
10. **PreToolUse hook**
11. **UserPromptSubmit hook**
12. **Context Injector** — `.claude/rules/motive.md` 動的生成

### Phase 4: 人間協調 + 学習（Phase 3に依存）

13. **Trust & Collaboration Manager**
14. **Learning Logger + Pattern Analyzer**
15. **Curiosity Engine**

### Phase 5: 統合テスト + 実運用

16. E2Eテスト（実際のClaude Codeセッション）
17. パフォーマンスチューニング（各Hook < 300ms目標）

---

## 10. リスクと未決事項

1. **Hook起動パフォーマンス**: Pythonプロセス毎回起動がPostToolUseの頻度に耐えられるか → Phase 5で計測、問題あれば常駐デーモン化
2. **State Vector更新の精度**: ツール出力からの更新はヒューリスティック依存 → 初期はルールベース、将来LLM判定追加可能
3. **UserPromptSubmitの関連度判定**: LLMなしで十分か → 初期はキーワード+TF-IDF、不十分なら`prompt`ハンドラ型に切替
4. **motive.mdのサイズ**: コンテキスト圧迫防止 → 500トークン以下に制限
5. **マルチゴール時のスコア振動**: ヒステリシス（直前ゴール+0.1ボーナス）で対策
