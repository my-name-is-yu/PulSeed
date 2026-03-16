# In-Progress: M7 Dogfooding完了 → コミット待ち

## 完了済み

### M7 Dogfooding 実ゴール実行（2026-03-16）
- ゴール: 「docs/status.mdをStage 1-14 + M1-7の実装状況と一致させる」
- 結果: **8イテレーションで completed** (max 10)
- バグ修正: `src/core-loop.ts` — `runTreeIteration`にGoalTree自動分解を追加
  - rootゴールに`children_ids`がない場合、`goalTreeManager.decomposeGoal()`を自動呼び出し
  - 分解失敗時はflatモードにfallback（クラッシュしない）
- Dogfooding発見事項:
  1. Goal Tree自動分解がLLM（gpt-4o-mini）では動作しない（childCount=0を返す）→ より大きなモデルが必要
  2. Codexがdocs/status.mdを書き換えた際に誤情報を含む（「1 test failed」は虚偽）
  3. LLM観測はCodex自己申告を検証できていない（独立検証の限界）
- スコア推移: 0.70-0.90 → 0.80-1.00 で収束
- 3282テスト全パス、90ファイル

### 過去の完了
- M7 E2Eテスト（commit 3cc1af7）— 14テスト追加
- M7 再帰的Goal Tree & 横断ポートフォリオ Phase 2（commit aa0a04d）
- M6 — 能力自律調達 Phase 2
- M5 — 意味的埋め込み Phase 2 + Dogfooding
- M4 — 永続ランタイム Phase 2

## 現在の状態
- 3282テスト全パス（90ファイル）
- ブランチ: main
- 未コミット: `src/core-loop.ts`（auto-decompose fix）+ `docs/status.md`（Codex書き換え）

## 次のステップ
- コミット → docs/status.mdのCodex虚偽情報を手動修正するか判断
- M7完了宣言 → Milestone 8以降の検討（docs/roadmap.md参照）
