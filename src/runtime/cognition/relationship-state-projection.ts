import {
  CognitionRefSchema,
  RelationshipProjectionSourceRefSchema,
  RelationshipProjectionTurnRefSchema,
  RelationshipStateProjectionSchema,
  type CognitionMemoryResult,
  type CognitionMemorySource,
  type CognitionRef,
  type CompanionCognitionCallerPath,
  type ParsedCompanionCognitionInput,
  type RelationshipProjectionSourceRef,
  type RelationshipProjectionTurnRef,
  type RelationshipStateProjection,
  type RelationshipSurfaceAllowedUse,
  type RelationshipSurfaceFactRole,
  type RelationshipSurfaceRepairPath,
} from "./contracts.js";

export interface CreateRelationshipStateProjectionInput {
  projectionId: string;
  turnRef: RelationshipProjectionTurnRef;
  memoryResult: CognitionMemoryResult;
  callerPath: CompanionCognitionCallerPath;
  characterPolicyRef?: RelationshipProjectionSourceRef;
  overreachRisk?: RelationshipStateProjection["overreach_risk"];
}

export function createRelationshipStateProjectionV2(
  input: CreateRelationshipStateProjectionInput,
): RelationshipStateProjection {
  const turnRef = RelationshipProjectionTurnRefSchema.parse(input.turnRef);
  const included = input.memoryResult.included
    .filter((source) => source.source_kind === "semantic")
    .map((source) => relationshipSurfaceFactForMemorySource(source));
  const withheld = input.memoryResult.withheld
    .map((source) => ({
      memory_ref: source.memory_ref.ref,
      role: relationshipRoleForMemorySource(source),
      withheld_reason: source.withheld_reason,
      user_readable_reason: userReadableWithheldReason(source.withheld_reason),
      sensitivity: source.sensitivity,
      repair_paths: repairPathsForWithheldReason(source.withheld_reason),
    }));
  const conflictRefs = conflictRefsForIncluded(input.memoryResult.included);
  const posture = postureForRelationshipFacts(included, withheld);
  const overreachRisk = maxOverreachRisk([
    input.overreachRisk ?? (input.callerPath === "resident_proactive_check" ? "medium" : "unknown"),
    overreachRiskForRelationshipFacts(included, withheld),
  ]);

  return RelationshipStateProjectionSchema.parse({
    projection_id: input.projectionId,
    turn_ref: turnRef,
    ...(input.memoryResult.surface_projection_ref
      ? {
          surface_projection_ref: RelationshipProjectionSourceRefSchema.parse({
            kind: "surface_projection",
            ref: input.memoryResult.surface_projection_ref.ref,
          }),
        }
      : {}),
    ...(input.memoryResult.core_memory_projection_ref
      ? {
          core_memory_projection_ref: RelationshipProjectionSourceRefSchema.parse({
            kind: "memory_projection",
            ref: input.memoryResult.core_memory_projection_ref.ref,
          }),
        }
      : {}),
    included,
    withheld,
    ...(input.characterPolicyRef ? { character_policy_ref: input.characterPolicyRef } : {}),
    posture,
    relationship_refs: input.memoryResult.included.filter((source) => source.source_kind === "semantic"),
    withheld_memory_refs: input.memoryResult.withheld,
    conflict_refs: conflictRefs,
    overreach_risk: overreachRisk,
    normal_surface_debug_visible: false,
    ordinary_surface_debug_visible: false,
  });
}

export function relationshipTurnRefForCognitionInput(
  input: ParsedCompanionCognitionInput,
): RelationshipProjectionTurnRef {
  if (input.caller_path === "chat_user_turn") {
    return RelationshipProjectionTurnRefSchema.parse({
      kind: input.session_context?.route_kind === "gateway_model_loop" ? "gateway_turn" : "chat_turn",
      ref: input.session_context?.turn_ref.ref ?? input.working_context.input_ref.ref,
    });
  }
  if (input.caller_path === "resident_proactive_check") {
    return RelationshipProjectionTurnRefSchema.parse({
      kind: "resident_turn",
      ref: input.attention_context?.attention_input_ref.ref ?? input.working_context.input_ref.ref,
    });
  }
  return RelationshipProjectionTurnRefSchema.parse({
    kind: "task_turn",
    ref: input.runtime_context?.phase_ref?.ref ?? input.working_context.input_ref.ref,
  });
}

export function relationshipCharacterPolicyProjectionRef(
  ref: Pick<CognitionRef, "kind" | "ref">,
): RelationshipProjectionSourceRef {
  return RelationshipProjectionSourceRefSchema.parse({
    kind: "character_policy_projection",
    ref: `${ref.kind}:${ref.ref}`,
  });
}

function relationshipSurfaceFactForMemorySource(
  source: CognitionMemorySource,
): RelationshipStateProjection["included"][number] {
  const role = relationshipRoleForMemorySource(source);
  const allowedSurfaceUse = allowedSurfaceUseForMemorySource(source, role);
  return {
    memory_ref: source.memory_ref.ref,
    role,
    user_readable_reason: userReadableIncludedReason(role, allowedSurfaceUse, source.confidence ?? 0.7),
    allowed_surface_use: allowedSurfaceUse,
    confidence: source.confidence ?? 0.7,
    sensitivity: source.sensitivity === "public" ? "public" : "private",
    repair_paths: repairPathsForIncludedRole(role),
  };
}

function relationshipRoleForMemorySource(
  source: CognitionMemorySource,
): RelationshipSurfaceFactRole {
  if (source.relationship_role) return source.relationship_role;
  switch (source.memory_ref.source_event_type) {
    case "boundary":
      return "boundary";
    case "promise":
    case "work_commitment":
      return "promise";
    case "open_tension":
      return "open_tension";
    case "intervention_policy":
      return "intervention_policy";
    case "notification_preference":
      return "notification_preference";
    default:
      return "preference";
  }
}

function allowedSurfaceUseForMemorySource(
  source: CognitionMemorySource,
  role: RelationshipSurfaceFactRole,
): RelationshipSurfaceAllowedUse {
  if (role === "boundary") return "behavioral_inhibition";
  if (role === "open_tension") return "ask_for_confirmation";
  if (source.confidence !== undefined && source.confidence < 0.5) return "ask_for_confirmation";
  if (source.allowed_uses.includes("ask_for_confirmation")) return "ask_for_confirmation";
  if (source.allowed_uses.includes("user_facing_reference")) return "user_facing_reference";
  if (source.allowed_uses.includes("behavioral_inhibition")) return "behavioral_inhibition";
  return "tone_adaptation";
}

function userReadableIncludedReason(
  role: RelationshipSurfaceFactRole,
  use: RelationshipSurfaceAllowedUse,
  confidence: number,
): string {
  if (role === "boundary") {
    return "A current boundary is limiting this response before preferences or character style are applied.";
  }
  if (role === "open_tension" || confidence < 0.5) {
    return "An uncertain relationship note is present, so this turn should ask or stay neutral instead of treating it as a stable fact.";
  }
  if (role === "promise") {
    return "A current promise is available for reminder or repair, without authorizing side effects.";
  }
  if (use === "user_facing_reference") {
    return "A current relationship preference may be briefly named on the normal surface.";
  }
  if (use === "behavioral_inhibition") {
    return "A current relationship rule is available only to inhibit behavior.";
  }
  return "A current relationship preference may shape tone without granting authority.";
}

function userReadableWithheldReason(reason: RelationshipStateProjection["withheld"][number]["withheld_reason"]): string {
  switch (reason) {
    case "sensitive":
      return "A relationship memory was withheld because sensitive records are not shown on the normal surface.";
    case "corrected":
    case "superseded":
    case "stale":
      return "A relationship memory was withheld because it is no longer the current value.";
    case "forbidden_use":
      return "A relationship memory was withheld because this turn is not allowed to use it that way.";
    case "missing_surface_projection":
      return "A relationship memory was withheld because the required Surface projection was missing.";
    default:
      return "A relationship memory was withheld by the relationship memory governance policy.";
  }
}

function repairPathsForIncludedRole(
  role: RelationshipSurfaceFactRole,
): RelationshipSurfaceRepairPath[] {
  if (role === "boundary" || role === "open_tension") return ["correct", "suppress", "revoke", "forget"];
  return ["correct", "suppress", "forget"];
}

function repairPathsForWithheldReason(
  reason: RelationshipStateProjection["withheld"][number]["withheld_reason"],
): RelationshipSurfaceRepairPath[] {
  if (reason === "forbidden_use") return ["correct", "revoke", "suppress"];
  if (reason === "deleted") return ["forget"];
  return ["correct", "suppress", "forget"];
}

function conflictRefsForIncluded(sources: CognitionMemorySource[]): CognitionRef[] {
  const hasBoundary = sources.some((source) => relationshipRoleForMemorySource(source) === "boundary");
  const hasPreference = sources.some((source) => relationshipRoleForMemorySource(source) === "preference");
  if (!hasBoundary || !hasPreference) return [];
  return sources
    .filter((source) => {
      const role = relationshipRoleForMemorySource(source);
      return role === "boundary" || role === "preference";
    })
    .map((source) => CognitionRefSchema.parse({
      kind: "memory",
      ref: source.memory_ref.ref,
    }));
}

function postureForRelationshipFacts(
  included: RelationshipStateProjection["included"],
  withheld: RelationshipStateProjection["withheld"],
): RelationshipStateProjection["posture"] {
  const hasBoundary = included.some((fact) => fact.role === "boundary");
  const hasPreference = included.some((fact) => fact.role === "preference");
  if (hasBoundary && hasPreference) return "boundary_first";
  if (hasBoundary) return "boundary_first";
  if (included.some((fact) => fact.role === "open_tension" || fact.confidence < 0.5) || withheld.length > 0) {
    return "careful";
  }
  if (included.some((fact) => fact.role === "preference" || fact.role === "notification_preference")) {
    return "concise";
  }
  return "neutral";
}

function overreachRiskForRelationshipFacts(
  included: RelationshipStateProjection["included"],
  withheld: RelationshipStateProjection["withheld"],
): RelationshipStateProjection["overreach_risk"] {
  if (included.some((fact) => fact.role === "open_tension")) return "medium";
  if (included.some((fact) => fact.role === "boundary")) return "medium";
  if (withheld.some((fact) => fact.sensitivity === "sensitive")) return "medium";
  if (included.some((fact) => fact.sensitivity === "private")) return "low";
  if (included.length > 0) return "none";
  return "unknown";
}

function maxOverreachRisk(
  risks: RelationshipStateProjection["overreach_risk"][],
): RelationshipStateProjection["overreach_risk"] {
  type KnownOverreachRisk = Exclude<RelationshipStateProjection["overreach_risk"], "unknown">;
  const knownRisks = risks.filter((risk): risk is KnownOverreachRisk => risk !== "unknown");
  if (knownRisks.length === 0) return "unknown";
  const rank: Record<KnownOverreachRisk, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
  };
  return knownRisks.reduce((max, risk) => rank[risk] > rank[max] ? risk : max, "none");
}
