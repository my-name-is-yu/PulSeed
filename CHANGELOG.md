# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.4] - 2026-04-02

### Added

- Added `pulseed chat` — unified agent entry point for interactive chat mode (Phase 1) (#419).
- Added `pulseed logs` command with `--follow` (real-time tail with rotation handling), `--lines N`, and `--level` filtering (ERROR > WARN > INFO > DEBUG) (#420).
- Added `pulseed install` / `pulseed uninstall` commands for macOS launchd integration — generates plist, registers with `launchctl`, enables auto-start on boot with KeepAlive (#420).
- Added `pulseed doctor` command with 10-point health check: Node.js version, PulSeed directory, provider config, API key, goals, log directory, build artifact, daemon status, notifications, disk usage (#420).
- Added `pulseed notify add/list/remove/test` commands for notification channel management (Slack webhook, generic webhook, email) with persistent config at `~/.pulseed/notification.json` (#420).
- Enriched `pulseed daemon status` with uptime display, relative cycle times, config section (interval, adaptive sleep, iterations, proactive mode, crash recovery counter), and box-drawing formatting (#420).
- Added grep-based content matching to observation context selection for more relevant file selection (#418).
- Added structured monitoring logs to core execution path for better daemon observability (#407).
- Added forced goal decomposition on first daemon iteration for immediate tree structure (#408).
- Enriched task prompts with parent goal context, issue content, and purpose statement (#409).

### Fixed

- Fixed TS2454 build error in `session-manager.ts` by adding default case to session context switch.
- Fixed `force` flag not propagating to `goalRefiner.refine()`, breaking tree decomposition (#417).
- Fixed missing `goal.title` in observation context and added tree decomposition debug logs (#414).
- Fixed dimension-aware file selection for observation — forced tree decomposition + smarter context (#413).
- Fixed `goalRefiner` not wired to `TreeLoopOrchestrator` + widened observation context limits (MAX_CONTEXT_CHARS=16000) (#412).
- Fixed dogfood reliability issues: goalRefiner wiring, workspace auto-detection, LLM progress logging (#411).
- Fixed leaf test prompt hardening and LLM call progress logs for dogfooding (#410).
- Fixed `--check-interval-ms` and `--iterations-per-cycle` CLI flags not wired for daemon start (#405).
- Fixed daemon `start`/`stop`/`cron` subcommands not registered in cli-runner.

## [0.1.3] - 2026-04-01

### Added

- Added Phase A-C proactive AI orchestration: CronScheduler, MCP client/server, HookManager, TriggerMapper, request batching, and agent profiles (#399, #400).
- Added trigger API (`POST /triggers`) with configurable trigger-to-goal mappings and 4 actions (observe, create_task, notify, wake).
- Added `GET /goals` and `GET /goals/:id` REST endpoints to EventServer.
- Added adaptive sleep with time-of-day, urgency, and activity factors for daemon interval tuning.
- Added proactive tick with LLM-powered idle-time actions (suggest_goal, investigate, preemptive_check).
- Added 115 E2E tests covering Phase A-C features.
- Added dogfooding scripts: `dogfood-hooks.sh`, `dogfood-daemon-proactive.sh`, `dogfood-cron.sh`, `dogfood-30min-integrated.sh`.

### Fixed

- Fixed daemon blocking cron/proactive/sleep during long-running `CoreLoop.run()` — changed to interleaved 1-iteration-per-goal-per-cycle execution with configurable `iterations_per_cycle` (#401).
- Fixed cron scheduler `isDue()` bidirectional jitter pushing `adjustedPrev` into the future, causing missed and phantom firings — changed to one-sided negative jitter.
- Fixed `EventServer.isWatching()` and `getEventsDir()` incorrectly marked as `private`.
- Fixed CI build failure: added missing `@modelcontextprotocol/sdk` and `cron-parser` to package.json dependencies.
- Fixed `test_count` DataSource to search all `.ts/.js` files from workspace root (#389, #390, #391).
- Fixed shell DataSource to use `workspace_path` as cwd (#387).
- Fixed jump suppression for present/match binary dimensions (#386).
- Fixed match type gap calculation for numeric observation values (#385).
- Fixed dynamic workspace context resolution for LLM observation (#384).
- Fixed LLM observation to read workspace files when git diff is empty (#383).
- Fixed constraints inheritance in decomposed subgoals and raw goal creation paths.
- Fixed workspace path wiring through CLI, observation engine, and datasource registration.
- Fixed gap=1.00 stuck after successful task execution (#375).
- Fixed knowledge gap detection limited to first iteration only (#375).
- Fixed fallback to exact dimension name when normalization fails (#374).
- Fixed untracked file detection in post-execution change check (#373).
- Fixed Codex adapter to produce file-modifying tasks (#371).

### Added (Infrastructure)

- Added `GET /health` endpoint to EventServer.
- Added `daemon status` command and `--detach` flag (#369).
- Added `GoalLoop` guard for bounded goal execution (#368).
- Added OpenAI OAuth token support from `~/.codex/auth.json` (#370).
- Added gradual gap decrease and continuous value gap dogfooding scripts.

## [0.1.2] - 2026-03-30

### Added

- Added `ProgressPredictor` for early stall detection via linear regression on gap history, with new stall types `predicted_plateau` and `predicted_regression` (#343).
- Added difficulty-based curriculum ordering for subgoal selection — medium-complexity subgoals (0.3–0.7 band) are prioritized, with a near-complete guard to prevent task starvation (#344).
- Added PulSeed ASCII banner (Sprout Green) to setup wizard (#342).
- Added per-iteration log line in CoreLoop for timeout diagnosis (#349).

### Fixed

- Fixed `improve` / `suggest` commands hanging indefinitely on LLM timeout — added `SuggestTimeoutError` with configurable 30s default and `try/finally` cleanup (#351).
- Fixed `cleanup` command not removing orphaned datasources for deleted goals (#350).
- Fixed datasource dedup key to include `scope_goal_id`, preventing incorrect merging of scoped datasources for different goals (#350).
- Fixed Anthropic adapter ignoring `config.model` setting (#341).

## [0.1.1] - 2026-03-29

### Fixed

- Added `maxRetries` to `rmSync` for Node 22 flaky test reliability (#340).
- Parallelized dimension LLM calls in negotiate/renegotiate for faster goal setup (#338).
- Fixed `looksLikeSoftwareGoal` bypassing normalizer `isSoftwareGoal` check (#337).
- Improved OSS documentation readability — reorganized, translated, and added missing docs (#339).

## [0.1.0] - 2026-03-28

### Demo Release

First public demo release of PulSeed — an AI agent orchestrator that gives existing agents the drive to persist. PulSeed sits above agents, selecting goals, spawning sessions, observing results, and judging completion. PulSeed delegates all execution; it does not act directly.

Renamed from SeedPulse to PulSeed. Published to npm as [`pulseed`](https://www.npmjs.com/package/pulseed).

### Added

#### Core Loop and Goal Model

- Added the core orchestration loop: observe → gap → score → task → execute → verify, running autonomously until satisficing completion.
- Added the 4-element goal model: Goal (with measurable thresholds), Current State (observation + confidence), Gap, and Constraints.
- Added goal negotiation with feasibility evaluation, dimension decomposition, and counter-proposal handling.
- Added recursive goal tree for sub-goal management with concreteness scoring, decomposition quality metrics, and maxDepth enforcement.
- Added satisficing completion judgment: execution stops when the goal is "good enough" rather than continuing toward perfection.
- Added convergence detection in `SatisficingJudge` to prevent infinite iteration on plateau states.

#### Observation and Verification

- Added 3-layer observation pipeline: mechanical checks (shell/file) → LLM-powered review → self-report fallback.
- Added 3-layer verification pipeline: mechanical checks → LLM reviewer → self-report fallback.
- Added `ShellDataSourceAdapter` and `FileExistenceDataSourceAdapter` for evidence-based observation.
- Added cross-validation across observation layers to improve confidence scoring.
- Added hypothesis verification mechanism for strategy assessment.

#### Drive, Scoring, and Trust

- Added drive scoring with three components: dissatisfaction (gap magnitude), deadline urgency, and opportunity cost.
- Added asymmetric trust system: success adds +3, failure subtracts -10, bounded to [-100, +100].
- Added stall detection with graduated responses (warn → escalate → abort strategy).
- Added monotonic progress controls that prevent score backsliding during repeated evaluations.

#### Safety and Ethics

- Added 2-stage ethics gate for goal screening before execution begins.
- Added path traversal protection in `StateManager.readRaw` / `writeRaw`.
- Added shell-binary denylist enforcement in `ShellDataSourceAdapter`.
- Added sensitive-directory denylist in workspace context to prevent credential leakage.

#### Strategy and Portfolio

- Added strategy management with portfolio optimization across concurrent goals.
- Added momentum allocation with velocity and trend detection, topological dependency scheduling, and stall-triggered rebalancing.
- Added embedding-based strategy template recommendation combining tag scoring and vector similarity.
- Added cross-goal pattern sharing with persistent storage in `KnowledgeTransfer`.

#### Adapters

- Added `claude_code_cli` adapter for Claude Code CLI agent delegation.
- Added `openai_codex_cli` adapter for OpenAI Codex CLI agent delegation.
- Added `browser_use_cli` adapter for browser-automation task delegation.
- Added `claude_api` adapter for direct Anthropic API calls.
- Added `github_issue` adapter for GitHub REST API integration.
- Added `a2a` adapter for Agent-to-Agent protocol interoperability.

#### CLI

- Added `goal add`, `goal list`, and `goal archive` commands.
- Added `run` command to start the autonomous core loop.
- Added `status` and `report` commands for runtime inspection.
- Added `cleanup` command to remove stale state files.
- Added `datasource add`, `datasource list`, and `datasource remove` commands.
- Added `improve` command for LLM-powered goal suggestion.
- Added `--yes` flag (position-independent) to skip confirmation prompts in all flows.
- Added `ensure-api-key` CLI helper for interactive provider key setup.

#### Infrastructure

- Added plugin architecture for external integrations, loaded dynamically from `~/.pulseed/plugins/`.
- Added TUI dashboard built with Ink/React, including approval UI and chat interface.
- Added Web UI built with Next.js, covering Goals, Sessions, Knowledge, and Settings pages.
- Added daemon mode with PID management, graceful shutdown, and interrupted goal state restoration.
- Added event server with HTTP and file-queue (`~/.pulseed/events/`) ingestion modes.
- Added notification dispatcher with SMTP email delivery via `nodemailer`.
- Added date-based log rotation with async stream management.

#### Knowledge and Memory

- Added semantic knowledge base with `IEmbeddingClient` abstraction (OpenAI / Ollama / Mock backends).
- Added `VectorIndex` with hand-implemented cosine similarity search (no external dependencies).
- Added knowledge graph and goal dependency graph with cycle detection.
- Added learning pipeline with 4-step structural feedback recording and parameter auto-tuning suggestions.
- Added knowledge transfer with cross-goal pattern extraction and sharing.
- Added hierarchical memory with three-tier storage (core / recall / archival), LLM-driven page-in/page-out, and dynamic context budgeting.

#### Character and Curiosity

- Added curiosity engine for autonomous exploration of underobserved goal dimensions.
- Added character configuration manager for personality and ethics profile customization.
- Added Reflexion-style reflection with task-lifecycle split for iterative self-improvement.

#### Developer Experience

- Added custom Error class hierarchy for error classification and stack filtering.
- Added 4-point guardrail callbacks (before/after execution, before/after LLM call) for observability.
- Added LLM fault-tolerance guards covering enum sanitization, direction-check on `dimension_updates`, and Zod validation across 6 modules.
- Added npm publishing metadata including `exports`, license, author fields, and `.npmignore`.
- Added `SECURITY.md`, `CONTRIBUTING.md`, competitor comparison table, and OSS-quality README badges.
- Test suite: 4315 tests across 196 test files.
