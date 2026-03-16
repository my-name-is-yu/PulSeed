# Milestone 5 実装計画 — 意味的埋め込み Phase 2

## サブステージ構成

### 5.1a — 型定義拡張 + 共有ナレッジベース基盤
**ファイル**: `src/types/knowledge.ts`(新規 or 拡張）, `src/knowledge-manager.ts`
**内容**:
- `SharedKnowledgeEntry` スキーマ追加（ゴール横断、埋め込みベクトル参照付き）
- `DomainStability` enum（stable/moderate/volatile）+ 再検証間隔マッピング
- `RevalidationSchedule` スキーマ
- KnowledgeManager に `saveToSharedKnowledgeBase()`, `querySharedKnowledge()` メソッド追加
- 共有ナレッジの保存先: `~/.motiva/memory/shared-knowledge/`
**依存**: なし
**テスト**: 共有KB CRUD、ゴール横断検索

### 5.1b — ベクトル検索による知識共有
**ファイル**: `src/knowledge-manager.ts`, `src/vector-index.ts`（既存活用）
**内容**:
- KnowledgeManager に `searchByEmbedding(query, topK)` メソッド追加
- 知識エントリ登録時に VectorIndex にも自動登録
- ゴールAの知識がゴールBのコンテキストに自動で含まれるフロー
- `KnowledgeGraph` にもクロスゴール関係エッジを追加
**依存**: 5.1a
**テスト**: 異なるゴール間で関連知識がベクトル検索で発見できる

### 5.1c — ドメイン安定性ベース自動再検証
**ファイル**: `src/knowledge-manager.ts`
**内容**:
- `classifyDomainStability(domain)` — LLM判定でstable/moderate/volatile分類
- `getStaleEntries()` — 安定性に応じた期限超過エントリ検出
- `generateRevalidationTask()` — 再検証用の調査タスク生成
**依存**: 5.1a
**テスト**: 安定性分類、期限超過検出、再検証タスク生成

### 5.2a — Drive-based Memory Management
**ファイル**: `src/memory-lifecycle.ts`
**内容**:
- `relevanceScore(entry, context)` — tag_match * drive_weight * freshness
- `compressionDelay(dimension)` — 不満スコアに応じた保持期間延長
- `onSatisficingJudgment(dimension, isSatisfied)` — 早期圧縮マーク
- DriveScorer への依存注入（constructor に追加）
- `applyRetentionPolicy` を Drive-based ロジックで拡張
**依存**: なし
**テスト**: 不満スコア高次元の保持延長、satisficed次元の早期圧縮

### 5.2b — 意味的検索によるWorking Memory選択
**ファイル**: `src/memory-lifecycle.ts`
**内容**:
- `selectForWorkingMemory` を拡張: タグ完全一致 → 埋め込みベース検索にフォールバック
- Short-term/Long-term エントリの埋め込み登録フロー
- VectorIndex を MemoryLifecycleManager に注入
**依存**: 5.2a
**テスト**: 意味的類似クエリで関連記憶が選択される

### 5.2c — Long-term教訓のゴール横断検索
**ファイル**: `src/memory-lifecycle.ts`
**内容**:
- `searchCrossGoalLessons(query, topK)` — ゴール横断で教訓を検索
- `queryLongTermLessons(dimensions, context)` 拡張 — 埋め込み検索を使用
- 教訓エントリの VectorIndex 自動登録
**依存**: 5.2b
**テスト**: ゴールAの教訓がゴールBのコンテキストで発見される

### 5.3a — バジェットベース動的コンテキスト選択
**ファイル**: `src/session-manager.ts`
**内容**:
- `DynamicContextBudget` 型追加
- `buildContextForType` を拡張: 固定top-4 → トークンバジェットに応じた動的選択
- 優先度6（記憶層からの関連データ）の25%枠実装
- トークン推定: 文字数ベースの簡易推定（1トークン ≈ 4文字）
**依存**: なし
**テスト**: バジェット超過時に低優先度項目が除外される

### 5.3b — 依存グラフ活用（resource_conflict排他制御）
**ファイル**: `src/session-manager.ts`, `src/goal-dependency-graph.ts`（既存活用）
**内容**:
- `checkResourceConflicts(goalId)` — 依存グラフからresource_conflict関係を取得
- タスク生成前に競合チェック、競合時はタスク生成を一時抑制
- 競合情報をコンテキストに含める
**依存**: 5.3a
**テスト**: resource_conflict時にタスク生成が抑制される

## 実装順序

```
5.1a (型+共有KB) ──→ 5.1b (ベクトル検索) ──→ 5.1c (再検証)
5.2a (Drive-based) ──→ 5.2b (意味的WM選択) ──→ 5.2c (横断教訓)
5.3a (動的バジェット) ──→ 5.3b (依存グラフ)
```

3つのトラックは独立して並列実装可能。

## ファイル所有権（並列ワーカー用）

- Worker A: `src/knowledge-manager.ts`, `src/types/knowledge.ts` — 5.1a, 5.1b, 5.1c
- Worker B: `src/memory-lifecycle.ts` — 5.2a, 5.2b, 5.2c
- Worker C: `src/session-manager.ts` — 5.3a, 5.3b

各ワーカーは自分のファイルのみ編集。型定義の共有が必要な場合は Worker A が先行。
