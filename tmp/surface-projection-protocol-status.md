# Surface Projection Protocol Status

Branch: `yu/surface-projection-protocol`
Base: `origin/main` at `09b374f9`
Started: 2026-05-17

## Goal

Unify normal and operator-facing PulSeed surfaces behind one typed Surface
Projection Protocol that can be consumed by chat/gateway, CLI/runtime status,
TUI-adjacent status, Telegram/peer delivery, approvals, memory/profile
summaries, runtime diagnostics, and future GUI without direct reads of runtime,
cognition, authority, or memory internals from normal consumers.

## Completion Gates

- Draft PR opened before broad implementation.
- Protocol contracts exported from one shared module.
- At least five production surfaces consume the shared boundary.
- Normal/operator separation, redaction, action binding freshness, and replay
  determinism are covered by tests.
- Direct-bypass guard is wired into `check:public-contracts`.
- Required local verification commands are run.
- Local review agent reports no material findings.
- GitHub Codex review reports no actionable findings/LGTM before ready/complete.

## Progress

- [x] Confirmed Node `v24.15.0`.
- [x] Fast-forwarded work branch to latest `origin/main` before edits.
- [ ] Draft PR opened.
- [ ] Protocol contracts implemented.
- [ ] Production surfaces migrated.
- [ ] Tests/docs/guard implemented.
- [ ] Local verification clean.
- [ ] Local review clean.
- [ ] GitHub Codex review clean.
