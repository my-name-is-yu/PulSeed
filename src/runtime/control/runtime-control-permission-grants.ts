import { randomUUID } from "node:crypto";
import type {
  PermissionGrantCapability,
  PermissionGrantCreateInput,
  PermissionGrantRecord,
} from "../store/permission-grant-store.js";
import type {
  RuntimeControlActor,
  RuntimeControlOperationKind,
  RuntimeControlReplyTarget,
} from "../store/runtime-operation-schemas.js";
import type { RuntimeControlIntent } from "./runtime-control-intent.js";

export interface PermissionGrantControlContext {
  intent: RuntimeControlIntent;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
}

export function permissionGrantMatchesRequest(
  grant: PermissionGrantRecord,
  request: PermissionGrantControlContext,
): boolean {
  const target = request.intent.target;
  const hasTargetContext = Boolean(target?.runId || target?.sessionId);
  const targetMatches = Boolean(
    (target?.runId && grant.scope.kind === "run" && grant.scope.run_id === target.runId)
      || (target?.sessionId && (grant.scope.session_id === target.sessionId || grant.origin.session_id === target.sessionId))
  );
  const conversationId = request.replyTarget?.conversation_id ?? request.requestedBy?.conversation_id;
  const userId = request.replyTarget?.user_id ?? request.requestedBy?.user_id;
  const chatSurface = request.replyTarget?.surface === "chat" || request.requestedBy?.surface === "chat";

  if (conversationId) {
    if (grant.origin.conversation_id !== conversationId) return false;
    if (userId && grant.origin.user_id && grant.origin.user_id !== userId) return false;
    return hasTargetContext ? targetMatches : true;
  }
  if (userId) {
    if (grant.origin.user_id !== userId) return false;
    return hasTargetContext ? targetMatches : true;
  }
  if (chatSurface) return false;
  return targetMatches;
}

export function hasPermissionGrantSelectionContext(request: PermissionGrantControlContext): boolean {
  const target = request.intent.target;
  return Boolean(
    target?.runId
    || target?.sessionId
    || request.replyTarget?.conversation_id
    || request.requestedBy?.conversation_id
    || request.replyTarget?.user_id
    || request.requestedBy?.user_id
    || request.replyTarget?.surface === "chat"
    || request.requestedBy?.surface === "chat"
  );
}

export function formatPermissionGrantSummary(grants: PermissionGrantRecord[]): string {
  if (grants.length === 0) {
    return "No active PermissionGrant matches this chat/runtime context.";
  }
  return [
    "Active permission boundary:",
    ...grants.map((grant) => [
      `- ${grant.grant_id}`,
      `scope=${formatGrantScope(grant)}`,
      `duration=${grant.duration.kind}`,
      `review=${grant.review.kind === "periodic" ? new Date(grant.review.due_at).toISOString() : "none"}`,
      `capabilities=${grant.capabilities.join(", ")}`,
      `excluded=${grant.excluded_capabilities.length > 0 ? grant.excluded_capabilities.join(", ") : "none"}`,
      `uses=${grant.usage_count}`,
      "source=redacted",
    ].join("; ")),
  ].join("\n");
}

export function formatPermissionGrantAudit(grants: PermissionGrantRecord[]): string {
  if (grants.length === 0) {
    return "No PermissionGrant audit records match this chat/runtime context.";
  }
  return [
    "PermissionGrant audit:",
    ...grants.map((grant) => [
      `- ${grant.grant_id}`,
      `state=${grant.state}`,
      `scope=${formatGrantScope(grant)}`,
      `review=${grant.review.kind === "periodic" ? new Date(grant.review.due_at).toISOString() : "none"}`,
      `capabilities=${grant.capabilities.join(", ")}`,
      `excluded=${grant.excluded_capabilities.length > 0 ? grant.excluded_capabilities.join(", ") : "none"}`,
      `uses=${grant.usage_count}`,
      `last_used=${grant.last_used_at ? new Date(grant.last_used_at).toISOString() : "never"}`,
      `audit_refs=${grant.audit_refs.length > 0 ? grant.audit_refs.join(", ") : "none"}`,
    ].join("; ")),
    "Covered local actions may reuse matching active grants. Excluded, stale, revoked, unknown, remote, destructive, or hard-boundary actions still ask again or block.",
  ].join("\n");
}

export function nextPermissionCapabilities(
  grant: PermissionGrantRecord,
  requested: PermissionGrantCapability[] | undefined,
  kind: Extract<RuntimeControlOperationKind, "narrow_permission" | "extend_permission">,
): PermissionGrantCapability[] {
  const requestedUnique = uniqueCapabilities(requested ?? []);
  if (kind === "narrow_permission") {
    const allowed = new Set(grant.capabilities);
    return requestedUnique.filter((capability) => allowed.has(capability));
  }
  return uniqueCapabilities([...grant.capabilities, ...requestedUnique]);
}

export function replacementGrantInput(
  grant: PermissionGrantRecord,
  capabilities: PermissionGrantCapability[],
  request: PermissionGrantControlContext,
  operationId: string,
): PermissionGrantCreateInput {
  const now = Date.now();
  return {
    grant_id: `permission-grant:${operationId}:${randomUUID()}`,
    subject: grant.subject,
    origin: grant.origin,
    source: grant.source,
    scope: grant.scope,
    duration: grant.duration,
    review: grant.review,
    capabilities,
    excluded_capabilities: request.intent.permissionExcludedCapabilities ?? grant.excluded_capabilities,
    staleness: grant.staleness,
    audit_refs: [`runtime-control:${operationId}`],
    supersedes: [grant.grant_id],
    created_at: now,
  };
}

export function actorKey(actor: RuntimeControlActor | undefined): string {
  return actor?.identity_key ?? actor?.user_id ?? actor?.conversation_id ?? actor?.surface ?? "operator";
}

function formatGrantScope(grant: PermissionGrantRecord): string {
  switch (grant.scope.kind) {
    case "turn":
      return `turn:${grant.scope.turn_id}`;
    case "run":
      return `run:${grant.scope.run_id}`;
    case "goal":
      return `goal:${grant.scope.goal_id}`;
    case "session":
      return `session:${grant.scope.session_id}`;
    case "workspace":
      return `workspace:${grant.scope.workspace_root}`;
    case "project":
      return `project:${grant.scope.project_id}`;
    case "global":
      return "global";
  }
}

function uniqueCapabilities(capabilities: PermissionGrantCapability[]): PermissionGrantCapability[] {
  return [...new Set(capabilities)];
}
