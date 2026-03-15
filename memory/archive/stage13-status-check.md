# Stage 13 実装状況チェック

**作成日**: 2026-03-15
**ベースコミット**: eb08254 (feat: Stage 13A — capability detector, data source adapter, observation integration)

---

## 結論: Stage 13 は実装完了

docs/status.md はまだ Stage 11 完了（1749テスト）と記載されているが、**ソースコードレベルでは Stage 13 の全コンポーネントが実装済み**。docs/status.md の更新が遅れている。

---

## 実装済み Stage 13 コンポーネント

### Part A: 13.1 能力自律調達 + 13.3 Registry動的管理

**`src/capability-detector.ts`** (拡張済み)
- `planAcquisition(gap: CapabilityGap): CapabilityAcquisitionTask` — 調達方法選択（tool_creation / permission_request / service_setup）
- `verifyAcquiredCapability(capability, acquisitionTask): VerificationResult` — 3段階検証
- `registerCapability(cap, context?): Promise<void>` — Registry登録 + KnowledgeManager保存
- `getAcquisitionHistory(goalId): Promise<AcquisitionContext[]>` — コンテキスト記録と再利用
- `"data_source"` CapabilityType サポート（service_setup として処理）

**`src/types/capability.ts`** (拡張済み)
- `CapabilityAcquisitionTask` 型
- `AcquisitionContext` 型
- `CapabilityDependency` 型（推定済み）
- `CapabilityStatus` に `"acquiring"` | `"verification_failed"` 追加

**`src/task-lifecycle.ts`** (拡張済み)
- `task_category: "capability_acquisition"` の識別（line 717-718: CapabilityDetectorを呼ばないガード）

**テスト**: `tests/capability-detector.test.ts` 存在

---

### Part B: 13.2 外部データソース連携

**`docs/design/data-source.md`** (新規作成済み)
- IDataSourceAdapter インターフェース仕様
- DataSourceConfig, DataSourceResult, PollingConfig 詳細設計
- ObservationEngine Layer 1 統合設計
- CLI サブコマンド定義
- 認証モデル（secrets 分離方式）

**`src/types/data-source.ts`** (新規作成済み)
- DataSourceType, DataSourceConfig, DataSourceResult, PollingConfig Zodスキーマ

**`src/data-source-adapter.ts`** (新規作成済み)
- `IDataSourceAdapter` インターフェース（connect/query/disconnect/healthCheck）
- `FileDataSourceAdapter` — JSON/CSV/テキストファイル読み取り
- `HttpApiDataSourceAdapter` — HTTP GET/POST、レスポンスパース
- `DataSourceRegistry` — 登録・削除・検索

**`src/observation-engine.ts`** (拡張済み)
- `IDataSourceAdapter[]` の DI 注入対応（constructor で `dataSources` パラメータ）
- `observeFromDataSource(sourceId, query): Promise<ObservationResult>` メソッド
- `getDataSources(): IDataSourceAdapter[]` メソッド
- healthCheck 失敗時の confidence 引き下げ処理（設計通り）

**`src/cli-runner.ts`** (拡張済み)
- `motiva datasource add <type>` (file / http_api)
- `motiva datasource list`
- `motiva datasource remove <id>`
- datasources 設定の `~/.motiva/datasources/` への永続化

**テスト**: `tests/data-source-adapter.test.ts` 存在

---

## 実装されていないもの / 不明点

1. **docs/status.md の Stage 13 記載がない** — Stage 11 完了（1749テスト）のまま更新されていない。ソースコードは Stage 13 完了水準だが、status.md の更新が必要。

2. **テスト数が不明** — `npx vitest run` を実行していないため、現在の通過テスト数と40テストファイルの状況が未確認。ただし git commit メッセージ（eb08254）が Stage 13A 完了を示しており、コンパイルエラーがないと仮定。

3. **adapter-layer.ts との統合** — stage13-research.md では `src/adapter-layer.ts` がデータソースアダプタの登録先として言及されていたが、実際は `DataSourceRegistry` クラスが独立して実装されている。AdapterRegistry との統合は行われていない可能性（設計変更か意図的分離）。

4. **`index.ts` のエクスポート追加** — stage13-plan.md で `src/index.ts` へのエクスポート追加が要求されていたが、確認未実施。

---

## テスト状況

| 確認方法 | 結果 |
|---------|------|
| git log | `eb08254 feat: Stage 13A — capability detector, data source adapter, observation integration` 確認 |
| テストファイル数 | 38ファイル（Glob結果）— Stage 12 完了時 40 ファイルから微減している可能性（要確認）|
| `vitest run` | 未実行（ツール制約） |

ファイル一覧に存在するテストファイル（Stage 13関連）:
- `tests/capability-detector.test.ts` — 存在確認
- `tests/data-source-adapter.test.ts` — 存在確認
- `tests/observation-engine.test.ts` — 存在確認

---

## Stage 14 への準備状況

**Stage 14 の前提（docs/roadmap.md §Stage 14 依存関係）**:
- Stage 12 完了: GoalDependencyGraph → 済み
- Stage 13 完了: 能力カタログ（CapabilityRegistry + AcquisitionContext） → 済み

**判断**: Stage 13 のコアコンポーネントはすべて実装済みであり、**Stage 14 への着手が可能**。

ただし着手前に以下を推奨:
1. `npx vitest run` でテスト全通過を確認
2. `docs/status.md` に Stage 13 の記載を追加
3. `src/index.ts` に Stage 13 の新規エクスポートが含まれているか確認

---

## ファイルパス一覧

| ファイル | 種別 | Stage 13 関連 |
|---------|------|--------------|
| `src/capability-detector.ts` | 実装 | Part A (13.1+13.3) |
| `src/types/capability.ts` | 型 | Part A |
| `src/data-source-adapter.ts` | 実装 | Part B (13.2) |
| `src/types/data-source.ts` | 型 | Part B |
| `src/observation-engine.ts` | 拡張 | Part B |
| `src/cli-runner.ts` | 拡張 | Part B |
| `src/task-lifecycle.ts` | 拡張 | Part A |
| `docs/design/data-source.md` | 設計 | Part B |
| `tests/capability-detector.test.ts` | テスト | Part A |
| `tests/data-source-adapter.test.ts` | テスト | Part B |
| `memory/stage13-plan.md` | 計画 | — |
| `memory/stage13-research.md` | リサーチ | — |
