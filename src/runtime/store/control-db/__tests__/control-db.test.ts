import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod/v3";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { getControlDatabasePath } from "../../../../base/utils/paths.js";
import {
  CONTROL_DB_MIGRATIONS,
  CONTROL_DB_SCHEMA_VERSION,
  createJsonRowCodec,
  createRuntimeControlDatabaseOwner,
  createControlDbMigration,
  hasCompletedControlLegacyImport,
  initializeControlDatabase,
  inspectControlDatabase,
  openControlDatabase,
  recordControlLegacyImport,
  resolveControlDbPath,
} from "../index.js";

describe("ControlDatabase", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  it("resolves the default control database under the PulSeed state directory", () => {
    const baseDir = tempHome("pulseed-control-db-path-");

    expect(resolveControlDbPath({ baseDir })).toBe(path.join(baseDir, "state", "pulseed-control.sqlite"));
    expect(getControlDatabasePath(baseDir)).toBe(path.join(baseDir, "state", "pulseed-control.sqlite"));
  });

  it("initializes schema migrations idempotently", async () => {
    const baseDir = tempHome("pulseed-control-db-init-");

    const first = await openControlDatabase({ baseDir });
    try {
      expect(first.dbPath).toBe(path.join(baseDir, "state", "pulseed-control.sqlite"));
      expect(first.schemaVersion()).toBe(CONTROL_DB_SCHEMA_VERSION);
      expect(first.listMigrations()).toHaveLength(CONTROL_DB_MIGRATIONS.length);
    } finally {
      first.close();
    }

    const second = await openControlDatabase({ baseDir });
    try {
      expect(second.schemaVersion()).toBe(CONTROL_DB_SCHEMA_VERSION);
      expect(second.listMigrations()).toHaveLength(CONTROL_DB_MIGRATIONS.length);
    } finally {
      second.close();
    }
  });

  it("applies a later migration to an initialized older database", async () => {
    const baseDir = tempHome("pulseed-control-db-upgrade-");
    const initial = await openControlDatabase({ baseDir, migrations: [CONTROL_DB_MIGRATIONS[0]!] });
    initial.close();

    const upgradeMigration = createControlDbMigration(
      2,
      "upgrade-probe",
      "CREATE TABLE upgrade_probe (id TEXT PRIMARY KEY);"
    );
    const migrations = [CONTROL_DB_MIGRATIONS[0]!, upgradeMigration];

    const pending = inspectControlDatabase({ baseDir, migrations });
    expect(pending.status).toBe("pending_migration");
    expect(pending.pendingMigrations.map((migration) => migration.version)).toEqual([2]);

    const upgraded = await openControlDatabase({ baseDir, migrations });
    try {
      expect(upgraded.schemaVersion()).toBe(2);
      expect(upgraded.listMigrations().map((migration) => migration.version)).toEqual([1, 2]);
    } finally {
      upgraded.close();
    }
    const rawDb = new Database(path.join(baseDir, "state", "pulseed-control.sqlite"));
    try {
      const table = rawDb.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'upgrade_probe'
      `).get();
      expect(table).toEqual({ name: "upgrade_probe" });
    } finally {
      rawDb.close();
    }
  });

  it("rolls back a failed migration transaction", () => {
    const baseDir = tempHome("pulseed-control-db-rollback-");
    const dbPath = path.join(baseDir, "state", "rollback.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    const badMigration = createControlDbMigration(
      1,
      "bad-migration",
      `
      CREATE TABLE rollback_probe (id TEXT PRIMARY KEY);
      INSERT INTO missing_table (id) VALUES ('nope');
      `
    );

    try {
      expect(() => initializeControlDatabase(db, [badMigration])).toThrow();
      const row = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'rollback_probe'
      `).get();
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("fails closed when the database schema is ahead of this code", async () => {
    const baseDir = tempHome("pulseed-control-db-ahead-");
    const dbPath = path.join(baseDir, "state", "pulseed-control.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("user_version = 99");
    db.close();

    await expect(openControlDatabase({ baseDir })).rejects.toThrow("newer than supported version");
    expect(inspectControlDatabase({ baseDir }).status).toBe("ahead_of_code");

    const reopened = new Database(dbPath);
    try {
      expect(reopened.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      reopened.close();
    }
  });

  it("classifies a migration ledger ahead of this code as ahead of code", async () => {
    const baseDir = tempHome("pulseed-control-db-ledger-ahead-");
    const database = await openControlDatabase({ baseDir });
    database.close();

    const db = new Database(path.join(baseDir, "state", "pulseed-control.sqlite"));
    db.prepare(`
      INSERT INTO control_schema_migrations (version, name, checksum, applied_at)
      VALUES (99, 'future', 'future-checksum', '2026-05-09T00:00:00.000Z')
    `).run();
    db.close();

    const inspection = inspectControlDatabase({ baseDir });
    expect(inspection.status).toBe("ahead_of_code");
    expect(inspection.schemaVersion).toBe(99);
  });

  it("fails closed when an applied migration checksum does not match code", async () => {
    const baseDir = tempHome("pulseed-control-db-checksum-");
    const database = await openControlDatabase({ baseDir });
    database.close();

    const db = new Database(path.join(baseDir, "state", "pulseed-control.sqlite"));
    db.prepare("UPDATE control_schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    db.close();

    await expect(openControlDatabase({ baseDir })).rejects.toThrow("checksum mismatch");
    const inspection = inspectControlDatabase({ baseDir });
    expect(inspection.status).toBe("unreadable");
    expect(inspection.error).toContain("checksum mismatch");
  });

  it("records explicit legacy import bookkeeping without reading legacy stores on normal open", async () => {
    const baseDir = tempHome("pulseed-control-db-import-");
    const database = await openControlDatabase({ baseDir });

    try {
      const record = database.recordLegacyImport({
        importId: "import-runtime-health",
        sourceKind: "runtime-health-json",
        sourceId: "runtime-health:daemon",
        sourcePath: "runtime/health/daemon.json",
        sourceChecksum: "sha256:test",
        sourceMtimeMs: 123,
        migrationName: "runtime-health-json-import",
        migrationVersion: 1,
        status: "validated",
        details: { rows: 1 },
        importedAt: "2026-05-09T00:00:00.000Z",
      });

      expect(record.status).toBe("validated");
      expect(record.source_id).toBe("runtime-health:daemon");
      expect(record.details).toEqual({ rows: 1 });
      expect(database.listLegacyImports()).toEqual([record]);
    } finally {
      database.close();
    }
  });

  it("keeps injected control databases owned by the caller", async () => {
    const baseDir = tempHome("pulseed-control-db-owner-injected-");
    const injected = await openControlDatabase({ baseDir });
    const owner = createRuntimeControlDatabaseOwner({ rootDir: path.join(baseDir, "runtime") }, { controlDb: injected });

    try {
      expect(await owner.database()).toBe(injected);
      await owner.close();
      expect(injected.schemaVersion()).toBe(CONTROL_DB_SCHEMA_VERSION);
    } finally {
      injected.close();
    }
  });

  it("resets per-instance runtime control database owners without changing nested runtime path resolution", async () => {
    const baseDir = tempHome("pulseed-runtime-control-owner-reset-");
    const runtimeRoot = path.join(baseDir, "runtime");
    const owner = createRuntimeControlDatabaseOwner({ rootDir: runtimeRoot });

    const first = await owner.database();
    expect(first.dbPath).toBe(path.join(baseDir, "state", "pulseed-control.sqlite"));

    await owner.reset();
    const second = await owner.database();
    try {
      expect(second).not.toBe(first);
      expect(second.dbPath).toBe(path.join(baseDir, "state", "pulseed-control.sqlite"));
    } finally {
      await owner.close();
    }
  });

  it("fails closed for corrupt or schema-invalid JSON rows", () => {
    const codec = createJsonRowCodec(z.object({
      id: z.string().min(1),
    }).strict());

    expect(codec.safeParse("{")).toBeNull();
    expect(codec.safeParse(JSON.stringify({ id: 1 }))).toBeNull();
    expect(codec.safeParse(JSON.stringify({ id: "row-1" }))).toEqual({ id: "row-1" });
  });

  it("recognizes completed legacy imports through the shared helper", async () => {
    const baseDir = tempHome("pulseed-control-db-import-helper-");
    const database = await openControlDatabase({ baseDir });

    try {
      recordControlLegacyImport(database, {
        importId: "import-helper-1",
        sourceKind: "runtime-health-json",
        sourceId: "runtime-health:daemon",
        migrationName: "runtime-health-json-import",
        migrationVersion: 1,
        status: "imported",
      });
      recordControlLegacyImport(database, {
        importId: "import-helper-2",
        sourceKind: "runtime-health-json",
        sourceId: "runtime-health:components",
        migrationName: "runtime-health-json-import",
        migrationVersion: 1,
        status: "blocked",
      });

      expect(hasCompletedControlLegacyImport(database, {
        sourceKind: "runtime-health-json",
        sourceId: "runtime-health:daemon",
        migrationName: "runtime-health-json-import",
      })).toBe(true);
      expect(hasCompletedControlLegacyImport(database, {
        sourceKind: "runtime-health-json",
        sourceId: "runtime-health:components",
        migrationName: "runtime-health-json-import",
      })).toBe(false);
    } finally {
      database.close();
    }
  });

  it("inspects missing and ready databases without creating missing files", async () => {
    const baseDir = tempHome("pulseed-control-db-inspect-");
    const dbPath = path.join(baseDir, "state", "pulseed-control.sqlite");

    const missing = inspectControlDatabase({ baseDir });
    expect(missing.status).toBe("missing");
    expect(fs.existsSync(dbPath)).toBe(false);

    const database = await openControlDatabase({ baseDir });
    database.close();

    const ready = inspectControlDatabase({ baseDir });
    expect(ready.status).toBe("ready");
    expect(ready.schemaVersion).toBe(CONTROL_DB_SCHEMA_VERSION);
    expect(ready.appliedMigrations).toHaveLength(CONTROL_DB_MIGRATIONS.length);
  });
});
