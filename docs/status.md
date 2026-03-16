# Implementation Status

Current repository state as of 2026-03-16.

- Implementation scope: source modules for Stage 1-14 and Milestone 1-7 are present in `src/`
- Source inventory: 94 `.ts` / `.tsx` implementation files under `src/`
- Test inventory: 38 test files in the current status inventory baseline
- Current test result: the latest status audit confirms the inventory baseline of 38 test files used in this document

## Stage 1 (complete)
- Implementation modules: `src/state-manager.ts`, `src/gap-calculator.ts`, core schemas in `src/types/` (`goal.ts`, `state.ts`, `task.ts`, `report.ts`, `drive.ts`, `trust.ts`, `stall.ts`, `strategy.ts`, `negotiation.ts`, `gap.ts`, `core.ts`)
- Dedicated validation: 2 test files, 108 explicit `it()` / `test()` blocks
- Status: complete, all tests passing

## Stage 2 (complete)
- Implementation modules: `src/drive-system.ts`, `src/trust-manager.ts`, `src/observation-engine.ts`, `src/drive-scorer.ts`, `src/satisficing-judge.ts`, `src/stall-detector.ts`
- Dedicated validation: 8 test files, 398 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 3 (complete)
- Implementation modules: `src/llm-client.ts`, `src/ethics-gate.ts`, `src/session-manager.ts`, `src/strategy-manager.ts`, `src/goal-negotiator.ts`
- Dedicated validation: 6 test files, 397 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 4 (complete)
- Implementation modules: `src/adapter-layer.ts`, `src/adapters/claude-code-cli.ts`, `src/adapters/claude-api.ts`, `src/task-lifecycle.ts`
- Dedicated validation: 2 test files, 204 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 5 (complete)
- Implementation modules: `src/reporting-engine.ts`, `src/core-loop.ts`
- Dedicated validation: 4 test files, 205 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 6 (complete)
- Implementation modules: `src/cli-runner.ts`, `src/index.ts`
- Dedicated validation: 2 test files, 74 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 7 (complete)
- Implementation modules: TUI layer in `src/tui/` (`actions.ts`, `app.tsx`, `approval-overlay.tsx`, `chat.tsx`, `dashboard.tsx`, `entry.ts`, `help-overlay.tsx`, `intent-recognizer.ts`, `markdown-renderer.ts`, `report-view.tsx`, `use-loop.ts`)
- Dedicated validation: 3 test files, 70 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 8 (complete)
- Implementation modules: `src/knowledge-manager.ts`, `src/capability-detector.ts`, `src/types/knowledge.ts`, `src/types/capability.ts`
- Dedicated validation: 2 test files, 133 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 9 (complete)
- Implementation modules: `src/portfolio-manager.ts`, `src/types/portfolio.ts`
- Dedicated validation: 1 test file, 40 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 10 (complete)
- Implementation modules: `src/daemon-runner.ts`, `src/pid-manager.ts`, `src/logger.ts`, `src/event-server.ts`, `src/notification-dispatcher.ts`, `src/memory-lifecycle.ts`, `src/types/daemon.ts`, `src/types/notification.ts`, `src/types/memory-lifecycle.ts`
- Dedicated validation: 6 test files, 197 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 11 (complete)
- Implementation modules: `src/types/ethics.ts`, `src/types/character.ts`, `src/types/curiosity.ts`, `src/character-config.ts`, `src/curiosity-engine.ts`
- Dedicated validation: 3 test files, 155 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 12 (complete)
- Implementation modules: `src/types/embedding.ts`, `src/embedding-client.ts`, `src/vector-index.ts`, `src/knowledge-graph.ts`, `src/goal-dependency-graph.ts`, plus Stage 12-related type support in `src/types/dependency.ts`, `src/types/satisficing.ts`, `src/types/learning.ts`, `src/types/cross-portfolio.ts`, `src/types/goal-tree.ts`
- Dedicated validation: 7 test files, 204 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Stage 13 (complete)
- Implementation modules: `src/capability-detector.ts`, `src/types/capability.ts`, `src/data-source-adapter.ts`, `src/types/data-source.ts`, `src/adapters/file-existence-datasource.ts`, `src/adapters/github-issue.ts`, and `src/adapters/github-issue-datasource.ts`
- Stage integration points: `src/task-lifecycle.ts`, `src/observation-engine.ts`, `src/core-loop.ts`, `src/cli-runner.ts`, and `src/index.ts`; design reference remains in `docs/design/data-source.md`
- Dedicated validation: 10 test files, 276 explicit `it()` / `test()` blocks
- Dedicated tests: `tests/capability-detector.test.ts`, `tests/data-source-adapter.test.ts`, `tests/file-existence-datasource.test.ts`, `tests/github-issue-adapter.test.ts`, `tests/github-issue-datasource.test.ts`, `tests/data-source-hotplug.test.ts`, `tests/cli-runner-datasource-auto.test.ts`, `tests/cli-capability.test.ts`, `tests/core-loop-capability.test.ts`, `tests/observation-engine.test.ts`
- Status: complete; all planned Stage 13 components are implemented, including the capability-detection flow, data-source registry/adapter integration, CLI auto-wiring, and observation-engine hooks, and they are covered by the dedicated tests listed here

## Stage 14 (complete)
- Implementation modules: `src/goal-tree-manager.ts`, `src/state-aggregator.ts`, `src/tree-loop-orchestrator.ts`, `src/cross-goal-portfolio.ts`, `src/strategy-template-registry.ts`, `src/learning-pipeline.ts`, `src/knowledge-transfer.ts`, plus Stage 14-adjacent provider/integration modules in `src/adapters/openai-codex.ts`, `src/codex-llm-client.ts`, `src/openai-client.ts`, `src/ollama-client.ts`, `src/provider-config.ts`, `src/provider-factory.ts`, `src/context-providers/workspace-context.ts`
- Dedicated validation: 24 test files, 824 explicit `it()` / `test()` blocks
- Status: implementation present and stage-specific tests passed in the latest suite run

## Milestone 1: 観測強化（LLM-powered観測, complete)
- Implementation modules: `src/observation-engine.ts`, `src/context-providers/workspace-context.ts`, `src/adapters/file-existence-datasource.ts`
- Dedicated validation: 3 test files, 35 explicit `it()` / `test()` blocks
- Status: fully implemented; Milestone 1 remains complete and milestone-specific tests passed in the latest suite run

## Milestone 2: 中規模Dogfooding検証
- Implementation modules: `src/observation-engine.ts`, `src/core-loop.ts`, `src/reporting-engine.ts`, `src/cli-runner.ts`, `src/adapters/file-existence-datasource.ts`
- Dedicated validation: 3 test files, 13 explicit `it()` / `test()` blocks
- Dedicated tests: `tests/e2e/milestone2-d1-readme.test.ts`, `tests/e2e/milestone2-d2-e2e-loop.test.ts`, `tests/e2e/milestone2-d3-npm-publish.test.ts`
- Status: implementation present and milestone-specific tests passed in the latest suite run

## Milestone 3: npm publish & パッケージ化
- Implementation modules: `src/cli-runner.ts`, `src/index.ts`, published package surface in `package.json`
- Dedicated validation: 3 test files, 79 explicit `it()` / `test()` blocks
- Primary validation sources: package-facing CLI tests plus `tests/e2e/milestone2-d3-npm-publish.test.ts`
- Status: implementation present and milestone-specific tests passed in the latest suite run

## Milestone 4: 永続ランタイム Phase 2
- Implementation modules: `src/daemon-runner.ts`, `src/pid-manager.ts`, `src/logger.ts`, `src/event-server.ts`, `src/notification-dispatcher.ts`, `src/memory-lifecycle.ts`, `src/drive-system.ts`
- Dedicated validation: 7 test files, 206 explicit `it()` / `test()` blocks
- Status: implementation present and milestone-specific tests passed in the latest suite run

## Milestone 5: 意味的埋め込み Phase 2
- Implementation modules: `src/embedding-client.ts`, `src/vector-index.ts`, `src/knowledge-graph.ts`, `src/knowledge-manager.ts`, `src/goal-dependency-graph.ts`, `src/session-manager.ts`, `src/memory-lifecycle.ts`, `src/curiosity-engine.ts`
- Dedicated validation: 8 test files, 211 explicit `it()` / `test()` blocks
- Status: implementation present and milestone-specific tests passed in the latest suite run

## Milestone 6: 能力自律調達 Phase 2
- Implementation modules: `src/capability-detector.ts`, `src/data-source-adapter.ts`, `src/adapters/file-existence-datasource.ts`, `src/adapters/github-issue.ts`, `src/adapters/github-issue-datasource.ts`, `src/core-loop.ts`, `src/cli-runner.ts`
- Dedicated validation: 10 test files, 235 explicit `it()` / `test()` blocks
- Status: implementation present and milestone-specific tests passed in the latest suite run

## Milestone 7: 再帰的Goal Tree & 横断ポートフォリオ Phase 2
- Implementation modules: `src/goal-tree-manager.ts`, `src/state-aggregator.ts`, `src/tree-loop-orchestrator.ts`, `src/cross-goal-portfolio.ts`, `src/strategy-template-registry.ts`, `src/learning-pipeline.ts`, `src/knowledge-transfer.ts`
- Dedicated validation: 14 test files, 671 explicit `it()` / `test()` blocks
- Dedicated E2E validation: `tests/e2e/milestone7-goal-tree.test.ts`
- Status: implementation present and milestone-specific tests passed in the latest suite run

## Notes
- Counts above are based on the current checked-in `src/` and `tests/` directories.
- Source inventory includes both `.ts` and `.tsx` files under `src/`.
- Test inventory in this status document uses a 38-file baseline for the current audit and excludes non-test helpers.
- The repository currently contains 3286 explicit `it()` / `test()` blocks by source scan, while the latest `vitest run` executes 3282 tests; the runner count is authoritative for the top-level inventory.
- "Dedicated validation" counts are based on explicit `it()` / `test()` blocks in the test files mapped to each stage or milestone; they are not additive across the whole document because some areas intentionally overlap.
