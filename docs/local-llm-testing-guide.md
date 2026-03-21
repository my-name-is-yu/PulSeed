# ローカルLLMテストガイド（古いMacBook用）

## 前提条件

- Intel MacBook (8GB RAM / 256GB Storage)
- macOS
- Node.js 20+
- Ollama インストール済み
- モデル: `qwen3:4b`

## 1. セットアップ

### Ollama

```bash
# Ollamaインストール（未済の場合）
# https://ollama.com からダウンロード

# モデル取得
ollama pull qwen3:4b

# 確認
ollama list  # qwen3:4b が表示されればOK
```

### Motivaリポジトリ

```bash
git clone <リポジトリURL> Motiva
cd Motiva
npm install
npm run build
```

## 2. Ollama起動

```bash
# ローカルのみ（同じマシンでMotiva実行する場合）
ollama serve

# 外部アクセス許可（別マシンからアクセスする場合）
OLLAMA_HOST=0.0.0.0 ollama serve
```

## 3. Motiva実行

### 共通の環境変数

```bash
export MOTIVA_LLM_PROVIDER=ollama
export ANTHROPIC_API_KEY=dummy
```

> **注意**: `ANTHROPIC_API_KEY=dummy` はTUI起動時のチェック回避用。Ollama使用時は実際のキーは不要。

### エントリポイント

`npx motiva` または直接実行：

```bash
npx motiva <サブコマンド>
# または
node dist/cli-runner.js <サブコマンド>
```

### ヘルプ

```bash
node dist/cli-runner.js --help
```

### ゴール追加

```bash
node dist/cli-runner.js goal add "Motivaのreadmeを作成"
```

### ゴール一覧

```bash
node dist/cli-runner.js goal list
```

### コアループ実行

```bash
node dist/cli-runner.js run
```

### ステータス確認

```bash
node dist/cli-runner.js status
```

### レポート

```bash
node dist/cli-runner.js report
```

### TUI（インタラクティブUI）

```bash
node dist/cli-runner.js tui
```

TUI操作:
- `/help` — コマンド一覧
- `/goal add <ゴール>` — ゴール追加
- `Ctrl-C` — 終了

> **TUI注意点**:
> - SSH + tmux経由だと表示が崩れることがある → `Ctrl-b z` でペインをズームして幅を確保
> - チャットは自由入力ではなくコマンドベース
> - フリーズした場合は `Ctrl-C` か別ペインから `pkill -f "node dist/cli-runner.js"`

## 4. 別マシンからOllamaに接続する場合

古いMacBookでOllamaを動かし、開発マシンからMotiva実行：

```bash
# 古いMacBookのIPアドレスを確認
ifconfig | grep "inet "

# 開発マシンから接続テスト
curl http://<古いMacのIP>:11434/v1/models

# 開発マシンでMotiva実行
MOTIVA_LLM_PROVIDER=ollama \
OLLAMA_BASE_URL=http://<古いMacのIP>:11434 \
node dist/cli-runner.js run
```

## 5. テストシナリオ

### A. 基本動作確認

```bash
# 1. ゴール追加
node dist/cli-runner.js goal add "テスト用のシンプルなゴール"

# 2. ゴール一覧で登録確認
node dist/cli-runner.js goal list

# 3. コアループ実行
node dist/cli-runner.js run

# 4. ステータス確認
node dist/cli-runner.js status

# 5. レポート生成
node dist/cli-runner.js report
```

### B. TUI動作確認

```bash
node dist/cli-runner.js tui
# → /help でコマンド確認
# → ゴール追加・実行を試す
# → Ctrl-C で終了
```

### C. エラーハンドリング確認

```bash
# Ollama停止状態でMotiva実行 → リトライ→エラー表示を確認
# (別ターミナルでollamaを止めてから実行)
node dist/cli-runner.js run
```

## 6. 既知の問題

| 問題 | 原因 | 回避策 |
|------|------|--------|
| ~~`npx motiva` が何も出力しない~~ | ~~修正済み~~ `import.meta.url` + `realpathSync` 判定に修正 | `npx motiva` も `node dist/cli-runner.js` も使用可 |
| TUI表示崩れ | SSH+tmux経由でターミナル幅不足 | `Ctrl-b z` でペインズーム |
| TUIチャットが「I didn't understand」 | コマンドベース（自由入力未対応） | `/help` でコマンド確認して使う |
| TUIフリーズ | Ink描画問題 | `Ctrl-C` or `pkill -f "node dist/cli-runner.js"` |
| `ANTHROPIC_API_KEY` 必要 | TUI起動時のハードコードチェック | `ANTHROPIC_API_KEY=dummy` をセット |

## 7. 状態リセット

テストデータをクリアして最初からやり直す場合：

```bash
rm -rf ~/.motiva
```
