# M7 Dogfooding Findings (2026-03-16)

## 概要
- ゴール: 「docs/status.mdをStage 1-14 + M1-7の実装状況と一致させる」
- モデル比較: gpt-4o-mini vs gpt-5.3-codex
- Goal Tree `--tree` モード初の実ゴール実行

## モデル比較結果

| モデル | Fix適用 | イテレーション | Tree分解 | 所要時間 |
|--------|---------|---------------|----------|----------|
| gpt-4o-mini | なし | 100 (max_iterations) | 未動作 | ~3分（無駄ループ） |
| gpt-4o-mini | auto-decompose | 8 | childCount=0 | ~21分 |
| gpt-5.3-codex | auto-decompose | 3 | childCount=0 | ~4分 |
| gpt-5.3-codex | 全fix | **2** | **成功** | ~9分 |

## 発見・修正したバグ（4件）

### Bug 1: runTreeIterationがdecomposeGoal()を呼ばない
- **症状**: `--tree`フラグ付きでも、GoalTreeが生成されずflatモードと同じ動作
- **原因**: `runTreeIteration()`は`selectNextNode()`を呼ぶだけで、`decomposeGoal()`を呼んでいなかった
- **修正**: `src/core-loop.ts` — rootゴールにchildren_idsがない場合、decomposeGoal()を自動呼び出し。失敗時はflatモードにfallback
- **コミット**: 726c4d5

### Bug 2: depth=0でspecificity checkが早期終了
- **症状**: LLMがrootゴールのspecificity >= 0.7と評価 → isLeaf=true → 分解スキップ
- **原因**: 具体的な記述（ファイル名入り）のゴールはLLMが「十分具体的」と判定
- **修正**: `src/goal-tree-manager.ts` — depth=0ではspecificity checkをスキップ。rootゴールは常に分解を試行
- **コミット**: ec4dd20

### Bug 3: buildSpecificityPromptの問い方が不適切
- **症状**: LLMが「具体的か？」に対して高スコアを返しすぎる
- **原因**: プロンプトが「concrete enough to generate tasks」と聞いていた
- **修正**: 「single, atomic task with no meaningful sub-components」に変更
- **コミット**: ec4dd20

### Bug 4: LLMが不正なthreshold_typeを返す
- **症状**: サブゴール生成でZodバリデーション失敗 → catchブロックがサイレントにchildren:[]を返す
- **原因**: LLMが"exact", "scale", "qualitative"等を返すが、スキーマは"min"|"max"|"range"|"present"|"match"のみ許可
- **修正**: パース前にthreshold_typeをサニタイズ（"exact"→"match"等）。catchブロックにエラーログ追加
- **コミット**: ec4dd20

## その他の発見

### Codex虚偽情報問題
- gpt-4o-miniでdocs/status.mdを書き換えた際、「1 test failed」と虚偽記載
- 実際は全3282テスト通過
- LLM観測（independent_review）はCodexの出力を独立検証できていない

### gpt-5.3-codexの優位性
- 初回観測で4/6次元を正確に1.00と評価（gpt-4o-miniは0.70-0.90混在）
- 収束速度が大幅に速い（8iter→3iter、21分→4分）
- 虚偽情報問題なし
