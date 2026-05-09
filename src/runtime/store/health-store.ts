import {
  RuntimeComponentsHealthSchema,
  RuntimeDaemonHealthSchema,
  RuntimeHealthSnapshotSchema,
  evolveRuntimeHealthKpi,
  summarizeRuntimeHealthStatus,
  RuntimeHealthStatusSchema,
  type RuntimeComponentsHealth,
  type RuntimeDaemonHealth,
  type RuntimeHealthSnapshot,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

type RuntimeHealthRecordKind = "daemon" | "components";

interface RuntimeHealthRecordRow {
  record_json: string;
}

export class RuntimeHealthStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadDaemonHealth(): Promise<RuntimeDaemonHealth | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = readRuntimeHealthRecord(sqlite, "daemon");
      return row ? RuntimeDaemonHealthSchema.parse(JSON.parse(row.record_json) as unknown) : null;
    });
  }

  async saveDaemonHealth(health: RuntimeDaemonHealth): Promise<RuntimeDaemonHealth> {
    const parsed = RuntimeDaemonHealthSchema.parse(health);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertRuntimeHealthRecord(sqlite, "daemon", parsed.checked_at, parsed.status, parsed);
    });
    return parsed;
  }

  async loadComponentsHealth(): Promise<RuntimeComponentsHealth | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = readRuntimeHealthRecord(sqlite, "components");
      return row ? RuntimeComponentsHealthSchema.parse(JSON.parse(row.record_json) as unknown) : null;
    });
  }

  async saveComponentsHealth(health: RuntimeComponentsHealth): Promise<RuntimeComponentsHealth> {
    const parsed = RuntimeComponentsHealthSchema.parse(health);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertRuntimeHealthRecord(
        sqlite,
        "components",
        parsed.checked_at,
        summarizeRuntimeHealthStatus(parsed.components),
        parsed,
      );
    });
    return parsed;
  }

  async loadSnapshot(): Promise<RuntimeHealthSnapshot | null> {
    const [daemon, components] = await Promise.all([
      this.loadDaemonHealth(),
      this.loadComponentsHealth(),
    ]);
    if (daemon === null || components === null) return null;
    return RuntimeHealthSnapshotSchema.parse({
      status: daemon.status,
      leader: daemon.leader,
      checked_at: Math.max(daemon.checked_at, components.checked_at),
      components: components.components,
      kpi: daemon.kpi,
      long_running: daemon.long_running,
      details: daemon.details,
    });
  }

  async saveSnapshot(snapshot: RuntimeHealthSnapshot): Promise<RuntimeHealthSnapshot> {
    const parsed = RuntimeHealthSnapshotSchema.parse(snapshot);
    const daemon = RuntimeDaemonHealthSchema.parse({
      status: parsed.status,
      leader: parsed.leader,
      checked_at: parsed.checked_at,
      kpi: parsed.kpi,
      long_running: parsed.long_running,
      details: parsed.details,
    });
    const components = RuntimeComponentsHealthSchema.parse({
      checked_at: parsed.checked_at,
      components: parsed.components,
    });
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertRuntimeHealthRecord(sqlite, "daemon", daemon.checked_at, daemon.status, daemon);
      upsertRuntimeHealthRecord(
        sqlite,
        "components",
        components.checked_at,
        summarizeRuntimeHealthStatus(components.components),
        components,
      );
    });
    return parsed;
  }

  async reconcile(now = Date.now()): Promise<RuntimeHealthSnapshot> {
    const [daemon, components] = await Promise.all([
      this.loadDaemonHealth(),
      this.loadComponentsHealth(),
    ]);

    if (daemon !== null && components !== null) {
      const snapshot = await this.loadSnapshot();
      if (snapshot !== null) {
        return snapshot;
      }
      return RuntimeHealthSnapshotSchema.parse({
        status: daemon.status,
        leader: daemon.leader,
        checked_at: Math.max(daemon.checked_at, components.checked_at),
        components: components.components,
        kpi: daemon.kpi,
        long_running: daemon.long_running,
        details: daemon.details,
      });
    }

    const degradedComponents: RuntimeComponentsHealth = {
      checked_at: now,
      components: {
        gateway: "degraded",
        queue: "degraded",
        leases: "degraded",
        approval: "degraded",
        outbox: "degraded",
        supervisor: "degraded",
      },
    };

    if (daemon !== null && components === null) {
      const degradedSnapshot = RuntimeHealthSnapshotSchema.parse({
        status: "degraded",
        leader: daemon.leader,
        checked_at: now,
        components: degradedComponents.components,
        kpi:
          daemon.kpi ??
          evolveRuntimeHealthKpi(null, {
            process_alive: daemon.status === "failed" ? "failed" : "degraded",
            command_acceptance: "degraded",
            task_execution: "degraded",
          }, now, {
            process_alive: "repaired from missing components health",
            command_acceptance: "repaired from missing components health",
            task_execution: "repaired from missing components health",
          }),
        long_running: daemon.long_running,
        details: {
          ...daemon.details,
          repaired: true,
          recovered_from: "missing_components_health",
          previous_status: daemon.status,
        },
      });
      await Promise.all([
        this.saveComponentsHealth(degradedComponents),
        this.saveDaemonHealth({
          status: "degraded",
          leader: daemon.leader,
          checked_at: now,
          kpi: degradedSnapshot.kpi,
          long_running: degradedSnapshot.long_running,
          details: degradedSnapshot.details,
        }),
      ]);
      return degradedSnapshot;
    }

    if (daemon === null && components !== null) {
      const status = summarizeRuntimeHealthStatus(components.components);
      const repairedDaemon: RuntimeDaemonHealth = {
        status,
        leader: false,
        checked_at: now,
        kpi: evolveRuntimeHealthKpi(null, {
          process_alive: "degraded",
          command_acceptance: status,
          task_execution: status,
        }, now, {
          process_alive: "repaired from missing daemon health",
          command_acceptance: "repaired from missing daemon health",
          task_execution: "repaired from missing daemon health",
        }),
        details: {
          repaired: true,
          recovered_from: "missing_daemon_health",
        },
      };
      await this.saveDaemonHealth(repairedDaemon);
      return RuntimeHealthSnapshotSchema.parse({
        status,
        leader: repairedDaemon.leader,
        checked_at: Math.max(now, components.checked_at),
        components: components.components,
        kpi: repairedDaemon.kpi,
        long_running: repairedDaemon.long_running,
        details: repairedDaemon.details,
      });
    }

    const repairedSnapshot = RuntimeHealthSnapshotSchema.parse({
      status: "degraded",
      leader: false,
      checked_at: now,
      components: degradedComponents.components,
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "degraded",
        command_acceptance: "degraded",
        task_execution: "degraded",
      }, now, {
        process_alive: "repaired from missing health snapshot",
        command_acceptance: "repaired from missing health snapshot",
        task_execution: "repaired from missing health snapshot",
      }),
      details: {
        repaired: true,
        recovered_from: "missing_health_snapshot",
        previous_status: RuntimeHealthStatusSchema.parse("degraded"),
      },
    });
    await this.saveSnapshot(repairedSnapshot);
    return repairedSnapshot;
  }

  summarizeStatus(components: Record<string, RuntimeHealthSnapshot["status"]>): RuntimeHealthSnapshot["status"] {
    return summarizeRuntimeHealthStatus(components);
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

function readRuntimeHealthRecord(
  sqlite: SqliteDatabase,
  recordKind: RuntimeHealthRecordKind
): RuntimeHealthRecordRow | undefined {
  return sqlite.prepare(`
    SELECT record_json
    FROM runtime_health_records
    WHERE record_kind = ?
  `).get(recordKind) as RuntimeHealthRecordRow | undefined;
}

function upsertRuntimeHealthRecord(
  sqlite: SqliteDatabase,
  recordKind: RuntimeHealthRecordKind,
  checkedAt: number,
  status: string,
  record: RuntimeDaemonHealth | RuntimeComponentsHealth
): void {
  sqlite.prepare(`
    INSERT INTO runtime_health_records (
      record_kind, checked_at, status, record_json
    ) VALUES (
      @record_kind, @checked_at, @status, @record_json
    )
    ON CONFLICT(record_kind) DO UPDATE SET
      checked_at = excluded.checked_at,
      status = excluded.status,
      record_json = excluded.record_json
  `).run({
    record_kind: recordKind,
    checked_at: checkedAt,
    status,
    record_json: JSON.stringify(record),
  });
}
