# In-Progress

## 現在: plugin CLI実装（`motiva plugin list/install/remove`）

M12設計に含まれるが未実装のCLIコマンド。`docs/roadmap-m8-beyond.md` §12参照。

## Dogfoodingフェーズ — 完了サマリー

### 修正済み（11件）
1. negotiate()コンテキスト不足 → gatherNegotiationContext()（67be750）
2. ShellDataSource未登録 → autoRegisterShellDataSources()（9620877）
3. Codex --pathフラグ未対応 → spawn cwdに変更（7304d61）
4. ノイズ次元がタスク支配 → confidence重み付き次元選択（4a1e311）
5. monotonic clampバグ → max次元のclamp削除（observation-engine.ts）
6. negotiate次元膨張 → プロンプト改善（goal-negotiator.ts）
7. ShellDataSource grepパターン → コメント行のみ対象（goal.ts）
8. GoalTreeManager hypothesisパースエラー → サニタイズ拡張（goal-tree-manager.ts）
9. LLMプロンプト全面圧縮 — 5ファイル11プロンプト（101行削減）
10. タスク実行スコープ制約 + テストファイル保護除外（task-lifecycle.ts）
11. workspaceContext → executeTask転送（task-lifecycle.ts）

### Dogfooding検証結果（2026-03-17）
- TODOゴール: Codexがファイル変更に成功、スコープ制約でconfig/build保護
- FIXMEゴール: 前回9ファイル変更→修正後1ファイルに制限
- テストカバレッジゴール: Codexがテストファイル追加に成功（105テストパス）
- tree mode: サブゴール分解 → completed到達
- tscゴール: ShellDataSourceにtsc_error_countパターンがなくフォールバック→要追加

### 未解決・要観察
- tsc_error_countパターン未定義 → SHELL_DIMENSION_PATTERNSに追加すべき
- test_coverageのmechanical観測未対応 → vitest --coverageパース必要
- サブゴール品質（tree mode）→ プロンプト圧縮で改善したが未再検証
- GitHub Issueゴール — GitHubIssueAdapter検証未実施
