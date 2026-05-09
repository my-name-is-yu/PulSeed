import {
  DaemonStateSchema,
  type DaemonState,
} from "../../base/types/daemon.js";
import {
  ShutdownMarkerSchema,
  type ShutdownMarker,
} from "../daemon/types.js";
import {
  openControlDatabase,
  openControlDatabaseSync,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export class DaemonStateStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.dbOptions = options;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async load(): Promise<DaemonState | null> {
    const db = await this.database();
    return db.read((sqlite) => readDaemonState(sqlite));
  }

  async save(state: DaemonState): Promise<DaemonState> {
    const parsed = DaemonStateSchema.parse(state);
    const db = await this.database();
    db.transaction((sqlite) => upsertDaemonState(sqlite, parsed));
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.dbOptions.controlBaseDir ?? this.baseDir,
      dbPath: this.dbOptions.controlDbPath,
    });
    return this.dbPromise;
  }
}

export class DaemonShutdownStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.dbOptions = options;
  }

  async load(): Promise<ShutdownMarker | null> {
    const db = await this.database();
    return db.read((sqlite) => readShutdownMarker(sqlite));
  }

  async save(marker: ShutdownMarker): Promise<ShutdownMarker> {
    const parsed = ShutdownMarkerSchema.parse(marker);
    const db = await this.database();
    db.transaction((sqlite) => upsertShutdownMarker(sqlite, parsed));
    return parsed;
  }

  async delete(): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM daemon_shutdown_markers WHERE marker_id = 'current'").run();
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.dbOptions.controlBaseDir ?? this.baseDir,
      dbPath: this.dbOptions.controlDbPath,
    });
    return this.dbPromise;
  }
}

export function loadDaemonStateSync(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {}
): DaemonState | null {
  const db = options.controlDb ?? openControlDatabaseSync({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  try {
    return db.read((sqlite) => readDaemonState(sqlite));
  } finally {
    if (!options.controlDb) {
      db.close();
    }
  }
}

interface DaemonStateRow {
  state_json: string;
}

interface ShutdownMarkerRow {
  marker_json: string;
}

function readDaemonState(sqlite: SqliteDatabase): DaemonState | null {
  const row = sqlite.prepare(`
    SELECT state_json
    FROM daemon_state_snapshots
    WHERE state_id = 'current'
  `).get() as DaemonStateRow | undefined;
  if (!row) return null;
  return DaemonStateSchema.parse(JSON.parse(row.state_json) as unknown);
}

function upsertDaemonState(sqlite: SqliteDatabase, state: DaemonState): void {
  sqlite.prepare(`
    INSERT INTO daemon_state_snapshots (
      state_id,
      pid,
      status,
      runtime_root,
      loop_count,
      updated_at,
      state_json
    )
    VALUES ('current', ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(state_id) DO UPDATE SET
      pid = excluded.pid,
      status = excluded.status,
      runtime_root = excluded.runtime_root,
      loop_count = excluded.loop_count,
      updated_at = excluded.updated_at,
      state_json = excluded.state_json
  `).run(
    state.pid,
    state.status,
    state.runtime_root ?? null,
    state.loop_count,
    state.last_loop_at ?? state.started_at,
    JSON.stringify(state),
  );
}

function readShutdownMarker(sqlite: SqliteDatabase): ShutdownMarker | null {
  const row = sqlite.prepare(`
    SELECT marker_json
    FROM daemon_shutdown_markers
    WHERE marker_id = 'current'
  `).get() as ShutdownMarkerRow | undefined;
  if (!row) return null;
  return ShutdownMarkerSchema.parse(JSON.parse(row.marker_json) as unknown);
}

function upsertShutdownMarker(sqlite: SqliteDatabase, marker: ShutdownMarker): void {
  sqlite.prepare(`
    INSERT INTO daemon_shutdown_markers (
      marker_id,
      marker_state,
      reason,
      marker_timestamp,
      updated_at,
      marker_json
    )
    VALUES ('current', ?, ?, ?, ?, json(?))
    ON CONFLICT(marker_id) DO UPDATE SET
      marker_state = excluded.marker_state,
      reason = excluded.reason,
      marker_timestamp = excluded.marker_timestamp,
      updated_at = excluded.updated_at,
      marker_json = excluded.marker_json
  `).run(
    marker.state,
    marker.reason,
    marker.timestamp,
    new Date().toISOString(),
    JSON.stringify(marker),
  );
}
