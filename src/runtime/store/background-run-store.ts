import {
  BackgroundRunSchema,
  type BackgroundRun,
  type BackgroundRunKind,
  type BackgroundRunStatus,
  type RuntimeArtifactRef,
  type RuntimeReplyTarget,
  type RuntimeSessionRef,
} from "../session-registry/types.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const TERMINAL_STATUS_ALIASES = {
  success: "succeeded",
  completed: "succeeded",
  complete: "succeeded",
  error: "failed",
  timeout: "timed_out",
  timedout: "timed_out",
  canceled: "cancelled",
  cancel: "cancelled",
  missing: "lost",
} as const satisfies Record<string, BackgroundRunTerminalStatus>;

export const BackgroundRunLedgerRecordSchema = BackgroundRunSchema.superRefine((run, ctx) => {
  if (run.reply_target_source === "pinned_run" && run.pinned_reply_target === null) {
    ctx.addIssue({
      code: "custom",
      path: ["pinned_reply_target"],
      message: "pinned_run requires pinned_reply_target",
    });
  }
  if (run.reply_target_source !== "pinned_run" && run.pinned_reply_target !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["pinned_reply_target"],
      message: `pinned_reply_target is invalid when reply_target_source is ${run.reply_target_source}`,
    });
  }
  if (run.notify_policy !== "silent" && run.reply_target_source !== "pinned_run") {
    ctx.addIssue({
      code: "custom",
      path: ["reply_target_source"],
      message: "non-silent runs require pinned_run reply target",
    });
  }
});

export type BackgroundRunTerminalStatus = Extract<
  BackgroundRunStatus,
  "succeeded" | "failed" | "timed_out" | "cancelled" | "lost"
>;

export interface BackgroundRunCreateInput {
  id: string;
  kind: BackgroundRunKind;
  notify_policy?: BackgroundRun["notify_policy"];
  reply_target_source?: BackgroundRun["reply_target_source"];
  pinned_reply_target?: RuntimeReplyTarget | null;
  parent_session_id?: string | null;
  child_session_id?: string | null;
  process_session_id?: string | null;
  goal_id?: string | null;
  status?: Extract<BackgroundRunStatus, "queued" | "running">;
  title?: string | null;
  workspace?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  summary?: string | null;
  error?: string | null;
  artifacts?: RuntimeArtifactRef[];
  source_refs?: RuntimeSessionRef[];
  origin_metadata?: Record<string, unknown>;
}

export interface BackgroundRunLinkInput {
  parent_session_id?: string | null;
  child_session_id?: string | null;
  process_session_id?: string | null;
  updated_at?: string | null;
  source_refs?: RuntimeSessionRef[];
}

export interface BackgroundRunStartedInput {
  started_at?: string | null;
  updated_at?: string | null;
  process_session_id?: string | null;
  child_session_id?: string | null;
  source_refs?: RuntimeSessionRef[];
}

export interface BackgroundRunTerminalInput {
  status: BackgroundRunTerminalStatus | keyof typeof TERMINAL_STATUS_ALIASES;
  completed_at?: string | null;
  updated_at?: string | null;
  summary?: string | null;
  error?: string | null;
  artifacts?: RuntimeArtifactRef[];
  source_refs?: RuntimeSessionRef[];
}

export class BackgroundRunLedger {
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

  async load(runId: string): Promise<BackgroundRun | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT run_json
        FROM background_runs
        WHERE run_id = ?
      `).get(runId) as { run_json: string } | undefined;
      return row ? parseBackgroundRunJson(row.run_json) : null;
    });
  }

  async list(): Promise<BackgroundRun[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT run_json
        FROM background_runs
        ORDER BY updated_at ASC, run_id ASC
      `).all() as Array<{ run_json: string }>;
      return rows.map((row) => parseBackgroundRunJson(row.run_json));
    });
  }

  async create(input: BackgroundRunCreateInput): Promise<BackgroundRun> {
    const createdAt = input.created_at ?? input.updated_at ?? new Date().toISOString();
    return this.save({
      schema_version: "background-run-v1",
      id: input.id,
      kind: input.kind,
      parent_session_id: input.parent_session_id ?? null,
      child_session_id: input.child_session_id ?? null,
      process_session_id: input.process_session_id ?? null,
      goal_id: input.goal_id ?? null,
      status: input.status ?? "queued",
      notify_policy: input.notify_policy ?? "done_only",
      reply_target_source: input.reply_target_source ?? (input.pinned_reply_target ? "pinned_run" : "none"),
      pinned_reply_target: input.pinned_reply_target ?? null,
      title: input.title ?? null,
      workspace: input.workspace ?? null,
      created_at: createdAt,
      started_at: input.started_at ?? null,
      updated_at: input.updated_at ?? createdAt,
      completed_at: null,
      summary: input.summary ?? null,
      error: input.error ?? null,
      artifacts: input.artifacts ?? [],
      source_refs: input.source_refs ?? [],
      ...(input.origin_metadata ? { origin_metadata: input.origin_metadata } : {}),
    });
  }

  async link(runId: string, input: BackgroundRunLinkInput): Promise<BackgroundRun> {
    return this.update(runId, (run) => ({
      ...run,
      parent_session_id: input.parent_session_id ?? run.parent_session_id,
      child_session_id: input.child_session_id ?? run.child_session_id,
      process_session_id: input.process_session_id ?? run.process_session_id,
      updated_at: input.updated_at ?? run.updated_at,
      source_refs: input.source_refs ?? run.source_refs,
    }));
  }

  async started(runId: string, input: BackgroundRunStartedInput = {}): Promise<BackgroundRun> {
    const updatedAt = input.updated_at ?? input.started_at ?? new Date().toISOString();
    return this.update(runId, (run) => ({
      ...run,
      status: "running",
      started_at: input.started_at ?? run.started_at ?? updatedAt,
      updated_at: updatedAt,
      process_session_id: input.process_session_id ?? run.process_session_id,
      child_session_id: input.child_session_id ?? run.child_session_id,
      source_refs: input.source_refs ?? run.source_refs,
    }));
  }

  async terminal(runId: string, input: BackgroundRunTerminalInput): Promise<BackgroundRun> {
    const status = normalizeTerminalStatus(input.status);
    const completedAt = input.completed_at ?? input.updated_at ?? new Date().toISOString();
    return this.update(runId, (run) => ({
      ...run,
      status,
      completed_at: completedAt,
      updated_at: input.updated_at ?? completedAt,
      summary: input.summary ?? run.summary,
      error: input.error ?? run.error,
      artifacts: input.artifacts ?? run.artifacts,
      source_refs: input.source_refs ?? run.source_refs,
    }));
  }

  async save(run: BackgroundRun): Promise<BackgroundRun> {
    const parsed = validateBackgroundRunLedgerRecord(run);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO background_runs (
          run_id, kind, status, parent_session_id, child_session_id,
          process_session_id, goal_id, created_at, updated_at, run_json
        ) VALUES (
          @run_id, @kind, @status, @parent_session_id, @child_session_id,
          @process_session_id, @goal_id, @created_at, @updated_at, @run_json
        )
        ON CONFLICT(run_id) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          parent_session_id = excluded.parent_session_id,
          child_session_id = excluded.child_session_id,
          process_session_id = excluded.process_session_id,
          goal_id = excluded.goal_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          run_json = excluded.run_json
      `).run({
        run_id: parsed.id,
        kind: parsed.kind,
        status: parsed.status,
        parent_session_id: parsed.parent_session_id ?? null,
        child_session_id: parsed.child_session_id ?? null,
        process_session_id: parsed.process_session_id ?? null,
        goal_id: parsed.goal_id ?? null,
        created_at: parsed.created_at ?? null,
        updated_at: parsed.updated_at ?? null,
        run_json: JSON.stringify(parsed),
      });
    });
    return parsed;
  }

  private async update(
    runId: string,
    updater: (run: BackgroundRun) => BackgroundRun,
  ): Promise<BackgroundRun> {
    const existing = await this.load(runId);
    if (!existing) {
      throw new Error(`BackgroundRun ${runId} does not exist`);
    }
    return this.save(updater(existing));
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

export function normalizeTerminalStatus(
  status: BackgroundRunTerminalInput["status"],
): BackgroundRunTerminalStatus {
  if (status === "succeeded"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled"
    || status === "lost") {
    return status;
  }
  const normalized = TERMINAL_STATUS_ALIASES[status];
  if (normalized) return normalized;
  throw new Error(`Unsupported BackgroundRun terminal status: ${status}`);
}

export function validateBackgroundRunLedgerRecord(run: BackgroundRun): BackgroundRun {
  const parsed = BackgroundRunSchema.parse(run);
  if (parsed.reply_target_source === "pinned_run" && parsed.pinned_reply_target === null) {
    throw new Error(`BackgroundRun ${parsed.id} uses pinned_run without pinned_reply_target`);
  }
  if (parsed.reply_target_source !== "pinned_run" && parsed.pinned_reply_target !== null) {
    throw new Error(`BackgroundRun ${parsed.id} pins a reply target with source ${parsed.reply_target_source}`);
  }
  if (parsed.notify_policy !== "silent" && parsed.reply_target_source !== "pinned_run") {
    throw new Error(`BackgroundRun ${parsed.id} with notify_policy ${parsed.notify_policy} requires pinned_run reply target`);
  }
  return parsed;
}

function parseBackgroundRunJson(runJson: string): BackgroundRun {
  return BackgroundRunLedgerRecordSchema.parse(JSON.parse(runJson) as unknown);
}
