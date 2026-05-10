import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import { GoalTaskStateStore } from "../../../runtime/store/goal-task-state-store.js";

export type TaskOutcomeEventType =
  | "acked"
  | "started"
  | "succeeded"
  | "failed"
  | "retried"
  | "abandoned";

export interface TaskOutcomeEvent {
  type: TaskOutcomeEventType;
  ts: string;
  attempt: number;
  task_status: Task["status"];
  verification_verdict?: VerificationResult["verdict"];
  action?: string;
  reason?: string;
  stopped_reason?: string | null;
  created_at: string | null;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verification_at: string | null;
  elapsed_ms: number | null;
  estimated_duration_ms: number | null;
  tokens_used: number | null;
}

export interface TaskOutcomeSummary extends Record<string, unknown> {
  task_id: string;
  goal_id: string;
  latest_event_type: TaskOutcomeEventType | null;
  latest_event_at: string | null;
  attempt: number;
  task_status: Task["status"];
  verification_verdict?: VerificationResult["verdict"];
  action?: string;
  stopped_reason: string | null;
  created_at: string | null;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verification_at: string | null;
  last_failure_at: string | null;
  abandoned_at: string | null;
  estimated_duration_ms: number | null;
  tokens_used: number;
  latencies: {
    created_to_acked_ms: number | null;
    acked_to_started_ms: number | null;
    started_to_completed_ms: number | null;
    completed_to_verification_ms: number | null;
    created_to_completed_ms: number | null;
  };
}

export interface TaskOutcomeLedgerRecord {
  task_id: string;
  goal_id: string;
  events: TaskOutcomeEvent[];
  summary: TaskOutcomeSummary;
}

export interface TaskOutcomeAggregateSummary {
  total_tasks: number;
  terminal_tasks: number;
  inflight_tasks: number;
  succeeded: number;
  failed: number;
  abandoned: number;
  retried: number;
  failure_stopped_reasons: {
    timeout: number;
    policy_blocked: number;
    cancelled: number;
    error: number;
    unknown: number;
    other: number;
  };
  total_tokens_used: number;
  success_rate: number | null;
  retry_rate: number | null;
  abandoned_rate: number | null;
  p95_created_to_acked_ms: number | null;
  p95_started_to_completed_ms: number | null;
  p95_created_to_completed_ms: number | null;
}

interface AppendTaskOutcomeEventParams {
  task: Task;
  type: TaskOutcomeEventType;
  attempt?: number;
  ts?: string;
  action?: string;
  reason?: string;
  stoppedReason?: string | null;
  verificationResult?: VerificationResult;
  elapsedMs?: number | null;
  tokensUsed?: number | null;
}

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function diffMs(start: string | null | undefined, end: string | null | undefined): number | null {
  const startMs = toMillis(start);
  const endMs = toMillis(end);
  if (startMs === null || endMs === null) return null;
  return Math.max(0, endMs - startMs);
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function estimateDurationMs(task: Task): number | null {
  if (!task.estimated_duration) return null;
  const multipliers: Record<string, number> = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };
  return task.estimated_duration.value * (multipliers[task.estimated_duration.unit] ?? 60 * 60 * 1000);
}

function buildEvent(params: AppendTaskOutcomeEventParams): TaskOutcomeEvent {
  const ts = params.ts ?? new Date().toISOString();
  return {
    type: params.type,
    ts,
    attempt: params.attempt ?? Math.max(params.task.consecutive_failure_count, 1),
    task_status: params.task.status,
    verification_verdict: params.verificationResult?.verdict ?? params.task.verification_verdict,
    action: params.action,
    reason: params.reason,
    stopped_reason: params.stoppedReason ?? null,
    created_at: params.task.created_at ?? null,
    acked_at: params.type === "acked" ? ts : null,
    started_at: params.task.started_at ?? null,
    completed_at: params.task.completed_at ?? null,
    verification_at: params.verificationResult?.timestamp ?? null,
    elapsed_ms: params.elapsedMs ?? diffMs(params.task.started_at, params.task.completed_at),
    estimated_duration_ms: estimateDurationMs(params.task),
    tokens_used: typeof params.tokensUsed === "number" ? params.tokensUsed : null,
  };
}

function findLastEvent(
  events: TaskOutcomeEvent[],
  predicate: (event: TaskOutcomeEvent) => boolean
): TaskOutcomeEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) {
      return event;
    }
  }
  return null;
}

function summarizeStoppedReason(task: Task, events: TaskOutcomeEvent[], lastEvent: TaskOutcomeEvent | null): string | null {
  if (lastEvent?.stopped_reason !== null && lastEvent?.stopped_reason !== undefined) {
    return lastEvent.stopped_reason;
  }
  if (task.status === "timed_out") {
    return "timeout";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "blocked") {
    return "blocked";
  }
  return null;
}

function buildSummary(task: Task, events: TaskOutcomeEvent[]): TaskOutcomeSummary {
  const ackedAt = findLastEvent(events, (event) => event.type === "acked")?.acked_at ?? null;
  const lastEvent = events.at(-1) ?? null;
  const lastFailure = findLastEvent(events, (event) => event.type === "failed");
  const lastAbandoned = findLastEvent(events, (event) => event.type === "abandoned");
  const latestStoppedReason = summarizeStoppedReason(task, events, lastEvent);
  const verificationAt =
    lastEvent?.verification_at ??
    findLastEvent(events, (event) => event.verification_at !== null)?.verification_at ??
    null;
  const latestTokensUsed = findLastEvent(events, (event) => typeof event.tokens_used === "number")?.tokens_used ?? 0;

  return {
    task_id: task.id,
    goal_id: task.goal_id,
    latest_event_type: lastEvent?.type ?? null,
    latest_event_at: lastEvent?.ts ?? null,
    attempt: lastEvent?.attempt ?? Math.max(task.consecutive_failure_count, 1),
    task_status: task.status,
    verification_verdict: task.verification_verdict,
    action: lastEvent?.action,
    stopped_reason: latestStoppedReason,
    created_at: task.created_at ?? null,
    acked_at: ackedAt,
    started_at: task.started_at ?? null,
    completed_at: task.completed_at ?? null,
    verification_at: verificationAt,
    last_failure_at: lastFailure?.ts ?? null,
    abandoned_at: lastAbandoned?.ts ?? null,
    estimated_duration_ms: estimateDurationMs(task),
    tokens_used: latestTokensUsed,
    latencies: {
      created_to_acked_ms: diffMs(task.created_at ?? null, ackedAt),
      acked_to_started_ms: diffMs(ackedAt, task.started_at ?? null),
      started_to_completed_ms: diffMs(task.started_at ?? null, task.completed_at ?? null),
      completed_to_verification_ms: diffMs(task.completed_at ?? null, verificationAt),
      created_to_completed_ms: diffMs(task.created_at ?? null, task.completed_at ?? null),
    },
  };
}

async function readLedgerRecord(
  stateManager: StateManager,
  goalId: string,
  taskId: string
): Promise<TaskOutcomeLedgerRecord | null> {
  const existing = await stateManager.loadTaskOutcomeLedger(goalId, taskId);
  if (!existing || typeof existing !== "object") {
    return null;
  }
  const record = existing as unknown as Partial<TaskOutcomeLedgerRecord>;
  return {
    task_id: typeof record.task_id === "string" ? record.task_id : taskId,
    goal_id: typeof record.goal_id === "string" ? record.goal_id : goalId,
    events: Array.isArray(record.events) ? (record.events as TaskOutcomeEvent[]) : [],
    summary: record.summary as TaskOutcomeSummary,
  };
}

async function writeLedgerRecord(
  stateManager: StateManager,
  task: Task,
  events: TaskOutcomeEvent[]
): Promise<TaskOutcomeLedgerRecord> {
  const record: TaskOutcomeLedgerRecord = {
    task_id: task.id,
    goal_id: task.goal_id,
    events,
    summary: buildSummary(task, events),
  };
  await stateManager.saveTaskOutcomeLedger(record);
  return record;
}

export async function appendTaskOutcomeEvent(
  stateManager: StateManager,
  params: AppendTaskOutcomeEventParams
): Promise<TaskOutcomeLedgerRecord> {
  const existing = await readLedgerRecord(stateManager, params.task.goal_id, params.task.id);
  const nextEvent = buildEvent(params);
  const events = [...(existing?.events ?? []), nextEvent];
  return writeLedgerRecord(stateManager, params.task, events);
}

export async function syncTaskOutcomeSummary(
  stateManager: StateManager,
  task: Task
): Promise<TaskOutcomeLedgerRecord> {
  const existing = await readLedgerRecord(stateManager, task.goal_id, task.id);
  return writeLedgerRecord(stateManager, task, existing?.events ?? []);
}

export async function setTaskOutcomeTokens(
  stateManager: StateManager,
  task: Task,
  tokensUsed: number
): Promise<TaskOutcomeLedgerRecord | null> {
  const existing = await readLedgerRecord(stateManager, task.goal_id, task.id);
  if (!existing) return null;
  const nextEvents = [...existing.events];
  const lastIndex = nextEvents.length - 1;
  if (lastIndex >= 0) {
    const lastEvent = nextEvents[lastIndex]!;
    nextEvents[lastIndex] = {
      ...lastEvent,
      tokens_used: tokensUsed,
    };
  } else {
    nextEvents.push(buildEvent({
      task,
      type: inferMutationEvent(task) ?? "acked",
      tokensUsed,
    }));
  }
  return writeLedgerRecord(stateManager, task, nextEvents);
}

function inferMutationEvent(task: Task): TaskOutcomeEventType | null {
  if (task.status === "running") return "started";
  if (task.verification_verdict === "pass") return "succeeded";
  if (task.status === "error" || task.status === "timed_out" || task.status === "blocked" || task.verification_verdict === "fail") return "failed";
  return null;
}

export async function recordTaskOutcomeMutation(
  stateManager: StateManager,
  task: Task
): Promise<TaskOutcomeLedgerRecord> {
  const existing = await readLedgerRecord(stateManager, task.goal_id, task.id);
  const inferredType = inferMutationEvent(task);
  const latestType = existing?.events.at(-1)?.type ?? null;
  if (latestType === "abandoned" || latestType === "succeeded") {
    return syncTaskOutcomeSummary(stateManager, task);
  }

  if (inferredType !== null && latestType !== inferredType) {
    return appendTaskOutcomeEvent(stateManager, {
      task,
      type: inferredType,
      attempt: Math.max(task.consecutive_failure_count, 1),
      reason: inferredType === "abandoned" ? "task mutated externally" : undefined,
    });
  }

  return syncTaskOutcomeSummary(stateManager, task);
}

export async function summarizeTaskOutcomeLedgers(baseDir: string): Promise<TaskOutcomeAggregateSummary> {
  const records = await new GoalTaskStateStore(baseDir).listTaskOutcomeLedgers() as unknown as TaskOutcomeLedgerRecord[];
  const createdToAcked = records
    .map((record) => record.summary.latencies.created_to_acked_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startedToCompleted = records
    .map((record) => record.summary.latencies.started_to_completed_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const createdToCompleted = records
    .map((record) => record.summary.latencies.created_to_completed_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const succeeded = records.filter((record) => record.summary.latest_event_type === "succeeded").length;
  const failed = records.filter((record) => record.summary.latest_event_type === "failed").length;
  const abandoned = records.filter((record) => record.summary.latest_event_type === "abandoned").length;
  const retried = records.filter((record) => record.events.some((event) => event.type === "retried")).length;
  const failureStoppedReasons = records
    .filter((record) => record.summary.latest_event_type === "failed" || record.summary.latest_event_type === "abandoned")
    .reduce<TaskOutcomeAggregateSummary["failure_stopped_reasons"]>((counts, record) => {
      const latestEvent = record.events.at(-1) ?? null;
      const stoppedReason =
        record.summary.stopped_reason ??
        latestEvent?.stopped_reason ??
        null;
      if (stoppedReason === "timeout" || record.summary.task_status === "timed_out") {
        counts.timeout += 1;
      } else if (stoppedReason === "policy_blocked") {
        counts.policy_blocked += 1;
      } else if (stoppedReason === "cancelled" || record.summary.task_status === "cancelled") {
        counts.cancelled += 1;
      } else if (stoppedReason === "error") {
        counts.error += 1;
      } else if (stoppedReason === null) {
        counts.unknown += 1;
      } else {
        counts.other += 1;
      }
      return counts;
    }, {
      timeout: 0,
      policy_blocked: 0,
      cancelled: 0,
      error: 0,
      unknown: 0,
      other: 0,
    });
  const totalTokensUsed = records.reduce((sum, record) => sum + (record.summary.tokens_used ?? 0), 0);
  const inflightTasks = records.filter((record) => {
    const latestEvent = record.summary.latest_event_type;
    return latestEvent === "acked" || latestEvent === "started" || latestEvent === "retried";
  }).length;
  const terminalTasks = succeeded + failed + abandoned;

  return {
    total_tasks: records.length,
    terminal_tasks: terminalTasks,
    inflight_tasks: inflightTasks,
    succeeded,
    failed,
    abandoned,
    retried,
    failure_stopped_reasons: failureStoppedReasons,
    total_tokens_used: totalTokensUsed,
    success_rate: terminalTasks > 0 ? succeeded / terminalTasks : null,
    retry_rate: records.length > 0 ? retried / records.length : null,
    abandoned_rate: terminalTasks > 0 ? abandoned / terminalTasks : null,
    p95_created_to_acked_ms: percentile95(createdToAcked),
    p95_started_to_completed_ms: percentile95(startedToCompleted),
    p95_created_to_completed_ms: percentile95(createdToCompleted),
  };
}
