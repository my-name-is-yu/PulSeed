# Centralize Companion Cognition Kernel Status

## Session Rules

- Session updates: Japanese.
- GitHub-facing branch, commit, PR, and review text: English.
- Base: `origin/main` after PR #2000.
- PR state: draft until local verification, sub-agent review, and GitHub Codex review are clean.
- Merge: out of scope.

## Preflight

- Open PRs inspected: only Dependabot #1989 was open at kickoff.
- Recent merged related PRs inspected: #2000, #1998, #1997, #1996, #1993.
- Node version verified: `v24.15.0`.

## Progress

- [x] Read goal document.
- [x] Sync/fetch `origin/main`.
- [x] Inspect relevant recent PR state.
- [x] Create implementation branch.
- [x] Create draft PR: https://github.com/my-name-is-yu/PulSeed/pull/2002
- [x] Current-state inventory: `tmp/companion-cognition-kernel-inventory.md`
- [x] Kernel implementation.
- [x] Production caller migrations.
- [x] Guardrail.
- [x] Tests and docs.
- [x] Local verification.
- [x] Sub-agent review round 1 findings fixed: gateway model prompt policy projection, memory-truth withheld evidence, and broader boundary guard.
- [x] Sub-agent review: follow-up review reported `No material findings.`
- [x] GitHub Codex review round 1 findings fixed: deferred commitment attention persistence until cognition persistence succeeds, and replacement memory refs no longer project as stale targets.
- [ ] GitHub Codex review.

## Local Verification

- `npm run check:database-first-legacy-stores`
- `npm run check:docs`
- `npm run typecheck`
- `npm run lint:boundaries` (0 errors; existing warnings remain)
- `npm run test:contracts`
- `npm run test:replay`
- `npm run test:product-gauntlet`
- `npm run test:smoke`
- `npm run test:integration`
- `npm run test:changed` (passed with temporary `PULSEED_HOME` after clearing generated Control DB state under fixed test temp directories)
- `npm run build`
- `npm run check:public-contracts`
- `git diff --check`
