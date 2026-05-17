import {
  buildRelationshipProfileSurfaceProjection,
  loadRelationshipProfileSurfaceContext,
} from "../../grounding/profile-surface.js";
import type { SurfaceProjectionTarget } from "../../grounding/surface-contracts.js";
import {
  GovernedMemoryAllowedUseClassSchema,
  type GovernedMemoryAllowedUseClass,
} from "../../platform/profile/governed-memory.js";
import type { RelationshipProfileConsentScope } from "../../platform/profile/relationship-profile.js";
import {
  createCoreCompanionMemoryProjectionFromSurface,
  type CoreCompanionMemoryProjection,
} from "../decision/core-companion-memory-projection.js";
import type { CognitionProjectionCallerPathKind } from "../decision/companion-decision-contract.js";
import {
  CognitionEventRefSchema,
  CognitionMemoryResultSchema,
  CognitionRefSchema,
  type CognitionMemoryRequest,
  type CognitionMemoryResult,
  type CognitionMemorySource,
  type CognitionRequestedMemoryUse,
  type RelationshipSurfaceFactRole,
} from "./contracts.js";
import type { CognitionMemoryPort } from "./ports.js";

type GovernedCognitionMemoryUse = Extract<CognitionRequestedMemoryUse, GovernedMemoryAllowedUseClass>;

interface RelationshipProfileCognitionMemoryPortInput {
  baseDir: string;
  now?: () => Date;
}

interface RelationshipProfileCognitionBinding {
  callerPath: CognitionProjectionCallerPathKind;
  purpose: string;
  requestedUse: GovernedCognitionMemoryUse;
  scope: RelationshipProfileConsentScope;
  target: SurfaceProjectionTarget;
}

export function createEmptyCognitionMemoryResult(input: {
  requestId: string;
  auditRefs?: unknown[];
}): CognitionMemoryResult {
  return CognitionMemoryResultSchema.parse({
    request_id: input.requestId,
    included: [],
    withheld: [],
    audit_refs: input.auditRefs ?? [],
    model_visible_without_cloud_gate: false,
  });
}

export function cognitionMemoryResultFromCoreProjection(input: {
  requestId: string;
  projection: CoreCompanionMemoryProjection;
  requestedUse: CognitionRequestedMemoryUse;
}): CognitionMemoryResult {
  const auditRef = CognitionEventRefSchema.parse({
    ref: input.projection.projection_id,
    source_store: "profile",
    source_event_type: "core_companion_memory_projection",
    schema_version: 1,
    replay_key: input.projection.projection_id,
    redaction_policy: "metadata_only",
  });
  return CognitionMemoryResultSchema.parse({
    request_id: input.requestId,
    surface_projection_ref: CognitionRefSchema.parse({
      kind: "surface_projection",
      ref: input.projection.surface_ref,
    }),
    core_memory_projection_ref: CognitionRefSchema.parse({
      kind: "memory_projection",
      ref: input.projection.projection_id,
    }),
    included: input.projection.included_entries.map((entry): CognitionMemorySource => ({
      memory_ref: {
        ref: entry.source_ref.memory_id,
        source_store: sourceStoreForMemoryOwner(entry.source_ref.owning_store_ref.kind),
        source_event_type: entry.source_ref.record_kind,
        schema_version: 1,
        source_epoch: entry.source_ref.dependency_ref.ref,
        redaction_policy: "materialized",
      },
      source_kind: sourceKindForMemoryRole(entry.source_ref.role),
      allowed_uses: [input.requestedUse],
      forbidden_uses: [],
      sensitivity: entry.source_ref.sensitivity === "public" ? "public" : "private",
      lifecycle: entry.source_ref.lifecycle === "matured" ? "matured" : "active",
      correction_state: "current",
      confidence: confidenceForMemorySource(entry.source_ref),
      surface_projection_ref: entry.source_projection_ref,
      relationship_role: relationshipRoleForMemorySource(entry.source_ref),
      ...(entry.content.state === "available" ? { excerpt: entry.content.excerpt } : {}),
    })),
    withheld: input.projection.restricted_entries.map((entry) => ({
      memory_ref: {
        ref: entry.source_ref.memory_id,
        source_store: sourceStoreForMemoryOwner(entry.source_ref.owning_store_ref.kind),
        source_event_type: entry.source_ref.record_kind,
        schema_version: 1,
        source_epoch: entry.source_ref.dependency_ref.ref,
        redaction_policy: entry.content.redaction_ref ? "redacted" : "metadata_only",
      },
      source_kind: sourceKindForMemoryRole(entry.source_ref.role),
      allowed_uses: [],
      forbidden_uses: [input.requestedUse],
      sensitivity: entry.source_ref.sensitivity === "sensitive" ? "sensitive" : "private",
      lifecycle: lifecycleForWithheld(entry),
      correction_state: entry.source_ref.correction_state === "current" ? "current" : "corrected",
      confidence: confidenceForMemorySource(entry.source_ref),
      surface_projection_ref: entry.source_projection_ref,
      relationship_role: relationshipRoleForMemorySource(entry.source_ref),
      withheld_reason: withheldReasonFor(entry.restriction_reasons),
    })),
    audit_refs: [auditRef],
    model_visible_without_cloud_gate: false,
  });
}

export function createRelationshipProfileCognitionMemoryPort(
  input: RelationshipProfileCognitionMemoryPortInput,
): CognitionMemoryPort {
  return {
    async retrieveMemory(request: CognitionMemoryRequest): Promise<CognitionMemoryResult> {
      const binding = relationshipProfileBindingForCognitionRequest(request);
      const now = input.now?.() ?? new Date();
      const surfaceContext = await loadRelationshipProfileSurfaceContext({
        baseDir: input.baseDir,
        scope: binding.scope,
        includeSensitive: true,
      });
      const surfaceProjection = buildRelationshipProfileSurfaceProjection({
        context: surfaceContext,
        target: binding.target,
        scopeRef: request.query_ref.ref,
        purpose: binding.purpose,
        requestedUse: binding.requestedUse,
        now: now.toISOString(),
      });
      if (!surfaceProjection) {
        return createEmptyCognitionMemoryResult({
          requestId: request.request_id,
          auditRefs: [],
        });
      }
      const coreProjection = createCoreCompanionMemoryProjectionFromSurface({
        surfaceProjection,
        callerPath: binding.callerPath,
        projectionId: `core-memory:${request.request_id}`,
        cognitionRef: request.request_id,
        createdAt: now.toISOString(),
      });
      return cognitionMemoryResultFromCoreProjection({
        requestId: request.request_id,
        projection: coreProjection,
        requestedUse: binding.requestedUse,
      });
    },
  };
}

function sourceStoreForMemoryOwner(owner: string): CognitionMemorySource["memory_ref"]["source_store"] {
  if (owner === "soil") return "soil";
  if (owner === "knowledge") return "knowledge";
  if (owner === "dream_seed") return "dream_event_log";
  if (owner === "runtime_session") return "runtime_operation";
  return "profile";
}

function sourceKindForMemoryRole(role: string): CognitionMemorySource["source_kind"] {
  if (role === "work_memory") return "working";
  if (role === "seed") return "episodic";
  if (role === "knowledge") return "semantic";
  return "semantic";
}

function confidenceForMemorySource(
  source: CoreCompanionMemoryProjection["included_entries"][number]["source_ref"],
): number | undefined {
  const confidence = source.domain_fields["confidence"];
  return typeof confidence === "number" ? confidence : undefined;
}

function relationshipRoleForMemorySource(
  source: CoreCompanionMemoryProjection["included_entries"][number]["source_ref"],
): RelationshipSurfaceFactRole {
  const profileKind = source.domain_fields["profile_kind"];
  if (profileKind === "notification_preference") return "notification_preference";
  if (source.record_kind === "boundary") return "boundary";
  if (source.record_kind === "promise" || source.record_kind === "work_commitment") return "promise";
  if (source.record_kind === "open_tension") return "open_tension";
  if (source.record_kind === "intervention_policy") return "intervention_policy";
  return "preference";
}

function relationshipProfileBindingForCognitionRequest(
  request: CognitionMemoryRequest,
): RelationshipProfileCognitionBinding {
  if (request.caller_path === "resident_proactive_check") {
    return {
      callerPath: "resident_attention_cycle",
      purpose: "companion_cognition_resident_proactive",
      requestedUse: requestedUseFor(request, [
        "proactive_action_candidate",
        "behavioral_inhibition",
        "attention_prioritization",
      ]),
      scope: "resident_behavior",
      target: "daemon",
    };
  }
  if (request.caller_path === "long_running_task_turn") {
    return {
      callerPath: "task_agent_loop",
      purpose: "companion_cognition_task_agent_loop",
      requestedUse: requestedUseFor(request, ["goal_planning", "runtime_grounding"]),
      scope: "local_planning",
      target: "agent_loop",
    };
  }
  if (request.caller_path === "schedule_wake") {
    return {
      callerPath: "resident_attention_cycle",
      purpose: "companion_cognition_schedule_wake",
      requestedUse: requestedUseFor(request, ["attention_prioritization", "runtime_grounding", "behavioral_inhibition"]),
      scope: "resident_behavior",
      target: "daemon",
    };
  }
  if (request.caller_path === "runtime_control_response") {
    return {
      callerPath: "task_agent_loop",
      purpose: "companion_cognition_runtime_control",
      requestedUse: requestedUseFor(request, ["runtime_grounding", "ask_for_confirmation", "behavioral_inhibition"]),
      scope: "local_planning",
      target: "agent_loop",
    };
  }
  if (request.caller_path === "memory_truth_operation") {
    return {
      callerPath: "chat_gateway_model_loop",
      purpose: "companion_cognition_memory_truth_operation",
      requestedUse: requestedUseFor(request, ["behavioral_inhibition", "user_facing_reference", "runtime_grounding"]),
      scope: "memory_retrieval",
      target: "chat",
    };
  }
  return {
    callerPath: "chat_gateway_model_loop",
    purpose: "companion_cognition_chat_turn",
    requestedUse: requestedUseFor(request, ["runtime_grounding", "user_facing_reference"]),
    scope: "memory_retrieval",
    target: "chat",
  };
}

function requestedUseFor(
  request: CognitionMemoryRequest,
  preferred: GovernedCognitionMemoryUse[],
): GovernedCognitionMemoryUse {
  const requestedUses = new Set<CognitionRequestedMemoryUse>(request.requested_uses);
  const preferredMatch = preferred.find((use) => requestedUses.has(use));
  if (preferredMatch) return preferredMatch;
  return request.requested_uses.find(isGovernedCognitionMemoryUse) ?? "runtime_grounding";
}

function isGovernedCognitionMemoryUse(
  value: CognitionRequestedMemoryUse,
): value is GovernedCognitionMemoryUse {
  return GovernedMemoryAllowedUseClassSchema.safeParse(value).success;
}

function lifecycleForWithheld(
  entry: CoreCompanionMemoryProjection["restricted_entries"][number],
): CognitionMemorySource["lifecycle"] {
  if (entry.restriction_reasons.includes("superseded")) return "superseded";
  if (entry.restriction_reasons.includes("corrected")) return "stale";
  if (entry.restriction_reasons.includes("sensitive")) return "quarantined";
  return "stale";
}

function withheldReasonFor(
  reasons: CoreCompanionMemoryProjection["restricted_entries"][number]["restriction_reasons"],
): CognitionMemoryResult["withheld"][number]["withheld_reason"] {
  if (reasons.includes("superseded")) return "superseded";
  if (reasons.includes("corrected")) return "corrected";
  if (reasons.includes("sensitive")) return "sensitive";
  if (reasons.includes("redacted")) return "deleted";
  if (reasons.includes("forbidden_use") || reasons.includes("not_allowed_for_requested_use")) return "forbidden_use";
  return "stale";
}
