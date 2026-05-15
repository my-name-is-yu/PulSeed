import { z } from "zod/v3";
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

export const PermissionGrantStateSchema = z.enum([
  "proposed",
  "active",
  "expired",
  "revoked",
  "superseded",
]);
export type PermissionGrantState = z.infer<typeof PermissionGrantStateSchema>;

export const PermissionGrantCapabilitySchema = z.enum([
  "read_workspace",
  "write_workspace",
  "run_tests",
  "run_safe_local_commands",
  "update_memory",
  "update_surface",
  "notify_user",
  "delegate_work",
  "inspect_runtime",
  "prepare_draft",
]);
export type PermissionGrantCapability = z.infer<typeof PermissionGrantCapabilitySchema>;

export const PermissionGrantExcludedCapabilitySchema = z.enum([
  "destructive_action",
  "delete",
  "write_remote",
  "network_send",
  "external_send",
  "secret_change",
  "protected_path_mutation",
  "production_mutation",
  "billing_or_purchase",
  "unknown_capability",
]);
export type PermissionGrantExcludedCapability = z.infer<typeof PermissionGrantExcludedCapabilitySchema>;

export const PermissionGrantSubjectSchema = z.object({
  kind: z.enum(["user", "operator", "agent", "system"]),
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
}).strict();
export type PermissionGrantSubject = z.infer<typeof PermissionGrantSubjectSchema>;

export const PermissionGrantOriginSchema = z.object({
  channel: z.string().min(1),
  platform: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  turn_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  reply_target: z.unknown().optional(),
}).strict();
export type PermissionGrantOrigin = z.infer<typeof PermissionGrantOriginSchema>;

const PermissionGrantRedactedSourceSchema = z.object({
  kind: z.literal("redacted_text"),
  redacted_text: z.string().min(1),
  redaction_reason: z.string().min(1).optional(),
}).strict();

const PermissionGrantSourceRefSchema = z.object({
  kind: z.literal("source_ref"),
  ref: z.string().min(1),
  redaction_reason: z.string().min(1).optional(),
}).strict();

export const PermissionGrantSourceSchema = z.discriminatedUnion("kind", [
  PermissionGrantRedactedSourceSchema,
  PermissionGrantSourceRefSchema,
]);
export type PermissionGrantSource = z.infer<typeof PermissionGrantSourceSchema>;

const PermissionGrantSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();
const PermissionGrantSafePositiveIntSchema = z.number().int().positive().safe();

export const PermissionGrantScopeSchema = z.object({
  kind: z.enum(["turn", "run", "goal", "session", "workspace", "project", "global"]),
  turn_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  goal_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  workspace_root: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
}).strict().superRefine((scope, ctx) => {
  const requiredByScope = {
    turn: "turn_id",
    run: "run_id",
    goal: "goal_id",
    session: "session_id",
    workspace: "workspace_root",
    project: "project_id",
  } as const;
  if (scope.kind === "global") return;
  const requiredField = requiredByScope[scope.kind];
  if (!scope[requiredField]) {
    ctx.addIssue({
      code: "custom",
      path: [requiredField],
      message: `${scope.kind} permission scope requires ${requiredField}`,
    });
  }
});
export type PermissionGrantScope = z.infer<typeof PermissionGrantScopeSchema>;

export const PermissionGrantDurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once") }).strict(),
  z.object({ kind: z.literal("until_run_done") }).strict(),
  z.object({ kind: z.literal("until_goal_done") }).strict(),
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("standing") }).strict(),
  z.object({
    kind: z.literal("expires_at"),
    expires_at: PermissionGrantSafeNonnegativeIntSchema,
  }).strict(),
]);
export type PermissionGrantDuration = z.infer<typeof PermissionGrantDurationSchema>;

export const PermissionGrantReviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("periodic"),
    interval_ms: PermissionGrantSafePositiveIntSchema,
    due_at: PermissionGrantSafeNonnegativeIntSchema,
    last_reviewed_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  }).strict(),
]);
export type PermissionGrantReview = z.infer<typeof PermissionGrantReviewSchema>;

export const PermissionGrantFreshnessBindingSchema = z.object({
  permission_state_epoch: PermissionGrantSafeNonnegativeIntSchema.optional(),
  project_state_ref: z.string().min(1).optional(),
  goal_state_ref: z.string().min(1).optional(),
  session_state_ref: z.string().min(1).optional(),
  surface_state_ref: z.string().min(1).optional(),
  relationship_state_ref: z.string().min(1).optional(),
  world_state_ref: z.string().min(1).optional(),
}).strict();
export type PermissionGrantFreshnessBinding = z.infer<typeof PermissionGrantFreshnessBindingSchema>;

export const PermissionGrantStalenessSchema = z.object({
  status: z.enum(["fresh", "stale", "unknown"]).default("fresh"),
  checked_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  stale_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  reason: z.string().min(1).optional(),
  binding: PermissionGrantFreshnessBindingSchema.default({}),
}).strict();
export type PermissionGrantStaleness = z.infer<typeof PermissionGrantStalenessSchema>;

export const PermissionGrantRecordSchema = z.object({
  schema_version: z.literal("permission-grant-v1"),
  grant_id: z.string().min(1),
  subject: PermissionGrantSubjectSchema,
  origin: PermissionGrantOriginSchema,
  source: PermissionGrantSourceSchema,
  scope: PermissionGrantScopeSchema,
  duration: PermissionGrantDurationSchema,
  review: PermissionGrantReviewSchema.default({ kind: "none" }),
  capabilities: z.array(PermissionGrantCapabilitySchema).min(1),
  excluded_capabilities: z.array(PermissionGrantExcludedCapabilitySchema).default([]),
  state: PermissionGrantStateSchema,
  state_version: PermissionGrantSafeNonnegativeIntSchema,
  state_epoch: PermissionGrantSafeNonnegativeIntSchema,
  staleness: PermissionGrantStalenessSchema.default({ status: "fresh" }),
  created_at: PermissionGrantSafeNonnegativeIntSchema,
  updated_at: PermissionGrantSafeNonnegativeIntSchema,
  activated_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  expired_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  revoked_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  revoked_by: z.string().min(1).optional(),
  revocation_reason: z.string().min(1).optional(),
  superseded_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  supersedes: z.array(z.string().min(1)).default([]),
  superseded_by: z.string().min(1).optional(),
  last_used_at: PermissionGrantSafeNonnegativeIntSchema.optional(),
  usage_count: PermissionGrantSafeNonnegativeIntSchema.default(0),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((grant, ctx) => {
  for (const [pathName, values] of [
    ["capabilities", grant.capabilities],
    ["excluded_capabilities", grant.excluded_capabilities],
    ["audit_refs", grant.audit_refs],
    ["supersedes", grant.supersedes],
  ] as const) {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) {
        ctx.addIssue({
          code: "custom",
          path: [pathName],
          message: `duplicate permission grant ${pathName}: ${value}`,
        });
      }
      seen.add(value);
    }
  }
  if (grant.state === "active" && grant.activated_at === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["activated_at"],
      message: "active permission grants require activated_at",
    });
  }
  if (grant.state === "expired" && grant.expired_at === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["expired_at"],
      message: "expired permission grants require expired_at",
    });
  }
  if (grant.state === "revoked" && grant.revoked_at === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["revoked_at"],
      message: "revoked permission grants require revoked_at",
    });
  }
  if (grant.state === "superseded" && !grant.superseded_by) {
    ctx.addIssue({
      code: "custom",
      path: ["superseded_by"],
      message: "superseded permission grants require superseded_by",
    });
  }
  if (grant.duration.kind === "standing" && grant.review.kind === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["review"],
      message: "standing permission grants require an explicit review policy",
    });
  }
});
export type PermissionGrantRecord = z.infer<typeof PermissionGrantRecordSchema>;
const PermissionGrantRecordRuntimeSchema = PermissionGrantRecordSchema as unknown as z.ZodType<PermissionGrantRecord>;

export interface PermissionGrantCreateInput {
  grant_id: string;
  subject: PermissionGrantSubject;
  origin: PermissionGrantOrigin;
  source: PermissionGrantSource;
  scope: PermissionGrantScope;
  duration: PermissionGrantDuration;
  review?: PermissionGrantReview;
  capabilities: PermissionGrantCapability[];
  excluded_capabilities?: PermissionGrantExcludedCapability[];
  staleness?: PermissionGrantStaleness;
  audit_refs?: string[];
  supersedes?: string[];
  created_at?: number;
}

export interface PermissionGrantRevocationInput {
  revoked_at?: number;
  revoked_by?: string;
  reason?: string;
  audit_refs?: string[];
}

export interface PermissionGrantStaleInput {
  stale_at?: number;
  reason: string;
  audit_refs?: string[];
}

export interface PermissionGrantReviewInput {
  reviewed_at?: number;
  next_review_due_at: number;
  audit_refs?: string[];
}

export function isPermissionGrantExpired(record: PermissionGrantRecord, now = Date.now()): boolean {
  if (record.state === "expired") return true;
  return record.duration.kind === "expires_at" && record.duration.expires_at <= now;
}

export function isPermissionGrantReviewDue(record: PermissionGrantRecord, now = Date.now()): boolean {
  return record.review.kind === "periodic" && record.review.due_at <= now;
}

export function isPermissionGrantStale(record: PermissionGrantRecord): boolean {
  return record.staleness.status !== "fresh";
}

export function isPermissionGrantCurrentlyActive(record: PermissionGrantRecord, now = Date.now()): boolean {
  return record.state === "active"
    && !isPermissionGrantExpired(record, now)
    && !isPermissionGrantReviewDue(record, now)
    && !isPermissionGrantStale(record)
    && !(record.duration.kind === "once" && record.usage_count > 0);
}

export class PermissionGrantStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;
  private readonly now: () => number;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions & { now?: () => number } = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
    this.now = options.now ?? (() => Date.now());
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async load(grantId: string): Promise<PermissionGrantRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readPermissionGrant(sqlite, grantId));
  }

  async list(): Promise<PermissionGrantRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listPermissionGrants(sqlite));
  }

  async listByState(state: PermissionGrantState): Promise<PermissionGrantRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listPermissionGrants(sqlite, "state = ?", [state]));
  }

  async listActive(now = this.now()): Promise<PermissionGrantRecord[]> {
    const grants = await this.list();
    return grants.filter((grant) => isPermissionGrantCurrentlyActive(grant, now));
  }

  async createProposed(input: PermissionGrantCreateInput): Promise<PermissionGrantRecord> {
    return this.create(input, "proposed");
  }

  async createActive(input: PermissionGrantCreateInput): Promise<PermissionGrantRecord> {
    return this.create(input, "active");
  }

  async activate(grantId: string, options: { activated_at?: number; audit_refs?: string[] } = {}): Promise<PermissionGrantRecord | null> {
    return this.update(grantId, (grant) => {
      if (grant.state !== "proposed" && grant.state !== "active") return grant;
      const activatedAt = options.activated_at ?? this.now();
      return {
        ...grant,
        state: "active",
        state_version: grant.state_version + 1,
        state_epoch: activatedAt,
        activated_at: grant.activated_at ?? activatedAt,
        updated_at: activatedAt,
        audit_refs: appendUnique(grant.audit_refs, options.audit_refs ?? []),
      };
    });
  }

  async expire(grantId: string, expiredAt = this.now(), auditRefs: string[] = []): Promise<PermissionGrantRecord | null> {
    return this.update(grantId, (grant) => ({
      ...grant,
      state: "expired",
      state_version: grant.state_version + 1,
      state_epoch: expiredAt,
      expired_at: expiredAt,
      updated_at: expiredAt,
      audit_refs: appendUnique(grant.audit_refs, auditRefs),
    }));
  }

  async revoke(grantId: string, input: PermissionGrantRevocationInput = {}): Promise<PermissionGrantRecord | null> {
    return this.update(grantId, (grant) => {
      const revokedAt = input.revoked_at ?? this.now();
      return {
        ...grant,
        state: "revoked",
        state_version: grant.state_version + 1,
        state_epoch: revokedAt,
        revoked_at: revokedAt,
        ...(input.revoked_by ? { revoked_by: input.revoked_by } : {}),
        ...(input.reason ? { revocation_reason: input.reason } : {}),
        updated_at: revokedAt,
        audit_refs: appendUnique(grant.audit_refs, input.audit_refs ?? []),
      };
    });
  }

  async markStale(grantId: string, input: PermissionGrantStaleInput): Promise<PermissionGrantRecord | null> {
    return this.update(grantId, (grant) => {
      const staleAt = input.stale_at ?? this.now();
      return {
        ...grant,
        updated_at: staleAt,
        staleness: {
          ...grant.staleness,
          status: "stale",
          checked_at: staleAt,
          stale_at: staleAt,
          reason: input.reason,
        },
        audit_refs: appendUnique(grant.audit_refs, input.audit_refs ?? []),
      };
    });
  }

  async review(grantId: string, input: PermissionGrantReviewInput): Promise<PermissionGrantRecord | null> {
    return this.update(grantId, (grant) => {
      if (grant.state !== "active") return grant;
      const reviewedAt = input.reviewed_at ?? this.now();
      const intervalMs = Math.max(input.next_review_due_at - reviewedAt, 1);
      return {
        ...grant,
        state_version: grant.state_version + 1,
        state_epoch: reviewedAt,
        updated_at: reviewedAt,
        review: {
          kind: "periodic",
          interval_ms: intervalMs,
          due_at: input.next_review_due_at,
          last_reviewed_at: reviewedAt,
        },
        staleness: {
          ...grant.staleness,
          status: "fresh",
          checked_at: reviewedAt,
        },
        audit_refs: appendUnique(grant.audit_refs, input.audit_refs ?? []),
      };
    });
  }

  async recordUse(grantId: string, input: { used_at?: number; audit_ref?: string } = {}): Promise<PermissionGrantRecord | null> {
    return this.update(grantId, (grant) => {
      const usedAt = input.used_at ?? this.now();
      const usageCount = grant.usage_count + 1;
      const next: PermissionGrantRecord = {
        ...grant,
        updated_at: usedAt,
        last_used_at: usedAt,
        usage_count: usageCount,
        audit_refs: appendUnique(grant.audit_refs, input.audit_ref ? [input.audit_ref] : []),
      };
      if (grant.duration.kind !== "once") return next;
      return {
        ...next,
        state: "expired",
        state_version: grant.state_version + 1,
        state_epoch: usedAt,
        expired_at: usedAt,
      };
    }, { requireActive: true });
  }

  async supersede(
    grantId: string,
    replacementInput: PermissionGrantCreateInput,
    options: { superseded_at?: number; audit_refs?: string[] } = {},
  ): Promise<{ superseded: PermissionGrantRecord; replacement: PermissionGrantRecord } | null> {
    const current = await this.load(grantId);
    if (!current) return null;
    const supersededAt = PermissionGrantSafeNonnegativeIntSchema.parse(options.superseded_at ?? this.now());
    const replacement = await this.createProposed({
      ...replacementInput,
      supersedes: appendUnique(replacementInput.supersedes ?? [], [grantId]),
      created_at: replacementInput.created_at ?? supersededAt,
    });
    const superseded = await this.update(grantId, (grant) => ({
      ...grant,
      state: "superseded",
      state_version: grant.state_version + 1,
      state_epoch: supersededAt,
      superseded_at: supersededAt,
      superseded_by: replacement.grant_id,
      updated_at: supersededAt,
      audit_refs: appendUnique(grant.audit_refs, options.audit_refs ?? []),
    }));
    if (!superseded) return null;
    return { superseded, replacement };
  }

  async importLegacyRecord(record: PermissionGrantRecord): Promise<PermissionGrantRecord> {
    return this.save(record);
  }

  private async create(input: PermissionGrantCreateInput, state: "proposed" | "active"): Promise<PermissionGrantRecord> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const existing = readPermissionGrant(sqlite, input.grant_id);
      if (existing) throw new Error(`Permission grant already exists: ${input.grant_id}`);
      const now = input.created_at ?? this.now();
      const record = PermissionGrantRecordSchema.parse({
        schema_version: "permission-grant-v1",
        grant_id: input.grant_id,
        subject: input.subject,
        origin: input.origin,
        source: input.source,
        scope: input.scope,
        duration: input.duration,
        review: input.review ?? { kind: "none" },
        capabilities: unique(input.capabilities),
        excluded_capabilities: unique(input.excluded_capabilities ?? []),
        state,
        state_version: 0,
        state_epoch: now,
        staleness: input.staleness ?? { status: "fresh", checked_at: now },
        created_at: now,
        updated_at: now,
        ...(state === "active" ? { activated_at: now } : {}),
        supersedes: unique(input.supersedes ?? []),
        usage_count: 0,
        audit_refs: unique(input.audit_refs ?? []),
      });
      upsertPermissionGrant(sqlite, record);
      return record;
    });
  }

  private async update(
    grantId: string,
    updater: (grant: PermissionGrantRecord) => PermissionGrantRecord,
    options: { requireActive?: boolean } = {},
  ): Promise<PermissionGrantRecord | null> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readPermissionGrant(sqlite, grantId);
      if (!current) return null;
      if (options.requireActive && !isPermissionGrantCurrentlyActive(current, this.now())) return null;
      const updated = PermissionGrantRecordSchema.parse(updater(current));
      upsertPermissionGrant(sqlite, updated);
      return updated;
    });
  }

  private async save(record: PermissionGrantRecord): Promise<PermissionGrantRecord> {
    const parsed = PermissionGrantRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertPermissionGrant(sqlite, parsed);
    });
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function appendUnique<T extends string>(current: T[], additions: T[]): T[] {
  return unique([...current, ...additions]);
}

interface PermissionGrantRow {
  record_json: string;
}

function parsePermissionGrantJson(recordJson: string): PermissionGrantRecord {
  return PermissionGrantRecordRuntimeSchema.parse(JSON.parse(recordJson) as unknown);
}

function readPermissionGrant(sqlite: SqliteDatabase, grantId: string): PermissionGrantRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM permission_grants
    WHERE grant_id = ?
  `).get(grantId) as PermissionGrantRow | undefined;
  return row ? parsePermissionGrantJson(row.record_json) : null;
}

function listPermissionGrants(sqlite: SqliteDatabase, whereSql = "1 = 1", params: unknown[] = []): PermissionGrantRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM permission_grants
    WHERE ${whereSql}
    ORDER BY updated_at ASC, grant_id ASC
  `).all(...params) as PermissionGrantRow[];
  return rows.map((row) => parsePermissionGrantJson(row.record_json));
}

function permissionGrantExpiresAt(record: PermissionGrantRecord): number | null {
  return record.duration.kind === "expires_at" ? record.duration.expires_at : null;
}

function permissionGrantReviewDueAt(record: PermissionGrantRecord): number | null {
  return record.review.kind === "periodic" ? record.review.due_at : null;
}

function upsertPermissionGrant(sqlite: SqliteDatabase, record: PermissionGrantRecord): void {
  sqlite.prepare(`
    INSERT INTO permission_grants (
      grant_id,
      state,
      scope_kind,
      subject_kind,
      subject_id,
      created_at,
      updated_at,
      state_epoch,
      expires_at,
      review_due_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(grant_id) DO UPDATE SET
      state = excluded.state,
      scope_kind = excluded.scope_kind,
      subject_kind = excluded.subject_kind,
      subject_id = excluded.subject_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      state_epoch = excluded.state_epoch,
      expires_at = excluded.expires_at,
      review_due_at = excluded.review_due_at,
      record_json = excluded.record_json
  `).run(
    record.grant_id,
    record.state,
    record.scope.kind,
    record.subject.kind,
    record.subject.id,
    record.created_at,
    record.updated_at,
    record.state_epoch,
    permissionGrantExpiresAt(record),
    permissionGrantReviewDueAt(record),
    JSON.stringify(record),
  );
}
