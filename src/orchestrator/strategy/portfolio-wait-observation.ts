import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { CapabilityRegistrySchema } from "../../base/types/capability.js";
import type {
  WaitCondition,
  WaitMetadata,
  WaitObservationResult,
  WaitExpiryOutcome,
} from "../../base/types/strategy.js";
import { ProcessSessionStateStore } from "../../runtime/store/process-session-state-store.js";

const DEFAULT_WAIT_REOBSERVE_MS = 5 * 60 * 1000;
const JSON_POINTER_ARRAY_INDEX_TOKEN = /^[0-9]+$/;
const PROCESS_SESSION_SIGNALS = new Set(Object.keys(os.constants.signals));
const PROCESS_SESSION_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ProcessSessionWaitSnapshotSchema = z.object({
  session_id: z.string().min(1),
  running: z.boolean(),
  pid: z.preprocess(
    (value) => isProcessPidValue(value) ? value : undefined,
    z.number().int().positive().safe().optional()
  ),
  exitCode: z.preprocess(
    (value) => isProcessExitCodeValue(value) ? value : null,
    z.number().int().safe().nullable()
  ),
  signal: z.preprocess(
    (value) => isProcessSignalValue(value) ? value : null,
    z.string().min(1).nullable()
  ),
  exitedAt: z.preprocess(
    (value) => isProcessTimestampValue(value) ? value : undefined,
    z.string().min(1).optional()
  ),
}).passthrough();
type ProcessSessionWaitSnapshot = z.infer<typeof ProcessSessionWaitSnapshotSchema>;

interface WaitConditionEvaluationContext {
  nowMs: number;
  stateBaseDir: string | null;
}

interface ConditionEvaluation {
  status: WaitObservationResult["status"];
  evidence: Record<string, unknown>;
  nextObserveAt?: string | null;
  resumeHint?: string | null;
}

export async function approvalOutcomeFromWaitMetadata(
  goalId: string,
  strategyId: string,
  metadata: WaitMetadata,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>,
  getWaitApprovalRecord?: (approvalId: string) => unknown | null | Promise<unknown | null>
): Promise<WaitExpiryOutcome | null> {
  const resumePlan = metadata.resume_plan;
  if (resumePlan.action === "request_approval") {
    const existingApproval = await getApprovedWaitApproval(goalId, strategyId, getWaitApprovalRecord);
    if (existingApproval) return null;
    return {
      status: "approval_required",
      goal_id: goalId,
      strategy_id: strategyId,
      details: resumePlan.reason ?? "WaitStrategy requires approval before continuing",
    };
  }

  const approvalPolicy = asRecord(metadata.approval_policy);
  if (!approvalPolicy) return null;

  const required = approvalPolicy["required"] === true || approvalPolicy["requires_approval"] === true;
  if (!required) return null;

  const existingApproval = await getApprovedWaitApproval(goalId, strategyId, getWaitApprovalRecord);
  if (existingApproval) return null;

  const capabilityName = typeof approvalPolicy["capability"] === "string"
    ? approvalPolicy["capability"]
    : typeof approvalPolicy["approved_capability"] === "string"
      ? approvalPolicy["approved_capability"]
      : null;
  if (capabilityName && await hasAvailableCapability(capabilityName, getCapabilityRegistry)) {
    return null;
  }

  return {
    status: "approval_required",
    goal_id: goalId,
    strategy_id: strategyId,
    details: capabilityName
      ? `WaitStrategy requires approved capability: ${capabilityName}`
      : "WaitStrategy requires approval before continuing",
  };
}

export async function missingRequiredCapabilities(
  metadata: WaitMetadata,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>
): Promise<string[]> {
  const raw = (metadata as Record<string, unknown>)["required_capabilities"];
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const missing: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string"
      ? item
      : asRecord(item) && typeof asRecord(item)?.["name"] === "string"
        ? asRecord(item)?.["name"] as string
        : null;
    if (!name) continue;
    if (!await hasAvailableCapability(name, getCapabilityRegistry)) missing.push(name);
  }
  return missing;
}

export async function evaluateWaitConditions(
  conditions: WaitCondition[],
  metadata: WaitMetadata,
  context: WaitConditionEvaluationContext
): Promise<WaitObservationResult> {
  const results = await Promise.all(conditions.map((condition) => evaluateWaitCondition(condition, metadata, context)));
  const evidence = {
    conditions: results.map((result) => result.evidence),
  };

  const failed = results.find((result) => result.status === "failed" || result.status === "expired");
  if (failed) {
    return {
      status: failed.status,
      evidence,
      next_observe_at: nextReobserveAt(context.nowMs),
      confidence: 0.1,
      resume_hint: failed.resumeHint ?? null,
    };
  }

  const pending = results.find((result) => result.status === "pending" || result.status === "stale");
  if (pending) {
    return {
      status: pending.status,
      evidence,
      next_observe_at: pending.nextObserveAt ?? nextReobserveAt(context.nowMs),
      confidence: 0.4,
      resume_hint: pending.resumeHint ?? null,
    };
  }

  return {
    status: "satisfied",
    evidence,
    next_observe_at: null,
    confidence: 0.9,
    resume_hint: "wait_conditions_satisfied",
  };
}

export async function persistWaitObservation(
  goalId: string,
  strategyId: string,
  metadata: WaitMetadata,
  observation: WaitObservationResult,
  writeWaitMetadata?: (goalId: string, strategyId: string, metadata: WaitMetadata) => void | Promise<void>
): Promise<void> {
  if (!writeWaitMetadata) return;
  try {
    await writeWaitMetadata(goalId, strategyId, {
      ...metadata,
      next_observe_at: observation.next_observe_at,
      latest_observation: observation,
    });
  } catch {
    // Durable observation sidecars are fail-soft; wait expiry can still decide from live state.
  }
}

export function nextReobserveAt(nowMs: number): string {
  return new Date(nowMs + DEFAULT_WAIT_REOBSERVE_MS).toISOString();
}

export function buildWaitApprovalId(goalId: string, strategyId: string): string {
  return `wait-${encodeURIComponent(goalId)}-${encodeURIComponent(strategyId)}`;
}

export function resolveConditionPath(inputPath: string, stateBaseDir: string | null): string | null {
  const base = path.resolve(stateBaseDir ?? process.cwd());
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

export function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  const parts = pointer.startsWith("/")
    ? pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    : pointer.split(".");
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = parseJsonPointerArrayIndex(part);
      current = index !== null ? current[index] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function parseJsonPointerArrayIndex(part: string): number | null {
  if (!JSON_POINTER_ARRAY_INDEX_TOKEN.test(part)) return null;
  const index = Number(part);
  return Number.isSafeInteger(index) ? index : null;
}

export function isProcessPidValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isProcessTimestampValue(value: unknown): value is string {
  if (typeof value !== "string" || !PROCESS_SESSION_ISO_TIMESTAMP.test(value)) return false;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === value;
}

async function getApprovedWaitApproval(
  goalId: string,
  strategyId: string,
  getWaitApprovalRecord?: (approvalId: string) => unknown | null | Promise<unknown | null>
): Promise<boolean> {
  if (!getWaitApprovalRecord) return false;
  const record = await getWaitApprovalRecord(buildWaitApprovalId(goalId, strategyId));
  if (!record || typeof record !== "object") return false;
  return (record as Record<string, unknown>)["state"] === "approved";
}

async function hasAvailableCapability(
  capabilityName: string,
  getCapabilityRegistry?: () => unknown | null | Promise<unknown | null>
): Promise<boolean> {
  if (!getCapabilityRegistry) return false;
  const raw = await getCapabilityRegistry();
  const parsed = CapabilityRegistrySchema.safeParse(raw);
  if (!parsed.success) return false;
  return parsed.data.capabilities.some(
    (capability) => capability.name === capabilityName && capability.status === "available"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

async function evaluateWaitCondition(
  condition: WaitCondition,
  metadata: WaitMetadata,
  context: WaitConditionEvaluationContext
): Promise<ConditionEvaluation> {
  try {
    switch (condition.type) {
      case "time_until": {
        const untilMs = Date.parse(condition.until);
        if (!Number.isFinite(untilMs)) {
          return failedCondition(condition, "invalid_time_until");
        }
        if (untilMs > context.nowMs) {
          return {
            status: "pending",
            evidence: { condition, due_at: condition.until },
            nextObserveAt: condition.until,
            resumeHint: `waiting until ${condition.until}`,
          };
        }
        return satisfiedCondition(condition, { due_at: condition.until });
      }
      case "file_exists": {
        const target = resolveConditionPath(condition.path, context.stateBaseDir);
        if (!target) return failedCondition(condition, `path escapes state base: ${condition.path}`);
        try {
          await fsp.access(target);
          return satisfiedCondition(condition, { path: target });
        } catch {
          return pendingCondition(condition, `file not found: ${condition.path}`);
        }
      }
      case "file_mtime_changed": {
        const target = resolveConditionPath(condition.path, context.stateBaseDir);
        if (!target) return failedCondition(condition, `path escapes state base: ${condition.path}`);
        try {
          const stats = await fsp.stat(target);
          if (stats.mtimeMs > condition.previous_mtime_ms) {
            return satisfiedCondition(condition, { path: target, mtime_ms: stats.mtimeMs });
          }
          return staleCondition(condition, `file mtime unchanged: ${condition.path}`, { path: target, mtime_ms: stats.mtimeMs });
        } catch {
          return pendingCondition(condition, `file not found: ${condition.path}`);
        }
      }
      case "process_session_exited": {
        const snapshot = await readProcessSessionSnapshot(condition.session_id, context.stateBaseDir);
        if (!snapshot) {
          return pendingCondition(condition, `process session metadata not found: ${condition.session_id}`);
        }
        const exited = snapshot.running === false
          || snapshot.exitCode !== null
          || typeof snapshot.exitedAt === "string"
          || snapshot.signal !== null;
        if (exited) {
          return satisfiedCondition(condition, {
            session_id: condition.session_id,
            exitCode: snapshot.exitCode,
            signal: snapshot.signal,
            exitedAt: snapshot.exitedAt ?? null,
          });
        }
        if (isProcessPidValue(snapshot.pid) && !isProcessAlive(snapshot.pid)) {
          return satisfiedCondition(condition, {
            session_id: condition.session_id,
            pid: snapshot.pid,
            inferred_exit: true,
          });
        }
        return staleCondition(condition, `process session still running: ${condition.session_id}`, {
          session_id: condition.session_id,
          pid: snapshot.pid ?? null,
        });
      }
      case "artifact_json_value": {
        const target = resolveConditionPath(condition.path, context.stateBaseDir);
        if (!target) return failedCondition(condition, `path escapes state base: ${condition.path}`);
        try {
          const parsed = JSON.parse(await fsp.readFile(target, "utf8"));
          const actual = readJsonPointer(parsed, condition.json_pointer);
          if (jsonEqual(actual, condition.expected)) {
            return satisfiedCondition(condition, { path: target, json_pointer: condition.json_pointer, actual });
          }
          return staleCondition(condition, `artifact value did not match: ${condition.path} ${condition.json_pointer}`, {
            path: target,
            json_pointer: condition.json_pointer,
            actual,
            expected: condition.expected,
          });
        } catch (err) {
          return pendingCondition(condition, `artifact JSON unavailable: ${condition.path}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      case "metric_threshold": {
        const actual = readMetric(metadata, condition.metric);
        if (typeof actual !== "number") {
          return pendingCondition(condition, `metric unavailable: ${condition.metric}`);
        }
        if (compareMetric(actual, condition.operator, condition.value)) {
          return satisfiedCondition(condition, { metric: condition.metric, actual, operator: condition.operator, value: condition.value });
        }
        return staleCondition(condition, `metric threshold not reached: ${condition.metric}`, {
          metric: condition.metric,
          actual,
          operator: condition.operator,
          value: condition.value,
        });
      }
    }
  } catch (err) {
    return failedCondition(condition, err instanceof Error ? err.message : String(err));
  }
}

function satisfiedCondition(condition: WaitCondition, evidence: Record<string, unknown> = {}): ConditionEvaluation {
  return { status: "satisfied", evidence: { condition, ...evidence } };
}

function pendingCondition(
  condition: WaitCondition,
  resumeHint: string,
  evidence: Record<string, unknown> = {}
): ConditionEvaluation {
  return { status: "pending", evidence: { condition, ...evidence }, resumeHint };
}

function staleCondition(
  condition: WaitCondition,
  resumeHint: string,
  evidence: Record<string, unknown> = {}
): ConditionEvaluation {
  return { status: "stale", evidence: { condition, ...evidence }, resumeHint };
}

function failedCondition(condition: WaitCondition, resumeHint: string): ConditionEvaluation {
  return { status: "failed", evidence: { condition, error: resumeHint }, resumeHint };
}

async function readProcessSessionSnapshot(
  sessionId: string,
  stateBaseDir: string | null
): Promise<ProcessSessionWaitSnapshot | null> {
  if (!isSafeSessionId(sessionId)) return null;
  if (!stateBaseDir) return null;
  const snapshot = await new ProcessSessionStateStore(stateBaseDir).loadSnapshot(sessionId);
  const parsed = ProcessSessionWaitSnapshotSchema.safeParse(snapshot);
  return parsed.success && parsed.data.session_id === sessionId ? parsed.data : null;
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readMetric(metadata: WaitMetadata, metric: string): number | null {
  const candidates: unknown[] = [
    (metadata as Record<string, unknown>)[metric],
    asRecord((metadata as Record<string, unknown>)["metrics"])?.[metric],
    metadata.latest_observation?.evidence[metric],
    asRecord(metadata.latest_observation?.evidence["metrics"])?.[metric],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function compareMetric(actual: number, operator: "lt" | "lte" | "eq" | "gte" | "gt", expected: number): boolean {
  switch (operator) {
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
    case "eq": return actual === expected;
    case "gte": return actual >= expected;
    case "gt": return actual > expected;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!isProcessPidValue(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessExitCodeValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isProcessSignalValue(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && PROCESS_SESSION_SIGNALS.has(value);
}
