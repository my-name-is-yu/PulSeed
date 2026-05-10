# Direct File State Slice 8: Config, Setup, Plugin, Gateway, And Channel Files

## Evidence

- Guard baseline on the fresh Slice 8 worktree reported `findings=0`, `debtReport=[]`, and `directFileDebtReport=[]`.
- The remaining Slice 8 inventory entries were `config-setup-plugin-gateway-channel-files` and `user-authored-profile-content`, both already categorized as non-debt but still marked for Slice 8 follow-up.
- Config surfaces have typed schemas or structured readers at the relevant boundaries: provider config, daemon config, notification config, datasource config, gateway channel config, plugin manifests, MCP server config, global config, and character config.
- Relationship profile and character configuration are user/admin-authored content, not hidden runtime state owners.

## Plan

1. Mark config/setup/plugin/gateway/channel and user-authored profile surfaces as confirmed with no follow-up slice.
2. Tighten the guard so a config-looking filename cannot suppress unrelated runtime `state.json`, queue, cache, or state-directory ownership.
3. Update guard tests and the database-first design doc.

## Result

- Slice 8 direct file owners are closed as explicit config/secret or user-authored content boundaries.
- The guard now only treats MCP config filenames as line-level config exceptions; runtime state rules are no longer skipped just because a line also mentions `config.json`.
- The final boundary report now records Slice 8 entries with `nextSlice: null`.

## Validation

- `nvm use 24.15.0 && npm ci`: passed
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`: passed, 20 tests
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0, `debtReport=[]`, `directFileDebtReport=[]`
- `npm run typecheck`: passed
- `npm run lint:boundaries`: passed with existing warnings, 0 errors
- `npm run build`: passed
- `git diff --check`: passed
