# Telegram Natural UX Slice 1: CLI Help Survives Control DB Mismatch

Status: implementation validated after third review fix; final review pending

## Dogfood Finding

During the Mac mini latest-main refresh, `pulseed --help` failed before printing usage because the existing Control DB had applied a pre-merge version of migration 7. The CLI raised:

```text
Control DB migration checksum mismatch for version 7.
```

## Expected Behavior

Basic diagnostic-safe commands such as `pulseed --help`, `pulseed -h`, and `pulseed help` should print usage without initializing mutable runtime state. A broken or incompatible Control DB should not prevent users from discovering recovery commands.

## Owner Files

- `src/interface/cli/cli-runner.ts`
- `src/interface/cli/__tests__/cli-runner.test.ts`

## Test Plan

- Add a regression test proving help exits before `StateManager.init()`.
- Run targeted CLI runner tests.
- Run required validation:
  - `npm run typecheck`
  - `npm run lint:boundaries`
  - `npm run build`
  - `git diff --check`

## Implementation

- `CLIRunner.run()` now returns top-level `--help`, `-h`, and `help` before `StateManager.init()`.
- Global flags such as `--yes`, `-y`, and `--dev` do not force help through state initialization.
- `pulseed setup --help` preserves setup-specific help before state initialization.
- `pulseed telegram setup --help` and `pulseed gateway setup --help` preserve setup-specific help before state initialization.
- Telegram and gateway setup commands now have explicit help paths and do not prompt or verify credentials when help is requested.
- A no-argument launch still tries the default TUI path, but if local runtime state cannot initialize, it prints a recovery-visible error plus normal usage instead of failing before any discovery surface is shown.
- Default-equivalent TUI launches with only global flags or explicit `pulseed tui` get the same recovery-visible fallback.
- Existing version behavior remains unchanged.
- Subcommand-specific argument handling is not broadened; only top-level help bypasses state initialization.

## Validation

- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-runner.test.ts src/interface/cli/__tests__/telegram-setup.test.ts src/interface/cli/__tests__/gateway-setup.test.ts`: 127 passed.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings only, 0 errors.
- `npm run build`: passed.
- `git diff --check`: passed.
- Manual mismatch smoke:
  - Created a temporary `PULSEED_HOME` with a deliberately tampered `control_schema_migrations` row.
  - `PULSEED_HOME="$TMP_HOME" node dist/interface/cli/cli-runner.js --yes --help` printed usage and exited 0.
  - `PULSEED_HOME="$TMP_HOME" node dist/interface/cli/cli-runner.js setup --help` printed setup-specific usage and exited 0.
  - `PULSEED_HOME="$TMP_HOME" node dist/interface/cli/cli-runner.js telegram setup --help` printed Telegram setup-specific usage and exited 0.
  - `PULSEED_HOME="$TMP_HOME" node dist/interface/cli/cli-runner.js gateway setup --help` printed gateway setup-specific usage and exited 0.
  - `PULSEED_HOME="$TMP_HOME" node dist/interface/cli/cli-runner.js --dev` printed a runtime-state initialization error plus usage and exited 1.
  - `PULSEED_HOME="$TMP_HOME" node dist/interface/cli/cli-runner.js tui` printed a runtime-state initialization error plus usage and exited 1.

## Review

- First review found two material blockers:
  - global-flag help still initialized state;
  - no-argument launch had no recovery/discovery fallback when state initialization failed.
- Both blockers were fixed and covered by tests/manual smoke.
- Second review found two material blockers:
  - `pulseed tui` / global-flag default launch still lacked recovery guidance on state init failure;
  - broad pre-init help matching hijacked `pulseed setup --help`.
- Both blockers were fixed and covered by tests/manual smoke.
- Third review found one material blocker:
  - nested setup help (`telegram setup --help`, `gateway setup --help`) still depended on Control DB initialization.
- The blocker was fixed and covered by tests/manual smoke.
