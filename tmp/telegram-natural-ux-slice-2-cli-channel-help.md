# Telegram Natural UX Slice 2 - CLI Channel Help

## Dogfood Finding

While preparing for live Telegram dogfood on the Mac mini, parent channel help commands returned unknown-subcommand errors:

- `pulseed telegram --help`: `Unknown telegram subcommand: "--help"` followed by `Available: telegram setup`
- `pulseed gateway --help`: `Unknown gateway subcommand: "--help"` followed by `Available: gateway setup`

## Expected Behavior

Parent channel commands should provide human-readable discovery help without initializing local runtime state or launching setup prompts.

## Owner Files

- `src/interface/cli/cli-runner.ts`
- `src/interface/cli/cli-command-registry.ts`
- `src/interface/cli/commands/telegram.ts`
- `src/interface/cli/commands/gateway.ts`
- `src/interface/cli/__tests__/cli-runner.test.ts`
- `src/interface/cli/__tests__/telegram-setup.test.ts`
- `src/interface/cli/__tests__/gateway-setup.test.ts`

## Test Plan

- Targeted CLI tests for parent and setup help.
- Full typecheck, boundary lint, build, and diff check.

