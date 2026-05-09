import { z } from "zod";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import { ApprovalOriginSchema } from "./runtime-schemas.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export const PermissionWaitPlanStateSchema = z.enum([
  "waiting_for_permission",
  "approved",
  "denied",
  "expired",
  "cancelled",
  "resumed",
  "mismatch_rejected",
]);
export type PermissionWaitPlanState = z.infer<typeof PermissionWaitPlanStateSchema>;

export const PermissionWaitPlanTargetSchema = z.object({
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  turn_id: z.string().min(1).optional(),
  tool_call_id: z.string().min(1).optional(),
}).strict();
export type PermissionWaitPlanTarget = z.infer<typeof PermissionWaitPlanTargetSchema>;

export const PermissionWaitPlanPermissionSchema = z.object({
  permission_level: z.string().min(1),
  is_destructive: z.boolean(),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]),
}).strict();
export type PermissionWaitPlanPermission = z.infer<typeof PermissionWaitPlanPermissionSchema>;

export const PermissionWaitPlanCapabilityFactsSchema = z.object({
  tool_permission_level: z.string().min(1),
  tool_is_read_only: z.boolean(),
  tool_is_destructive: z.boolean(),
  tool_requires_network: z.boolean().optional(),
  tool_activity_category: z.string().min(1).optional(),
  tool_tags: z.array(z.string()).default([]),
  host_decision_status: z.string().min(1).optional(),
  host_decision_reason: z.string().min(1).optional(),
  permission_grant_status: z.string().min(1).optional(),
  permission_grant_reason: z.string().min(1).optional(),
}).strict();
export type PermissionWaitPlanCapabilityFacts = z.infer<typeof PermissionWaitPlanCapabilityFactsSchema>;

const PermissionWaitPlanSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();

export const PermissionWaitCanonicalPlanSchema = z.object({
  schema_version: z.literal("permission-wait-canonical-plan-v1"),
  tool_name: z.string().min(1),
  input: z.unknown(),
  cwd: z.string().min(1),
  command: z.string().min(1).optional(),
  target: PermissionWaitPlanTargetSchema,
  permission: PermissionWaitPlanPermissionSchema,
  state_epoch: z.string().min(1).optional(),
  capability_facts: PermissionWaitPlanCapabilityFactsSchema,
}).strict();
export type PermissionWaitCanonicalPlan = z.infer<typeof PermissionWaitCanonicalPlanSchema>;

export const PermissionWaitPlanAuditEventSchema = z.object({
  event_id: z.string().min(1),
  state: PermissionWaitPlanStateSchema,
  created_at: PermissionWaitPlanSafeNonnegativeIntSchema,
  reason: z.string().min(1).optional(),
  response_channel: z.string().min(1).optional(),
  audit_refs: z.array(z.string()).default([]),
  mismatch_reasons: z.array(z.string()).optional(),
}).strict();
export type PermissionWaitPlanAuditEvent = z.infer<typeof PermissionWaitPlanAuditEventSchema>;

export const PermissionWaitPlanRecordSchema = z.object({
  schema_version: z.literal("permission-wait-plan-v1"),
  wait_plan_id: z.string().min(1),
  approval_id: z.string().min(1),
  goal_id: z.string().min(1).optional(),
  state: PermissionWaitPlanStateSchema,
  created_at: PermissionWaitPlanSafeNonnegativeIntSchema,
  updated_at: PermissionWaitPlanSafeNonnegativeIntSchema,
  expires_at: PermissionWaitPlanSafeNonnegativeIntSchema.optional(),
  resolved_at: PermissionWaitPlanSafeNonnegativeIntSchema.optional(),
  resumed_at: PermissionWaitPlanSafeNonnegativeIntSchema.optional(),
  origin: ApprovalOriginSchema.optional(),
  canonical_plan: PermissionWaitCanonicalPlanSchema,
  audit_refs: z.array(z.string()).default([]),
  audit_events: z.array(PermissionWaitPlanAuditEventSchema).default([]),
}).strict();
export type PermissionWaitPlanRecord = z.infer<typeof PermissionWaitPlanRecordSchema>;

const PermissionWaitPlanRecordRuntimeSchema =
  PermissionWaitPlanRecordSchema as unknown as z.ZodType<PermissionWaitPlanRecord>;

export interface PermissionWaitPlanCreateInput {
  wait_plan_id: string;
  approval_id?: string;
  goal_id?: string;
  expires_at?: number;
  origin?: z.infer<typeof ApprovalOriginSchema>;
  canonical_plan: PermissionWaitCanonicalPlan;
  audit_refs?: string[];
}

export type PermissionWaitPlanResumeResult =
  | { status: "resumed"; record: PermissionWaitPlanRecord }
  | { status: "mismatch_rejected"; record: PermissionWaitPlanRecord; mismatch_reasons: string[] }
  | { status: "expired"; record: PermissionWaitPlanRecord }
  | { status: "not_approved"; record: PermissionWaitPlanRecord }
  | { status: "not_found" };

export class PermissionWaitPlanStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;
  private readonly now: () => number;
  private readonly createEventId: () => string;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions & { now?: () => number; createEventId?: () => string } = {},
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
    this.now = options.now ?? (() => Date.now());
    this.createEventId =
      options.createEventId ?? (() => `permission-wait-event-${this.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async load(waitPlanId: string): Promise<PermissionWaitPlanRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readPermissionWaitPlan(sqlite, waitPlanId));
  }

  async list(): Promise<PermissionWaitPlanRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listPermissionWaitPlans(sqlite));
  }

  async listByState(state: PermissionWaitPlanState): Promise<PermissionWaitPlanRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listPermissionWaitPlans(sqlite, "state = ?", [state]));
  }

  async createWaiting(input: PermissionWaitPlanCreateInput): Promise<PermissionWaitPlanRecord> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const existing = readPermissionWaitPlan(sqlite, input.wait_plan_id);
      if (existing) return existing;
      const now = this.now();
      const record = PermissionWaitPlanRecordSchema.parse({
        schema_version: "permission-wait-plan-v1",
        wait_plan_id: input.wait_plan_id,
        approval_id: input.approval_id ?? input.wait_plan_id,
        ...(input.goal_id ? { goal_id: input.goal_id } : {}),
        state: "waiting_for_permission",
        created_at: now,
        updated_at: now,
        ...(input.expires_at ? { expires_at: input.expires_at } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        canonical_plan: input.canonical_plan,
        audit_refs: input.audit_refs ?? [],
        audit_events: [
          this.event("waiting_for_permission", {
            reason: "approval_required",
            auditRefs: input.audit_refs ?? [],
          }),
        ],
      });
      upsertPermissionWaitPlan(sqlite, record);
      return record;
    });
  }

  async markApproved(
    waitPlanId: string,
    input: { resolved_at?: number; response_channel?: string; audit_refs?: string[] } = {},
  ): Promise<PermissionWaitPlanRecord | null> {
    return this.transition(waitPlanId, "approved", {
      resolvedAt: input.resolved_at,
      responseChannel: input.response_channel,
      auditRefs: input.audit_refs,
    });
  }

  async markDenied(
    waitPlanId: string,
    input: { resolved_at?: number; response_channel?: string; reason?: string; audit_refs?: string[] } = {},
  ): Promise<PermissionWaitPlanRecord | null> {
    return this.transition(waitPlanId, "denied", {
      resolvedAt: input.resolved_at,
      responseChannel: input.response_channel,
      reason: input.reason,
      auditRefs: input.audit_refs,
    });
  }

  async markExpired(
    waitPlanId: string,
    input: { resolved_at?: number; reason?: string; audit_refs?: string[] } = {},
  ): Promise<PermissionWaitPlanRecord | null> {
    return this.transition(waitPlanId, "expired", {
      resolvedAt: input.resolved_at,
      reason: input.reason ?? "approval_expired",
      auditRefs: input.audit_refs,
    });
  }

  async markCancelled(
    waitPlanId: string,
    input: { resolved_at?: number; response_channel?: string; reason?: string; audit_refs?: string[] } = {},
  ): Promise<PermissionWaitPlanRecord | null> {
    return this.transition(waitPlanId, "cancelled", {
      resolvedAt: input.resolved_at,
      responseChannel: input.response_channel,
      reason: input.reason,
      auditRefs: input.audit_refs,
    });
  }

  async resumeApproved(
    waitPlanId: string,
    input: {
      canonical_plan: PermissionWaitCanonicalPlan;
      resumed_at?: number;
      audit_refs?: string[];
    },
  ): Promise<PermissionWaitPlanResumeResult> {
    const current = await this.load(waitPlanId);
    if (!current) return { status: "not_found" };
    if (current.state === "expired") return { status: "expired", record: current };

    const now = this.now();
    if (
      (current.state === "waiting_for_permission" || current.state === "approved")
      && current.expires_at !== undefined
      && current.expires_at <= now
    ) {
      const expired = await this.markExpired(waitPlanId, {
        resolved_at: now,
        reason: "approval_expired_before_resume",
        audit_refs: input.audit_refs,
      });
      return { status: "expired", record: expired ?? current };
    }

    if (current.state !== "approved") {
      return { status: "not_approved", record: current };
    }

    const mismatchReasons = diffPermissionWaitCanonicalPlans(current.canonical_plan, input.canonical_plan);
    if (mismatchReasons.length > 0) {
      const rejected = await this.save({
        ...current,
        state: "mismatch_rejected",
        updated_at: now,
        resolved_at: now,
        audit_refs: mergeRefs(current.audit_refs, input.audit_refs ?? []),
        audit_events: [
          ...current.audit_events,
          this.event("mismatch_rejected", {
            reason: "canonical_plan_mismatch",
            auditRefs: input.audit_refs ?? [],
            mismatchReasons,
          }),
        ],
      });
      return { status: "mismatch_rejected", record: rejected, mismatch_reasons: mismatchReasons };
    }

    const resumedAt = input.resumed_at ?? now;
    const resumed = await this.save({
      ...current,
      state: "resumed",
      resumed_at: resumedAt,
      updated_at: resumedAt,
      audit_refs: mergeRefs(current.audit_refs, input.audit_refs ?? []),
      audit_events: [
        ...current.audit_events,
        this.event("resumed", {
          reason: "approved_plan_resumed",
          auditRefs: input.audit_refs ?? [],
        }),
      ],
    });
    return { status: "resumed", record: resumed };
  }

  async importLegacyRecord(record: PermissionWaitPlanRecord): Promise<PermissionWaitPlanRecord> {
    return this.save(record);
  }

  private async transition(
    waitPlanId: string,
    state: PermissionWaitPlanState,
    input: {
      resolvedAt?: number;
      responseChannel?: string;
      reason?: string;
      auditRefs?: string[];
    },
  ): Promise<PermissionWaitPlanRecord | null> {
    const current = await this.load(waitPlanId);
    if (!current) return null;
    if (isTerminalPermissionWaitPlanState(current.state)) return current;
    if (current.state === state) return current;
    const resolvedAt = input.resolvedAt ?? this.now();
    return this.save({
      ...current,
      state,
      updated_at: resolvedAt,
      resolved_at: resolvedAt,
      audit_refs: mergeRefs(current.audit_refs, input.auditRefs ?? []),
      audit_events: [
        ...current.audit_events,
        this.event(state, {
          reason: input.reason,
          responseChannel: input.responseChannel,
          auditRefs: input.auditRefs ?? [],
        }),
      ],
    });
  }

  private event(
    state: PermissionWaitPlanState,
    input: {
      reason?: string;
      responseChannel?: string;
      auditRefs?: string[];
      mismatchReasons?: string[];
    } = {},
  ): PermissionWaitPlanAuditEvent {
    return PermissionWaitPlanAuditEventSchema.parse({
      event_id: this.createEventId(),
      state,
      created_at: this.now(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.responseChannel ? { response_channel: input.responseChannel } : {}),
      audit_refs: input.auditRefs ?? [],
      ...(input.mismatchReasons ? { mismatch_reasons: input.mismatchReasons } : {}),
    });
  }

  private async save(record: PermissionWaitPlanRecord): Promise<PermissionWaitPlanRecord> {
    const parsed = PermissionWaitPlanRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertPermissionWaitPlan(sqlite, parsed);
    });
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

export function diffPermissionWaitCanonicalPlans(
  expected: PermissionWaitCanonicalPlan,
  actual: PermissionWaitCanonicalPlan,
): string[] {
  const reasons: string[] = [];
  if (expected.tool_name !== actual.tool_name) reasons.push("tool_name_changed");
  if (expected.cwd !== actual.cwd) reasons.push("cwd_changed");
  if ((expected.command ?? null) !== (actual.command ?? null)) reasons.push("command_changed");
  if ((expected.state_epoch ?? null) !== (actual.state_epoch ?? null)) reasons.push("state_epoch_changed");
  if (stableJson(expected.target) !== stableJson(actual.target)) reasons.push("target_changed");
  if (stableJson(expected.permission) !== stableJson(actual.permission)) reasons.push("permission_changed");
  if (stableJson(expected.capability_facts) !== stableJson(actual.capability_facts)) reasons.push("capability_facts_changed");
  if (stableJson(expected.input) !== stableJson(actual.input)) reasons.push("input_changed");
  return reasons;
}

export function isTerminalPermissionWaitPlanState(state: PermissionWaitPlanState): boolean {
  return state === "denied"
    || state === "expired"
    || state === "cancelled"
    || state === "resumed"
    || state === "mismatch_rejected";
}

function mergeRefs(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next])];
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

interface PermissionWaitPlanRow {
  record_json: string;
}

function parsePermissionWaitPlanJson(recordJson: string): PermissionWaitPlanRecord {
  return PermissionWaitPlanRecordRuntimeSchema.parse(JSON.parse(recordJson) as unknown);
}

function readPermissionWaitPlan(sqlite: SqliteDatabase, waitPlanId: string): PermissionWaitPlanRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM permission_wait_plans
    WHERE wait_plan_id = ?
  `).get(waitPlanId) as PermissionWaitPlanRow | undefined;
  return row ? parsePermissionWaitPlanJson(row.record_json) : null;
}

function listPermissionWaitPlans(
  sqlite: SqliteDatabase,
  whereSql = "1 = 1",
  params: unknown[] = []
): PermissionWaitPlanRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM permission_wait_plans
    WHERE ${whereSql}
    ORDER BY updated_at ASC, wait_plan_id ASC
  `).all(...params) as PermissionWaitPlanRow[];
  return rows.map((row) => parsePermissionWaitPlanJson(row.record_json));
}

function upsertPermissionWaitPlan(sqlite: SqliteDatabase, record: PermissionWaitPlanRecord): void {
  sqlite.prepare(`
    INSERT INTO permission_wait_plans (
      wait_plan_id,
      approval_id,
      goal_id,
      state,
      created_at,
      updated_at,
      expires_at,
      resolved_at,
      resumed_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(wait_plan_id) DO UPDATE SET
      approval_id = excluded.approval_id,
      goal_id = excluded.goal_id,
      state = excluded.state,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at,
      resolved_at = excluded.resolved_at,
      resumed_at = excluded.resumed_at,
      record_json = excluded.record_json
  `).run(
    record.wait_plan_id,
    record.approval_id,
    record.goal_id ?? null,
    record.state,
    record.created_at,
    record.updated_at,
    record.expires_at ?? null,
    record.resolved_at ?? null,
    record.resumed_at ?? null,
    JSON.stringify(record),
  );
}
