import type { z } from "zod/v3";
import {
  openControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportRecord,
  type ControlLegacyImportStatus,
} from "./control-db.js";
import {
  openRuntimeControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./runtime-control-db.js";
import type { RuntimeStorePaths } from "../runtime-paths.js";

export class ControlDatabaseHandleOwner {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly opener: () => Promise<ControlDatabase>,
    private readonly injectedDb: ControlDatabase | undefined = undefined,
  ) {}

  async database(): Promise<ControlDatabase> {
    if (this.injectedDb) return this.injectedDb;
    this.dbPromise ??= this.opener();
    return this.dbPromise;
  }

  async close(): Promise<void> {
    if (this.injectedDb || this.dbPromise === null) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }

  async reset(): Promise<void> {
    await this.close();
  }
}

export function createControlDatabaseOwner(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): ControlDatabaseHandleOwner {
  return new ControlDatabaseHandleOwner(
    () => openControlDatabase({
      baseDir: options.controlBaseDir ?? baseDir,
      dbPath: options.controlDbPath,
    }),
    options.controlDb,
  );
}

export function createRuntimeControlDatabaseOwner(
  paths: Pick<RuntimeStorePaths, "rootDir">,
  options: RuntimeControlDbStoreOptions = {},
): ControlDatabaseHandleOwner {
  return new ControlDatabaseHandleOwner(
    () => openRuntimeControlDatabase(paths, options),
    options.controlDb,
  );
}

export interface JsonRowCodec<T> {
  parse(raw: string): T;
  safeParse(raw: string): T | null;
  stringify(value: T): string;
}

export function createJsonRowCodec<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
): JsonRowCodec<z.output<TSchema>> {
  return {
    parse(raw: string): z.output<TSchema> {
      return schema.parse(JSON.parse(raw) as unknown);
    },
    safeParse(raw: string): z.output<TSchema> | null {
      try {
        const parsed = schema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    stringify(value: z.output<TSchema>): string {
      return JSON.stringify(schema.parse(value));
    },
  };
}

export function parseJsonRow<T, K extends string>(
  row: Record<K, string> | undefined,
  column: K,
  codec: JsonRowCodec<T>,
): T | null {
  return row ? codec.safeParse(row[column]) : null;
}

export function parseJsonRows<T, K extends string>(
  rows: Array<Record<K, string>>,
  column: K,
  codec: JsonRowCodec<T>,
): T[] {
  return rows.flatMap((row) => {
    const parsed = codec.safeParse(row[column]);
    return parsed ? [parsed] : [];
  });
}

export function stringifyJsonRow<T>(codec: JsonRowCodec<T>, value: T): string {
  return codec.stringify(value);
}

export interface StateTransitionAuditInput<TState, TAudit> {
  emitAudit?: boolean;
  loadPrevious: () => TState | null;
  persistCurrent: () => void;
  buildAudit: (current: TState, previous: TState | null) => TAudit | null;
  persistAudit: (audit: TAudit) => void;
  current: TState;
}

export function persistStateTransitionWithAudit<TState, TAudit>(
  input: StateTransitionAuditInput<TState, TAudit>,
): TAudit | null {
  const previous = input.loadPrevious();
  input.persistCurrent();
  if (input.emitAudit === false) return null;
  const audit = input.buildAudit(input.current, previous);
  if (audit) input.persistAudit(audit);
  return audit;
}

export interface CompletedControlLegacyImportQuery {
  sourceKind?: string;
  sourceId: string;
  migrationName: string;
  statuses?: readonly ControlLegacyImportStatus[];
}

export function hasCompletedControlLegacyImport(
  controlDb: ControlDatabase,
  query: CompletedControlLegacyImportQuery,
): boolean {
  const completedStatuses = new Set(query.statuses ?? ["imported"]);
  return controlDb.listLegacyImports().some((record) =>
    (query.sourceKind === undefined || record.source_kind === query.sourceKind)
    && record.source_id === query.sourceId
    && record.migration_name === query.migrationName
    && completedStatuses.has(record.status)
  );
}

export function recordControlLegacyImport(
  controlDb: ControlDatabase,
  input: Parameters<ControlDatabase["recordLegacyImport"]>[0],
): ControlLegacyImportRecord {
  return controlDb.recordLegacyImport(input);
}
