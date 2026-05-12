import { z } from "zod";
import {
  RuntimeControlOperationSchema,
  isTerminalRuntimeControlState,
  type RuntimeControlOperation,
} from "./runtime-operation-schemas.js";
import { RuntimeEventSchema, type RuntimeEvent, type RuntimeItem } from "../types/companion-state.js";
import {
  runtimeEventFromOperationTransition,
  runtimeItemFromOperation,
} from "./runtime-operation-companion.js";
import { createRuntimeStorePaths, type RuntimeStorePaths } from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

const RuntimeEventJournalSchema = RuntimeEventSchema as z.ZodType<RuntimeEvent>;
const RuntimeEventRecentLimitSchema = z.number().int().positive().safe().max(500);
const RuntimeOperationRecentLimitSchema = z.number().int().positive().safe().max(500);

interface RuntimeOperationRow {
  operation_json: string;
}

interface RuntimeOperationEventRow {
  event_json: string;
}

export interface RuntimeOperationStoreSaveOptions {
  emitEvent?: boolean;
}

export class RuntimeOperationStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
  }

  runtimeRootDir(): string {
    return this.paths.rootDir;
  }

  runtimeControlDbOptions(): RuntimeControlDbStoreOptions {
    return this.dbOptions;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async load(operationId: string): Promise<RuntimeControlOperation | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT operation_json
        FROM runtime_operations
        WHERE operation_id = ?
      `).get(operationId) as RuntimeOperationRow | undefined;
      return row ? parseRuntimeOperationJson(row.operation_json) : null;
    });
  }

  async listPending(): Promise<RuntimeControlOperation[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT operation_json
        FROM runtime_operations
        WHERE terminal = 0
        ORDER BY requested_at ASC, operation_id ASC
      `).all() as RuntimeOperationRow[];
      return rows.map((row) => parseRuntimeOperationJson(row.operation_json));
    });
  }

  async listCompleted(): Promise<RuntimeControlOperation[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT operation_json
        FROM runtime_operations
        WHERE terminal = 1
        ORDER BY updated_at ASC, operation_id ASC
      `).all() as RuntimeOperationRow[];
      return rows.map((row) => parseRuntimeOperationJson(row.operation_json));
    });
  }

  async listRecentOperations(limit = 50): Promise<RuntimeControlOperation[]> {
    const parsedLimit = RuntimeOperationRecentLimitSchema.parse(limit);
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT operation_json
        FROM runtime_operations
        ORDER BY updated_at DESC, operation_id DESC
        LIMIT ?
      `).all(parsedLimit) as RuntimeOperationRow[];
      return rows.reverse().map((row) => parseRuntimeOperationJson(row.operation_json));
    });
  }

  async listRuntimeItems(): Promise<RuntimeItem[]> {
    return [...await this.listPending(), ...await this.listCompleted()]
      .map(runtimeItemFromOperation);
  }

  async listRuntimeEvents(): Promise<RuntimeEvent[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT event_json
        FROM runtime_operation_events
        ORDER BY occurred_at ASC, event_id ASC
      `).all() as RuntimeOperationEventRow[];
      return rows.map((row) => parseRuntimeEventJson(row.event_json));
    });
  }

  async listRecentRuntimeEvents(limit = 50): Promise<RuntimeEvent[]> {
    const parsedLimit = RuntimeEventRecentLimitSchema.parse(limit);
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT event_json
        FROM runtime_operation_events
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?
      `).all(parsedLimit) as RuntimeOperationEventRow[];
      return rows.reverse().map((row) => parseRuntimeEventJson(row.event_json));
    });
  }

  async save(
    operation: RuntimeControlOperation,
    options: RuntimeOperationStoreSaveOptions = {}
  ): Promise<RuntimeControlOperation> {
    const parsed = RuntimeControlOperationSchema.parse(operation);
    const db = await this.database();
    db.transaction((sqlite) => {
      const previousRow = sqlite.prepare(`
        SELECT operation_json
        FROM runtime_operations
        WHERE operation_id = ?
      `).get(parsed.operation_id) as RuntimeOperationRow | undefined;
      const previous = previousRow ? parseRuntimeOperationJson(previousRow.operation_json) : null;
      upsertRuntimeOperation(sqlite, parsed);
      if (options.emitEvent !== false) {
        const event = runtimeEventFromOperationTransition(parsed, previous);
        if (event) {
          insertRuntimeOperationEvent(sqlite, event, parsed.operation_id);
        }
      }
    });
    return parsed;
  }

  async importLegacyRuntimeEvent(
    event: RuntimeEvent,
    operationId: string | null = null,
  ): Promise<RuntimeEvent> {
    const parsed = RuntimeEventJournalSchema.parse(event);
    const db = await this.database();
    db.transaction((sqlite) => {
      insertRuntimeOperationEvent(sqlite, parsed, operationId);
    });
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

function parseRuntimeOperationJson(operationJson: string): RuntimeControlOperation {
  return RuntimeControlOperationSchema.parse(JSON.parse(operationJson) as unknown);
}

function parseRuntimeEventJson(eventJson: string): RuntimeEvent {
  return RuntimeEventJournalSchema.parse(JSON.parse(eventJson) as unknown);
}

function upsertRuntimeOperation(
  sqlite: SqliteDatabase,
  operation: RuntimeControlOperation
): void {
  sqlite.prepare(`
    INSERT INTO runtime_operations (
      operation_id, kind, state, terminal, requested_at, updated_at, operation_json
    ) VALUES (
      @operation_id, @kind, @state, @terminal, @requested_at, @updated_at, @operation_json
    )
    ON CONFLICT(operation_id) DO UPDATE SET
      kind = excluded.kind,
      state = excluded.state,
      terminal = excluded.terminal,
      requested_at = excluded.requested_at,
      updated_at = excluded.updated_at,
      operation_json = excluded.operation_json
  `).run({
    operation_id: operation.operation_id,
    kind: operation.kind,
    state: operation.state,
    terminal: isTerminalRuntimeControlState(operation.state) ? 1 : 0,
    requested_at: operation.requested_at,
    updated_at: operation.updated_at,
    operation_json: JSON.stringify(operation),
  });
}

function insertRuntimeOperationEvent(
  sqlite: SqliteDatabase,
  event: RuntimeEvent,
  operationId: string | null
): void {
  const parsed = RuntimeEventJournalSchema.parse(event);
  sqlite.prepare(`
    INSERT INTO runtime_operation_events (
      event_id, operation_id, occurred_at, event_json
    ) VALUES (
      @event_id, @operation_id, @occurred_at, @event_json
    )
    ON CONFLICT(event_id) DO UPDATE SET
      operation_id = excluded.operation_id,
      occurred_at = excluded.occurred_at,
      event_json = excluded.event_json
  `).run({
    event_id: parsed.event_id,
    operation_id: operationId,
    occurred_at: parsed.occurred_at,
    event_json: JSON.stringify(parsed),
  });
}

export function deriveRuntimeOperationIdFromEvent(event: RuntimeEvent): string | null {
  const itemRefPrefix = "runtime-control:";
  if (!event.item_ref.startsWith(itemRefPrefix)) {
    return null;
  }
  return event.item_ref.slice(itemRefPrefix.length);
}
