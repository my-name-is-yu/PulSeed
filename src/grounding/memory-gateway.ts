import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  GroundingKnowledgeResult,
  GroundingRequest,
  GroundingSoilHit,
  GroundingSoilResult,
} from "./contracts.js";
import {
  buildRelationshipProfileSurfaceProjection,
  contextFromRelationshipProfileSurfaceProjection,
  formatRelationshipProfileSurfaceContext,
  relationshipProfileSurfaceInspectionMetadata,
  type RelationshipProfileSurfaceContext,
} from "./profile-surface.js";
import {
  loadRelationshipProfile,
} from "../platform/profile/relationship-profile.js";
import {
  loadRelationshipProfileRetrievalContext,
  summarizeRelationshipProfileRetrievalContext,
  type RelationshipProfileRetrievalContext,
} from "../platform/profile/retrieval-context.js";
import { SoilQueryTool } from "../tools/query/SoilQueryTool/SoilQueryTool.js";
import type { ToolCallContext } from "../tools/types.js";
import { SqliteSoilRepository } from "../platform/soil/sqlite-repository.js";
import {
  correctionStateForTarget,
  summarizeMemoryCorrectionState,
  type MemoryCorrectionTargetState,
} from "../platform/corrections/memory-correction-ledger.js";
import type { SoilRecord, SoilRecordStatus } from "../platform/soil/contracts.js";
import type { SurfaceExcludedContext, SurfaceIncludedContext } from "./surface-contracts.js";

export const MEMORY_GATEWAY_RUNTIME_KEY = "memory_gateway_result";

const MemoryGatewaySourceKindSchema = z.enum([
  "soil",
  "knowledge",
  "relationship_profile",
  "prefetched_context",
  "correction_ledger",
]);
export type MemoryGatewaySourceKind = z.infer<typeof MemoryGatewaySourceKindSchema>;

const MemoryGatewaySelectedSectionSchema = z.enum(["soil_knowledge", "knowledge_query"]);
export type MemoryGatewaySelectedSection = z.infer<typeof MemoryGatewaySelectedSectionSchema>;

const MemoryGatewayLifecycleSchema = z.enum([
  "active",
  "matured",
  "stale",
  "superseded",
  "retracted",
  "forgotten",
  "quarantined",
  "deleted",
  "unknown",
]);
export type MemoryGatewayLifecycle = z.infer<typeof MemoryGatewayLifecycleSchema>;

const MemoryGatewayCorrectionSchema = z.enum([
  "current",
  "corrected",
  "superseded",
  "retracted",
  "forgotten",
  "quarantined",
  "deleted",
  "not_reported_by_owner",
]);
export type MemoryGatewayCorrection = z.infer<typeof MemoryGatewayCorrectionSchema>;

const MemoryGatewayQuarantineSchema = z.enum(["not_quarantined", "quarantined", "not_reported_by_owner"]);
export type MemoryGatewayQuarantine = z.infer<typeof MemoryGatewayQuarantineSchema>;

const MemoryGatewaySensitivitySchema = z.enum(["public", "local", "private", "sensitive", "secret", "unknown"]);
export type MemoryGatewaySensitivity = z.infer<typeof MemoryGatewaySensitivitySchema>;

const MemoryGatewayOwnerRefSchema = z.object({
  kind: z.string().min(1),
  store_ref: z.string().min(1),
  record_ref: z.string().min(1),
}).strict();
export type MemoryGatewayOwnerRef = z.infer<typeof MemoryGatewayOwnerRefSchema>;

const MemoryGatewaySourceRefSchema = z.object({
  source_id: z.string().min(1),
  source_kind: MemoryGatewaySourceKindSchema,
  owner_ref: MemoryGatewayOwnerRefSchema,
  retrieval_source: z.string().min(1),
  provenance_refs: z.array(z.string().min(1)).default([]),
  lifecycle: MemoryGatewayLifecycleSchema,
  correction: MemoryGatewayCorrectionSchema,
  quarantine: MemoryGatewayQuarantineSchema,
  sensitivity: MemoryGatewaySensitivitySchema,
  scope: z.string().min(1),
  allowed_uses: z.array(z.string().min(1)).default([]),
  blocked_uses: z.array(z.string().min(1)).default([]),
}).strict();
export type MemoryGatewaySourceRef = z.infer<typeof MemoryGatewaySourceRefSchema>;

const MemoryGatewaySelectedEntrySchema = z.object({
  entry_id: z.string().min(1),
  section: MemoryGatewaySelectedSectionSchema,
  source_ref: MemoryGatewaySourceRefSchema.refine((source) => source.source_kind !== "correction_ledger", {
    message: "correction ledger refs cannot be selected prompt content",
  }),
  content: z.object({
    state: z.literal("available"),
    text: z.string().min(1),
  }).strict(),
  prompt_eligible: z.literal(true),
  user_visible_eligible: z.boolean(),
  rationale: z.string().min(1),
  rank: z.number().int().positive().optional(),
  score: z.number().finite().optional(),
}).strict();
export type MemoryGatewaySelectedEntry = z.infer<typeof MemoryGatewaySelectedEntrySchema>;

const MemoryGatewayExcludedEntrySchema = z.object({
  entry_id: z.string().min(1),
  source_ref: MemoryGatewaySourceRefSchema,
  prompt_eligible: z.literal(false),
  user_visible_eligible: z.literal(false),
  redaction_ref: z.string().min(1).optional(),
  rationale: z.string().min(1),
  blocked_by: z.array(z.string().min(1)).min(1),
}).strict();
export type MemoryGatewayExcludedEntry = z.infer<typeof MemoryGatewayExcludedEntrySchema>;

export const MemoryGatewayRequestSchema = z.object({
  target: z.enum(["chat", "agent_loop", "core_loop"]),
  purpose: z.enum(["general_turn", "task_execution", "replanning", "verification", "knowledge_refresh", "handoff"]),
  user_visible_sink: z.boolean(),
  scope_ref: z.string().min(1),
  requested_use: z.string().min(1).default("runtime_grounding"),
  query: z.string().optional(),
  workspace_root: z.string().min(1).optional(),
  home_dir: z.string().min(1),
  soil_root_dir: z.string().min(1),
  goal_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  max_hits: z.number().int().min(1).max(50).default(5),
  include_sensitive_relationship_profile: z.boolean().default(false),
}).strict();
export type MemoryGatewayRequest = z.infer<typeof MemoryGatewayRequestSchema>;

export const MemoryGatewayResultSchema = z.object({
  schema_version: z.literal("memory-gateway/v1"),
  retrieval_id: z.string().min(1),
  query_ref: z.string().min(1).refine((value) => !value.includes("\n") && value.length <= 96, {
    message: "query_ref must be a short non-content ref, not prompt text",
  }),
  target: MemoryGatewayRequestSchema.shape.target,
  purpose: MemoryGatewayRequestSchema.shape.purpose,
  scope_ref: z.string().min(1),
  requested_use: z.string().min(1),
  user_visible_sink: z.boolean(),
  selected_section: MemoryGatewaySelectedSectionSchema.nullable(),
  selected_entries: z.array(MemoryGatewaySelectedEntrySchema).default([]),
  excluded_entries: z.array(MemoryGatewayExcludedEntrySchema).default([]),
  sources: z.array(MemoryGatewaySourceRefSchema).default([]),
  selection: z.object({
    rationale: z.string().min(1),
    selected_source_order: z.array(MemoryGatewaySourceKindSchema).default([]),
  }).strict(),
  governance: z.object({
    current_count: z.number().int().nonnegative(),
    corrected_count: z.number().int().nonnegative(),
    superseded_count: z.number().int().nonnegative(),
    retracted_count: z.number().int().nonnegative(),
    forgotten_count: z.number().int().nonnegative(),
    quarantined_count: z.number().int().nonnegative(),
    restricted_count: z.number().int().nonnegative(),
    unknown_governance_count: z.number().int().nonnegative(),
  }).strict(),
  relationship_profile_context: z.custom<RelationshipProfileRetrievalContext>().optional(),
  relationship_profile_prompt_context: z.string().default(""),
  relationship_profile_metadata: z.record(z.unknown()).optional(),
  relationship_profile_surface_metadata: z.record(z.unknown()).optional(),
  warnings: z.array(z.string()).default([]),
  soil_usage_record_ids: z.array(z.string().min(1)).default([]),
  soil_root_dir: z.string().min(1).optional(),
}).strict().superRefine((result, ctx) => {
  const selectedSection = result.selected_section;
  if (selectedSection === null && result.selected_entries.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selected_section"],
      message: "selected entries require selected_section",
    });
  }
  if (result.user_visible_sink) {
    const nonVisible = result.selected_entries.find((entry) => !entry.user_visible_eligible);
    if (nonVisible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_entries"],
        message: "user-visible sinks can only select user-visible eligible prompt content",
      });
    }
  }
});
export type MemoryGatewayResult = z.infer<typeof MemoryGatewayResultSchema>;

export interface MemoryGatewayDeps {
  soilQuery?: GroundingRequest["soilQuery"];
  knowledgeQuery?: GroundingRequest["knowledgeQuery"];
  knowledgeContext?: string;
  relationshipProfileContext?: RelationshipProfileRetrievalContext;
}

export interface RetrieveGroundingMemoryInput extends MemoryGatewayRequest, MemoryGatewayDeps {}

function buildToolContext(cwd: string, goalId?: string): ToolCallContext {
  return {
    cwd,
    goalId: goalId ?? "grounding",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => false,
  };
}

function queryRef(query: string | undefined): string {
  const text = query?.trim() ?? "";
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `query:${hash}:chars:${text.length}`;
}

function shouldQuerySoil(query: string | undefined): query is string {
  return Boolean(query && query.trim().length >= 8);
}

function isUserVisibleSelected(source: MemoryGatewaySourceRef): boolean {
  if (source.source_kind !== "relationship_profile") return false;
  return source.allowed_uses.includes("user_facing_reference");
}

function canSelectForPrompt(source: MemoryGatewaySourceRef, userVisibleSink: boolean): boolean {
  if (
    !userVisibleSink
    && (source.source_kind === "knowledge" || source.source_kind === "prefetched_context")
    && source.correction === "not_reported_by_owner"
    && source.quarantine === "not_reported_by_owner"
    && source.allowed_uses.includes("runtime_grounding")
    && !source.blocked_uses.includes("runtime_grounding")
  ) {
    return true;
  }
  if (source.lifecycle !== "active" && source.lifecycle !== "matured") return false;
  if (source.correction !== "current") return false;
  if (source.quarantine !== "not_quarantined") return false;
  if (source.blocked_uses.includes("runtime_grounding")) return false;
  if (!source.allowed_uses.includes("runtime_grounding")) return false;
  if (source.sensitivity === "sensitive" || source.sensitivity === "secret") return false;
  if (userVisibleSink && !isUserVisibleSelected(source)) return false;
  return true;
}

function exclusionReasons(source: MemoryGatewaySourceRef, userVisibleSink: boolean): string[] {
  const reasons = new Set<string>();
  if (source.lifecycle !== "active" && source.lifecycle !== "matured") reasons.add(`lifecycle:${source.lifecycle}`);
  if (source.correction !== "current") reasons.add(`correction:${source.correction}`);
  if (source.quarantine !== "not_quarantined") reasons.add(`quarantine:${source.quarantine}`);
  if (!source.allowed_uses.includes("runtime_grounding")) reasons.add("allowed_use_missing");
  if (source.blocked_uses.includes("runtime_grounding")) reasons.add("blocked_use");
  if (source.sensitivity === "sensitive" || source.sensitivity === "secret") reasons.add(`sensitivity:${source.sensitivity}`);
  if (userVisibleSink && !isUserVisibleSelected(source)) reasons.add("user_visible_ineligible");
  return Array.from(reasons.size > 0 ? reasons : new Set(["not_selected"]));
}

function soilLifecycle(status: SoilRecordStatus | undefined): MemoryGatewayLifecycle {
  switch (status) {
    case "active":
    case "confirmed":
    case "completed":
      return "active";
    case "superseded":
    case "replaced":
      return "superseded";
    case "retracted":
      return "retracted";
    case "forgotten":
      return "forgotten";
    case "quarantined":
      return "quarantined";
    case "deleted":
      return "deleted";
    case "stale":
    case "expired":
    case "archived":
    case "cancelled":
    case "rejected":
      return "stale";
    case "corrected":
      return "superseded";
    default:
      return "unknown";
  }
}

function soilCorrection(status: SoilRecordStatus | undefined, correction: MemoryCorrectionTargetState): MemoryGatewayCorrection {
  if (correction.status !== "active") return correction.status;
  switch (status) {
    case "corrected":
      return "corrected";
    case "superseded":
    case "replaced":
      return "superseded";
    case "retracted":
      return "retracted";
    case "forgotten":
      return "forgotten";
    case "quarantined":
      return "quarantined";
    case "deleted":
      return "deleted";
    default:
      return "current";
  }
}

function soilSourceForHit(
  hit: GroundingSoilHit,
  result: GroundingSoilResult,
  record: SoilRecord | undefined,
  correction: MemoryCorrectionTargetState | null,
): MemoryGatewaySourceRef {
  if (result.retrievalSource !== "sqlite" || !record || !correction) {
    return MemoryGatewaySourceRefSchema.parse({
      source_id: `prefetch:${hit.recordId ?? hit.soilId}`,
      source_kind: "prefetched_context",
      owner_ref: {
        kind: "runtime_request",
        store_ref: "soil_query",
        record_ref: hit.recordId ?? hit.soilId,
      },
      retrieval_source: result.retrievalSource,
      provenance_refs: [],
      lifecycle: "unknown",
      correction: "not_reported_by_owner",
      quarantine: "not_reported_by_owner",
      sensitivity: "unknown",
      scope: "runtime_grounding",
      allowed_uses: ["runtime_grounding"],
      blocked_uses: [],
    });
  }

  const correctionState = soilCorrection(record.status, correction);
  return MemoryGatewaySourceRefSchema.parse({
    source_id: `soil:${record.record_id}`,
    source_kind: "soil",
    owner_ref: {
      kind: "soil",
      store_ref: "soil",
      record_ref: record.record_id,
    },
    retrieval_source: result.retrievalSource,
    provenance_refs: [record.source_id ? `soil-source:${record.source_type}:${record.source_id}` : `soil-source:${record.source_type}`],
    lifecycle: soilLifecycle(record.status),
    correction: correctionState,
    quarantine: correctionState === "quarantined" ? "quarantined" : "not_quarantined",
    sensitivity: "private",
    scope: record.goal_id ?? record.task_id ?? "runtime_grounding",
    allowed_uses: ["runtime_grounding"],
    blocked_uses: [],
  });
}

function selectedEntryForHit(
  hit: GroundingSoilHit,
  source: MemoryGatewaySourceRef,
  rank: number,
): MemoryGatewaySelectedEntry {
  const usage = hit.usageStats
    ? `usage used=${hit.usageStats.use_count} validated=${hit.usageStats.validated_count} negative=${hit.usageStats.negative_outcome_count}`
    : null;
  const detail = [hit.summary, hit.snippet, usage].filter((part): part is string => Boolean(part && part.trim())).join(" | ");
  const text = `- ${hit.title} (${hit.soilId})${detail ? `: ${detail}` : ""}`;
  return MemoryGatewaySelectedEntrySchema.parse({
    entry_id: `memory-gateway:selected:${source.source_id}`,
    section: "soil_knowledge",
    source_ref: source,
    content: { state: "available", text },
    prompt_eligible: true,
    user_visible_eligible: false,
    rationale: source.source_kind === "soil" ? "canonical_soil_selected" : "prefetched_soil_context_selected_for_non_user_visible_runtime",
    rank,
    ...(typeof hit.score === "number" ? { score: hit.score } : {}),
  });
}

function excludedEntryForSource(source: MemoryGatewaySourceRef, rationale: string, userVisibleSink: boolean): MemoryGatewayExcludedEntry {
  return MemoryGatewayExcludedEntrySchema.parse({
    entry_id: `memory-gateway:excluded:${source.source_id}`,
    source_ref: source,
    prompt_eligible: false,
    user_visible_eligible: false,
    redaction_ref: `redaction:${source.source_id}`,
    rationale,
    blocked_by: exclusionReasons(source, userVisibleSink),
  });
}

async function querySoil(input: RetrieveGroundingMemoryInput): Promise<GroundingSoilResult | null> {
  if (!shouldQuerySoil(input.query)) return null;
  if (input.soilQuery) {
    return await input.soilQuery({
      query: input.query,
      rootDir: input.soil_root_dir,
      limit: input.max_hits,
    });
  }
  const tool = new SoilQueryTool();
  const toolResult = await tool.call({
    query: input.query,
      rootDir: input.soil_root_dir,
    limit: input.max_hits,
  }, buildToolContext(input.workspace_root ?? process.cwd(), input.goal_id));
  if (!toolResult.success) return null;
  const data = toolResult.data as {
    retrievalSource: GroundingSoilResult["retrievalSource"];
    warnings: string[];
    hits: GroundingSoilResult["hits"];
  };
  return {
    retrievalSource: data.retrievalSource,
    warnings: data.warnings,
    hits: data.hits,
  };
}

async function loadSoilOwners(rootDir: string, result: GroundingSoilResult | null): Promise<{
  records: Map<string, SoilRecord>;
  corrections: Record<string, MemoryCorrectionTargetState>;
}> {
  const recordIds = [...new Set((result?.hits ?? []).map((hit) => hit.recordId).filter((id): id is string => Boolean(id)))];
  if (result?.retrievalSource !== "sqlite" || recordIds.length === 0) {
    return { records: new Map(), corrections: {} };
  }
  const repository = await SqliteSoilRepository.openExisting({ rootDir });
  if (!repository) return { records: new Map(), corrections: {} };
  try {
    const records = await repository.loadRecords({ record_ids: recordIds, active_only: false });
    const corrections = await repository.loadCorrections(recordIds);
    const states = summarizeMemoryCorrectionState(corrections);
    return {
      records: new Map(records.map((record) => [record.record_id, record])),
      corrections: states,
    };
  } finally {
    repository.close();
  }
}

function soilTargetRef(recordId: string) {
  return { kind: "soil_record" as const, id: recordId };
}

async function buildRelationshipProfile(input: RetrieveGroundingMemoryInput): Promise<{
  context: RelationshipProfileRetrievalContext;
  promptContext: string;
  metadata?: Record<string, unknown>;
  surfaceMetadata?: Record<string, unknown>;
  sources: MemoryGatewaySourceRef[];
  excludedEntries: MemoryGatewayExcludedEntry[];
}> {
  const rawContext: RelationshipProfileSurfaceContext = input.relationshipProfileContext
    ? input.relationshipProfileContext
    : {
      scope: "memory_retrieval",
      includeSensitive: input.include_sensitive_relationship_profile,
      items: (await loadRelationshipProfile(input.home_dir)).items,
    };
  const surface = buildRelationshipProfileSurfaceProjection({
    context: rawContext,
    target: input.target,
    scopeRef: input.scope_ref,
    purpose: input.purpose,
    now: new Date().toISOString(),
  });
  const fallbackContext = input.relationshipProfileContext
    ?? await loadRelationshipProfileRetrievalContext({
      baseDir: input.home_dir,
      includeSensitive: input.include_sensitive_relationship_profile,
    });
  const context = contextFromRelationshipProfileSurfaceProjection(fallbackContext, surface);
  const promptContext = input.user_visible_sink ? "" : formatRelationshipProfileSurfaceContext(surface);
  const sources = [
    ...((surface?.included_context ?? []) as SurfaceIncludedContext[]).map((entry) => profileSource(entry.source_ref.memory_id, entry.source_ref.owning_store_ref.record_ref, entry.source_ref.sensitivity, true)),
    ...((surface?.excluded_context ?? []) as SurfaceExcludedContext[]).map((entry) => profileSource(entry.source_ref.memory_id, entry.source_ref.owning_store_ref.record_ref, entry.source_ref.sensitivity, false)),
  ];
  const excludedEntries = sources
    .filter((source) => !canSelectForPrompt(source, input.user_visible_sink))
    .map((source) => excludedEntryForSource(source, "relationship_profile_surface_excluded", input.user_visible_sink));
  return {
    context,
    promptContext,
    metadata: summarizeRelationshipProfileRetrievalContext(context) as unknown as Record<string, unknown>,
    surfaceMetadata: relationshipProfileSurfaceInspectionMetadata(surface, input.target) ?? undefined,
    sources,
    excludedEntries,
  };
}

function profileSource(
  memoryId: string,
  recordRef: string,
  sensitivity: "public" | "private" | "sensitive",
  included: boolean,
): MemoryGatewaySourceRef {
  return MemoryGatewaySourceRefSchema.parse({
    source_id: memoryId,
    source_kind: "relationship_profile",
    owner_ref: {
      kind: "relationship_profile",
      store_ref: "relationship-profile",
      record_ref: recordRef,
    },
    retrieval_source: "relationship_profile_surface",
    provenance_refs: [],
    lifecycle: included ? "active" : "unknown",
    correction: included ? "current" : "not_reported_by_owner",
    quarantine: "not_quarantined",
    sensitivity,
    scope: "memory_retrieval",
    allowed_uses: included ? ["runtime_grounding", "surface_projection"] : [],
    blocked_uses: included ? [] : ["runtime_grounding"],
  });
}

function knowledgeSource(id: string, source: string, kind: "knowledge" | "prefetched_context"): MemoryGatewaySourceRef {
  return MemoryGatewaySourceRefSchema.parse({
    source_id: `${kind}:${id}`,
    source_kind: kind,
    owner_ref: {
      kind: kind === "knowledge" ? "legacy_knowledge_query" : "runtime_request",
      store_ref: kind === "knowledge" ? "knowledge_query" : "knowledge_context",
      record_ref: id,
    },
    retrieval_source: source,
    provenance_refs: [source],
    lifecycle: "unknown",
    correction: "not_reported_by_owner",
    quarantine: "not_reported_by_owner",
    sensitivity: "unknown",
    scope: "runtime_grounding",
    allowed_uses: ["runtime_grounding"],
    blocked_uses: [],
  });
}

function governanceFor(sources: MemoryGatewaySourceRef[], excluded: MemoryGatewayExcludedEntry[]) {
  return {
    current_count: sources.filter((source) => source.correction === "current").length,
    corrected_count: sources.filter((source) => source.correction === "corrected").length,
    superseded_count: sources.filter((source) => source.correction === "superseded" || source.lifecycle === "superseded").length,
    retracted_count: sources.filter((source) => source.correction === "retracted" || source.lifecycle === "retracted").length,
    forgotten_count: sources.filter((source) => source.correction === "forgotten" || source.lifecycle === "forgotten").length,
    quarantined_count: sources.filter((source) => source.correction === "quarantined" || source.quarantine === "quarantined").length,
    restricted_count: excluded.length,
    unknown_governance_count: sources.filter((source) =>
      source.correction === "not_reported_by_owner" || source.quarantine === "not_reported_by_owner"
    ).length,
  };
}

export function getMemoryGatewayResult(runtime: Map<string, unknown>): MemoryGatewayResult | null {
  const result = MemoryGatewayResultSchema.safeParse(runtime.get(MEMORY_GATEWAY_RUNTIME_KEY));
  return result.success ? result.data : null;
}

export function setMemoryGatewayResult(runtime: Map<string, unknown>, result: MemoryGatewayResult): void {
  runtime.set(MEMORY_GATEWAY_RUNTIME_KEY, result);
}

export async function retrieveGroundingMemory(input: RetrieveGroundingMemoryInput): Promise<MemoryGatewayResult> {
  const request = MemoryGatewayRequestSchema.parse({
    target: input.target,
    purpose: input.purpose,
    user_visible_sink: input.user_visible_sink,
    scope_ref: input.scope_ref,
    requested_use: input.requested_use,
    query: input.query,
    workspace_root: input.workspace_root,
    home_dir: input.home_dir,
    soil_root_dir: input.soil_root_dir,
    goal_id: input.goal_id,
    task_id: input.task_id,
    max_hits: input.max_hits,
    include_sensitive_relationship_profile: input.include_sensitive_relationship_profile,
  });
  const warnings: string[] = [];
  const sources: MemoryGatewaySourceRef[] = [];
  const selected: MemoryGatewaySelectedEntry[] = [];
  const excluded: MemoryGatewayExcludedEntry[] = [];
  const soilResult = await querySoil(input);
  warnings.push(...(soilResult?.warnings ?? []));
  const owners = await loadSoilOwners(input.soil_root_dir, soilResult);
  const soilHits = soilResult?.hits.slice(0, input.max_hits) ?? [];
  for (let index = 0; index < soilHits.length; index += 1) {
    const hit = soilHits[index]!;
    const record = hit.recordId ? owners.records.get(hit.recordId) : undefined;
    const correction = hit.recordId ? correctionStateForTarget(owners.corrections, soilTargetRef(hit.recordId)) : null;
    const source = soilSourceForHit(hit, soilResult!, record, correction);
    sources.push(source);
    if (
      (source.source_kind === "soil" || source.source_kind === "prefetched_context")
      && canSelectForPrompt(source, input.user_visible_sink)
    ) {
      selected.push(selectedEntryForHit(hit, source, index + 1));
    } else {
      excluded.push(excludedEntryForSource(source, source.source_kind === "soil" ? "soil_owner_state_excluded" : "soil_unknown_governance", input.user_visible_sink));
    }
  }

  const relationship = await buildRelationshipProfile(input);
  sources.push(...relationship.sources);
  excluded.push(...relationship.excludedEntries);

  const hasCallerKnowledgeContext = Boolean(input.knowledgeContext?.trim());
  if (hasCallerKnowledgeContext) {
    const source = knowledgeSource("request.knowledgeContext", "request.knowledgeContext", "prefetched_context");
    sources.push(source);
    if (canSelectForPrompt(source, input.user_visible_sink)) {
      selected.push(MemoryGatewaySelectedEntrySchema.parse({
        entry_id: `memory-gateway:selected:${source.source_id}`,
        section: "knowledge_query",
        source_ref: source,
        content: { state: "available", text: input.knowledgeContext!.trim() },
        prompt_eligible: true,
        user_visible_eligible: false,
        rationale: "caller_supplied_context_selected_for_non_user_visible_runtime",
        rank: 1,
      }));
    } else {
      excluded.push(excludedEntryForSource(source, "prefetched_context_unknown_governance", input.user_visible_sink));
    }
  }

  if (!selected.some((entry) => entry.section === "soil_knowledge") && !hasCallerKnowledgeContext && input.knowledgeQuery && input.query?.trim()) {
    const result: GroundingKnowledgeResult | null = await input.knowledgeQuery({
      query: input.query,
      goalId: input.goal_id,
      limit: input.max_hits,
      relationshipProfileContext: relationship.context,
      relationshipProfilePromptContext: relationship.promptContext,
    });
    const items = (result?.items ?? []).slice(0, input.max_hits);
    warnings.push(...(result?.warnings ?? []));
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const source = knowledgeSource(item.id, item.source, "knowledge");
      sources.push(source);
      if (canSelectForPrompt(source, input.user_visible_sink)) {
        selected.push(MemoryGatewaySelectedEntrySchema.parse({
          entry_id: `memory-gateway:selected:${source.source_id}`,
          section: "knowledge_query",
          source_ref: source,
          content: { state: "available", text: item.content },
          prompt_eligible: true,
          user_visible_eligible: false,
          rationale: "legacy_knowledge_query_selected",
          rank: index + 1,
          ...(typeof item.relevance === "number" ? { score: item.relevance } : {}),
        }));
      } else {
        excluded.push(excludedEntryForSource(source, "legacy_knowledge_unknown_governance", input.user_visible_sink));
      }
    }
  }

  let selectedSection: MemoryGatewaySelectedSection | null = null;
  let rationale = "no_memory_selected";
  if (selected.some((entry) => entry.section === "soil_knowledge")) {
    selectedSection = "soil_knowledge";
    rationale = selected.some((entry) => entry.source_ref.source_kind === "soil")
      ? "canonical_soil_selected"
      : "prefetched_soil_context_selected_for_non_user_visible_runtime";
  } else if (selected.some((entry) => entry.section === "knowledge_query")) {
    selectedSection = "knowledge_query";
    rationale = "knowledge_selected_after_soil_miss";
  }

  return MemoryGatewayResultSchema.parse({
    schema_version: "memory-gateway/v1",
    retrieval_id: `memory-gateway:${queryRef(input.query)}`,
    query_ref: queryRef(input.query),
    target: request.target,
    purpose: request.purpose,
    scope_ref: request.scope_ref,
    requested_use: request.requested_use,
    user_visible_sink: request.user_visible_sink,
    selected_section: selectedSection,
    selected_entries: selected,
    excluded_entries: excluded,
    sources,
    selection: {
      rationale,
      selected_source_order: Array.from(new Set(selected.map((entry) => entry.source_ref.source_kind))),
    },
    governance: governanceFor(sources, excluded),
    relationship_profile_context: relationship.context,
    relationship_profile_prompt_context: relationship.promptContext,
    relationship_profile_metadata: relationship.metadata,
    relationship_profile_surface_metadata: relationship.surfaceMetadata,
    warnings,
    soil_usage_record_ids: selected
      .filter((entry) => entry.source_ref.source_kind === "soil")
      .map((entry) => entry.source_ref.owner_ref.record_ref),
    soil_root_dir: input.soil_root_dir,
  });
}
