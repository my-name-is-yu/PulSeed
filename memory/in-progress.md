# In-Progress: Milestone 5（意味的埋め込み Phase 2）実装中

## 完了済み

### M5.1 — 知識獲得 Phase 2
- 共有ナレッジベース: `SharedKnowledgeEntry`スキーマ、`saveToSharedKnowledgeBase()`, `querySharedKnowledge()`
- ベクトル検索: `searchByEmbedding()` — VectorIndex連携、自動埋め込み登録
- ドメイン安定性自動再検証: `classifyDomainStability()`, `getStaleEntries()`, `generateRevalidationTasks()`
- 型拡張: `DomainStabilitySchema`, `SharedKnowledgeEntrySchema`, `RevalidationScheduleSchema`
- テスト: 28テスト（tests/knowledge-manager-phase2.test.ts）

### M5.2 — 記憶ライフサイクル Phase 2
- Drive-based Memory Management: `relevanceScore()`, `compressionDelay()`, `onSatisficingJudgment()`
- DriveScorer連携: 不満スコアに応じた保持期間延長、satisficed次元の早期圧縮
- 意味的WM選択: `selectForWorkingMemory` VectorIndex フォールバック
- ゴール横断教訓検索: `searchCrossGoalLessons()`, `queryCrossGoalLessons()`
- `applyRetentionPolicy` Drive-based遅延対応
- テスト: 28テスト（tests/memory-lifecycle-phase2.test.ts）

### M5.3 — セッション・コンテキスト Phase 2
- 動的バジェット: `estimateTokens()`, `compressSlot()`, priority-based動的選択
- `buildContextForType` トークンバジェット対応
- 依存グラフ活用: `checkResourceConflicts()`, `buildContextWithConflictAwareness()`
- テスト: 31テスト（tests/session-manager-phase2.test.ts）

### 過去の完了
- M4 — 永続ランタイム Phase 2（commit 5d1f7f4）

## 現在の状態
- 3036テスト全パス（77ファイル）
- ビルド成功
- レビュー実行中
- ブランチ: main

## 次のステップ: Milestone 6（能力自律調達 Phase 2）
- 6.1: 能力自律調達フルサイクル（検出→調達→検証→登録）
- 6.2: Capability Registryの動的管理
- ロードマップ: `docs/roadmap.md` Milestone 6セクション
