# Proactivity Calibration Closed Loop Status - 2026-05-16

## Goal

Build a practical pre-dogfood proactivity calibration slice before running a
one-day dogfood pass. Scope is broader than the minimum report-only closure:

- tune default proactive behavior around the existing `helpful_nudge` profile;
- close the feedback-to-threshold loop without creating execution authority;
- add resident activation proposal/binding support so proactive dogfood can run
  intentionally;
- expose relationship-review items from `wrong_read` style feedback without
  mutating relationship memory automatically.

## Boundaries

- Stay on existing owners: `runtime/attention`, `runtime/peer-initiative`,
  `runtime/store`, `runtime/control`, `runtime/cognition`, and CLI diagnostics.
- Do not start a real daemon or one-day dogfood run during implementation.
- Do not add keyword/regex/includes semantic routing.
- Do not auto-write relationship profile or auto-escalate notify/prepare/execute
  from positive feedback.
- Do not create a parallel proactivity or relationship subsystem.

## Work Items

| Item | Target | Status | Verification |
| --- | --- | --- | --- |
| 2 | Feedback closes into proactive policy state/cooldown/budget evidence | implemented | `proactive-calibration --apply-policy`, Telegram callback policy application, resident caller-path policy read |
| 3 | Accepted feedback cannot escalate delivery authority | guarded | policy reducer/store application keeps `runtime_authority=false` and accepted does not raise max delivery |
| 4 | Resident activation proposal/binding for intentional dogfood | implemented | `runtime resident-activation propose/accept/status`, active binding projects budget/max delivery |
| 5 | `wrong_read` relationship review item/projection | implemented | calibration report includes non-mutating relationship review items without candidate/raw refs |

## Notes

- Current `proactive-calibration` is read-only and reports no local dogfood
  evidence unless explicitly run with `--apply-policy`.
- Active feedback application is explicit in CLI diagnostics, automatic only on
  the Telegram feedback callback path after a user presses a structured feedback
  button.
- Resident activation is an explicit proposal/binding; it can raise delivery
  only by operator command and remains capped to digest/suggest/notify with
  `runtime_authority=false`.
- Default posture is intentionally a bit meddlesome for the first dogfood pass:
  `helpful_nudge` starts at `notify`, peer initiative candidates default to
  `notify`, and resident activation proposes `notify` with a 4/day Telegram
  notification budget. Feedback still narrows future delivery to digest/hold.
- PR #1974 already landed the `helpful_nudge` profile and threshold contracts.
- PR #1993 already landed Telegram-only peer initiative capability diagnostics
  and calibration report aggregation.

## Verification Log

- `node -v` -> `v24.15.0`
- `npm run typecheck` -> passed
- `npm run test:unit -- --run ...` -> passed for unit-covered calibration/CLI files
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/outbound-conversation.test.ts src/runtime/daemon/__tests__/resident-peer-initiative.test.ts` -> passed
- `npm run lint:boundaries -- --quiet` -> passed
- `git diff --check` -> passed

## Review Follow-up

- GitHub Codex P1 review on PR #1995 identified that active resident activation
  binding reapplication could reset budget debits and that expired activation
  budgets could remain in persisted policy state.
- Fixed by preserving same-budget debit counts across binding reapplication and
  clearing inactive resident activation budgets from the effective policy state.
  Added store-level and resident caller-path regression coverage.
- A second Codex P1 review identified that clearing an inactive activation
  budget also needs to restore temporary activation delivery caps. Fixed by
  restoring `helpful_nudge` default delivery only when no cooldown is active,
  while preserving feedback-driven downgrades.
