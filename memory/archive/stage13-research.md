# Stage 13 リサーチ: 能力自律調達と外部世界接続

**作成日**: 2026-03-15
**前提**: Stage 1-12 完了（1919テスト、40テストファイル）
**ビジョン対応**: 6. 現実世界との接続 / 7. 自律的ツール調達

---

## Stage 13 の概要

Stage 13 は3つのサブシステムで構成される。

| サブシステム | 概要 | 設計ドキュメント |
|------------|------|----------------|
| **13.1 能力の自律調達** | エージェントへのツール/コード作成委譲、新能力の検証・自動登録 | `docs/design/execution-boundary.md` Phase 2 (§5.5) |
| **13.2 外部データソース連携** | DBアダプタ、API、IoT、ファイル; 観測エンジンの拡張 | `docs/vision.md` §5.7 |
| **13.3 Capability Registryの動的管理** | 新アダプタのホットプラグ、再利用可能な能力カタログ | `docs/design/execution-boundary.md` §5 |

---

## 依存関係

### Stage依存
- **Stage 11**（好奇心・倫理）: 必須
  - `CuriosityEngine` — 能力不足を発見する好奇心トリガーが必要
  - `EthicsGate` Layer 1 — 自律調達されたツールの手段チェックが必要
- **Stage 12**（埋め込み基盤）: 必須
  - `VectorIndex` / `KnowledgeGraph` — 能力カタログの意味的検索、類似能力の発見
  - `GoalDependencyGraph` — 複数ゴールをまたぐ能力共有の管理

### 既存モジュール依存（実装済み）
- `CapabilityDetector`（Stage 8）— 能力不足検知のMVP実装済み。Stage 13はその Phase 2
- `KnowledgeManager` — 調達した能力の知識として保存
- `TaskLifecycle` — 調達タスクを通常タスクと同じライフサイクルで扱う
- `AdapterLayer` / `AdapterRegistry` — 新しいデータソースアダプタの登録先

### `src/types/capability.ts` 既存型
```
CapabilityType: "tool" | "permission" | "service"
CapabilityStatus: "available" | "missing" | "requested"
CapabilitySchema: { id, name, type, status, description, acquired_at?, context? }
CapabilityRegistry: { capabilities: Capability[] }
CapabilityGap: { missing_capability, reason, alternative?, goal_id, task_id? }
```

---

## 13.1 能力の自律調達 — 詳細

設計出典: `docs/design/execution-boundary.md` §5.2〜5.5

### MVP（Stage 8で実装済み）との差分

| 項目 | Stage 8 MVP | Stage 13 Phase 2 |
|------|------------|-----------------|
| 能力不足の対応 | 人間へのエスカレーションのみ | エージェントへの調達タスク委譲 |
| ツール/コード | 未実装 | Claude Codeに作成を委譲、検証後自動登録 |
| 外部サービス連携 | 未実装 | 設定手順の自動ガイド生成 → ユーザー承認後に完了 |
| 権限/APIキー | エスカレーション | 引き続きエスカレーション（変更なし） |

### 調達フローの6ステップ（§5.2）

```
1. 能力不足の確定（シグナル: task_generation/連続失敗/停滞診断）
2. 調達方法の選択（ツール作成委譲 / 権限要求 / 外部連携提案）
3. 調達タスクの生成（task_category: "capability_acquisition"）
4. 調達タスクの実行（TaskLifecycle経由で委譲）
5. 新能力の検証（3層検証: 基本動作/エラーハンドリング/制約整合性/スコープ境界）
6. Capability Registryへの登録（再利用のためコンテキスト記録付き）
```

### 検証が3回失敗した場合: ユーザーエスカレーション

### 実装対象ファイル（推定）
- `src/capability-detector.ts` — 調達タスク生成・検証・登録ロジックの追加
- `src/types/capability.ts` — `CapabilityAcquisitionTask` 型追加、`CapabilityType` に `"data_source"` 追加
- `src/task-lifecycle.ts` — `task_category: "capability_acquisition"` のハンドリング追加
- `src/index.ts` — エクスポート更新

**複雑度**: Medium-High（4-5ファイル変更、検証ロジックが複雑）

---

## 13.2 外部データソース連携 — 詳細

設計出典: `docs/vision.md` §5.7（詳細設計ドキュメントなし — 要新規設計）

### 機能要件

- **データソースアダプタの抽象化**: `IDataSourceAdapter` インターフェース（DB/API/IoT/ファイル）
- **観測エンジンの拡張**: LLM経由だけでなく、直接データソースからの観測値取得
- **メトリクス監視**: 定期ポーリング、変化検知、閾値アラート
- **認証・権限管理**: APIキー、OAuth、DB接続文字列の安全な管理

### アーキテクチャ上の位置づけ

```
ObservationEngine（既存）
  ├── Layer 1: 直接観測（現在: シェルコマンド実行）
  │              ↓ Stage 13 拡張
  │           直接観測 = シェルコマンド OR IDataSourceAdapter
  ├── Layer 2: LLMレビュー
  └── Layer 3: 自己申告
```

### 実装対象ファイル（推定）
- `src/data-source-adapter.ts`（新規）— `IDataSourceAdapter` インターフェース + 基本実装（ファイル/HTTP API）
- `src/types/data-source.ts`（新規）— DataSourceConfig, DataSourceResult, PollingConfig 型
- `src/observation-engine.ts` — `IDataSourceAdapter` のDI対応追加
- `src/adapter-layer.ts` — データソースアダプタのレジストリ統合
- `src/cli-runner.ts` — データソース登録サブコマンド（`motiva datasource add`）

**複雑度**: High（新規インターフェース定義 + 既存ObservationEngineの大幅拡張）
**注意**: 詳細設計ドキュメントが存在しない。実装前に設計ドキュメント(`docs/design/data-source.md`)を作成するか、実装と同時に設計を固める必要がある。

---

## 13.3 Capability Registryの動的管理 — 詳細

設計出典: `docs/design/execution-boundary.md` §5（既存）

### 機能要件

- 委譲可能な能力カタログの動的管理（ホットプラグ）
- 新しい種類のアダプタ/データソースの実行時登録・削除
- 能力の依存関係と組み合わせの管理
- 調達コンテキストの記録（どのゴールのために調達したか）
- 他のゴールでも再利用可能な形での登録

### 実装対象ファイル（推定）
- `src/capability-detector.ts` — 動的管理ロジック（13.1と同一ファイル）
- `src/types/capability.ts` — `CapabilityDependency`、`AcquisitionContext` 型追加

**複雑度**: Medium（13.1と統合して実装する。独立ファイル追加なし）

---

## Stage 13 全体見積もり

### ファイル構成

| パート | 新規ファイル | 変更ファイル | 複雑度 |
|--------|------------|------------|--------|
| 13.1 能力自律調達 | 0 | 4（capability-detector, types/capability, task-lifecycle, index） | Medium-High |
| 13.2 外部データソース | 2（data-source-adapter, types/data-source） | 3（observation-engine, adapter-layer, cli-runner） | High |
| 13.3 Registry動的管理 | 0 | 2（同上: capability-detector, types/capability） | Medium |

**合計**: 新規2ファイル、変更5-6ファイル（重複含む）、テストファイル新規2-3

### 推奨パート分割

```
Part A: 13.1 + 13.3 (能力自律調達 + Registry動的管理)
  ← 独立着手可（CapabilityDetector既存の拡張）
  ← 4ファイル変更

Part B: 13.2 (外部データソース連携)
  ← Part Aの完了が推奨（13.1でRegistry管理が完成してから）
  ← 5ファイル（新規2 + 変更3）
  ← 設計ドキュメントが未存在のため、着手前に要設計
```

---

## リスクフラグ

| リスク | 影響 | 対応方針 |
|--------|------|---------|
| 能力自律調達の安全性 | 高 | EthicsGate.checkMeans()との密な統合が必須。エージェントが作成するツールの検証が不可欠 |
| 外部データソース設計ドキュメント未存在 | 中 | 13.2着手前に `docs/design/data-source.md` を新規作成するか、実装段階で設計と実装を同時進行 |
| 外部データソースの多様性 | 中 | IDataSourceAdapterパターンで抽象化し、MVP=ファイル/HTTPに絞る。IoT/DBは Phase 2以降 |
| 不可逆アクション確認 | 高 | データソース書き込み操作は execution-boundary.md §7 に従い必ず人間承認 |
| 調達した能力の再利用 | 低 | GoalDependencyGraph（Stage 12）でゴール横断の能力共有を管理 |

---

## 設計ドキュメント対応表

| 設計ドキュメント | Stage 13での使用箇所 | Phase |
|----------------|-------------------|-------|
| `execution-boundary.md` | 13.1: 動的調達フロー（§5.2-5.5） | Phase 2 |
| `execution-boundary.md` | 13.3: Capability Registry管理（§5） | Phase 2 |
| `vision.md` | 13.2: 外部世界の観測（§5.7） | — |
| `knowledge-acquisition.md` | 13.2: 調査手段として外部APIを追加（§4.1 Phase 2） | Phase 2 |
| `task-lifecycle.md` | 13.1: 調達タスクの実行（通常タスクと同一構造） | — |
| `goal-ethics.md` | 13.1: 調達ツールの手段チェック | — |

**詳細設計ドキュメントが存在しない**: 13.2の外部データソース連携には専用の設計ドキュメントがない。`docs/design/data-source.md` を新規作成する必要がある。

---

## 既存コード参照

- `src/capability-detector.ts` — Stage 13の主要な拡張対象
- `src/types/capability.ts` — 型の拡張対象（`CapabilityType`, `CapabilityGap`等）
- `src/observation-engine.ts` — 13.2の直接統合対象
- `src/adapter-layer.ts` — `AdapterRegistry` — データソースアダプタの登録先として流用可能
- `src/ethics-gate.ts` — 調達ツールのcheckMeans()統合先
- `src/task-lifecycle.ts` — 調達タスクの実行ハンドラー

---

## 次のステップ

1. **Part A（13.1+13.3）から着手可能** — CapabilityDetectorの拡張。外部依存なし
2. **13.2は設計ドキュメントが必要** — `docs/design/data-source.md` 作成が先決
3. **テスト品質課題** — `memory/test-quality-audit.md` の未解決事項はStage 13と並行して対処
4. **Stage 14への準備** — Stage 13完了で GoalDependencyGraph（12.6）+ 能力カタログ（13.3）が揃い、Stage 14（再帰的Goal Tree）の前提が整う
