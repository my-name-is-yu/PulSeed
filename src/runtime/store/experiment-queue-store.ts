import { z } from "zod";
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
import {
  RuntimeEvidenceArtifactRefSchema,
  RuntimeEvidenceMetricSchema,
  type RuntimeEvidenceArtifactRef,
  type RuntimeEvidenceMetric,
} from "./evidence-types.js";

export const RuntimeExperimentQueuePhaseSchema = z.enum(["designing", "executing_frozen_queue"]);
export type RuntimeExperimentQueuePhase = z.infer<typeof RuntimeExperimentQueuePhaseSchema>;

export const RuntimeExperimentQueueRevisionStatusSchema = z.enum([
  "draft",
  "frozen",
  "executing",
  "completed",
  "blocked",
]);
export type RuntimeExperimentQueueRevisionStatus = z.infer<typeof RuntimeExperimentQueueRevisionStatusSchema>;

export const RuntimeExperimentQueueItemStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
export type RuntimeExperimentQueueItemStatus = z.infer<typeof RuntimeExperimentQueueItemStatusSchema>;

const RuntimeExperimentQueuePositiveSafeIntSchema = z.number().int().positive().safe();

export const RuntimeExperimentQueueProvenanceSchema = z.object({
  source: z.string().min(1),
  created_by: z.string().min(1).optional(),
  evidence_refs: z.array(z.string().min(1)).optional(),
  artifact_refs: z.array(z.string().min(1)).optional(),
  notes: z.string().min(1).optional(),
}).strict();
export type RuntimeExperimentQueueProvenance = z.infer<typeof RuntimeExperimentQueueProvenanceSchema>;
export type RuntimeExperimentQueueProvenanceInput = z.input<typeof RuntimeExperimentQueueProvenanceSchema>;

export const RuntimeExperimentQueueItemSchema = z.object({
  item_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  title: z.string().min(1).optional(),
  config: z.record(z.unknown()),
  status: RuntimeExperimentQueueItemStatusSchema,
  output_artifacts: z.array(RuntimeEvidenceArtifactRefSchema),
  metrics: z.array(RuntimeEvidenceMetricSchema),
  error: z.string().min(1).optional(),
  claimed_by: z.string().min(1).optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  updated_at: z.string().datetime(),
  provenance: RuntimeExperimentQueueProvenanceSchema,
}).strict();
export type RuntimeExperimentQueueItem = z.infer<typeof RuntimeExperimentQueueItemSchema>;

export const RuntimeExperimentQueueRevisionSchema = z.object({
  version: RuntimeExperimentQueuePositiveSafeIntSchema,
  phase: RuntimeExperimentQueuePhaseSchema,
  status: RuntimeExperimentQueueRevisionStatusSchema,
  revision_of: RuntimeExperimentQueuePositiveSafeIntSchema.nullable(),
  revision_reason: z.string().min(1).nullable(),
  created_at: z.string().datetime(),
  frozen_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
  provenance: RuntimeExperimentQueueProvenanceSchema,
  items: z.array(RuntimeExperimentQueueItemSchema),
}).strict();
export type RuntimeExperimentQueueRevision = z.infer<typeof RuntimeExperimentQueueRevisionSchema>;

export const RuntimeExperimentQueueRecordSchema = z.object({
  schema_version: z.literal("runtime-experiment-queue-v1"),
  queue_id: z.string().min(1),
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  current_version: RuntimeExperimentQueuePositiveSafeIntSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  revisions: z.array(RuntimeExperimentQueueRevisionSchema).min(1),
}).strict().superRefine((queue, ctx) => {
  if (!queue.revisions.some((revision) => revision.version === queue.current_version)) {
    ctx.addIssue({
      code: "custom",
      path: ["current_version"],
      message: `current_version ${queue.current_version} is not present in revisions`,
    });
  }
  for (const revision of queue.revisions) {
    const seen = new Set<string>();
    for (const item of revision.items) {
      if (seen.has(item.item_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["revisions", revision.version, "items", item.item_id],
          message: `duplicate experiment queue item_id: ${item.item_id}`,
        });
      }
      seen.add(item.item_id);
    }
  }
});
export type RuntimeExperimentQueueRecord = z.infer<typeof RuntimeExperimentQueueRecordSchema>;
const RuntimeExperimentQueueRecordRuntimeSchema = RuntimeExperimentQueueRecordSchema as unknown as z.ZodType<RuntimeExperimentQueueRecord>;

export interface RuntimeExperimentQueueItemInput {
  item_id: string;
  idempotency_key?: string;
  title?: string;
  config: Record<string, unknown>;
  provenance: RuntimeExperimentQueueProvenanceInput;
}

export interface RuntimeExperimentQueueCreateInput {
  queue_id: string;
  goal_id?: string;
  run_id?: string;
  title?: string;
  created_at?: string;
  provenance: RuntimeExperimentQueueProvenanceInput;
  items: RuntimeExperimentQueueItemInput[];
}

export interface RuntimeExperimentQueueRevisionInput {
  reason: string;
  created_at?: string;
  provenance: RuntimeExperimentQueueProvenanceInput;
  items: RuntimeExperimentQueueItemInput[];
}

export interface RuntimeExperimentQueueItemResultInput {
  version?: number;
  item_id: string;
  status: Extract<RuntimeExperimentQueueItemStatus, "succeeded" | "failed" | "skipped" | "cancelled">;
  completed_at?: string;
  output_artifacts?: RuntimeEvidenceArtifactRef[];
  metrics?: RuntimeEvidenceMetric[];
  error?: string;
}

export interface RuntimeExperimentQueueExecutionDirective {
  mode: "execute_frozen_queue_item";
  queue_id: string;
  version: number;
  phase: RuntimeExperimentQueuePhase;
  item: RuntimeExperimentQueueItem;
  idempotency_key: string;
  resume: boolean;
  summary: string;
}

const TERMINAL_ITEM_STATUSES = new Set<RuntimeExperimentQueueItemStatus>([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export class RuntimeExperimentQueueStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;
  private readonly now: () => Date;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: { now?: () => Date } & RuntimeControlDbStoreOptions = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
    this.now = options.now ?? (() => new Date());
  }

  async load(queueId: string): Promise<RuntimeExperimentQueueRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readExperimentQueue(sqlite, queueId));
  }

  async list(): Promise<RuntimeExperimentQueueRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listExperimentQueues(sqlite));
  }

  async create(input: RuntimeExperimentQueueCreateInput): Promise<RuntimeExperimentQueueRecord> {
    const existing = await this.load(input.queue_id);
    if (existing) {
      throw new Error(`Experiment queue already exists: ${input.queue_id}; use appendRevision for explicit queue changes`);
    }
    const createdAt = input.created_at ?? this.nowIso();
    const queue: RuntimeExperimentQueueRecord = {
      schema_version: "runtime-experiment-queue-v1",
      queue_id: input.queue_id,
      ...(input.goal_id ? { goal_id: input.goal_id } : {}),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.title ? { title: input.title } : {}),
      current_version: 1,
      created_at: createdAt,
      updated_at: createdAt,
      revisions: [{
        version: 1,
        phase: "designing",
        status: "draft",
        revision_of: null,
        revision_reason: null,
        created_at: createdAt,
        frozen_at: null,
        updated_at: createdAt,
        provenance: this.normalizeProvenance(input.provenance),
        items: input.items.map((item) => this.normalizeItem(item, createdAt)),
      }],
    };
    return this.save(queue);
  }

  async freeze(queueId: string, frozenAt = this.nowIso()): Promise<RuntimeExperimentQueueRecord> {
    return this.update(queueId, (queue) => {
      const revision = this.currentRevision(queue);
      if (revision.phase === "executing_frozen_queue") return queue;
      return {
        ...queue,
        updated_at: frozenAt,
        revisions: queue.revisions.map((candidate) =>
          candidate.version === revision.version
            ? {
                ...candidate,
                phase: "executing_frozen_queue",
                status: "frozen",
                frozen_at: frozenAt,
                updated_at: frozenAt,
              }
            : candidate
        ),
      };
    });
  }

  async appendRevision(queueId: string, input: RuntimeExperimentQueueRevisionInput): Promise<RuntimeExperimentQueueRecord> {
    return this.update(queueId, (queue) => {
      const current = this.currentRevision(queue);
      const createdAt = input.created_at ?? this.nowIso();
      const nextVersion = Math.max(...queue.revisions.map((revision) => revision.version)) + 1;
      return {
        ...queue,
        current_version: nextVersion,
        updated_at: createdAt,
        revisions: [
          ...queue.revisions,
          {
            version: nextVersion,
            phase: "designing",
            status: "draft",
            revision_of: current.version,
            revision_reason: input.reason,
            created_at: createdAt,
            frozen_at: null,
            updated_at: createdAt,
            provenance: this.normalizeProvenance(input.provenance),
            items: input.items.map((item) => this.normalizeItem(item, createdAt)),
          },
        ],
      };
    });
  }

  async markItemRunning(
    queueId: string,
    input: { version?: number; item_id: string; claimed_by?: string; started_at?: string }
  ): Promise<RuntimeExperimentQueueRecord> {
    return this.updateItem(queueId, input.version, input.item_id, (item, revision) => {
      this.assertFrozenExecution(revision);
      if (TERMINAL_ITEM_STATUSES.has(item.status)) return item;
      const startedAt = input.started_at ?? this.nowIso();
      return {
        ...item,
        status: "running",
        ...(input.claimed_by ? { claimed_by: input.claimed_by } : {}),
        started_at: item.started_at ?? startedAt,
        updated_at: startedAt,
      };
    });
  }

  async recordItemResult(
    queueId: string,
    input: RuntimeExperimentQueueItemResultInput
  ): Promise<RuntimeExperimentQueueRecord> {
    return this.updateItem(queueId, input.version, input.item_id, (item, revision) => {
      this.assertFrozenExecution(revision);
      if (TERMINAL_ITEM_STATUSES.has(item.status)) {
        if (item.status !== input.status) {
          throw new Error(`Experiment queue item ${item.item_id} already finished as ${item.status}`);
        }
        return item;
      }
      const completedAt = input.completed_at ?? this.nowIso();
      return {
        ...item,
        status: input.status,
        output_artifacts: input.output_artifacts ?? item.output_artifacts,
        metrics: input.metrics ?? item.metrics,
        ...(input.error ? { error: input.error } : {}),
        completed_at: completedAt,
        updated_at: completedAt,
      };
    });
  }

  async nextExecutionDirective(queueId: string): Promise<RuntimeExperimentQueueExecutionDirective | null> {
    const queue = await this.load(queueId);
    if (!queue) return null;
    const revision = this.currentRevision(queue);
    this.assertFrozenExecution(revision);
    const item = revision.items.find((candidate) => candidate.status === "running")
      ?? revision.items.find((candidate) => candidate.status === "pending");
    if (!item) return null;
    const resume = item.status === "running";
    return {
      mode: "execute_frozen_queue_item",
      queue_id: queue.queue_id,
      version: revision.version,
      phase: revision.phase,
      item,
      idempotency_key: item.idempotency_key,
      resume,
      summary: `${resume ? "Resume" : "Execute"} frozen experiment queue ${queue.queue_id} v${revision.version} item ${item.item_id}`,
    };
  }

  currentRevision(queue: RuntimeExperimentQueueRecord): RuntimeExperimentQueueRevision {
    const revision = queue.revisions.find((candidate) => candidate.version === queue.current_version);
    if (!revision) throw new Error(`Experiment queue ${queue.queue_id} current version is missing`);
    return revision;
  }

  private async update(
    queueId: string,
    updater: (queue: RuntimeExperimentQueueRecord) => RuntimeExperimentQueueRecord,
  ): Promise<RuntimeExperimentQueueRecord> {
    const queue = await this.load(queueId);
    if (!queue) throw new Error(`Experiment queue not found: ${queueId}`);
    return this.save(updater(queue));
  }

  private async updateItem(
    queueId: string,
    version: number | undefined,
    itemId: string,
    updater: (item: RuntimeExperimentQueueItem, revision: RuntimeExperimentQueueRevision) => RuntimeExperimentQueueItem,
  ): Promise<RuntimeExperimentQueueRecord> {
    return this.update(queueId, (queue) => {
      const targetVersion = version ?? queue.current_version;
      let revisionFound = false;
      let itemFound = false;
      const updatedAt = this.nowIso();
      const revisions = queue.revisions.map((revision) => {
        if (revision.version !== targetVersion) return revision;
        revisionFound = true;
        const items = revision.items.map((item) => {
          if (item.item_id !== itemId) return item;
          itemFound = true;
          return updater(item, revision);
        });
        if (!itemFound) return revision;
        const complete = items.length > 0 && items.every((item) => TERMINAL_ITEM_STATUSES.has(item.status));
        const status: RuntimeExperimentQueueRevisionStatus = complete ? "completed" : "executing";
        return {
          ...revision,
          status,
          updated_at: updatedAt,
          items,
        };
      });
      if (!revisionFound) throw new Error(`Experiment queue revision not found: ${queueId} v${targetVersion}`);
      if (!itemFound) throw new Error(`Experiment queue item not found: ${queueId} v${targetVersion} ${itemId}`);
      return {
        ...queue,
        updated_at: updatedAt,
        revisions,
      };
    });
  }

  private async save(queue: RuntimeExperimentQueueRecord): Promise<RuntimeExperimentQueueRecord> {
    const parsed = RuntimeExperimentQueueRecordRuntimeSchema.parse(queue);
    const db = await this.database();
    db.transaction((sqlite) => upsertExperimentQueue(sqlite, parsed));
    return parsed;
  }

  async importLegacyRecord(record: RuntimeExperimentQueueRecord): Promise<RuntimeExperimentQueueRecord> {
    return this.save(RuntimeExperimentQueueRecordRuntimeSchema.parse(record));
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }

  private normalizeItem(input: RuntimeExperimentQueueItemInput, updatedAt: string): RuntimeExperimentQueueItem {
    return RuntimeExperimentQueueItemSchema.parse({
      item_id: input.item_id,
      idempotency_key: input.idempotency_key ?? `${input.item_id}:${stableConfigKey(input.config)}`,
      title: input.title,
      config: input.config,
      status: "pending",
      output_artifacts: [],
      metrics: [],
      updated_at: updatedAt,
      provenance: this.normalizeProvenance(input.provenance),
    });
  }

  private normalizeProvenance(input: RuntimeExperimentQueueProvenanceInput): RuntimeExperimentQueueProvenance {
    return RuntimeExperimentQueueProvenanceSchema.parse(input);
  }

  private assertFrozenExecution(revision: RuntimeExperimentQueueRevision): void {
    if (revision.phase !== "executing_frozen_queue") {
      throw new Error(`Experiment queue revision v${revision.version} is still in ${revision.phase}`);
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

interface ExperimentQueueRow {
  record_json: string;
}

function parseExperimentQueueJson(recordJson: string): RuntimeExperimentQueueRecord | null {
  try {
    const parsed = RuntimeExperimentQueueRecordRuntimeSchema.safeParse(JSON.parse(recordJson) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readExperimentQueue(sqlite: SqliteDatabase, queueId: string): RuntimeExperimentQueueRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM runtime_experiment_queues
    WHERE queue_id = ?
  `).get(queueId) as ExperimentQueueRow | undefined;
  return row ? parseExperimentQueueJson(row.record_json) : null;
}

function listExperimentQueues(sqlite: SqliteDatabase): RuntimeExperimentQueueRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM runtime_experiment_queues
    ORDER BY queue_id ASC
  `).all() as ExperimentQueueRow[];
  return rows.flatMap((row) => {
    const record = parseExperimentQueueJson(row.record_json);
    return record ? [record] : [];
  });
}

function upsertExperimentQueue(sqlite: SqliteDatabase, record: RuntimeExperimentQueueRecord): void {
  sqlite.prepare(`
    INSERT INTO runtime_experiment_queues (
      queue_id,
      goal_id,
      run_id,
      current_version,
      created_at,
      updated_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(queue_id) DO UPDATE SET
      goal_id = excluded.goal_id,
      run_id = excluded.run_id,
      current_version = excluded.current_version,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      record_json = excluded.record_json
  `).run(
    record.queue_id,
    record.goal_id ?? null,
    record.run_id ?? null,
    record.current_version,
    record.created_at,
    record.updated_at,
    JSON.stringify(record),
  );
}

function stableConfigKey(config: Record<string, unknown>): string {
  return stableStringify(config);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
