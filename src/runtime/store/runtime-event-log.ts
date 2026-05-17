import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  ExecutionAuthorityDecisionSchema,
  type ExecutionAuthorityDecision,
} from "../control/execution-authority-decision.js";
import { GoalSchema, type Goal } from "../../base/types/goal.js";
import { TaskSchema, type Task } from "../../base/types/task.js";
import {
  PersonalAgentCallerPathSchema,
  PersonalAgentDecisionTraceSchema,
  RuntimeGraphEdgeSchema,
  RuntimeGraphNodeSchema,
  type PersonalAgentDecisionTrace,
  type RuntimeGraphEdge,
  type RuntimeGraphNode,
  type RuntimeGraphRef,
} from "../personal-agent/contracts.js";
import {
  CommitmentCandidateSchema,
  CommitmentLifecycleControlSchema,
  type CommitmentCandidate,
  type CommitmentLifecycleControl,
} from "../attention/commitment-candidate.js";
import {
  RuntimeControlOperationSchema,
  type RuntimeControlOperation,
} from "./runtime-operation-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  createRuntimeControlDatabaseOwner,
  type ControlDatabase,
  type ControlDatabaseHandleOwner,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

const RuntimeEventRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
}).strict();

const RuntimeEventActorSchema = z.object({
  kind: z.enum(["user", "operator", "runtime", "daemon", "gateway", "scheduler", "tool", "system", "unknown"]),
  ref: z.string().min(1).optional(),
}).strict();

export const RuntimeEventTypeSchema = z.enum([
  "personal_agent.trace.recorded",
  "runtime_control.operation.recorded",
  "approval.resume.recorded",
  "tool.call.recorded",
  "notification.dispatch.recorded",
  "outbox.enqueue.recorded",
  "gateway.chat.ingress.recorded",
  "gateway.telegram.delivery.recorded",
  "gateway.telegram.callback.recorded",
  "memory.correction.recorded",
  "memory.truth_maintenance.recorded",
  "schedule.wake.recorded",
  "daemon.resident_initiative.recorded",
  "interaction_authority.decision.recorded",
  "surface.projection.recorded",
  "projection.rebuild.recorded",
  "goal.mutation.recorded",
  "task.mutation.recorded",
  "attention.commitment.recorded",
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

export const RuntimeEventReplayPolicySchema = z.object({
  mode: z.enum(["append_only", "dedupe_by_idempotency_key", "projection_rebuild", "side_effect_guard"]),
  duplicate_side_effect_policy: z.enum(["never_repeat", "repeat_allowed", "projection_only"]).default("never_repeat"),
  idempotency_scope: z.string().min(1),
}).strict();
export type RuntimeEventReplayPolicy = z.infer<typeof RuntimeEventReplayPolicySchema>;

const RuntimePersonalAgentTraceEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/personal-agent-trace/v1"),
  trace: PersonalAgentDecisionTraceSchema,
}).strict();

const RuntimeAuthorityDecisionEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/authority-decision/v1"),
  decision: ExecutionAuthorityDecisionSchema,
}).strict();

const RuntimeProjectionRebuildEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/projection-rebuild/v1"),
  rebuild_id: z.string().min(1),
  dry_run: z.boolean(),
  projection_names: z.array(z.string().min(1)),
  summary: z.record(z.unknown()),
}).strict();

const RuntimeGoalTaskMutationEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/goal-task-mutation/v1"),
  mutation: z.discriminatedUnion("entity_kind", [
    z.object({
      entity_kind: z.literal("goal"),
      action: z.enum(["save", "archive", "delete"]),
      goal: GoalSchema,
    }).strict(),
    z.object({
      entity_kind: z.literal("task"),
      action: z.enum(["save", "delete"]),
      goal_id: z.string().min(1),
      task_id: z.string().min(1),
      task: TaskSchema.nullable(),
    }).strict(),
  ]),
}).strict();

const RuntimeControlOperationEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/runtime-control-operation/v1"),
  operation: RuntimeControlOperationSchema,
  previous_operation: RuntimeControlOperationSchema.nullable().default(null),
}).strict();

const RuntimeMemoryTruthMaintenanceEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/memory-truth-maintenance/v1"),
  operation: z.enum(["snapshot", "correction", "recall", "projection_rebuild"]),
  correction_ref: z.record(z.unknown()).nullable().default(null),
  claim_ids: z.array(z.string().min(1)).default([]),
  projection_ids: z.array(z.string().min(1)).default([]),
  recall_ids: z.array(z.string().min(1)).default([]),
  tombstone_ids: z.array(z.string().min(1)).default([]),
  conflict_set_ids: z.array(z.string().min(1)).default([]),
  owner: z.object({
    kind: z.string().min(1),
    scope: z.string().min(1),
  }).strict(),
}).strict();

const RuntimeAttentionCommitmentEventPayloadSchema = z.object({
  schema_version: z.literal("runtime-event-payload/attention-commitment/v1"),
  operation: z.enum(["candidate_saved", "lifecycle_control_applied", "projection_rebuild"]),
  commitment_id: z.string().min(1),
  previous_materialization_state: z.string().min(1).nullable().default(null),
  control: CommitmentLifecycleControlSchema.nullable().default(null),
  feedback_ref: z.string().min(1).nullable().default(null),
  materialization_ref: z.string().min(1).nullable().default(null),
  suppression_refs: z.array(z.string().min(1)).default([]),
  candidate: CommitmentCandidateSchema,
}).strict();

export const RuntimeEventPayloadSchema = z.discriminatedUnion("schema_version", [
  RuntimePersonalAgentTraceEventPayloadSchema,
  RuntimeAuthorityDecisionEventPayloadSchema,
  RuntimeProjectionRebuildEventPayloadSchema,
  RuntimeGoalTaskMutationEventPayloadSchema,
  RuntimeControlOperationEventPayloadSchema,
  RuntimeMemoryTruthMaintenanceEventPayloadSchema,
  RuntimeAttentionCommitmentEventPayloadSchema,
]);
export type RuntimeEventPayload = z.infer<typeof RuntimeEventPayloadSchema>;

export const RuntimeEventEnvelopeSchema = z.object({
  schema_version: z.literal("runtime-event-envelope/v1"),
  event_id: z.string().min(1),
  event_type: RuntimeEventTypeSchema,
  occurred_at: z.string().datetime(),
  trace_id: z.string().min(1),
  causation_id: z.string().min(1).nullable().default(null),
  correlation_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  actor: RuntimeEventActorSchema,
  caller_path: PersonalAgentCallerPathSchema,
  surface: z.string().min(1).nullable().default(null),
  goal_id: z.string().min(1).nullable().default(null),
  task_id: z.string().min(1).nullable().default(null),
  run_id: z.string().min(1).nullable().default(null),
  session_id: z.string().min(1).nullable().default(null),
  source_ref: RuntimeEventRefSchema,
  target_refs: z.array(RuntimeEventRefSchema).default([]),
  authority_decision_ref: RuntimeEventRefSchema.nullable().default(null),
  runtime_graph_node_ref: RuntimeEventRefSchema.nullable().default(null),
  runtime_graph_edge_refs: z.array(RuntimeEventRefSchema).default([]),
  side_effect_ref: RuntimeEventRefSchema.nullable().default(null),
  replay_policy: RuntimeEventReplayPolicySchema,
  payload_schema: z.string().min(1).default("runtime-event-payload/unknown"),
  payload_version: z.string().min(1).default("runtime-event-payload/unknown"),
  payload: RuntimeEventPayloadSchema,
}).strict();
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>;
export type RuntimeEventEnvelopeInput = z.input<typeof RuntimeEventEnvelopeSchema>;

export interface RuntimeEventLogListOptions {
  traceId?: string;
  eventType?: RuntimeEventType;
  limit?: number | null;
}

export type RuntimeEventAppendDisposition =
  | "inserted"
  | "deduplicated_by_event_id"
  | "deduplicated_by_idempotency";

export interface RuntimeEventAppendResult {
  event: RuntimeEventEnvelope;
  disposition: RuntimeEventAppendDisposition;
}

export interface RuntimeAttentionCommitmentEventInput {
  operation: "candidate_saved" | "lifecycle_control_applied" | "projection_rebuild";
  candidate: CommitmentCandidate;
  previousCandidate?: CommitmentCandidate | null;
  control?: CommitmentLifecycleControl | null;
  feedbackRef?: string | null;
  occurredAt?: string;
}

export interface RuntimeEventProjectionRebuild {
  schema_version: "runtime-event-projection-rebuild/v1";
  rebuilt_at: string;
  trace_id: string | null;
  source_event_count: number;
  runtime_graph_evidence: {
    node_count: number;
    edge_count: number;
    edge_kinds: Record<string, number>;
    source_event_refs: string[];
  };
  interaction_authority_summary: {
    decision_count: number;
    outcomes: Record<string, number>;
    fail_closed_count: number;
    suppressed_count: number;
  };
  approval_resume_outcomes: Array<Record<string, unknown>>;
  notification_outbox_dedupe_state: Array<Record<string, unknown>>;
  peer_delivery_state: Array<Record<string, unknown>>;
  memory_correction_invalidation_summary: Array<Record<string, unknown>>;
  memory_truth_maintenance_summary: Array<Record<string, unknown>>;
  schedule_wake_execution_summary: Array<Record<string, unknown>>;
  tool_execution_outcome_summary: Array<Record<string, unknown>>;
  runtime_control_operation_summary: Array<Record<string, unknown>>;
  attention_commitment_lifecycle_summary: Array<Record<string, unknown>>;
}

export type RuntimeEventProjectionName =
  | "interaction_authority_summary"
  | "approval_resume_outcomes"
  | "notification_outbox_dedupe_state"
  | "peer_delivery_state"
  | "memory_correction_invalidation_summary"
  | "memory_truth_maintenance_summary"
  | "schedule_wake_execution_summary"
  | "tool_execution_outcome_summary"
  | "runtime_control_operation_summary"
  | "attention_commitment_lifecycle_summary";

export interface RuntimeEventProjectionSnapshot {
  schema_version: "runtime-event-projection-snapshot/v1";
  projection_name: RuntimeEventProjectionName;
  scope: {
    kind: "trace" | "control_db";
    ref: string;
  };
  rebuilt_at: string;
  source_event_count: number;
  source_event_refs: string[];
  snapshot: unknown;
}

export interface RuntimeEventProjectionApplyResult {
  schema_version: "runtime-event-projection-apply/v1";
  applied_at: string;
  dry_run: false;
  rebuild: RuntimeEventProjectionRebuild;
  snapshots: RuntimeEventProjectionSnapshot[];
  event: RuntimeEventEnvelope;
}

export interface RuntimeGraphExplainResult {
  schema_version: "runtime-event-graph-explain/v1";
  trace_id: string;
  generated_at: string;
  events: RuntimeEventEnvelope[];
  runtime_graph: {
    nodes: RuntimeGraphNode[];
    edges: RuntimeGraphEdge[];
  };
  projection_rebuild: RuntimeEventProjectionRebuild;
  operator_debug_evidence: {
    why_it_happened: string[];
    admitted_or_blocked_by: string[];
    touched_refs: string[];
    side_effect_refs: string[];
    replay_or_dedupe_refs: string[];
    rebuilt_projection_names: string[];
  };
}

export class RuntimeEventLogStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private readonly dbOwner: ControlDatabaseHandleOwner;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
    this.dbOwner = createRuntimeControlDatabaseOwner(this.paths, this.dbOptions);
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async close(): Promise<void> {
    await this.dbOwner.close();
  }

  async append(input: RuntimeEventEnvelopeInput): Promise<RuntimeEventEnvelope> {
    return (await this.appendWithDisposition(input)).event;
  }

  async appendWithDisposition(input: RuntimeEventEnvelopeInput): Promise<RuntimeEventAppendResult> {
    const db = await this.database();
    return db.transaction((sqlite) => appendRuntimeEventEnvelopeInTransaction(sqlite, input));
  }

  async appendPersonalAgentTrace(traceInput: PersonalAgentDecisionTrace): Promise<RuntimeEventEnvelope> {
    const trace = PersonalAgentDecisionTraceSchema.parse(traceInput);
    return this.append(runtimeEventFromPersonalAgentTrace(trace));
  }

  async appendAuthorityDecision(decisionInput: ExecutionAuthorityDecision): Promise<RuntimeEventEnvelope> {
    return (await this.appendAuthorityDecisionWithDisposition(decisionInput)).event;
  }

  async appendAuthorityDecisionWithDisposition(decisionInput: ExecutionAuthorityDecision): Promise<RuntimeEventAppendResult> {
    const decision = ExecutionAuthorityDecisionSchema.parse(decisionInput);
    return this.appendWithDisposition(runtimeEventFromAuthorityDecision(decision));
  }

  async appendGoalTaskMutation(input:
    | { entityKind: "goal"; action: "save" | "archive" | "delete"; goal: Goal }
    | { entityKind: "task"; action: "save" | "delete"; goalId: string; taskId: string; task: Task | null }
  ): Promise<RuntimeEventEnvelope> {
    return this.append(runtimeEventFromGoalTaskMutation(input));
  }

  async appendRuntimeControlOperation(input: {
    operation: RuntimeControlOperation;
    previousOperation?: RuntimeControlOperation | null;
  }): Promise<RuntimeEventEnvelope> {
    return this.append(runtimeEventFromRuntimeControlOperationTransition(input.operation, input.previousOperation ?? null));
  }

  async appendAttentionCommitment(input: RuntimeAttentionCommitmentEventInput): Promise<RuntimeEventEnvelope> {
    return this.append(runtimeEventFromAttentionCommitment(input));
  }

  async recordProjectionRebuild(input: {
    rebuild: RuntimeEventProjectionRebuild;
    dryRun: boolean;
  }): Promise<RuntimeEventEnvelope> {
    return this.append(runtimeEventFromProjectionRebuild(input));
  }

  async applyProjectionRebuild(options: { traceId?: string } = {}): Promise<RuntimeEventProjectionApplyResult> {
    const rebuild = await this.rebuildProjections(options);
    const appliedAt = new Date().toISOString();
    const snapshots = projectionSnapshots(rebuild, appliedAt);
    const db = await this.database();
    const event = db.transaction((sqlite) => {
      for (const snapshot of snapshots) {
        upsertProjectionSnapshot(sqlite, snapshot);
      }
      return appendRuntimeEventEnvelopeInTransaction(sqlite, runtimeEventFromProjectionRebuild({
        rebuild,
        dryRun: false,
        occurredAt: appliedAt,
      })).event;
    });
    return {
      schema_version: "runtime-event-projection-apply/v1",
      applied_at: appliedAt,
      dry_run: false,
      rebuild,
      snapshots,
      event,
    };
  }

  async listProjectionSnapshots(): Promise<RuntimeEventProjectionSnapshot[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT snapshot_json
        FROM runtime_event_projection_snapshots
        ORDER BY projection_name ASC, scope_kind ASC, scope_ref ASC
      `).all() as Array<{ snapshot_json: string }>;
      return rows.flatMap((row) => parseProjectionSnapshot(row.snapshot_json));
    });
  }

  async listEvents(options: RuntimeEventLogListOptions = {}): Promise<RuntimeEventEnvelope[]> {
    const hasLimit = options.limit !== null;
    const limit = hasLimit ? Math.max(1, Math.floor(options.limit ?? 500)) : null;
    const db = await this.database();
    return db.read((sqlite) => {
      const params: unknown[] = [
        options.traceId ?? null,
        options.traceId ?? null,
        options.eventType ?? null,
        options.eventType ?? null,
      ];
      if (hasLimit) params.push(limit);
      const rows = sqlite.prepare(`
        SELECT event_json
        FROM runtime_events
        WHERE (? IS NULL OR trace_id = ?)
          AND (? IS NULL OR event_type = ?)
        ORDER BY occurred_at ASC, event_id ASC
        ${hasLimit ? "LIMIT ?" : ""}
      `).all(...params) as Array<{ event_json: string }>;
      return rows.flatMap((row) => parseRuntimeEvent(row.event_json));
    });
  }

  async rebuildProjections(options: { traceId?: string } = {}): Promise<RuntimeEventProjectionRebuild> {
    const events = await this.listEvents({ traceId: options.traceId, limit: null });
    const db = await this.database();
    const graph = db.read((sqlite) => readRuntimeGraphForEvents(sqlite, events));
    return rebuildRuntimeEventProjections(events, options.traceId ?? null, graph);
  }

  async explainTrace(traceId: string): Promise<RuntimeGraphExplainResult> {
    const events = await this.listEvents({ traceId, limit: null });
    const db = await this.database();
    const graph = db.read((sqlite) => readRuntimeGraphForEvents(sqlite, events));
    const projectionRebuild = rebuildRuntimeEventProjections(events, traceId, graph);
    return {
      schema_version: "runtime-event-graph-explain/v1",
      trace_id: traceId,
      generated_at: new Date().toISOString(),
      events,
      runtime_graph: graph,
      projection_rebuild: projectionRebuild,
      operator_debug_evidence: operatorDebugEvidence(events, projectionRebuild),
    };
  }

  private async database(): Promise<ControlDatabase> {
    return this.dbOwner.database();
  }
}

export function appendRuntimeEventEnvelopeInTransaction(
  sqlite: SqliteDatabase,
  input: RuntimeEventEnvelopeInput,
): RuntimeEventAppendResult {
  const event = RuntimeEventEnvelopeSchema.parse({
    ...input,
    payload_schema: input.payload_schema ?? payloadSchemaVersion(input.payload),
    payload_version: input.payload_version ?? payloadSchemaVersion(input.payload),
  });
  const inserted = insertRuntimeEvent(sqlite, event);
  if (inserted) {
    upsertRuntimeGraphForEvent(sqlite, event);
    return { event, disposition: "inserted" };
  }
  const eventIdMatch = readRuntimeEventById(sqlite, event.event_id);
  if (eventIdMatch) {
    return { event: eventIdMatch, disposition: "deduplicated_by_event_id" };
  }
  const idempotencyMatch = readRuntimeEventByIdempotency(sqlite, event);
  if (idempotencyMatch) {
    return { event: idempotencyMatch, disposition: "deduplicated_by_idempotency" };
  }
  throw new Error(`runtime event append failed without a dedupe match: ${event.event_id}`);
}

export function runtimeEventFromPersonalAgentTrace(trace: PersonalAgentDecisionTrace): RuntimeEventEnvelopeInput {
  const parsed = PersonalAgentDecisionTraceSchema.parse(trace);
  const occurredAt = latestTraceTime(parsed);
  const sourceEvent = parsed.initiative_events[0];
  const targetRefs = uniqueRefs([
    ...(sourceEvent?.target_ref ? [sourceEvent.target_ref] : []),
    ...parsed.task_candidates.map((candidate) => candidate.target_ref),
    ...parsed.intervention_decisions.map((decision) => ({ kind: "intervention_decision", ref: decision.decision_id })),
    ...parsed.capability_decisions.map((decision) => ({ kind: "capability_decision", ref: decision.decision_id })),
  ]);
  const scoped = scopedIdsFromTrace(parsed);
  const eventId = `runtime-event:${stableId(`personal-agent:${stableJson(parsed)}`)}`;
  const eventNodeRef = { kind: "runtime_event", ref: eventId };
  return {
    schema_version: "runtime-event-envelope/v1",
    event_id: eventId,
    event_type: eventTypeForTrace(parsed),
    occurred_at: occurredAt,
    trace_id: parsed.trace_id,
    causation_id: sourceEvent?.source_ref.ref ?? parsed.situation_frame.source_ref.ref,
    correlation_id: parsed.replay_key,
    idempotency_key: parsed.replay_key,
    actor: actorForCallerPath(parsed.situation_frame.caller_path),
    caller_path: parsed.situation_frame.caller_path,
    surface: surfaceForCallerPath(parsed.situation_frame.caller_path),
    ...scoped,
    source_ref: parsed.situation_frame.source_ref,
    target_refs: targetRefs,
    authority_decision_ref: parsed.intervention_decisions.at(-1)
      ? { kind: "intervention_decision", ref: parsed.intervention_decisions.at(-1)!.decision_id }
      : null,
    runtime_graph_node_ref: eventNodeRef,
    runtime_graph_edge_refs: parsed.runtime_graph_edges.map((edge) => ({ kind: "runtime_graph_edge", ref: edge.edge_id })),
    side_effect_ref: sideEffectRefForTrace(parsed),
    replay_policy: {
      mode: "dedupe_by_idempotency_key",
      duplicate_side_effect_policy: "never_repeat",
      idempotency_scope: parsed.situation_frame.caller_path,
    },
    payload_schema: "runtime-event-payload/personal-agent-trace/v1",
    payload_version: "runtime-event-payload/personal-agent-trace/v1",
    payload: {
      schema_version: "runtime-event-payload/personal-agent-trace/v1",
      trace: parsed,
    },
  };
}

export function runtimeEventFromAuthorityDecision(decision: ExecutionAuthorityDecision): RuntimeEventEnvelopeInput {
  const parsed = ExecutionAuthorityDecisionSchema.parse(decision);
  const sourceRef = { kind: parsed.source.kind, ref: parsed.source.ref };
  const eventId = `runtime-event:${stableId(`authority:${stableJson(parsed)}`)}`;
  const targetRefs = uniqueRefs([
    ...parsed.bindings.target_refs.map((ref) => refFromAuthorityTarget(ref)),
    parsed.bindings.target_binding_ref ? { kind: "target_binding", ref: parsed.bindings.target_binding_ref } : null,
    parsed.bindings.delivery_ref ? { kind: "delivery", ref: parsed.bindings.delivery_ref } : null,
    parsed.bindings.approval_ref ? { kind: "approval", ref: parsed.bindings.approval_ref } : null,
    parsed.bindings.normal_surface_projection_ref ? { kind: "surface_projection", ref: parsed.bindings.normal_surface_projection_ref } : null,
  ].filter(isRuntimeGraphRef));
  return {
    schema_version: "runtime-event-envelope/v1",
    event_id: eventId,
    event_type: eventTypeForAuthorityDecision(parsed),
    occurred_at: validIsoOrNow(parsed.decided_at),
    trace_id: traceIdForAuthorityDecision(parsed),
    causation_id: parsed.source.ref,
    correlation_id: parsed.bindings.delivery_ref ?? parsed.bindings.approval_ref ?? parsed.decision_id,
    idempotency_key: [
      "authority",
      parsed.source.kind,
      parsed.source.ref,
      parsed.source.stage,
      parsed.bindings.delivery_ref
        ?? parsed.bindings.approval_ref
        ?? parsed.bindings.feedback_ref
        ?? parsed.bindings.target_binding_ref
        ?? parsed.source.ref,
      parsed.lifecycle,
      parsed.outcome,
    ].join(":"),
    actor: actorForAuthoritySource(parsed.source.kind),
    caller_path: callerPathForAuthorityDecision(parsed),
    surface: parsed.surface ?? surfaceForAuthoritySource(parsed.source.kind),
    ...scopedIdsFromAuthorityDecision(parsed),
    source_ref: sourceRef,
    target_refs: targetRefs,
    authority_decision_ref: { kind: "execution_authority_decision", ref: parsed.decision_id },
    runtime_graph_node_ref: { kind: "runtime_event", ref: eventId },
    runtime_graph_edge_refs: [],
    side_effect_ref: sideEffectRefForAuthorityDecision(parsed),
    replay_policy: {
      mode: parsed.can_send || parsed.can_execute || parsed.can_notify
        ? "side_effect_guard"
        : "dedupe_by_idempotency_key",
      duplicate_side_effect_policy: "never_repeat",
      idempotency_scope: parsed.source.kind,
    },
    payload_schema: "runtime-event-payload/authority-decision/v1",
    payload_version: "runtime-event-payload/authority-decision/v1",
    payload: {
      schema_version: "runtime-event-payload/authority-decision/v1",
      decision: parsed,
    },
  };
}

export function runtimeEventFromGoalTaskMutation(input:
  | { entityKind: "goal"; action: "save" | "archive" | "delete"; goal: Goal }
  | { entityKind: "task"; action: "save" | "delete"; goalId: string; taskId: string; task: Task | null }
): RuntimeEventEnvelopeInput {
  const occurredAt = new Date().toISOString();
  if (input.entityKind === "goal") {
    const goal = GoalSchema.parse(input.goal);
    const sourceRef = { kind: "goal", ref: goal.id };
    const idempotencyKey = `goal:${input.action}:${goal.id}:${stableId(stableJson(goal))}`;
    const eventId = `runtime-event:${stableId(`goal-mutation:${idempotencyKey}`)}`;
    return {
      schema_version: "runtime-event-envelope/v1",
      event_id: eventId,
      event_type: "goal.mutation.recorded",
      occurred_at: validIsoOrNow(goal.updated_at),
      trace_id: `goal-mutation:${stableId(`${input.action}:${goal.id}`)}`,
      causation_id: `goal:${goal.id}`,
      correlation_id: `goal:${goal.id}`,
      idempotency_key: idempotencyKey,
      actor: { kind: "runtime", ref: "goal-task-state-store" },
      caller_path: "external_signal",
      surface: "operator_debug",
      goal_id: goal.id,
      source_ref: sourceRef,
      target_refs: uniqueRefs([
        sourceRef,
        { kind: "projection", ref: input.action === "archive" ? "archived_goal_records" : "goal_records" },
        { kind: "surface_projection", ref: `goal-state:${goal.id}` },
      ]),
      runtime_graph_node_ref: { kind: "runtime_event", ref: eventId },
      side_effect_ref: { kind: "side_effect", ref: `goal-state-store:${input.action}:${goal.id}` },
      replay_policy: {
        mode: "dedupe_by_idempotency_key",
        duplicate_side_effect_policy: "never_repeat",
        idempotency_scope: "goal-task-state-store:goal",
      },
      payload_schema: "runtime-event-payload/goal-task-mutation/v1",
      payload_version: "runtime-event-payload/goal-task-mutation/v1",
      payload: {
        schema_version: "runtime-event-payload/goal-task-mutation/v1",
        mutation: {
          entity_kind: "goal",
          action: input.action,
          goal,
        },
      },
    };
  }

  const task = input.task ? TaskSchema.parse(input.task) : null;
  const goalId = task?.goal_id ?? input.goalId;
  const taskId = task?.id ?? input.taskId;
  const taskRef = { kind: "task", ref: taskId };
  const idempotencyKey = `task:${input.action}:${goalId}:${taskId}:${stableId(stableJson(task ?? { goal_id: goalId, task_id: taskId }))}`;
  const eventId = `runtime-event:${stableId(`task-mutation:${idempotencyKey}`)}`;
  return {
    schema_version: "runtime-event-envelope/v1",
    event_id: eventId,
    event_type: "task.mutation.recorded",
    occurred_at: occurredAt,
    trace_id: `task-mutation:${stableId(`${input.action}:${goalId}:${taskId}`)}`,
    causation_id: `goal:${goalId}`,
    correlation_id: `task:${taskId}`,
    idempotency_key: idempotencyKey,
    actor: { kind: "runtime", ref: "goal-task-state-store" },
    caller_path: "external_signal",
    surface: "operator_debug",
    goal_id: goalId,
    task_id: taskId,
    source_ref: taskRef,
    target_refs: uniqueRefs([
      taskRef,
      { kind: "goal", ref: goalId },
      { kind: "projection", ref: "task_records" },
      { kind: "surface_projection", ref: `task-state:${goalId}:${taskId}` },
    ]),
    runtime_graph_node_ref: { kind: "runtime_event", ref: eventId },
    side_effect_ref: { kind: "side_effect", ref: `goal-task-state-store:${input.action}:${goalId}:${taskId}` },
    replay_policy: {
      mode: "dedupe_by_idempotency_key",
      duplicate_side_effect_policy: "never_repeat",
      idempotency_scope: "goal-task-state-store:task",
    },
    payload_schema: "runtime-event-payload/goal-task-mutation/v1",
    payload_version: "runtime-event-payload/goal-task-mutation/v1",
    payload: {
      schema_version: "runtime-event-payload/goal-task-mutation/v1",
      mutation: {
        entity_kind: "task",
        action: input.action,
        goal_id: goalId,
        task_id: taskId,
        task,
      },
    },
  };
}

export function runtimeEventFromRuntimeControlOperationTransition(
  operationInput: RuntimeControlOperation,
  previousOperationInput: RuntimeControlOperation | null,
): RuntimeEventEnvelopeInput {
  const operation = RuntimeControlOperationSchema.parse(operationInput);
  const previousOperation = previousOperationInput ? RuntimeControlOperationSchema.parse(previousOperationInput) : null;
  const eventId = `runtime-event:${stableId([
    "runtime-control-operation",
    operation.operation_id,
    previousOperation?.state ?? "created",
    operation.state,
    operation.updated_at,
  ].join(":"))}`;
  const operationRef = { kind: "runtime_control_operation", ref: operation.operation_id };
  const targetRefs = uniqueRefs([
    operationRef,
    { kind: "projection", ref: "runtime_operations" },
    { kind: "surface_projection", ref: `runtime-control:${operation.operation_id}` },
    ...(operation.target?.goal_id ? [{ kind: "goal", ref: operation.target.goal_id }] : []),
    ...(operation.target?.session_id ? [{ kind: "session", ref: operation.target.session_id }] : []),
  ]);
  return {
    schema_version: "runtime-event-envelope/v1",
    event_id: eventId,
    event_type: "runtime_control.operation.recorded",
    occurred_at: validIsoOrNow(operation.updated_at),
    trace_id: `runtime-control:${stableId(operation.operation_id)}`,
    causation_id: previousOperation?.operation_id ?? null,
    correlation_id: operation.operation_id,
    idempotency_key: [
      "runtime-control-operation",
      operation.operation_id,
      previousOperation?.state ?? "created",
      operation.state,
      operation.updated_at,
    ].join(":"),
    actor: { kind: "operator", ref: "runtime-operation-store" },
    caller_path: "runtime_control",
    surface: "operator_debug",
    goal_id: operation.target?.goal_id ?? null,
    session_id: operation.target?.session_id ?? null,
    source_ref: operationRef,
    target_refs: targetRefs,
    runtime_graph_node_ref: { kind: "runtime_event", ref: eventId },
    replay_policy: {
      mode: "dedupe_by_idempotency_key",
      duplicate_side_effect_policy: "projection_only",
      idempotency_scope: "runtime-operation-store",
    },
    payload_schema: "runtime-event-payload/runtime-control-operation/v1",
    payload_version: "runtime-event-payload/runtime-control-operation/v1",
    payload: {
      schema_version: "runtime-event-payload/runtime-control-operation/v1",
      operation,
      previous_operation: previousOperation,
    },
  };
}

export function runtimeEventFromAttentionCommitment(input: RuntimeAttentionCommitmentEventInput): RuntimeEventEnvelopeInput {
  const candidate = CommitmentCandidateSchema.parse(input.candidate);
  const occurredAt = validIsoOrNow(input.occurredAt ?? candidate.updated_at);
  const operation = input.operation;
  const commitmentRef = { kind: "commitment", ref: candidate.commitment_id };
  const sourceRef = graphRefFromCommitmentSource(candidate.source_ref);
  const materializationRef = candidate.materialization_id
    ? `commitment-materialization:${candidate.materialization_id}`
    : null;
  const eventId = `runtime-event:${stableId([
    "attention-commitment",
    operation,
    candidate.commitment_id,
    candidate.replay_key,
    candidate.updated_at,
    input.control ?? "",
    input.feedbackRef ?? "",
  ].join(":"))}`;
  const targetRefs = uniqueRefs([
    commitmentRef,
    sourceRef,
    graphRefFromCommitmentTarget(candidate.target_ref),
    { kind: "projection", ref: "attention_commitment_candidates" },
    { kind: "surface_projection", ref: `attention-commitment:${candidate.commitment_id}` },
    ...(candidate.materialization_id ? [{ kind: "commitment_materialization", ref: candidate.materialization_id }] : []),
    ...candidate.feedback_refs.map((ref) => ({ kind: "feedback", ref })),
    ...candidate.suppression_refs.map((ref) => ({ kind: "suppression", ref })),
  ]);
  return {
    schema_version: "runtime-event-envelope/v1",
    event_id: eventId,
    event_type: "attention.commitment.recorded",
    occurred_at: occurredAt,
    trace_id: `attention-commitment:${stableId(candidate.commitment_id)}`,
    causation_id: candidate.source_ref.id,
    correlation_id: candidate.commitment_id,
    idempotency_key: [
      "attention-commitment",
      operation,
      candidate.replay_key,
      candidate.materialization_state,
      candidate.updated_at,
      input.control ?? "",
      input.feedbackRef ?? "",
    ].join(":"),
    actor: { kind: "runtime", ref: "attention-state-store" },
    caller_path: "chat_gateway_turn",
    surface: candidate.scope.surfaceClass,
    session_id: candidate.scope.sessionId ?? null,
    source_ref: sourceRef,
    target_refs: targetRefs,
    runtime_graph_node_ref: { kind: "runtime_event", ref: eventId },
    side_effect_ref: candidate.materialization_id
      ? { kind: "commitment_materialization", ref: candidate.materialization_id }
      : null,
    replay_policy: {
      mode: "dedupe_by_idempotency_key",
      duplicate_side_effect_policy: "projection_only",
      idempotency_scope: "attention-commitment-candidate",
    },
    payload_schema: "runtime-event-payload/attention-commitment/v1",
    payload_version: "runtime-event-payload/attention-commitment/v1",
    payload: {
      schema_version: "runtime-event-payload/attention-commitment/v1",
      operation,
      commitment_id: candidate.commitment_id,
      previous_materialization_state: input.previousCandidate?.materialization_state ?? null,
      control: input.control ?? null,
      feedback_ref: input.feedbackRef ?? null,
      materialization_ref: materializationRef,
      suppression_refs: candidate.suppression_refs,
      candidate,
    },
  };
}

function runtimeEventFromProjectionRebuild(input: {
  rebuild: RuntimeEventProjectionRebuild;
  dryRun: boolean;
  occurredAt?: string;
}): RuntimeEventEnvelopeInput {
  const occurredAt = validIsoOrNow(input.occurredAt ?? new Date().toISOString());
  const rebuildId = `projection-rebuild:${stableId(stableJson(input.rebuild))}`;
  return {
    schema_version: "runtime-event-envelope/v1",
    event_id: `runtime-event:${stableId(`projection:${rebuildId}:${occurredAt}`)}`,
    event_type: "projection.rebuild.recorded",
    occurred_at: occurredAt,
    trace_id: input.rebuild.trace_id ?? rebuildId,
    causation_id: input.rebuild.trace_id,
    correlation_id: input.rebuild.trace_id ?? rebuildId,
    idempotency_key: rebuildId,
    actor: { kind: "operator", ref: "runtime-event-log-rebuild" },
    caller_path: "explicit_user_command",
    surface: "operator_debug",
    source_ref: { kind: "runtime_event_projection_rebuild", ref: rebuildId },
    target_refs: projectionNames(input.rebuild).map((name) => ({ kind: "projection", ref: name })),
    replay_policy: {
      mode: input.dryRun ? "projection_rebuild" : "dedupe_by_idempotency_key",
      duplicate_side_effect_policy: "projection_only",
      idempotency_scope: "runtime-event-projection-rebuild",
    },
    payload_schema: "runtime-event-payload/projection-rebuild/v1",
    payload_version: "runtime-event-payload/projection-rebuild/v1",
    payload: {
      schema_version: "runtime-event-payload/projection-rebuild/v1",
      rebuild_id: rebuildId,
      dry_run: input.dryRun,
      projection_names: projectionNames(input.rebuild),
      summary: input.rebuild as unknown as Record<string, unknown>,
    },
  };
}

function insertRuntimeEvent(sqlite: SqliteDatabase, event: RuntimeEventEnvelope): boolean {
  const result = sqlite.prepare(`
    INSERT OR IGNORE INTO runtime_events (
      event_id,
      event_type,
      schema_version,
      occurred_at,
      trace_id,
      causation_id,
      correlation_id,
      idempotency_key,
      caller_path,
      surface,
      replay_policy,
      goal_id,
      task_id,
      run_id,
      session_id,
      source_ref,
      authority_decision_ref,
      side_effect_ref,
      event_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `).run(
    event.event_id,
    event.event_type,
    event.schema_version,
    event.occurred_at,
    event.trace_id,
    event.causation_id,
    event.correlation_id,
    event.idempotency_key,
    event.caller_path,
    event.surface,
    event.replay_policy.mode,
    event.goal_id,
    event.task_id,
    event.run_id,
    event.session_id,
    refKey(event.source_ref),
    event.authority_decision_ref ? refKey(event.authority_decision_ref) : null,
    event.side_effect_ref ? refKey(event.side_effect_ref) : null,
    JSON.stringify(event),
  );
  return result.changes > 0;
}

function readRuntimeEventById(sqlite: SqliteDatabase, eventId: string): RuntimeEventEnvelope | null {
  const row = sqlite.prepare("SELECT event_json FROM runtime_events WHERE event_id = ?").get(eventId) as { event_json: string } | undefined;
  return row ? parseRuntimeEvent(row.event_json)[0] ?? null : null;
}

function readRuntimeEventByIdempotency(sqlite: SqliteDatabase, event: RuntimeEventEnvelope): RuntimeEventEnvelope | null {
  const row = sqlite.prepare(`
    SELECT event_json
    FROM runtime_events
    WHERE event_type = ?
      AND idempotency_key = ?
      AND replay_policy = ?
      AND COALESCE(side_effect_ref, 'pending') = ?
    ORDER BY occurred_at ASC, event_id ASC
    LIMIT 1
  `).get(
    event.event_type,
    event.idempotency_key,
    event.replay_policy.mode,
    event.side_effect_ref ? refKey(event.side_effect_ref) : "pending",
  ) as { event_json: string } | undefined;
  return row ? parseRuntimeEvent(row.event_json)[0] ?? null : null;
}

function upsertProjectionSnapshot(sqlite: SqliteDatabase, snapshot: RuntimeEventProjectionSnapshot): void {
  sqlite.prepare(`
    INSERT INTO runtime_event_projection_snapshots (
      projection_name,
      scope_kind,
      scope_ref,
      rebuilt_at,
      source_event_count,
      source_event_refs_json,
      snapshot_json
    )
    VALUES (?, ?, ?, ?, ?, json(?), json(?))
    ON CONFLICT(projection_name, scope_kind, scope_ref) DO UPDATE SET
      rebuilt_at = excluded.rebuilt_at,
      source_event_count = excluded.source_event_count,
      source_event_refs_json = excluded.source_event_refs_json,
      snapshot_json = excluded.snapshot_json
  `).run(
    snapshot.projection_name,
    snapshot.scope.kind,
    snapshot.scope.ref,
    snapshot.rebuilt_at,
    snapshot.source_event_count,
    JSON.stringify(snapshot.source_event_refs),
    JSON.stringify(snapshot),
  );
}

function parseProjectionSnapshot(value: string): RuntimeEventProjectionSnapshot[] {
  try {
    const raw = JSON.parse(value) as Partial<RuntimeEventProjectionSnapshot>;
    if (
      raw.schema_version === "runtime-event-projection-snapshot/v1"
      && typeof raw.projection_name === "string"
      && raw.scope
      && (raw.scope.kind === "trace" || raw.scope.kind === "control_db")
      && typeof raw.scope.ref === "string"
      && typeof raw.rebuilt_at === "string"
      && typeof raw.source_event_count === "number"
      && Array.isArray(raw.source_event_refs)
    ) {
      return [raw as RuntimeEventProjectionSnapshot];
    }
  } catch {
    return [];
  }
  return [];
}

function upsertRuntimeGraphForEvent(sqlite: SqliteDatabase, event: RuntimeEventEnvelope): void {
  const now = event.occurred_at;
  const eventNode = graphNodeForRef(
    runtimeEventNodeId(event.event_id),
    "runtime_event",
    { kind: "runtime_event", ref: event.event_id },
    `Runtime event ${event.event_type}`,
    now,
    [{ kind: "runtime_event", ref: event.event_id }],
    {
      runtime_graph_role: "source_of_truth",
      trace_id: event.trace_id,
      event_type: event.event_type,
      idempotency_key: event.idempotency_key,
      correlation_id: event.correlation_id,
    },
  );
  upsertGraphNode(sqlite, eventNode);

  const sourceNode = graphNodeForGenericRef(event.source_ref, now, event.event_id);
  upsertGraphNode(sqlite, sourceNode);
  insertGraphEdge(sqlite, graphEdgeFor(event, "caused_by", eventNode.node_id, sourceNode.node_id, "source"));

  if (event.authority_decision_ref) {
    const authorityNode = graphNodeForGenericRef(event.authority_decision_ref, now, event.event_id, "authority_decision");
    upsertGraphNode(sqlite, authorityNode);
    insertGraphEdge(sqlite, graphEdgeFor(
      event,
      event.payload.schema_version === "runtime-event-payload/authority-decision/v1" && event.payload.decision.fail_closed
        ? "blocked_by"
        : "decided_by",
      eventNode.node_id,
      authorityNode.node_id,
      "authority",
    ));
  }

  for (const ref of event.target_refs) {
    const targetNode = graphNodeForGenericRef(ref, now, event.event_id);
    upsertGraphNode(sqlite, targetNode);
    insertGraphEdge(sqlite, graphEdgeFor(event, edgeKindForTarget(event, ref), eventNode.node_id, targetNode.node_id, refKey(ref)));
  }

  if (event.side_effect_ref) {
    const effectNode = graphNodeForGenericRef(event.side_effect_ref, now, event.event_id, "side_effect");
    upsertGraphNode(sqlite, effectNode);
    insertGraphEdge(sqlite, graphEdgeFor(event, sideEffectEdgeKind(event), effectNode.node_id, eventNode.node_id, "side-effect"));
  }
}

function upsertGraphNode(sqlite: SqliteDatabase, node: RuntimeGraphNode): void {
  const parsed = RuntimeGraphNodeSchema.parse(node);
  sqlite.prepare(`
    INSERT INTO personal_agent_runtime_graph_nodes (
      node_id,
      node_kind,
      ref,
      created_at,
      updated_at,
      node_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(node_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      node_json = excluded.node_json
  `).run(
    parsed.node_id,
    parsed.node_kind,
    refKey(parsed.ref),
    parsed.created_at,
    parsed.updated_at,
    JSON.stringify(parsed),
  );
}

function insertGraphEdge(sqlite: SqliteDatabase, edge: RuntimeGraphEdge): void {
  const parsed = RuntimeGraphEdgeSchema.parse(edge);
  sqlite.prepare(`
    INSERT OR IGNORE INTO personal_agent_runtime_graph_edges (
      edge_id,
      edge_kind,
      from_node_id,
      to_node_id,
      created_at,
      edge_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
  `).run(
    parsed.edge_id,
    parsed.edge_kind,
    parsed.from_node_id,
    parsed.to_node_id,
    parsed.created_at,
    JSON.stringify(parsed),
  );
}

function parseRuntimeEvent(value: string): RuntimeEventEnvelope[] {
  try {
    const parsed = RuntimeEventEnvelopeSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}

function readRuntimeGraphForEvents(
  sqlite: SqliteDatabase,
  events: readonly RuntimeEventEnvelope[],
): RuntimeGraphExplainResult["runtime_graph"] {
  const eventNodeIds = events.map((event) => runtimeEventNodeId(event.event_id));
  if (eventNodeIds.length === 0) return { nodes: [], edges: [] };
  const placeholders = eventNodeIds.map(() => "?").join(", ");
  const edgeRows = sqlite.prepare(`
    SELECT edge_json
    FROM personal_agent_runtime_graph_edges
    WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})
    ORDER BY created_at ASC, edge_id ASC
  `).all(...eventNodeIds, ...eventNodeIds) as Array<{ edge_json: string }>;
  const edges = edgeRows.flatMap((row) => {
    try {
      const parsed = RuntimeGraphEdgeSchema.safeParse(JSON.parse(row.edge_json) as unknown);
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
  const nodeIds = [...new Set([
    ...eventNodeIds,
    ...edges.flatMap((edge) => [edge.from_node_id, edge.to_node_id]),
  ])];
  const nodePlaceholders = nodeIds.map(() => "?").join(", ");
  const nodeRows = sqlite.prepare(`
    SELECT node_json
    FROM personal_agent_runtime_graph_nodes
    WHERE node_id IN (${nodePlaceholders})
    ORDER BY updated_at ASC, node_id ASC
  `).all(...nodeIds) as Array<{ node_json: string }>;
  const nodes = nodeRows.flatMap((row) => {
    try {
      const parsed = RuntimeGraphNodeSchema.safeParse(JSON.parse(row.node_json) as unknown);
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
  return { nodes, edges };
}

function rebuildRuntimeEventProjections(
  events: readonly RuntimeEventEnvelope[],
  traceId: string | null,
  graph: RuntimeGraphExplainResult["runtime_graph"],
): RuntimeEventProjectionRebuild {
  const graphEvidence = runtimeGraphEvidence(graph);
  const graphEventIds = new Set(graphEvidence.source_event_refs);
  const graphBackedEvents = events.filter((event) => graphEventIds.has(event.event_id));
  const authorityDecisions = graphBackedEvents.flatMap((event) =>
    event.payload.schema_version === "runtime-event-payload/authority-decision/v1" ? [event.payload.decision] : []
  );
  const traces = graphBackedEvents.flatMap((event) =>
    event.payload.schema_version === "runtime-event-payload/personal-agent-trace/v1" ? [event.payload.trace] : []
  );
  return {
    schema_version: "runtime-event-projection-rebuild/v1",
    rebuilt_at: new Date().toISOString(),
    trace_id: traceId,
    source_event_count: graphBackedEvents.length,
    runtime_graph_evidence: graphEvidence,
    interaction_authority_summary: {
      decision_count: authorityDecisions.length,
      outcomes: countBy(authorityDecisions.map((decision) => decision.outcome)),
      fail_closed_count: authorityDecisions.filter((decision) => decision.fail_closed).length,
      suppressed_count: authorityDecisions.filter((decision) => decision.suppressed).length,
    },
    approval_resume_outcomes: authorityDecisions
      .filter((decision) => decision.source.kind === "approval")
      .map((decision) => ({
        decision_id: decision.decision_id,
        status: decision.metadata["resume_status"] ?? decision.outcome,
        approval_ref: decision.bindings.approval_ref ?? null,
        target_binding_ref: decision.bindings.target_binding_ref ?? null,
        idempotency_key: graphBackedEvents.find((event) => authorityEventMatches(event, decision))?.idempotency_key ?? null,
        runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, graphBackedEvents.find((event) => authorityEventMatches(event, decision))?.event_id),
      })),
    notification_outbox_dedupe_state: graphBackedEvents
      .filter((event) => event.event_type === "notification.dispatch.recorded" || event.event_type === "outbox.enqueue.recorded")
      .map((event) => ({
        event_id: event.event_id,
        trace_id: event.trace_id,
        idempotency_key: event.idempotency_key,
        correlation_id: event.correlation_id,
        replay_policy: event.replay_policy,
        target_refs: event.target_refs,
        runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, event.event_id),
      })),
    peer_delivery_state: authorityDecisions
      .filter((decision) => decision.source.kind === "peer_initiative" || decision.source.kind === "outbound_conversation" || decision.source.kind === "telegram_callback")
      .map((decision) => ({
        decision_id: decision.decision_id,
        source_kind: decision.source.kind,
        outcome: decision.outcome,
        delivery_ref: decision.bindings.delivery_ref ?? null,
        transport_message_ref: decision.bindings.transport_message_ref ?? null,
        feedback_ref: decision.bindings.feedback_ref ?? null,
        can_send: decision.can_send,
        can_execute: decision.can_execute,
        runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, graphBackedEvents.find((event) => authorityEventMatches(event, decision))?.event_id),
      })),
    memory_correction_invalidation_summary: [
      ...authorityDecisions
        .filter((decision) => decision.source.kind === "memory_correction")
        .map((decision) => ({
          decision_id: decision.decision_id,
          target_refs: decision.bindings.target_refs,
          memory_withheld: decision.memory_withheld,
          runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, graphBackedEvents.find((event) => authorityEventMatches(event, decision))?.event_id),
        })),
      ...traces.flatMap((trace) => trace.memory_audits
        .filter((audit) => audit.invalidated || audit.action === "correct" || audit.action === "invalidate")
        .map((audit) => ({
          trace_id: trace.trace_id,
          audit_id: audit.audit_id,
          memory_ref: audit.memory_ref,
          action: audit.action,
          correction_state: audit.correction_state,
          invalidated: audit.invalidated,
          runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, graphBackedEvents.find((event) =>
            event.payload.schema_version === "runtime-event-payload/personal-agent-trace/v1"
            && event.payload.trace.trace_id === trace.trace_id
          )?.event_id),
        }))),
    ],
    memory_truth_maintenance_summary: graphBackedEvents
      .filter((event) => event.event_type === "memory.truth_maintenance.recorded")
      .map((event) => {
        const payload = event.payload.schema_version === "runtime-event-payload/memory-truth-maintenance/v1"
          ? event.payload
          : null;
        return {
          event_id: event.event_id,
          trace_id: event.trace_id,
          operation: payload?.operation ?? null,
          owner: payload?.owner ?? null,
          claim_ids: payload?.claim_ids ?? [],
          correction_id: typeof payload?.correction_ref?.["correction_id"] === "string"
            ? payload.correction_ref["correction_id"]
            : null,
          tombstone_ids: payload?.tombstone_ids ?? [],
          conflict_set_ids: payload?.conflict_set_ids ?? [],
          projection_ids: payload?.projection_ids ?? [],
          recall_ids: payload?.recall_ids ?? [],
          runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, event.event_id),
        };
      }),
    schedule_wake_execution_summary: traces
      .filter((trace) => trace.situation_frame.caller_path === "scheduled_wake" || trace.situation_frame.source_kind === "schedule_wake")
      .map((trace) => ({
        trace_id: trace.trace_id,
        replay_key: trace.replay_key,
        decision: trace.intervention_decisions.at(-1)?.decision ?? null,
        target_effect: trace.intervention_decisions.at(-1)?.target_effect ?? null,
        outcome_events: trace.initiative_events.filter((event) => event.event_type === "action_outcome").map((event) => event.summary),
        runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, graphBackedEvents.find((event) =>
          event.payload.schema_version === "runtime-event-payload/personal-agent-trace/v1"
          && event.payload.trace.trace_id === trace.trace_id
        )?.event_id),
      })),
    tool_execution_outcome_summary: traces
      .filter((trace) => trace.task_candidates.some((candidate) => candidate.target_kind === "tool_call"))
      .map((trace) => ({
        trace_id: trace.trace_id,
        replay_key: trace.replay_key,
        tool_refs: trace.task_candidates.filter((candidate) => candidate.target_kind === "tool_call").map((candidate) => candidate.target_ref.ref),
        decision: trace.intervention_decisions.at(-1)?.decision ?? null,
        outcome_events: trace.initiative_events.filter((event) => event.event_type === "action_outcome").map((event) => event.summary),
        runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, graphBackedEvents.find((event) =>
          event.payload.schema_version === "runtime-event-payload/personal-agent-trace/v1"
          && event.payload.trace.trace_id === trace.trace_id
        )?.event_id),
      })),
    runtime_control_operation_summary: graphBackedEvents
      .filter((event) => event.event_type === "runtime_control.operation.recorded")
      .flatMap((event) => {
        if (event.payload.schema_version !== "runtime-event-payload/runtime-control-operation/v1") return [];
        return [{
          event_id: event.event_id,
          trace_id: event.trace_id,
          operation_id: event.payload.operation.operation_id,
          kind: event.payload.operation.kind,
          previous_state: event.payload.previous_operation?.state ?? null,
          state: event.payload.operation.state,
          terminal: ["verified", "blocked", "failed", "cancelled"].includes(event.payload.operation.state),
          goal_id: event.payload.operation.target?.goal_id ?? null,
          session_id: event.payload.operation.target?.session_id ?? null,
          runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, event.event_id),
        }];
      }),
    attention_commitment_lifecycle_summary: graphBackedEvents
      .filter((event) => event.event_type === "attention.commitment.recorded")
      .flatMap((event) => {
        if (event.payload.schema_version !== "runtime-event-payload/attention-commitment/v1") return [];
        return [{
          event_id: event.event_id,
          trace_id: event.trace_id,
          operation: event.payload.operation,
          commitment_id: event.payload.commitment_id,
          previous_materialization_state: event.payload.previous_materialization_state,
          materialization_state: event.payload.candidate.materialization_state,
          materialization_ref: event.payload.materialization_ref,
          control: event.payload.control,
          feedback_ref: event.payload.feedback_ref,
          feedback_refs: event.payload.candidate.feedback_refs,
          suppression_refs: event.payload.suppression_refs,
          source_epoch: event.payload.candidate.source_epoch,
          source_high_watermark: event.payload.candidate.source_high_watermark,
          replay_key: event.payload.candidate.replay_key,
          runtime_graph_edge_kinds: graphEdgeKindsForEvent(graph, event.event_id),
        }];
      }),
  };
}

function runtimeGraphEvidence(graph: RuntimeGraphExplainResult["runtime_graph"]): RuntimeEventProjectionRebuild["runtime_graph_evidence"] {
  return {
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    edge_kinds: countBy(graph.edges.map((edge) => edge.edge_kind)),
    source_event_refs: uniqueStrings(graph.edges.flatMap((edge) =>
      edge.provenance_refs
        .filter((ref) => ref.kind === "runtime_event")
        .map((ref) => ref.ref)
    )),
  };
}

function graphEdgeKindsForEvent(
  graph: RuntimeGraphExplainResult["runtime_graph"],
  eventId: string | undefined,
): string[] {
  if (!eventId) return [];
  return uniqueStrings(graph.edges.flatMap((edge) =>
    edge.provenance_refs.some((ref) => ref.kind === "runtime_event" && ref.ref === eventId) ? [edge.edge_kind] : []
  ));
}

function operatorDebugEvidence(
  events: readonly RuntimeEventEnvelope[],
  rebuild: RuntimeEventProjectionRebuild,
): RuntimeGraphExplainResult["operator_debug_evidence"] {
  return {
    why_it_happened: uniqueStrings(events.map((event) => refKey(event.source_ref))),
    admitted_or_blocked_by: uniqueStrings(events.flatMap((event) =>
      event.authority_decision_ref ? [refKey(event.authority_decision_ref)] : []
    )),
    touched_refs: uniqueStrings(events.flatMap((event) => event.target_refs.map(refKey))),
    side_effect_refs: uniqueStrings(events.flatMap((event) =>
      event.side_effect_ref ? [refKey(event.side_effect_ref)] : []
    )),
    replay_or_dedupe_refs: uniqueStrings(events.map((event) => event.idempotency_key)),
    rebuilt_projection_names: projectionNames(rebuild),
  };
}

function eventTypeForTrace(trace: PersonalAgentDecisionTrace): RuntimeEventType {
  if (trace.situation_frame.caller_path === "runtime_control") return "runtime_control.operation.recorded";
  if (trace.situation_frame.caller_path === "notification_interruption") {
    return trace.situation_frame.replay_key.startsWith("outbox_enqueue:")
      ? "outbox.enqueue.recorded"
      : "notification.dispatch.recorded";
  }
  if (trace.situation_frame.caller_path === "scheduled_wake") return "schedule.wake.recorded";
  if (trace.situation_frame.caller_path === "memory_correction") return "memory.correction.recorded";
  if (trace.situation_frame.caller_path === "chat_gateway_turn") return "gateway.chat.ingress.recorded";
  if (trace.situation_frame.caller_path === "resident_proactive") return "daemon.resident_initiative.recorded";
  const targetKinds = new Set(trace.task_candidates.map((candidate) => candidate.target_kind));
  if (targetKinds.has("tool_call")) return "tool.call.recorded";
  return "personal_agent.trace.recorded";
}

function eventTypeForAuthorityDecision(decision: ExecutionAuthorityDecision): RuntimeEventType {
  switch (decision.source.kind) {
    case "approval":
      return "approval.resume.recorded";
    case "tool_executor":
    case "host_tool_execution":
      return "tool.call.recorded";
    case "notification":
      return "notification.dispatch.recorded";
    case "outbound_conversation":
    case "peer_initiative":
      return "gateway.telegram.delivery.recorded";
    case "telegram_callback":
      return "gateway.telegram.callback.recorded";
    case "memory_correction":
      return "memory.correction.recorded";
    case "runtime_control":
      return "runtime_control.operation.recorded";
    case "schedule":
      return "schedule.wake.recorded";
    case "daemon_resident":
      return "daemon.resident_initiative.recorded";
    case "surface_projection":
      return "surface.projection.recorded";
    default:
      return "interaction_authority.decision.recorded";
  }
}

function latestTraceTime(trace: PersonalAgentDecisionTrace): string {
  const candidates = [
    trace.situation_frame.assembled_at,
    ...trace.initiative_events.map((event) => event.occurred_at),
    ...trace.attention_transitions.map((transition) => transition.occurred_at),
    ...trace.task_candidates.map((candidate) => candidate.proposed_at),
    ...trace.capability_decisions.map((decision) => decision.decided_at),
    ...trace.intervention_decisions.map((decision) => decision.decided_at),
    ...trace.memory_audits.map((audit) => audit.recorded_at),
  ].sort();
  return candidates.at(-1) ?? new Date().toISOString();
}

function traceIdForAuthorityDecision(decision: ExecutionAuthorityDecision): string {
  return `authority:${stableId([
    decision.source.kind,
    decision.source.ref,
    decision.bindings.delivery_ref ?? "",
    decision.bindings.approval_ref ?? "",
  ].join(":"))}`;
}

function callerPathForAuthorityDecision(decision: ExecutionAuthorityDecision): RuntimeEventEnvelope["caller_path"] {
  switch (decision.source.kind) {
    case "runtime_control":
      return "runtime_control";
    case "notification":
    case "outbound_conversation":
    case "peer_initiative":
    case "telegram_callback":
      return "notification_interruption";
    case "memory_correction":
      return "memory_correction";
    case "schedule":
      return "scheduled_wake";
    case "daemon_resident":
      return "resident_proactive";
    case "tool_executor":
    case "host_tool_execution":
    case "approval":
      return "task_execution";
    default:
      return "external_signal";
  }
}

function actorForCallerPath(callerPath: RuntimeEventEnvelope["caller_path"]): RuntimeEventEnvelope["actor"] {
  switch (callerPath) {
    case "chat_gateway_turn":
    case "tui_turn":
    case "explicit_user_command":
      return { kind: "user" };
    case "scheduled_wake":
      return { kind: "scheduler" };
    case "runtime_control":
      return { kind: "operator" };
    case "resident_proactive":
      return { kind: "daemon" };
    case "task_execution":
      return { kind: "tool" };
    default:
      return { kind: "runtime" };
  }
}

function actorForAuthoritySource(sourceKind: ExecutionAuthorityDecision["source"]["kind"]): RuntimeEventEnvelope["actor"] {
  if (sourceKind === "telegram_callback" || sourceKind === "outbound_conversation") return { kind: "gateway", ref: "telegram" };
  if (sourceKind === "schedule") return { kind: "scheduler" };
  if (sourceKind === "tool_executor" || sourceKind === "host_tool_execution") return { kind: "tool" };
  if (sourceKind === "runtime_control" || sourceKind === "approval") return { kind: "operator" };
  if (sourceKind === "daemon_resident") return { kind: "daemon" };
  return { kind: "runtime" };
}

function surfaceForCallerPath(callerPath: RuntimeEventEnvelope["caller_path"]): string | null {
  if (callerPath === "chat_gateway_turn") return "gateway";
  if (callerPath === "tui_turn") return "tui";
  if (callerPath === "runtime_control") return "operator_debug";
  if (callerPath === "notification_interruption") return "notification";
  return null;
}

function surfaceForAuthoritySource(sourceKind: ExecutionAuthorityDecision["source"]["kind"]): string | null {
  if (sourceKind === "telegram_callback" || sourceKind === "outbound_conversation" || sourceKind === "peer_initiative") return "telegram";
  if (sourceKind === "notification") return "notification";
  if (sourceKind === "runtime_control") return "operator_debug";
  return null;
}

function scopedIdsFromTrace(trace: PersonalAgentDecisionTrace): Pick<RuntimeEventEnvelope, "goal_id" | "task_id" | "run_id" | "session_id"> {
  const refs = [
    trace.situation_frame.source_ref,
    ...trace.situation_frame.current_refs,
    ...trace.task_candidates.map((candidate) => candidate.target_ref),
    ...trace.initiative_events.flatMap((event) => [event.source_ref, event.target_ref].filter(isRuntimeGraphRef)),
  ];
  return {
    goal_id: refs.find((ref) => ref.kind === "goal")?.ref ?? null,
    task_id: refs.find((ref) => ref.kind === "task")?.ref ?? null,
    run_id: refs.find((ref) => ref.kind === "run")?.ref ?? null,
    session_id: refs.find((ref) => ref.kind === "session")?.ref ?? null,
  };
}

function scopedIdsFromAuthorityDecision(decision: ExecutionAuthorityDecision): Pick<RuntimeEventEnvelope, "goal_id" | "task_id" | "run_id" | "session_id"> {
  const targetRefs = decision.bindings.target_refs;
  return {
    goal_id: targetRefs.find((ref) => ref.startsWith("goal:") || ref.includes("-goal:"))?.split(":").at(-1) ?? null,
    task_id: targetRefs.find((ref) => ref.startsWith("task:") || ref.includes("-task:"))?.split(":").at(-1) ?? null,
    run_id: targetRefs.find((ref) => ref.startsWith("run:") || ref.includes("-run:"))?.split(":").at(-1) ?? null,
    session_id: targetRefs.find((ref) => ref.startsWith("session:") || ref.includes("-session:"))?.split(":").at(-1) ?? null,
  };
}

function sideEffectRefForTrace(trace: PersonalAgentDecisionTrace): RuntimeGraphRef | null {
  const candidate = trace.task_candidates.at(-1);
  const outcome = trace.initiative_events.find((event) => event.event_type === "action_outcome");
  if (!candidate || !outcome) return null;
  return {
    kind: "side_effect",
    ref: `${candidate.target_kind}:${candidate.target_ref.ref}:${stableId(outcome.summary)}`,
  };
}

function sideEffectRefForAuthorityDecision(decision: ExecutionAuthorityDecision): RuntimeGraphRef | null {
  if (decision.bindings.transport_message_ref) {
    return { kind: "transport_message", ref: decision.bindings.transport_message_ref };
  }
  if (decision.bindings.feedback_ref) {
    return { kind: "feedback", ref: decision.bindings.feedback_ref };
  }
  if (decision.bindings.delivery_ref && (decision.can_send || decision.can_notify)) {
    return { kind: "delivery", ref: decision.bindings.delivery_ref };
  }
  if (decision.bindings.approval_ref && decision.can_execute) {
    return { kind: "approval_resume", ref: decision.bindings.approval_ref };
  }
  return null;
}

function graphNodeForRef(
  nodeId: string,
  nodeKind: RuntimeGraphNode["node_kind"],
  ref: RuntimeGraphRef,
  label: string,
  now: string,
  provenanceRefs: RuntimeGraphRef[],
  payload: Record<string, unknown>,
): RuntimeGraphNode {
  return RuntimeGraphNodeSchema.parse({
    schema_version: "runtime-graph-node/v1",
    node_id: nodeId,
    node_kind: nodeKind,
    ref,
    label,
    created_at: now,
    updated_at: now,
    provenance_refs: provenanceRefs,
    payload,
  });
}

function graphNodeForGenericRef(
  ref: RuntimeGraphRef,
  now: string,
  eventId: string,
  role?: RuntimeGraphNode["node_kind"],
): RuntimeGraphNode {
  const nodeKind = role ?? nodeKindForRef(ref);
  return graphNodeForRef(
    runtimeGraphRefNodeId(ref),
    nodeKind,
    ref,
    `${ref.kind}:${ref.ref}`,
    now,
    [{ kind: "runtime_event", ref: eventId }],
    {
      runtime_graph_role: "causal_index",
      ref,
    },
  );
}

function graphEdgeFor(
  event: RuntimeEventEnvelope,
  edgeKind: RuntimeGraphEdge["edge_kind"],
  fromNodeId: string,
  toNodeId: string,
  discriminator: string,
): RuntimeGraphEdge {
  return RuntimeGraphEdgeSchema.parse({
    schema_version: "runtime-graph-edge/v1",
    edge_id: `runtime-event-edge:${stableId(`${event.event_id}:${edgeKind}:${fromNodeId}:${toNodeId}:${discriminator}`)}`,
    edge_kind: edgeKind,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    created_at: event.occurred_at,
    provenance_refs: [{ kind: "runtime_event", ref: event.event_id }],
  });
}

function nodeKindForRef(ref: RuntimeGraphRef): RuntimeGraphNode["node_kind"] {
  switch (ref.kind) {
    case "goal":
      return "goal";
    case "task":
      return "task";
    case "commitment":
    case "commitment_materialization":
      return "commitment";
    case "run":
      return "run";
    case "session":
      return "session";
    case "situation_frame":
      return "situation_frame";
    case "initiative_event":
      return "initiative_event";
    case "task_candidate":
      return "task_candidate";
    case "intervention_decision":
    case "execution_authority_decision":
      return "authority_decision";
    case "capability_decision":
      return "capability_decision";
    case "memory":
    case "memory_record":
      return "memory_record";
    case "tool_call":
      return "tool_call";
    case "schedule_entry":
    case "schedule_wake":
      return "schedule_wake";
    case "delivery":
    case "transport_message":
    case "target_binding":
      return "gateway_message";
    case "surface_projection":
    case "projection":
      return "surface_projection";
    case "runtime_event":
      return "runtime_event";
    case "side_effect":
      return "side_effect";
    default:
      return "artifact";
  }
}

function edgeKindForTarget(event: RuntimeEventEnvelope, ref: RuntimeGraphRef): RuntimeGraphEdge["edge_kind"] {
  if (ref.kind === "approval") return "approved_by";
  if (ref.kind === "delivery" || ref.kind === "transport_message" || event.event_type === "gateway.telegram.delivery.recorded") return "delivered_to";
  if (ref.kind === "surface_projection" || ref.kind === "projection") return "projected_to";
  if (event.event_type === "memory.correction.recorded") return "invalidated_by";
  if (event.replay_policy.mode === "dedupe_by_idempotency_key") return "deduplicated_by";
  return "projected_to";
}

function sideEffectEdgeKind(event: RuntimeEventEnvelope): RuntimeGraphEdge["edge_kind"] {
  if (event.event_type === "gateway.telegram.delivery.recorded" || event.event_type === "notification.dispatch.recorded") {
    return "delivered_to";
  }
  return "executed_by";
}

function runtimeEventNodeId(eventId: string): string {
  return `runtime-event-node:${stableId(eventId)}`;
}

function runtimeGraphRefNodeId(ref: RuntimeGraphRef): string {
  return `runtime-graph-ref-node:${stableId(refKey(ref))}`;
}

function payloadSchemaVersion(payload: RuntimeEventEnvelopeInput["payload"]): string {
  if (payload && typeof payload === "object" && "schema_version" in payload && typeof payload.schema_version === "string") {
    return payload.schema_version;
  }
  return "runtime-event-payload/unknown";
}

function refFromAuthorityTarget(value: string): RuntimeGraphRef {
  const [kind, ...rest] = value.split(":");
  const ref = rest.join(":");
  return kind && ref ? { kind, ref } : { kind: "authority_target", ref: value };
}

function graphRefFromCommitmentSource(ref: CommitmentCandidate["source_ref"]): RuntimeGraphRef {
  return { kind: ref.kind, ref: ref.id };
}

function graphRefFromCommitmentTarget(ref: CommitmentCandidate["target_ref"]): RuntimeGraphRef {
  return { kind: ref.kind, ref: ref.id };
}

function refKey(ref: RuntimeGraphRef): string {
  return `${ref.kind}:${ref.ref}`;
}

function uniqueRefs(refs: readonly RuntimeGraphRef[]): RuntimeGraphRef[] {
  const seen = new Set<string>();
  const out: RuntimeGraphRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function isRuntimeGraphRef(value: unknown): value is RuntimeGraphRef {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as RuntimeGraphRef).kind === "string"
    && typeof (value as RuntimeGraphRef).ref === "string"
  );
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function stableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  return sorted;
}

function validIsoOrNow(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function authorityEventMatches(event: RuntimeEventEnvelope, decision: ExecutionAuthorityDecision): boolean {
  return event.payload.schema_version === "runtime-event-payload/authority-decision/v1"
    && event.payload.decision.decision_id === decision.decision_id;
}

function projectionSnapshots(
  rebuild: RuntimeEventProjectionRebuild,
  appliedAt: string,
): RuntimeEventProjectionSnapshot[] {
  const scope = {
    kind: rebuild.trace_id ? "trace" as const : "control_db" as const,
    ref: rebuild.trace_id ?? "default",
  };
  return projectionNames(rebuild).map((name) => ({
    schema_version: "runtime-event-projection-snapshot/v1",
    projection_name: name,
    scope,
    rebuilt_at: appliedAt,
    source_event_count: rebuild.source_event_count,
    source_event_refs: rebuild.runtime_graph_evidence.source_event_refs,
    snapshot: projectionValue(rebuild, name),
  }));
}

function projectionValue(
  rebuild: RuntimeEventProjectionRebuild,
  name: RuntimeEventProjectionName,
): unknown {
  switch (name) {
    case "interaction_authority_summary":
      return rebuild.interaction_authority_summary;
    case "approval_resume_outcomes":
      return rebuild.approval_resume_outcomes;
    case "notification_outbox_dedupe_state":
      return rebuild.notification_outbox_dedupe_state;
    case "peer_delivery_state":
      return rebuild.peer_delivery_state;
    case "memory_correction_invalidation_summary":
      return rebuild.memory_correction_invalidation_summary;
    case "memory_truth_maintenance_summary":
      return rebuild.memory_truth_maintenance_summary;
    case "schedule_wake_execution_summary":
      return rebuild.schedule_wake_execution_summary;
    case "tool_execution_outcome_summary":
      return rebuild.tool_execution_outcome_summary;
    case "runtime_control_operation_summary":
      return rebuild.runtime_control_operation_summary;
    case "attention_commitment_lifecycle_summary":
      return rebuild.attention_commitment_lifecycle_summary;
  }
}

function projectionNames(_rebuild: RuntimeEventProjectionRebuild): RuntimeEventProjectionName[] {
  return [
    "interaction_authority_summary",
    "approval_resume_outcomes",
    "notification_outbox_dedupe_state",
    "peer_delivery_state",
    "memory_correction_invalidation_summary",
    "memory_truth_maintenance_summary",
    "schedule_wake_execution_summary",
    "tool_execution_outcome_summary",
    "runtime_control_operation_summary",
    "attention_commitment_lifecycle_summary",
  ];
}
