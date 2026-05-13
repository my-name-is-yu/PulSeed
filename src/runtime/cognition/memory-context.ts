import type { CoreCompanionMemoryProjection } from "../decision/core-companion-memory-projection.js";
import {
  CognitionEventRefSchema,
  CognitionMemoryResultSchema,
  type CognitionMemoryResult,
  type CognitionMemorySource,
  type CognitionRequestedMemoryUse,
} from "./contracts.js";

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
      surface_projection_ref: entry.source_projection_ref,
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
      surface_projection_ref: entry.source_projection_ref,
      withheld_reason: withheldReasonFor(entry.restriction_reasons),
    })),
    audit_refs: [auditRef],
    model_visible_without_cloud_gate: false,
  });
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
  if (role === "knowledge") return "procedural";
  return "semantic";
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
