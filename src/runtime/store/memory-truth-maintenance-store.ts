import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v3";
import {
  createControlDatabaseOwner,
  createJsonRowCodec,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import {
  appendRuntimeEventEnvelopeInTransaction,
  type RuntimeEventEnvelopeInput,
} from "./runtime-event-log.js";
import type { RuntimeGraphRef } from "../personal-agent/contracts.js";
import type { MemoryCorrectionKind } from "../../platform/corrections/memory-correction-ledger.js";

export const MemoryClaimTypeSchema = z.enum([
  "fact",
  "procedure",
  "preference",
  "relationship",
  "observation",
  "knowledge",
  "shared_knowledge",
]);
export type MemoryClaimType = z.infer<typeof MemoryClaimTypeSchema>;

export const MemoryClaimLifecycleSchema = z.enum([
  "active",
  "corrected",
  "retracted",
  "forgotten",
  "conflicted",
  "archived",
]);
export type MemoryClaimLifecycle = z.infer<typeof MemoryClaimLifecycleSchema>;

export const MemoryClaimTrustStateSchema = z.enum([
  "unknown",
  "unverified",
  "verified",
  "contradicted",
  "suspicious",
]);
export type MemoryClaimTrustState = z.infer<typeof MemoryClaimTrustStateSchema>;

export const MemorySensitivitySchema = z.enum(["public", "local", "private", "secret"]);
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;

export const MemoryClaimScopeSchema = z.object({
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  source_goal_ids: z.array(z.string().min(1)).optional(),
}).strict();
export type MemoryClaimScope = z.infer<typeof MemoryClaimScopeSchema>;

export const EvidenceRefSchema = z.object({
  schema_version: z.literal("memory-evidence-ref/v1").default("memory-evidence-ref/v1"),
  evidence_id: z.string().min(1),
  claim_id: z.string().min(1),
  owner_kind: z.string().min(1),
  owner_scope: z.string().min(1),
  source_kind: z.enum(["user", "runtime", "tool", "web", "external", "imported", "soil", "knowledge", "system", "unknown"]),
  source_ref: z.string().min(1),
  raw_refs: z.array(z.string().min(1)).default([]),
  reliability: z.number().min(0).max(1).nullable().default(null),
  verification_status: MemoryClaimTrustStateSchema.default("unknown"),
  created_at: z.string().datetime(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type EvidenceRefInput = z.input<typeof EvidenceRefSchema>;

export const MemoryClaimSchema = z.object({
  schema_version: z.literal("memory-claim/v1").default("memory-claim/v1"),
  claim_id: z.string().min(1),
  owner_kind: z.string().min(1).default("memory"),
  owner_scope: z.string().min(1).default("global"),
  claim_type: MemoryClaimTypeSchema,
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown(),
  source_evidence_refs: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  trust_state: MemoryClaimTrustStateSchema.default("unknown"),
  sensitivity: MemorySensitivitySchema.default("local"),
  consent_scope: z.string().min(1).default("local_planning"),
  scope: MemoryClaimScopeSchema.default({}),
  lifecycle: MemoryClaimLifecycleSchema.default("active"),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  invalidated_by: z.string().min(1).nullable().default(null),
  superseded_by: z.string().min(1).nullable().default(null),
  visible_to_normal_surface: z.boolean().default(true),
  operator_explanation_refs: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export type MemoryClaim = z.infer<typeof MemoryClaimSchema>;
export type MemoryClaimInput = z.input<typeof MemoryClaimSchema>;

export const CorrectionRefSchema = z.object({
  schema_version: z.literal("memory-correction-ref/v1").default("memory-correction-ref/v1"),
  correction_id: z.string().min(1),
  target_claim_id: z.string().min(1),
  correction_kind: z.enum(["corrected", "superseded", "retracted", "forgotten", "quarantined"]),
  replacement_claim_id: z.string().min(1).nullable().default(null),
  idempotency_key: z.string().min(1),
  actor: z.enum(["user", "dream_lint", "runtime_verification", "manual_tool", "system"]).default("user"),
  reason: z.string().min(1),
  created_at: z.string().datetime(),
  evidence_refs: z.array(z.string().min(1)).default([]),
  runtime_event_ref: z.string().min(1).nullable().default(null),
  runtime_graph_refs: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export type CorrectionRef = z.infer<typeof CorrectionRefSchema>;
export type CorrectionRefInput = z.input<typeof CorrectionRefSchema>;

export const ForgetTombstoneSchema = z.object({
  schema_version: z.literal("memory-forget-tombstone/v1").default("memory-forget-tombstone/v1"),
  tombstone_id: z.string().min(1),
  claim_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  source_evidence_ref: z.string().min(1).nullable().default(null),
  reason: z.string().min(1),
  prevents_reimport: z.boolean().default(true),
  operator_restored_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
}).strict();
export type ForgetTombstone = z.infer<typeof ForgetTombstoneSchema>;
export type ForgetTombstoneInput = z.input<typeof ForgetTombstoneSchema>;

export const ConflictSetSchema = z.object({
  schema_version: z.literal("memory-conflict-set/v1").default("memory-conflict-set/v1"),
  conflict_set_id: z.string().min(1),
  claim_ids: z.array(z.string().min(1)).min(2),
  status: z.enum(["unresolved", "held", "resolved"]).default("unresolved"),
  resolution_claim_id: z.string().min(1).nullable().default(null),
  reason: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  operator_explanation_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type ConflictSet = z.infer<typeof ConflictSetSchema>;
export type ConflictSetInput = z.input<typeof ConflictSetSchema>;

export const ProcedureMemorySchema = z.object({
  schema_version: z.literal("procedure-memory/v1").default("procedure-memory/v1"),
  claim_id: z.string().min(1),
  steps: z.array(z.string()).default([]),
  updated_at: z.string().datetime(),
}).strict();
export type ProcedureMemory = z.infer<typeof ProcedureMemorySchema>;

export const PreferenceMemorySchema = z.object({
  schema_version: z.literal("preference-memory/v1").default("preference-memory/v1"),
  claim_id: z.string().min(1),
  preference_key: z.string().min(1),
  preference_value: z.unknown(),
  updated_at: z.string().datetime(),
}).strict();
export type PreferenceMemory = z.infer<typeof PreferenceMemorySchema>;

export const RelationshipMemorySchema = z.object({
  schema_version: z.literal("relationship-memory/v1").default("relationship-memory/v1"),
  claim_id: z.string().min(1),
  relationship_key: z.string().min(1),
  relationship_value: z.unknown(),
  updated_at: z.string().datetime(),
}).strict();
export type RelationshipMemory = z.infer<typeof RelationshipMemorySchema>;

export const RecallModeSchema = z.enum(["exact", "lexical", "semantic", "semantic_unavailable", "graph"]);
export type RecallMode = z.infer<typeof RecallModeSchema>;

export const RecallResultClaimSchema = z.object({
  claim_id: z.string().min(1),
  mode: RecallModeSchema,
  evidence_refs: z.array(z.string().min(1)).default([]),
  correction_status: MemoryClaimLifecycleSchema,
  invalidation_status: z.enum(["valid", "corrected", "forgotten", "retracted", "conflicted", "archived"]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  trust_state: MemoryClaimTrustStateSchema,
  safe_for_normal_projection: z.boolean(),
}).strict();
export type RecallResultClaim = z.infer<typeof RecallResultClaimSchema>;

export const RecallRecordSchema = z.object({
  schema_version: z.literal("memory-recall-record/v1").default("memory-recall-record/v1"),
  recall_id: z.string().min(1),
  mode: RecallModeSchema,
  query: z.string(),
  query_hash: z.string().min(1),
  result_claims: z.array(RecallResultClaimSchema).default([]),
  withheld_claim_ids: z.array(z.string().min(1)).default([]),
  semantic_index_status: z.enum(["available", "unavailable", "not_requested"]).default("not_requested"),
  safe_for_normal_projection: z.boolean(),
  created_at: z.string().datetime(),
}).strict();
export type RecallRecord = z.infer<typeof RecallRecordSchema>;
export type RecallRecordInput = z.input<typeof RecallRecordSchema>;

export const ProjectionRecordSchema = z.object({
  schema_version: z.literal("memory-projection-record/v1").default("memory-projection-record/v1"),
  projection_id: z.string().min(1),
  claim_id: z.string().min(1).nullable().default(null),
  owner_kind: z.string().min(1),
  owner_scope: z.string().min(1),
  projection_kind: z.enum(["normal_surface", "operator_debug", "soil", "knowledge_graph", "memory_metadata"]),
  surface: z.string().min(1),
  safe_for_normal_surface: z.boolean(),
  rebuilt_from_event_id: z.string().min(1).nullable().default(null),
  replayed_from_event_id: z.string().min(1).nullable().default(null),
  explanation_refs: z.array(z.string().min(1)).default([]),
  payload: z.record(z.unknown()).default({}),
  created_at: z.string().datetime(),
}).strict();
export type ProjectionRecord = z.infer<typeof ProjectionRecordSchema>;
export type ProjectionRecordInput = z.input<typeof ProjectionRecordSchema>;

export interface MemoryTruthMaintenanceStoreOptions extends RuntimeControlDbStoreOptions {
  runtimeRoot?: string;
  appendRuntimeEvents?: boolean;
}

export interface MemoryTruthSnapshotInput {
  ownerKind: string;
  ownerScope: string;
  claims: MemoryClaimInput[];
  evidenceRefs?: EvidenceRefInput[];
  corrections?: CorrectionRefInput[];
  tombstones?: ForgetTombstoneInput[];
  conflictSets?: ConflictSetInput[];
  projections?: ProjectionRecordInput[];
  tombstoneReason?: string;
  dropRemovedClaimIds?: string[];
  now?: string;
  emitRuntimeEvent?: boolean;
}

export interface MemoryCorrectionTransactionInput {
  correction: CorrectionRefInput;
  replacementClaim?: MemoryClaimInput | null;
  replacementEvidenceRefs?: EvidenceRefInput[];
  tombstone?: ForgetTombstoneInput | null;
  conflictSets?: ConflictSetInput[];
  recallRecords?: RecallRecordInput[];
  projectionRecords?: ProjectionRecordInput[];
  failureAfterStep?: "replacement_claim" | "correction" | "target_update" | "tombstone" | "conflict" | "recall" | "projection" | "runtime_event";
  emitRuntimeEvent?: boolean;
}

export interface MemoryCorrectionTransactionResult {
  correction: CorrectionRef;
  disposition: "inserted" | "deduplicated_by_idempotency";
}

const claimCodec = createJsonRowCodec(MemoryClaimSchema);
const evidenceCodec = createJsonRowCodec(EvidenceRefSchema);
const correctionCodec = createJsonRowCodec(CorrectionRefSchema);
const tombstoneCodec = createJsonRowCodec(ForgetTombstoneSchema);
const conflictCodec = createJsonRowCodec(ConflictSetSchema);
const recallCodec = createJsonRowCodec(RecallRecordSchema);
const projectionCodec = createJsonRowCodec(ProjectionRecordSchema);
const procedureCodec = createJsonRowCodec(ProcedureMemorySchema);
const preferenceCodec = createJsonRowCodec(PreferenceMemorySchema);
const relationshipCodec = createJsonRowCodec(RelationshipMemorySchema);

export class MemoryTruthMaintenanceStore {
  private readonly dbOwner;

  constructor(
    private readonly baseDir: string,
    private readonly options: MemoryTruthMaintenanceStoreOptions = {},
  ) {
    this.dbOwner = createControlDatabaseOwner(baseDir, options);
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async saveOwnerSnapshot(input: MemoryTruthSnapshotInput): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    const ownerKind = nonEmpty(input.ownerKind, "ownerKind");
    const ownerScope = nonEmpty(input.ownerScope, "ownerScope");
    const claims = input.claims.map((claim) => MemoryClaimSchema.parse({
      ...claim,
      owner_kind: ownerKind,
      owner_scope: ownerScope,
    }));
    const evidenceRefs = (input.evidenceRefs ?? []).map((evidence) => EvidenceRefSchema.parse({
      ...evidence,
      owner_kind: ownerKind,
      owner_scope: ownerScope,
    }));
    const corrections = (input.corrections ?? []).map((correction) => CorrectionRefSchema.parse(correction));
    const tombstones = (input.tombstones ?? []).map((tombstone) => ForgetTombstoneSchema.parse(tombstone));
    const conflictSets = (input.conflictSets ?? []).map((conflict) => ConflictSetSchema.parse(conflict));
    const projections = (input.projections ?? []).map((projection) => ProjectionRecordSchema.parse({
      ...projection,
      owner_kind: ownerKind,
      owner_scope: ownerScope,
    }));
    const dropRemovedClaimIds = new Set(input.dropRemovedClaimIds ?? []);
    const db = await this.database();
    db.transaction((sqlite) => {
      const resurrectedClaimIds = new Set(
        claims
          .filter((claim) => claim.lifecycle === "active" && hasBlockingTombstone(sqlite, claim.claim_id))
          .map((claim) => claim.claim_id),
      );
      const acceptedClaims = claims.filter((claim) => !resurrectedClaimIds.has(claim.claim_id));
      const acceptedClaimIds = new Set(acceptedClaims.map((claim) => claim.claim_id));
      const existingClaims = readClaims(sqlite, { ownerKind, ownerScope });
      const nextClaimIds = acceptedClaimIds;
      for (const existing of existingClaims) {
        if (!nextClaimIds.has(existing.claim_id) && existing.lifecycle !== "forgotten") {
          const correctionId = `memory-truth-snapshot-forget-${stableId(`${ownerKind}:${ownerScope}:${existing.claim_id}:${now}`)}`;
          const tombstone = ForgetTombstoneSchema.parse({
            tombstone_id: `tombstone-${correctionId}`,
            claim_id: existing.claim_id,
            idempotency_key: correctionId,
            source_evidence_ref: existing.source_evidence_refs[0] ?? null,
            reason: input.tombstoneReason ?? "Memory owner snapshot removed this claim; retaining tombstone to prevent stale resurrection.",
            created_at: now,
          });
          upsertTombstone(sqlite, tombstone);
          upsertClaim(sqlite, MemoryClaimSchema.parse({
            ...existing,
            metadata: dropRemovedClaimIds.has(existing.claim_id)
              ? { ...existing.metadata, destructive_delete_requested: true }
              : existing.metadata,
            lifecycle: "forgotten",
            invalidated_by: correctionId,
            visible_to_normal_surface: false,
            updated_at: now,
          }));
        }
      }
      sqlite.prepare("DELETE FROM memory_evidence_refs WHERE owner_kind = ? AND owner_scope = ?").run(ownerKind, ownerScope);
      sqlite.prepare("DELETE FROM memory_projection_records WHERE owner_kind = ? AND owner_scope = ?").run(ownerKind, ownerScope);
      for (const claim of acceptedClaims) upsertClaim(sqlite, claim);
      for (const evidence of evidenceRefs) {
        if (!acceptedClaimIds.has(evidence.claim_id)) continue;
        upsertEvidence(sqlite, evidence);
      }
      for (const correction of corrections) upsertCorrection(sqlite, correction);
      for (const tombstone of tombstones) upsertTombstone(sqlite, tombstone);
      for (const conflict of conflictSets) upsertConflict(sqlite, conflict);
      for (const projection of projections) {
        if (projection.claim_id && !acceptedClaimIds.has(projection.claim_id)) continue;
        upsertProjection(sqlite, projection);
      }
      if (input.emitRuntimeEvent ?? this.options.appendRuntimeEvents) {
        appendRuntimeEventEnvelopeInTransaction(sqlite, this.memoryTruthRuntimeEventInput({
          traceId: `memory-truth:snapshot:${ownerKind}:${stableId(ownerScope)}`,
          correlationId: `memory-truth:snapshot:${ownerKind}:${stableId(ownerScope)}`,
          idempotencyKey: `memory-truth:snapshot:${ownerKind}:${ownerScope}:${stableId(acceptedClaims.map((claim) => `${claim.claim_id}:${claim.updated_at}:${claim.lifecycle}`).join("|"))}`,
          sourceRef: { kind: "memory_truth_owner", ref: `${ownerKind}:${ownerScope}` },
          targetRefs: acceptedClaims.map((claim) => ({ kind: "memory_claim", ref: claim.claim_id })),
          payload: {
            schema_version: "runtime-event-payload/memory-truth-maintenance/v1",
            operation: "snapshot",
            correction_ref: null,
            claim_ids: acceptedClaims.map((claim) => claim.claim_id),
            projection_ids: projections.map((projection) => projection.projection_id),
            recall_ids: [],
            tombstone_ids: tombstones.map((tombstone) => tombstone.tombstone_id),
            conflict_set_ids: conflictSets.map((conflict) => conflict.conflict_set_id),
            owner: { kind: ownerKind, scope: ownerScope },
          },
        }));
      }
    });
  }

  async applyCorrectionTransaction(input: MemoryCorrectionTransactionInput): Promise<MemoryCorrectionTransactionResult> {
    const correction = CorrectionRefSchema.parse(input.correction);
    const replacementClaim = input.replacementClaim ? MemoryClaimSchema.parse(input.replacementClaim) : null;
    const replacementEvidenceRefs = (input.replacementEvidenceRefs ?? []).map((evidence) => EvidenceRefSchema.parse(evidence));
    const tombstone = input.tombstone ? ForgetTombstoneSchema.parse(input.tombstone) : null;
    const conflictSets = (input.conflictSets ?? []).map((conflict) => ConflictSetSchema.parse(conflict));
    const recallRecords = (input.recallRecords ?? []).map((recall) => RecallRecordSchema.parse(recall));
    const projectionRecords = (input.projectionRecords ?? []).map((projection) => ProjectionRecordSchema.parse(projection));
    const db = await this.database();
    let disposition: MemoryCorrectionTransactionResult["disposition"] = "inserted";
    let storedCorrection = correction;
    db.transaction((sqlite) => {
      const duplicate = readCorrectionByIdempotency(sqlite, correction.idempotency_key);
      if (duplicate) {
        storedCorrection = duplicate;
        disposition = "deduplicated_by_idempotency";
        return;
      }
      const target = readClaim(sqlite, correction.target_claim_id);
      if (!target) {
        throw new Error(`memory claim not found: ${correction.target_claim_id}`);
      }
      if (replacementClaim) {
        upsertClaim(sqlite, replacementClaim);
        for (const evidence of replacementEvidenceRefs) upsertEvidence(sqlite, evidence);
      }
      maybeFail(input.failureAfterStep, "replacement_claim");
      upsertCorrection(sqlite, correction);
      maybeFail(input.failureAfterStep, "correction");
      upsertClaim(sqlite, MemoryClaimSchema.parse({
        ...target,
        lifecycle: lifecycleForCorrection(correction.correction_kind),
        invalidated_by: correction.correction_id,
        superseded_by: replacementClaim?.claim_id ?? correction.replacement_claim_id,
        visible_to_normal_surface: false,
        updated_at: correction.created_at,
        operator_explanation_refs: unique([
          ...target.operator_explanation_refs,
          correction.correction_id,
          ...correction.evidence_refs,
        ]),
      }));
      maybeFail(input.failureAfterStep, "target_update");
      if (tombstone) upsertTombstone(sqlite, tombstone);
      maybeFail(input.failureAfterStep, "tombstone");
      for (const conflict of conflictSets) upsertConflict(sqlite, conflict);
      maybeFail(input.failureAfterStep, "conflict");
      for (const recall of recallRecords) upsertRecall(sqlite, recall);
      maybeFail(input.failureAfterStep, "recall");
      for (const projection of projectionRecords) upsertProjection(sqlite, projection);
      maybeFail(input.failureAfterStep, "projection");
      if (input.emitRuntimeEvent ?? this.options.appendRuntimeEvents) {
        const eventResult = appendRuntimeEventEnvelopeInTransaction(sqlite, this.memoryTruthRuntimeEventInput({
          traceId: `memory-truth:correction:${correction.correction_id}`,
          correlationId: correction.idempotency_key,
          idempotencyKey: correction.idempotency_key,
          sourceRef: { kind: "memory_correction", ref: correction.correction_id },
          targetRefs: [
            { kind: "memory_claim", ref: correction.target_claim_id },
            ...(replacementClaim ? [{ kind: "memory_claim", ref: replacementClaim.claim_id } satisfies RuntimeGraphRef] : []),
          ],
          payload: {
            schema_version: "runtime-event-payload/memory-truth-maintenance/v1",
            operation: "correction",
            correction_ref: correction,
            claim_ids: unique([correction.target_claim_id, replacementClaim?.claim_id].filter(isString)),
            projection_ids: projectionRecords.map((projection) => projection.projection_id),
            recall_ids: recallRecords.map((recall) => recall.recall_id),
            tombstone_ids: tombstone ? [tombstone.tombstone_id] : [],
            conflict_set_ids: conflictSets.map((conflict) => conflict.conflict_set_id),
            owner: {
              kind: "memory_truth",
              scope: correction.target_claim_id,
            },
          },
        }));
        maybeFail(input.failureAfterStep, "runtime_event");
        const event = eventResult.event;
        const updated = CorrectionRefSchema.parse({
          ...correction,
          runtime_event_ref: event.event_id,
          runtime_graph_refs: [event.runtime_graph_node_ref?.ref].filter(isString),
        });
        upsertCorrection(sqlite, updated);
        storedCorrection = updated;
      }
    });
    return { correction: storedCorrection, disposition };
  }

  async listClaims(input: {
    ownerKind?: string;
    ownerScope?: string;
    lifecycle?: MemoryClaimLifecycle[];
    includeInactive?: boolean;
    claimType?: MemoryClaimType;
  } = {}): Promise<MemoryClaim[]> {
    const db = await this.database();
    return db.read((sqlite) => readClaims(sqlite, input));
  }

  async getClaim(claimId: string): Promise<MemoryClaim | null> {
    const db = await this.database();
    return db.read((sqlite) => readClaim(sqlite, claimId));
  }

  async listEvidenceRefs(claimId?: string): Promise<EvidenceRef[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = claimId
        ? sqlite.prepare("SELECT evidence_json FROM memory_evidence_refs WHERE claim_id = ? ORDER BY created_at, evidence_id").all(claimId)
        : sqlite.prepare("SELECT evidence_json FROM memory_evidence_refs ORDER BY created_at, evidence_id").all();
      return (rows as Array<{ evidence_json: string }>).map((row) => evidenceCodec.parse(row.evidence_json));
    });
  }

  async listCorrections(targetClaimId?: string): Promise<CorrectionRef[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = targetClaimId
        ? sqlite.prepare("SELECT correction_json FROM memory_correction_refs WHERE target_claim_id = ? ORDER BY created_at, correction_id").all(targetClaimId)
        : sqlite.prepare("SELECT correction_json FROM memory_correction_refs ORDER BY created_at, correction_id").all();
      return (rows as Array<{ correction_json: string }>).map((row) => correctionCodec.parse(row.correction_json));
    });
  }

  async listTombstones(claimId?: string): Promise<ForgetTombstone[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = claimId
        ? sqlite.prepare("SELECT tombstone_json FROM memory_forget_tombstones WHERE claim_id = ? ORDER BY created_at, tombstone_id").all(claimId)
        : sqlite.prepare("SELECT tombstone_json FROM memory_forget_tombstones ORDER BY created_at, tombstone_id").all();
      return (rows as Array<{ tombstone_json: string }>).map((row) => tombstoneCodec.parse(row.tombstone_json));
    });
  }

  async listConflictSets(): Promise<ConflictSet[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare("SELECT conflict_json FROM memory_conflict_sets ORDER BY created_at, conflict_set_id").all() as Array<{ conflict_json: string }>;
      return rows.map((row) => conflictCodec.parse(row.conflict_json));
    });
  }

  async recordRecall(input: RecallRecordInput): Promise<RecallRecord> {
    const recall = RecallRecordSchema.parse(input);
    const db = await this.database();
    db.transaction((sqlite) => upsertRecall(sqlite, recall));
    return recall;
  }

  async listRecallRecords(): Promise<RecallRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare("SELECT recall_json FROM memory_recall_records ORDER BY created_at, recall_id").all() as Array<{ recall_json: string }>;
      return rows.map((row) => recallCodec.parse(row.recall_json));
    });
  }

  async listProjectionRecords(input: {
    claimId?: string;
    ownerKind?: string;
    ownerScope?: string;
    projectionKind?: ProjectionRecord["projection_kind"];
  } = {}): Promise<ProjectionRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (input.claimId) {
        clauses.push("claim_id = ?");
        params.push(input.claimId);
      }
      if (input.ownerKind) {
        clauses.push("owner_kind = ?");
        params.push(input.ownerKind);
      }
      if (input.ownerScope) {
        clauses.push("owner_scope = ?");
        params.push(input.ownerScope);
      }
      if (input.projectionKind) {
        clauses.push("projection_kind = ?");
        params.push(input.projectionKind);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = sqlite.prepare(`
        SELECT projection_json
        FROM memory_projection_records
        ${where}
        ORDER BY created_at, projection_id
      `).all(...params) as Array<{ projection_json: string }>;
      return rows.map((row) => projectionCodec.parse(row.projection_json));
    });
  }

  async close(): Promise<void> {
    await this.dbOwner.close();
  }

  private async database(): Promise<ControlDatabase> {
    return this.dbOwner.database();
  }

  private memoryTruthRuntimeEventInput(input: {
    traceId: string;
    correlationId: string;
    idempotencyKey: string;
    sourceRef: RuntimeGraphRef;
    targetRefs: RuntimeGraphRef[];
    payload: {
      schema_version: "runtime-event-payload/memory-truth-maintenance/v1";
      operation: "snapshot" | "correction" | "recall" | "projection_rebuild";
      correction_ref: CorrectionRef | null;
      claim_ids: string[];
      projection_ids: string[];
      recall_ids: string[];
      tombstone_ids: string[];
      conflict_set_ids: string[];
      owner: { kind: string; scope: string };
    };
  }): RuntimeEventEnvelopeInput {
    const eventId = `runtime-event:memory-truth:${stableId(`${input.traceId}:${input.idempotencyKey}`)}`;
    return {
      schema_version: "runtime-event-envelope/v1",
      event_id: eventId,
      event_type: "memory.truth_maintenance.recorded",
      occurred_at: new Date().toISOString(),
      trace_id: input.traceId,
      causation_id: null,
      correlation_id: input.correlationId,
      idempotency_key: input.idempotencyKey,
      actor: { kind: "runtime" },
      caller_path: "memory_correction",
      surface: "operator_debug",
      goal_id: null,
      task_id: null,
      run_id: null,
      session_id: null,
      source_ref: input.sourceRef,
      target_refs: input.targetRefs,
      authority_decision_ref: null,
      runtime_graph_node_ref: { kind: "runtime_event", ref: eventId },
      runtime_graph_edge_refs: [],
      side_effect_ref: null,
      replay_policy: {
        mode: "dedupe_by_idempotency_key",
        duplicate_side_effect_policy: "projection_only",
        idempotency_scope: "memory_truth_maintenance",
      },
      payload_schema: "runtime-event-payload/memory-truth-maintenance/v1",
      payload_version: "runtime-event-payload/memory-truth-maintenance/v1",
      payload: input.payload,
    };
  }
}

function upsertClaim(sqlite: SqliteDatabase, claimInput: MemoryClaim): void {
  const claim = MemoryClaimSchema.parse(claimInput);
  sqlite.prepare(`
    INSERT INTO memory_claims (
      claim_id, owner_kind, owner_scope, claim_type, subject, predicate, lifecycle,
      trust_state, sensitivity, consent_scope, visible_to_normal_surface,
      invalidated_by, superseded_by, created_at, updated_at, claim_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(claim_id) DO UPDATE SET
      owner_kind = excluded.owner_kind,
      owner_scope = excluded.owner_scope,
      claim_type = excluded.claim_type,
      subject = excluded.subject,
      predicate = excluded.predicate,
      lifecycle = excluded.lifecycle,
      trust_state = excluded.trust_state,
      sensitivity = excluded.sensitivity,
      consent_scope = excluded.consent_scope,
      visible_to_normal_surface = excluded.visible_to_normal_surface,
      invalidated_by = excluded.invalidated_by,
      superseded_by = excluded.superseded_by,
      updated_at = excluded.updated_at,
      claim_json = excluded.claim_json
  `).run(
    claim.claim_id,
    ownerKindForClaim(claim),
    ownerScopeForClaim(claim),
    claim.claim_type,
    claim.subject,
    claim.predicate,
    claim.lifecycle,
    claim.trust_state,
    claim.sensitivity,
    claim.consent_scope,
    claim.visible_to_normal_surface ? 1 : 0,
    claim.invalidated_by,
    claim.superseded_by,
    claim.created_at,
    claim.updated_at,
    claimCodec.stringify(claim),
  );
  sqlite.prepare("DELETE FROM procedure_memory_records WHERE claim_id = ?").run(claim.claim_id);
  sqlite.prepare("DELETE FROM preference_memory_records WHERE claim_id = ?").run(claim.claim_id);
  sqlite.prepare("DELETE FROM relationship_memory_records WHERE claim_id = ?").run(claim.claim_id);
  if (claim.claim_type === "procedure") {
    const procedure = ProcedureMemorySchema.parse({
      claim_id: claim.claim_id,
      steps: Array.isArray((claim.object as Record<string, unknown> | null)?.["steps"])
        ? (claim.object as { steps: string[] }).steps
        : [],
      updated_at: claim.updated_at,
    });
    sqlite.prepare(`
      INSERT INTO procedure_memory_records (claim_id, updated_at, procedure_json)
      VALUES (?, ?, json(?))
      ON CONFLICT(claim_id) DO UPDATE SET updated_at = excluded.updated_at, procedure_json = excluded.procedure_json
    `).run(procedure.claim_id, procedure.updated_at, procedureCodec.stringify(procedure));
  } else if (claim.claim_type === "preference") {
    const preference = PreferenceMemorySchema.parse({
      claim_id: claim.claim_id,
      preference_key: claim.subject,
      preference_value: claim.object,
      updated_at: claim.updated_at,
    });
    sqlite.prepare(`
      INSERT INTO preference_memory_records (claim_id, updated_at, preference_json)
      VALUES (?, ?, json(?))
      ON CONFLICT(claim_id) DO UPDATE SET updated_at = excluded.updated_at, preference_json = excluded.preference_json
    `).run(preference.claim_id, preference.updated_at, preferenceCodec.stringify(preference));
  } else if (claim.claim_type === "relationship") {
    const relationship = RelationshipMemorySchema.parse({
      claim_id: claim.claim_id,
      relationship_key: claim.subject,
      relationship_value: claim.object,
      updated_at: claim.updated_at,
    });
    sqlite.prepare(`
      INSERT INTO relationship_memory_records (claim_id, updated_at, relationship_json)
      VALUES (?, ?, json(?))
      ON CONFLICT(claim_id) DO UPDATE SET updated_at = excluded.updated_at, relationship_json = excluded.relationship_json
    `).run(relationship.claim_id, relationship.updated_at, relationshipCodec.stringify(relationship));
  }
}

function upsertEvidence(sqlite: SqliteDatabase, evidenceInput: EvidenceRef): void {
  const evidence = EvidenceRefSchema.parse(evidenceInput);
  sqlite.prepare(`
    INSERT INTO memory_evidence_refs (
      evidence_id, claim_id, owner_kind, owner_scope, source_kind, source_ref,
      reliability, created_at, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(evidence_id) DO UPDATE SET
      claim_id = excluded.claim_id,
      owner_kind = excluded.owner_kind,
      owner_scope = excluded.owner_scope,
      source_kind = excluded.source_kind,
      source_ref = excluded.source_ref,
      reliability = excluded.reliability,
      created_at = excluded.created_at,
      evidence_json = excluded.evidence_json
  `).run(
    evidence.evidence_id,
    evidence.claim_id,
    evidence.owner_kind,
    evidence.owner_scope,
    evidence.source_kind,
    evidence.source_ref,
    evidence.reliability,
    evidence.created_at,
    evidenceCodec.stringify(evidence),
  );
}

function upsertCorrection(sqlite: SqliteDatabase, correctionInput: CorrectionRef): void {
  const parsedCorrection = CorrectionRefSchema.parse(correctionInput);
  const existingCorrection = readCorrectionById(sqlite, parsedCorrection.correction_id);
  const correction = CorrectionRefSchema.parse({
    ...parsedCorrection,
    runtime_event_ref: parsedCorrection.runtime_event_ref ?? existingCorrection?.runtime_event_ref ?? null,
    runtime_graph_refs: unique([
      ...(existingCorrection?.runtime_graph_refs ?? []),
      ...parsedCorrection.runtime_graph_refs,
    ]),
  });
  sqlite.prepare(`
    INSERT INTO memory_correction_refs (
      correction_id, target_claim_id, correction_kind, replacement_claim_id,
      idempotency_key, actor, created_at, correction_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(correction_id) DO UPDATE SET
      target_claim_id = excluded.target_claim_id,
      correction_kind = excluded.correction_kind,
      replacement_claim_id = excluded.replacement_claim_id,
      idempotency_key = excluded.idempotency_key,
      actor = excluded.actor,
      created_at = excluded.created_at,
      correction_json = excluded.correction_json
  `).run(
    correction.correction_id,
    correction.target_claim_id,
    correction.correction_kind,
    correction.replacement_claim_id,
    correction.idempotency_key,
    correction.actor,
    correction.created_at,
    correctionCodec.stringify(correction),
  );
}

function readCorrectionById(sqlite: SqliteDatabase, correctionId: string): CorrectionRef | null {
  const row = sqlite.prepare(`
    SELECT correction_json
    FROM memory_correction_refs
    WHERE correction_id = ?
  `).get(correctionId) as { correction_json: string } | undefined;
  return row ? correctionCodec.parse(row.correction_json) : null;
}

function upsertTombstone(sqlite: SqliteDatabase, tombstoneInput: ForgetTombstone): void {
  const tombstone = ForgetTombstoneSchema.parse(tombstoneInput);
  sqlite.prepare(`
    INSERT INTO memory_forget_tombstones (
      tombstone_id, claim_id, idempotency_key, source_evidence_ref,
      reason, operator_restored_at, created_at, tombstone_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(tombstone_id) DO UPDATE SET
      claim_id = excluded.claim_id,
      idempotency_key = excluded.idempotency_key,
      source_evidence_ref = excluded.source_evidence_ref,
      reason = excluded.reason,
      operator_restored_at = excluded.operator_restored_at,
      created_at = excluded.created_at,
      tombstone_json = excluded.tombstone_json
  `).run(
    tombstone.tombstone_id,
    tombstone.claim_id,
    tombstone.idempotency_key,
    tombstone.source_evidence_ref,
    tombstone.reason,
    tombstone.operator_restored_at,
    tombstone.created_at,
    tombstoneCodec.stringify(tombstone),
  );
}

function upsertConflict(sqlite: SqliteDatabase, conflictInput: ConflictSet): void {
  const conflict = ConflictSetSchema.parse(conflictInput);
  sqlite.prepare(`
    INSERT INTO memory_conflict_sets (
      conflict_set_id, status, created_at, updated_at, conflict_json
    ) VALUES (?, ?, ?, ?, json(?))
    ON CONFLICT(conflict_set_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      conflict_json = excluded.conflict_json
  `).run(
    conflict.conflict_set_id,
    conflict.status,
    conflict.created_at,
    conflict.updated_at,
    conflictCodec.stringify(conflict),
  );
  sqlite.prepare("DELETE FROM memory_conflict_claims WHERE conflict_set_id = ?").run(conflict.conflict_set_id);
  for (const claimId of conflict.claim_ids) {
    sqlite.prepare(`
      INSERT OR IGNORE INTO memory_conflict_claims (conflict_set_id, claim_id, role)
      VALUES (?, ?, ?)
    `).run(conflict.conflict_set_id, claimId, claimId === conflict.resolution_claim_id ? "primary" : "conflicting");
    const claim = readClaim(sqlite, claimId);
    if (!claim) continue;
    if (conflict.status === "resolved") {
      upsertClaim(sqlite, resolvedConflictClaim(claim, conflict));
    } else {
      upsertClaim(sqlite, MemoryClaimSchema.parse({
        ...claim,
        lifecycle: "conflicted",
        visible_to_normal_surface: false,
        updated_at: conflict.updated_at,
        operator_explanation_refs: unique([...claim.operator_explanation_refs, conflict.conflict_set_id]),
        metadata: rememberPreConflictClaimState(claim, conflict),
      }));
    }
  }
}

function resolvedConflictClaim(claim: MemoryClaim, conflict: ConflictSet): MemoryClaim {
  const previousState = preConflictClaimState(claim, conflict.conflict_set_id);
  const metadata = forgetPreConflictClaimState(claim, conflict.conflict_set_id);
  const explanationRefs = unique([...claim.operator_explanation_refs, conflict.conflict_set_id]);
  if (conflict.resolution_claim_id && claim.claim_id !== conflict.resolution_claim_id) {
    return MemoryClaimSchema.parse({
      ...claim,
      lifecycle: claim.lifecycle === "active" || claim.lifecycle === "conflicted"
        ? "archived"
        : claim.lifecycle,
      visible_to_normal_surface: false,
      invalidated_by: claim.invalidated_by ?? conflict.conflict_set_id,
      updated_at: conflict.updated_at,
      operator_explanation_refs: explanationRefs,
      metadata,
    });
  }
  return MemoryClaimSchema.parse({
    ...claim,
    lifecycle: previousState?.lifecycle ?? "active",
    visible_to_normal_surface: previousState?.visible_to_normal_surface ?? true,
    updated_at: conflict.updated_at,
    operator_explanation_refs: explanationRefs,
    metadata,
  });
}

function rememberPreConflictClaimState(claim: MemoryClaim, conflict: ConflictSet): MemoryClaim["metadata"] {
  const conflictState = conflictStateMetadata(claim);
  if (!conflictState[conflict.conflict_set_id]) {
    conflictState[conflict.conflict_set_id] = {
      lifecycle: claim.lifecycle,
      visible_to_normal_surface: claim.visible_to_normal_surface,
    };
  }
  return {
    ...claim.metadata,
    conflict_state: conflictState,
  };
}

function preConflictClaimState(
  claim: MemoryClaim,
  conflictSetId: string,
): { lifecycle: MemoryClaimLifecycle; visible_to_normal_surface: boolean } | null {
  const raw = conflictStateMetadata(claim)[conflictSetId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const lifecycle = (raw as Record<string, unknown>)["lifecycle"];
  const visible = (raw as Record<string, unknown>)["visible_to_normal_surface"];
  const parsedLifecycle = MemoryClaimLifecycleSchema.safeParse(lifecycle);
  if (!parsedLifecycle.success || typeof visible !== "boolean") return null;
  return {
    lifecycle: parsedLifecycle.data,
    visible_to_normal_surface: visible,
  };
}

function forgetPreConflictClaimState(claim: MemoryClaim, conflictSetId: string): MemoryClaim["metadata"] {
  const conflictState = conflictStateMetadata(claim);
  delete conflictState[conflictSetId];
  const metadata = { ...claim.metadata };
  if (Object.keys(conflictState).length > 0) {
    metadata["conflict_state"] = conflictState;
  } else {
    delete metadata["conflict_state"];
  }
  return metadata;
}

function conflictStateMetadata(claim: MemoryClaim): Record<string, unknown> {
  const raw = claim.metadata["conflict_state"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

function upsertRecall(sqlite: SqliteDatabase, recallInput: RecallRecord): void {
  const recall = RecallRecordSchema.parse(recallInput);
  sqlite.prepare(`
    INSERT INTO memory_recall_records (
      recall_id, mode, query_hash, safe_for_normal_projection, created_at, recall_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(recall_id) DO UPDATE SET
      mode = excluded.mode,
      query_hash = excluded.query_hash,
      safe_for_normal_projection = excluded.safe_for_normal_projection,
      created_at = excluded.created_at,
      recall_json = excluded.recall_json
  `).run(
    recall.recall_id,
    recall.mode,
    recall.query_hash,
    recall.safe_for_normal_projection ? 1 : 0,
    recall.created_at,
    recallCodec.stringify(recall),
  );
}

function upsertProjection(sqlite: SqliteDatabase, projectionInput: ProjectionRecord): void {
  const projection = ProjectionRecordSchema.parse(projectionInput);
  sqlite.prepare(`
    INSERT INTO memory_projection_records (
      projection_id, claim_id, owner_kind, owner_scope, projection_kind, surface,
      safe_for_normal_surface, rebuilt_from_event_id, replayed_from_event_id,
      created_at, projection_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(projection_id) DO UPDATE SET
      claim_id = excluded.claim_id,
      owner_kind = excluded.owner_kind,
      owner_scope = excluded.owner_scope,
      projection_kind = excluded.projection_kind,
      surface = excluded.surface,
      safe_for_normal_surface = excluded.safe_for_normal_surface,
      rebuilt_from_event_id = excluded.rebuilt_from_event_id,
      replayed_from_event_id = excluded.replayed_from_event_id,
      created_at = excluded.created_at,
      projection_json = excluded.projection_json
  `).run(
    projection.projection_id,
    projection.claim_id,
    projection.owner_kind,
    projection.owner_scope,
    projection.projection_kind,
    projection.surface,
    projection.safe_for_normal_surface ? 1 : 0,
    projection.rebuilt_from_event_id,
    projection.replayed_from_event_id,
    projection.created_at,
    projectionCodec.stringify(projection),
  );
}

function readClaim(sqlite: SqliteDatabase, claimId: string): MemoryClaim | null {
  const row = sqlite.prepare("SELECT claim_json FROM memory_claims WHERE claim_id = ?").get(claimId) as { claim_json: string } | undefined;
  return row ? claimCodec.parse(row.claim_json) : null;
}

function hasBlockingTombstone(sqlite: SqliteDatabase, claimId: string): boolean {
  const rows = sqlite.prepare(`
    SELECT tombstone_json
    FROM memory_forget_tombstones
    WHERE claim_id = ?
  `).all(claimId) as Array<{ tombstone_json: string }>;
  return rows
    .map((row) => tombstoneCodec.parse(row.tombstone_json))
    .some((tombstone) => tombstone.prevents_reimport && tombstone.operator_restored_at === null);
}

function readClaims(sqlite: SqliteDatabase, input: {
  ownerKind?: string;
  ownerScope?: string;
  lifecycle?: MemoryClaimLifecycle[];
  includeInactive?: boolean;
  claimType?: MemoryClaimType;
} = {}): MemoryClaim[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.ownerKind) {
    clauses.push("owner_kind = ?");
    params.push(input.ownerKind);
  }
  if (input.ownerScope) {
    clauses.push("owner_scope = ?");
    params.push(input.ownerScope);
  }
  if (input.claimType) {
    clauses.push("claim_type = ?");
    params.push(input.claimType);
  }
  if (input.lifecycle?.length) {
    clauses.push(`lifecycle IN (${input.lifecycle.map(() => "?").join(", ")})`);
    params.push(...input.lifecycle);
  } else if (!input.includeInactive) {
    clauses.push("lifecycle = 'active'");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = sqlite.prepare(`
    SELECT claim_json
    FROM memory_claims
    ${where}
    ORDER BY updated_at DESC, claim_id ASC
  `).all(...params) as Array<{ claim_json: string }>;
  return rows.map((row) => claimCodec.parse(row.claim_json));
}

function readCorrectionByIdempotency(sqlite: SqliteDatabase, idempotencyKey: string): CorrectionRef | null {
  const row = sqlite.prepare(`
    SELECT correction_json
    FROM memory_correction_refs
    WHERE idempotency_key = ?
  `).get(idempotencyKey) as { correction_json: string } | undefined;
  return row ? correctionCodec.parse(row.correction_json) : null;
}

function lifecycleForCorrection(kind: MemoryCorrectionKind | CorrectionRef["correction_kind"]): MemoryClaimLifecycle {
  if (kind === "corrected" || kind === "superseded") return "corrected";
  if (kind === "forgotten") return "forgotten";
  if (kind === "retracted") return "retracted";
  if (kind === "quarantined") return "archived";
  return "archived";
}

function ownerKindForClaim(claim: MemoryClaim): string {
  return claim.owner_kind;
}

function ownerScopeForClaim(claim: MemoryClaim): string {
  return claim.owner_scope;
}

function maybeFail(actual: MemoryCorrectionTransactionInput["failureAfterStep"], expected: NonNullable<MemoryCorrectionTransactionInput["failureAfterStep"]>): void {
  if (actual === expected) {
    throw new Error(`injected memory truth transaction failure after ${expected}`);
  }
}

export function memoryTruthQueryHash(query: string): string {
  return stableId(query);
}

export function stableMemoryTruthId(prefix: string, value: unknown): string {
  return `${prefix}-${stableId(stableJson(value))}`;
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]),
  );
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function newMemoryTruthId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
