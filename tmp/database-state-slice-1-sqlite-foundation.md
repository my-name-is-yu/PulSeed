# Slice 1: SQLite Foundation And Migration Framework

## Evidence

- `origin/main` did not contain `pulseed-control.sqlite`, `control.sqlite`, or a schema migration ledger for durable internal state.
- Existing SQLite usage is Soil-specific and initializes DDL directly with `better-sqlite3`.
- Existing runtime durable state surfaces still use JSON/JSONL paths under `src/runtime/store/runtime-paths.ts` and `RuntimeJournal`; this slice does not migrate those business stores.

## Change Strategy

- Add a control database owner module under `src/runtime/store/control-db`.
- Resolve the control DB at `<PULSEED_HOME or ~/.pulseed>/state/pulseed-control.sqlite`.
- Keep Slice 1 limited to schema initialization, migration/version bookkeeping, legacy import bookkeeping, inspection, doctor visibility, and tests.
- Leave business store migration to later slices so normal runtime paths are not dual-written in this foundation PR.

## Validation

- Control DB integration test: passed, 9 tests.
- CLI doctor unit test: passed, 53 tests.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings, 0 errors.
- `npm run build`: passed.
- `git diff --check`: passed.

## Review Fixes

- Moved WAL/foreign-key pragmas after ahead-of-code and migration checksum validation.
- Changed legacy import identity from filesystem path to stable `source_id`; `source_path` remains optional audit metadata only.
- Added a positive old-DB-to-new-migration upgrade test covering pending migration inspection, apply, schema version, and ledger rows.
