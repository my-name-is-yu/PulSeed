# Direct File State Slice 5: Strategy Template Registry

## Scope

- Target: `src/orchestrator/strategy/strategy-template-registry.ts`
- Runtime callers: strategy enrichment through `loadStrategyTemplates`, dream activation, and dream consolidation.
- Legacy surface: `strategy-templates.json`.

## Evidence

The registry persisted successful strategy templates to `strategy-templates.json`, and dream runtime callers read the same file as normal strategy history input. That makes the file authoritative runtime learning/reuse state, not a debug artifact or user-authored content.

## Change Strategy

- Add `strategy_templates` to the control DB schema.
- Add `StrategyTemplateStateStore` as the typed store boundary.
- Make `StrategyTemplateRegistry.save/load`, dream activation, and dream consolidation use the typed store.
- Keep `strategy-templates.json` only as an explicit `doctor --repair` import input.
- Tighten the direct-file guard so runtime reintroduction of `strategy-templates.json` fails outside the migration module.

## Validation

- `nvm use 24.15.0 && npm ci`
- `npx vitest run --config vitest.unit.config.ts src/orchestrator/strategy/__tests__/strategy-template-registry.test.ts src/orchestrator/strategy/__tests__/strategy-template-state-store.test.ts src/orchestrator/strategy/__tests__/strategy-manager-core.test.ts`: passed, 70 tests
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts src/interface/cli/__tests__/cli-doctor.test.ts`: passed, 93 tests
- `node scripts/check-database-first-legacy-stores.mjs --json`: `ok=true`, `findings=0`; `strategy-template-registry` is non-debt migration-only input with typed control DB ownership
- `npm run typecheck`: passed
- `npm run lint:boundaries`: passed with existing warnings, 0 errors
- `npm run build`: passed
- `git diff --check`: passed

## Guard State

`strategy-template-registry` is now closed as normal runtime state. Remaining direct-file debt is `knowledge-graph`, `vector-index`, and `reflection-reports`, which are later slices.
