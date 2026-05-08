import type {
  BackgroundRun,
  RuntimeSessionRegistrySnapshot,
} from "../session-registry/index.js";
import type { RuntimeControlOperationKind } from "../store/runtime-operation-schemas.js";
import type {
  RuntimeControlTargetHint,
  RuntimeControlTargetSelector,
} from "./runtime-control-intent.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const ATTENTION_RUN_STATUSES = new Set(["failed", "timed_out", "lost"]);

export interface RuntimeTargetResolutionEvidence {
  selector: RuntimeControlTargetSelector | null;
  candidates: Array<{
    run_id: string;
    status: string;
    updated_at: string | null;
    parent_session_id: string | null;
    child_session_id: string | null;
    goal_id: string | null;
  }>;
  reason: string;
}

export type RuntimeTargetResolution =
  | { status: "resolved"; run: BackgroundRun; goalId: string | null; evidence: RuntimeTargetResolutionEvidence }
  | { status: "ambiguous"; evidence: RuntimeTargetResolutionEvidence }
  | { status: "stale"; evidence: RuntimeTargetResolutionEvidence }
  | { status: "unknown"; evidence: RuntimeTargetResolutionEvidence };

export interface ResolveRuntimeTargetInput {
  snapshot: RuntimeSessionRegistrySnapshot;
  operation: RuntimeControlOperationKind;
  target?: RuntimeControlTargetHint;
  selector?: RuntimeControlTargetSelector;
  conversationId?: string | null;
}

export function resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTargetResolution {
  const selectable = selectableRuns(input.snapshot);
  const explicit = resolveExplicitTarget(input.snapshot, input.target);
  if (explicit.status === "resolved") {
    return currentOrStale(explicit.run, input.operation, input.selector ?? null, selectable, "explicit target matched the runtime catalog");
  }
  if (explicit.status === "unknown") {
    return unknown(input.selector ?? null, selectable, "explicit run/session id did not match the runtime catalog");
  }

  const selector = input.selector ?? {
    scope: "run" as const,
    reference: "current" as const,
    sourceText: "implicit current runtime run",
  };
  if (selectable.length === 0) {
    return unknown(selector, selectable, "no active or attention-needed runtime runs are available");
  }
  const scopeCandidates = scopedRunsBySelector(selectable, selector);
  if (scopeCandidates.length === 0) {
    return unknown(selector, selectable, `no ${selector.scope}-scoped runtime runs are available`);
  }
  const scoped = scopedConversationRuns(scopeCandidates, input.conversationId);
  const candidates = scoped.length > 0 ? scoped : scopeCandidates;

  switch (selector.reference) {
    case "current":
    case "mentioned":
      if (input.conversationId && scoped.length === 0) {
        return unknown(
          selector,
          selectable,
          "no current runtime run is associated with this conversation; refusing to reuse another conversation's runtime run"
        );
      }
      if (candidates.length === 1) {
        return currentOrStale(candidates[0], input.operation, selector, candidates, "single current candidate resolved");
      }
      return ambiguous(selector, candidates, "multiple current candidates require clarification");
    case "latest":
      if (input.conversationId && scoped.length === 0) {
        return unknown(
          selector,
          selectable,
          "no latest runtime run is associated with this conversation; refusing to reuse another conversation's runtime run"
        );
      }
      {
        const timestamped = timestampedRuns(candidates);
        if (timestamped.length === 0) {
          return unknown(selector, candidates, "latest target was requested but no timestamped runtime run is available");
        }
        return currentOrStale(timestamped[0], input.operation, selector, candidates, "latest candidate selected by runtime timestamp");
      }
    case "previous":
      if (input.conversationId && scoped.length === 0) {
        return unknown(
          selector,
          selectable,
          "no previous runtime run is associated with this conversation; refusing to reuse another conversation's runtime run"
        );
      }
      {
        const timestamped = timestampedRuns(candidates);
        if (timestamped.length < 2) {
          return unknown(selector, candidates, "previous target was requested but there is no earlier timestamped candidate");
        }
        return currentOrStale(timestamped[1], input.operation, selector, candidates, "previous candidate selected by runtime timestamp");
      }
    case "exact":
      return unknown(selector, candidates, "exact target selector requires an explicit run or session id");
  }
}

function resolveExplicitTarget(
  snapshot: RuntimeSessionRegistrySnapshot,
  target: RuntimeControlTargetHint | undefined
): { status: "resolved"; run: BackgroundRun } | { status: "unknown" } | { status: "none" } {
  if (!target?.runId && !target?.sessionId) return { status: "none" };
  const run = target.runId
    ? snapshot.background_runs.find((candidate) => candidate.id === target.runId)
    : snapshot.background_runs.find((candidate) => candidate.child_session_id === target.sessionId);
  return run ? { status: "resolved", run } : { status: "unknown" };
}

function currentOrStale(
  run: BackgroundRun,
  operation: RuntimeControlOperationKind,
  selector: RuntimeControlTargetSelector | null,
  candidates: BackgroundRun[],
  reason: string
): RuntimeTargetResolution {
  if (!isCurrentRunForControl(run, operation)) {
    return stale(selector, candidates, `runtime run ${run.id} is stale or terminal for ${operation}`);
  }
  return {
    status: "resolved",
    run,
    goalId: resolveGoalId(run),
    evidence: evidence(selector, candidates, reason),
  };
}

function selectableRuns(snapshot: RuntimeSessionRegistrySnapshot): BackgroundRun[] {
  return [...snapshot.background_runs]
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status) || ATTENTION_RUN_STATUSES.has(run.status))
    .sort((left, right) => compareUpdated(right, left));
}

function scopedRunsBySelector(candidates: BackgroundRun[], selector: RuntimeControlTargetSelector): BackgroundRun[] {
  if (selector.scope === "run") return candidates;
  return candidates.filter((run) => run.child_session_id !== null);
}

function scopedConversationRuns(candidates: BackgroundRun[], conversationId: string | null | undefined): BackgroundRun[] {
  if (!conversationId) return [];
  const currentSessionId = `session:conversation:${conversationId}`;
  return candidates.filter((run) => run.parent_session_id === currentSessionId);
}

function isCurrentRunForControl(run: BackgroundRun, kind: RuntimeControlOperationKind): boolean {
  if (kind === "inspect_run") return ACTIVE_RUN_STATUSES.has(run.status) || ATTENTION_RUN_STATUSES.has(run.status);
  if (kind === "pause_run") return ACTIVE_RUN_STATUSES.has(run.status);
  if (kind === "resume_run") return ACTIVE_RUN_STATUSES.has(run.status) || ATTENTION_RUN_STATUSES.has(run.status);
  if (kind === "cancel_run") return ACTIVE_RUN_STATUSES.has(run.status);
  if (kind === "finalize_run") return ACTIVE_RUN_STATUSES.has(run.status) || ATTENTION_RUN_STATUSES.has(run.status);
  return false;
}

function resolveGoalId(run: BackgroundRun): string | null {
  if (run.kind !== "coreloop_run") return null;
  return run.goal_id ?? null;
}

function compareUpdated(left: BackgroundRun, right: BackgroundRun): number {
  const leftTime = runtimeTimestamp(left);
  const rightTime = runtimeTimestamp(right);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return right.id.localeCompare(left.id);
}

function timestampedRuns(candidates: BackgroundRun[]): BackgroundRun[] {
  return [...candidates]
    .filter((run) => runtimeTimestamp(run) !== Number.NEGATIVE_INFINITY)
    .sort((left, right) => compareUpdated(right, left));
}

function runtimeTimestamp(run: BackgroundRun): number {
  for (const value of [run.updated_at, run.started_at, run.created_at]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function ambiguous(
  selector: RuntimeControlTargetSelector,
  candidates: BackgroundRun[],
  reason: string
): RuntimeTargetResolution {
  return { status: "ambiguous", evidence: evidence(selector, candidates, reason) };
}

function stale(
  selector: RuntimeControlTargetSelector | null,
  candidates: BackgroundRun[],
  reason: string
): RuntimeTargetResolution {
  return { status: "stale", evidence: evidence(selector, candidates, reason) };
}

function unknown(
  selector: RuntimeControlTargetSelector | null,
  candidates: BackgroundRun[],
  reason: string
): RuntimeTargetResolution {
  return { status: "unknown", evidence: evidence(selector, candidates, reason) };
}

function evidence(
  selector: RuntimeControlTargetSelector | null,
  candidates: BackgroundRun[],
  reason: string
): RuntimeTargetResolutionEvidence {
  return {
    selector,
    candidates: candidates.map((run) => ({
      run_id: run.id,
      status: run.status,
      updated_at: run.updated_at,
      parent_session_id: run.parent_session_id,
      child_session_id: run.child_session_id,
      goal_id: run.goal_id ?? null,
    })),
    reason,
  };
}
