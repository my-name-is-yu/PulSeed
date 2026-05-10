# Seedy Gateway Codex-Like UX Implementation

Date: 2026-05-10

## Issue Order

1. #1850 Require real tool evidence for runtime-aware gateway status answers
2. #1849 Improve long-wait Seedy status from generic activity labels
3. #1851 Reduce first meaningful text latency for gateway turns
4. #1852 Stream assistant output incrementally across gateway display surfaces
5. #1855 Refine native typing timing to signal imminent text output

## Slice #1850

Issue: https://github.com/my-name-is-yu/PulSeed/issues/1850

Base HEAD: `8266cd128659fabc8f0159807e50ee65fff6d5a6`

Branch: `yu/issue-1850-runtime-evidence-gated-status`

PR: pending

### Design Decisions

- Track same-turn runtime/tool evidence in `ChatRunnerEventBridge` from typed chat events such as `tool_start`, `tool_update`, `tool_end`, `operation_progress`, and tool/approval `agent_timeline` items.
- Add a structured final-answer gate for agent-loop and tool-loop routes. When a final answer makes a current runtime/local status claim without same-turn evidence, replace it before persistence and gateway projection with bounded uncertainty.
- Add a model-visible runtime evidence rule to the turn context so the agent loop is instructed not to claim daemon, gateway, command, process, watchdog, runtime, session, or local machine status without trusted evidence.
- Keep the semantic decision in a structured LLM boundary checker rather than keyword, regex, `includes`, or title matching.

### Commands Run

- `git fetch origin main --prune`
- `git switch main`
- `git merge --ff-only origin/main`
- `git worktree add -b yu/issue-1850-runtime-evidence-gated-status /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1850-runtime-evidence-gated-status 8266cd128659fabc8f0159807e50ee65fff6d5a6`
- `npm ci`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts --testNamePattern "runtime status"`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-runner.test.ts --testNamePattern "persists assistant message only after streaming completes"`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npm run typecheck`
- `git diff --check`
- `npm run lint:boundaries -- --quiet`

### Verification

- Focused runtime status evidence tests: passed.
- Full `cross-platform-session.test.ts`: passed.
- `cross-platform-session.test.ts` + `chat-runner.test.ts`: passed.
- Typecheck: passed.
- Diff whitespace check: passed.
- Boundary lint with `--quiet`: passed.
- Independent review found a material issue in the first draft: unrelated tool/progress evidence could bypass the final-answer gate. Fixed by always running the structured checker when available and passing same-turn evidence refs into that checker. Added a regression test for unrelated failed tool evidence.
- Independent re-review found a tool-loop pre-final leak risk. Fixed gateway tool-loop LLM calls so raw model text is buffered until the gateway evidence gate runs, then only the gated output is projected.

### Deferred

- Live Telegram dogfood was not run for this slice before PR creation.
- Later slices will address early commentary, streaming, long-wait wording, and native typing timing.
