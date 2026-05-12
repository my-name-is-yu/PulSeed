import {
  AttentionScopeSchema,
  type AttentionConflict,
  type AttentionPermissionScope,
  type AttentionScope,
  type AttentionScopeSensitivity,
  type AttentionSensitivity,
  type SignalContext,
} from "../types/companion-autonomy.js";
import { refKey, stableId } from "./attention-refs.js";

export type ScopeCompatibilityDecision =
  | { outcome: "compatible"; derivedScope: AttentionScope; reasons: string[] }
  | { outcome: "conflict"; conflict: AttentionConflict; reasons: string[] }
  | { outcome: "unknown"; reasons: string[] };

type Authority = "none" | "read" | "draft" | "notify" | "write";

const UNKNOWN_CONFLICT_AT = "1970-01-01T00:00:00.000Z";

const PERMISSION_AUTHORITIES: Record<AttentionPermissionScope, ReadonlySet<Authority>> = {
  local_only: new Set(["none"]),
  read_only: new Set(["none", "read"]),
  draft_allowed: new Set(["none", "read", "draft"]),
  notify_allowed: new Set(["none", "notify"]),
  write_allowed: new Set(["none", "read", "draft", "write"]),
  unknown: new Set(),
};

export function decideScopeCompatibility(
  left: AttentionScope,
  right: AttentionScope,
): ScopeCompatibilityDecision {
  const parsedLeft = AttentionScopeSchema.parse(left);
  const parsedRight = AttentionScopeSchema.parse(right);

  if (parsedLeft.permissionScope === "unknown" || parsedRight.permissionScope === "unknown") {
    return {
      outcome: "unknown",
      reasons: ["unknown permission scope fails closed before concern merge"],
    };
  }
  if (parsedLeft.sensitivity === "unknown" || parsedRight.sensitivity === "unknown") {
    return {
      outcome: "unknown",
      reasons: ["unknown sensitivity fails closed before concern merge"],
    };
  }
  if (parsedLeft.policyEpoch !== parsedRight.policyEpoch) {
    return conflict("policy_epoch_mismatch", "policy epoch mismatch requires regrounding before merge", [
      `left:${parsedLeft.policyEpoch}`,
      `right:${parsedRight.policyEpoch}`,
    ]);
  }

  const identityDecision = deriveNullableIdentity("userId", parsedLeft.userId, parsedRight.userId);
  if (identityDecision.outcome !== "compatible") return identityDecision;

  for (const field of ["identityId", "workspaceId", "conversationId", "sessionId", "surfaceRef", "memoryOwner"] as const) {
    const decision = deriveNullableIdentity(field, parsedLeft[field] ?? null, parsedRight[field] ?? null);
    if (decision.outcome !== "compatible") return decision;
  }

  if (parsedLeft.surfaceClass !== parsedRight.surfaceClass) {
    return conflict("scope_conflict", "surface class mismatch requires an explicit cross-surface relation", [
      parsedLeft.surfaceClass,
      parsedRight.surfaceClass,
    ]);
  }

  const derivedPermission = derivePermissionScope([parsedLeft.permissionScope, parsedRight.permissionScope]);
  if (!derivedPermission) {
    return {
      outcome: "unknown",
      reasons: ["permission lattice intersection is not representable as an outward-capable scope"],
    };
  }

  const derivedScope = AttentionScopeSchema.parse({
    userId: identityDecision.value,
    identityId: parsedLeft.identityId ?? parsedRight.identityId ?? null,
    workspaceId: parsedLeft.workspaceId ?? parsedRight.workspaceId ?? null,
    conversationId: parsedLeft.conversationId ?? parsedRight.conversationId ?? null,
    sessionId: parsedLeft.sessionId ?? parsedRight.sessionId ?? null,
    surfaceClass: parsedLeft.surfaceClass,
    surfaceRef: parsedLeft.surfaceRef ?? parsedRight.surfaceRef ?? null,
    permissionScope: derivedPermission,
    sensitivity: maxSensitivity(parsedLeft.sensitivity, parsedRight.sensitivity),
    memoryOwner: parsedLeft.memoryOwner ?? parsedRight.memoryOwner ?? null,
    policyEpoch: parsedLeft.policyEpoch,
  });

  return {
    outcome: "compatible",
    derivedScope,
    reasons: [
      "scope identity fields are compatible",
      `permission narrowed to ${derivedPermission}`,
      `sensitivity derived as ${derivedScope.sensitivity}`,
    ],
  };
}

export function deriveClusterScope(scopes: readonly AttentionScope[]): ScopeCompatibilityDecision {
  if (scopes.length === 0) {
    return {
      outcome: "unknown",
      reasons: ["cannot derive a cluster scope without member scopes"],
    };
  }

  let current = AttentionScopeSchema.parse(scopes[0]);
  const reasons: string[] = [];
  for (const next of scopes.slice(1)) {
    const decision = decideScopeCompatibility(current, next);
    if (decision.outcome !== "compatible") return decision;
    current = decision.derivedScope;
    reasons.push(...decision.reasons);
  }

  return {
    outcome: "compatible",
    derivedScope: current,
    reasons: reasons.length > 0 ? reasons : ["single member scope retained"],
  };
}

export function deriveAttentionScopeFromSignalContext(input: {
  signalContext: SignalContext;
  policyEpoch?: string;
  permissionScope?: AttentionPermissionScope;
  sensitivity?: AttentionSensitivity | AttentionScopeSensitivity;
  userId?: string | null;
  identityId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  memoryOwner?: string | null;
}): AttentionScope {
  const surfaceClass = surfaceClassForSignalContext(input.signalContext);
  const surfaceRef = input.signalContext.active_surface_ref
    ? refKey(input.signalContext.active_surface_ref)
    : null;
  const sessionId = input.sessionId
    ?? input.signalContext.current_session_refs[0]?.id
    ?? null;

  return AttentionScopeSchema.parse({
    userId: input.userId ?? null,
    identityId: input.identityId ?? null,
    workspaceId: input.workspaceId ?? null,
    conversationId: input.conversationId ?? null,
    sessionId,
    surfaceClass,
    surfaceRef,
    permissionScope: input.permissionScope ?? "local_only",
    sensitivity: normalizeScopeSensitivity(input.sensitivity ?? "medium"),
    memoryOwner: input.memoryOwner ?? null,
    policyEpoch: input.policyEpoch ?? "policy:default",
  });
}

export function permissionScopeAllowsAuthority(
  permissionScope: AttentionPermissionScope,
  authority: Authority,
): boolean {
  return PERMISSION_AUTHORITIES[permissionScope].has(authority);
}

export function derivePermissionScope(scopes: readonly AttentionPermissionScope[]): AttentionPermissionScope | null {
  if (scopes.length === 0 || scopes.includes("unknown")) return null;
  const intersection = [...PERMISSION_AUTHORITIES[scopes[0] ?? "unknown"]]
    .filter((authority) => scopes.every((scope) => PERMISSION_AUTHORITIES[scope].has(authority)));

  for (const [scope, authorities] of Object.entries(PERMISSION_AUTHORITIES) as Array<[AttentionPermissionScope, ReadonlySet<Authority>]>) {
    if (scope === "unknown") continue;
    if (sameAuthoritySet(authorities, new Set(intersection))) return scope;
  }

  if (intersection.length === 1 && intersection[0] === "none") return "local_only";
  return null;
}

function deriveNullableIdentity(
  field: string,
  left: string | null,
  right: string | null,
): { outcome: "compatible"; value: string | null } | Exclude<ScopeCompatibilityDecision, { outcome: "compatible" }> {
  if (left && right && left !== right) {
    return conflict("scope_conflict", `${field} mismatch blocks concern merge`, [left, right]);
  }
  if ((left && !right) || (!left && right)) {
    return {
      outcome: "unknown",
      reasons: [`${field} is missing on one side; merge would risk cross-scope leakage`],
    };
  }
  return { outcome: "compatible", value: left ?? right ?? null };
}

function conflict(
  kind: AttentionConflict["kind"],
  reason: string,
  refs: readonly string[],
): Extract<ScopeCompatibilityDecision, { outcome: "conflict" }> {
  const conflictId = `attention-conflict:${stableId(`${kind}:${reason}:${refs.join("|")}`)}`;
  return {
    outcome: "conflict",
    conflict: {
      conflict_id: conflictId,
      kind,
      reason,
      refs: refs.map((id) => ({ kind: "policy", id })),
      createdAt: UNKNOWN_CONFLICT_AT,
    },
    reasons: [reason],
  };
}

function maxSensitivity(
  left: AttentionScopeSensitivity,
  right: AttentionScopeSensitivity,
): AttentionScopeSensitivity {
  const order: AttentionScopeSensitivity[] = ["low", "medium", "high", "unknown"];
  return order[Math.max(order.indexOf(left), order.indexOf(right))] ?? "unknown";
}

function normalizeScopeSensitivity(
  sensitivity: AttentionSensitivity | AttentionScopeSensitivity,
): AttentionScopeSensitivity {
  switch (sensitivity) {
    case "public":
    case "internal":
    case "low":
      return "low";
    case "sensitive":
    case "medium":
      return "medium";
    case "restricted":
    case "high":
      return "high";
    case "unknown":
      return "unknown";
  }
}

function surfaceClassForSignalContext(signalContext: SignalContext): AttentionScope["surfaceClass"] {
  if (signalContext.signal_sources.includes("schedule_tick") || signalContext.signal_sources.includes("wait_expiry")) {
    return "schedule";
  }
  if (signalContext.signal_sources.includes("daemon") || signalContext.signal_sources.includes("resident")) {
    return "daemon";
  }
  return signalContext.active_surface_ref ? "unknown" : "system";
}

function sameAuthoritySet(left: ReadonlySet<Authority>, right: ReadonlySet<Authority>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every((authority) => right.has(authority));
}
