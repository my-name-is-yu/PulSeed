# PulSeed Codex Rules

## Implementation Philosophy

Do not optimize for the smallest possible diff. Optimize for the best final architecture, correctness, maintainability, and testability.

Small diffs are preferred only when they do not compromise the design. If the existing structure is misaligned with the intended architecture, refactor it instead of adding compatibility layers or patching around it.

Avoid preserving bad abstractions just to reduce the patch size.

When a large change is appropriate:
- First explain the target design and why a broader change is justified.
- Separate mechanical refactors from behavior changes when possible.
- Preserve existing behavior unless the task explicitly changes it.
- Add or update tests around the affected behavior.
- Run lint, typecheck, and relevant tests.
- Summarize the important architectural changes after implementation.

## Semantic Decision Design

- For freeform user intent, natural-language chat, routing, target/session/run selection, status classification, safety/approval decisions, notification routing, failure recovery, RunSpec derivation, evidence Q&A, and dashboard/operator labels, do not ship keyword filters, regex lists, string `includes`, title matching, or language-specific phrase tables as the primary decision mechanism.
- Prefer durable contracts: typed APIs, schemas, explicit state machines, structured model/LLM classification with confidence and unknown/clarification behavior, domain parsers, and production caller paths that preserve the semantic context.
- Before adding new semantic decision logic, inspect the existing typed API, schema, store, router, recognizer, and caller path. Extend those contracts where possible instead of adding side-channel text matching.
- Deterministic parsing is acceptable for exact protocol surfaces: slash/CLI command grammar, IDs, file paths, URLs, enum values, schema validation, feature flags, and wire/protocol tokens. Do not treat this exception as permission to classify freeform human intent with brittle text rules.
- When replacing or touching an existing keyword/regex semantic shortcut, do not expand the shortcut with more phrases. Either replace it with a durable mechanism in scope, or record the blocker and create a focused follow-up issue.
- Tests for semantic behavior must include cases that would fail a brittle keyword implementation: paraphrases, multilingual phrasing where relevant, ambiguous input, stale/previous-target rejection, and at least one production caller-path test that lets the real routing/interpretation layer choose the path.
- Fresh review agents for SeedPulse semantic changes should explicitly look for keyword/regex/includes/title-matching bypasses, missing approval gates, stale target reuse, and tests that only prove precomputed lower-level inputs.

## Test Design

- Regression tests must exercise the same entrypoint shape and key input flags used in production. A fixture name or reused fake object is not enough.
- When a bug crosses a boundary between coordinator and runner, keep the narrow mock test, but add at least one contract test that runs the real downstream component that interprets the payload.
- For stateful chat, runtime, gateway, and TUI paths, cover at least two turns when the behavior depends on session state, route state, reply targets, persisted state paths, or resume semantics.
- Tests that claim "resume", "reuse", "latest", "current", "active", or "selected" must assert both the positive path and the stale/previous-turn value that must not be used.
- If a fix changes the meaning of an input field, add a test that would fail on the old implementation because that exact field is present.
- A test suite named or treated as integration must cross at least one real production boundary. If all downstream collaborators are `vi.fn()` fixtures, label it as mock/delegation coverage and add a separate contract test for the real seam.
- Route, gateway, runtime-control, and CoreLoop tests must include at least one caller-path test that lets production routing/interpretation choose the path; do not only pass precomputed route or policy objects into the lower-level method.
- If a test only passes in isolation but times out or flakes in the full lane, fix the lane classification, timeout, or shared-state isolation before trusting the result.
- Changes under `plugins/*` or `examples/plugins/*` must run subpackage verification in addition to root Vitest related tests when package manifests, configs, or package-local sources change.
