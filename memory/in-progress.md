# In-Progress

## 次の作業: 柱2 モジュール境界マップ更新

`docs/module-map.md` をPhase 3の分割結果に合わせて更新する。

### やること
1. `docs/module-map.md` を読む
2. Phase 3で新規作成した24ファイルを追加:
   - `src/loop/`: core-loop-types.ts, tree-loop-runner.ts
   - `src/execution/`: task-verifier.ts
   - `src/goal/`: goal-tree-pruner.ts, goal-tree-quality.ts, goal-decomposer.ts
   - `src/knowledge/`: memory-compression.ts, memory-selection.ts, learning-feedback.ts, learning-cross-goal.ts, knowledge-search.ts, knowledge-revalidation.ts, memory-index.ts, memory-stats.ts, memory-query.ts, memory-distill.ts
   - `src/traits/`: curiosity-proposals.ts, curiosity-transfer.ts
   - `src/strategy/`: portfolio-scheduling.ts, portfolio-allocation.ts, portfolio-momentum.ts
   - `src/observation/`: capability-registry.ts, capability-dependencies.ts
3. 分割元ファイルの行数・責務を更新
4. コミット

### 完了済み
- 柱3（テスト効率化）: npm test 8秒
- 柱1 高優先+中優先（Phase 3a-3k）: 11ファイル分割、24新ファイル作成完了
