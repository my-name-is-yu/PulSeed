import { z } from "zod/v3";
import { ExecutionAuthorityDecisionSchema } from "../control/execution-authority-decision.js";
import { OutboundConversationMessageSchema } from "../gateway/outbound-conversation.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "../store/runtime-paths.js";
import {
  createJsonRowCodec,
  createRuntimeControlDatabaseOwner,
  type ControlDatabase,
  type ControlDatabaseHandleOwner,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../store/control-db/index.js";
import {
  PeerInitiativeRecordSchema,
  PeerInitiativeKindSchema,
  PeerInitiativeSelectedStateSchema,
  type PeerInitiativeCandidate,
  type PeerInitiativeRecord,
  type PeerInitiativeSelectedState,
} from "./contracts.js";

export const PeerPreparedArtifactSchema = z.object({
  artifact_ref: z.string().min(1),
  candidate_id: z.string().min(1),
  preparation_kind: z.string().min(1),
  created_at: z.string().datetime(),
  summary: z.string().min(1),
  content_ref: z.string().min(1).optional(),
  content_preview: z.string().min(1).max(500).optional(),
}).strict();
export type PeerPreparedArtifact = z.infer<typeof PeerPreparedArtifactSchema>;

export const PeerDeliveryRecordSchema = z.object({
  delivery_id: z.string().min(1),
  candidate_id: z.string().min(1),
  surface: z.string().min(1),
  status: z.enum(["pending_send", "delivered", "held", "failed"]),
  claimed_at: z.string().datetime().optional(),
  claim_expires_at: z.string().datetime().optional(),
  claim_attempt: z.number().int().positive().optional(),
  delivered_at: z.string().datetime().optional(),
  message_id: z.string().min(1).optional(),
  transport_message_ref: z.string().min(1).optional(),
  target_binding_ref: z.string().min(1).optional(),
  expression_decision_ref: z.string().min(1).optional(),
  visibility_policy_ref: z.string().min(1).optional(),
  failure_reason: z.string().min(1).optional(),
  outbound_message: OutboundConversationMessageSchema.optional(),
  authority_decision_ref: z.string().min(1).optional(),
  authority_decision: ExecutionAuthorityDecisionSchema.optional(),
}).strict();
export type PeerDeliveryRecord = z.infer<typeof PeerDeliveryRecordSchema>;

export const PeerFeedbackProjectionSchema = z.object({
  projection_id: z.string().min(1),
  candidate_id: z.string().min(1),
  kind: PeerInitiativeKindSchema,
  structured_outcome: z.enum([
    "more_like_this",
    "less_like_this",
    "not_now",
    "wrong_read",
    "mute_this_kind",
  ]),
  source_surface: z.enum(["telegram", "discord", "whatsapp", "slack", "gui", "gateway"]),
  projected_at: z.string().datetime(),
  feedback_id: z.string().min(1).optional(),
  feedback_effect_refs: z.array(z.string().min(1)).default([]),
  next_eligible_at: z.string().datetime().optional(),
  authority_decision_ref: z.string().min(1).optional(),
}).strict();
export type PeerFeedbackProjection = z.infer<typeof PeerFeedbackProjectionSchema>;

const PeerInitiativeJsonCodec = createJsonRowCodec(PeerInitiativeRecordSchema);
const PeerPreparedArtifactJsonCodec = createJsonRowCodec(PeerPreparedArtifactSchema);
const PeerDeliveryJsonCodec = createJsonRowCodec(PeerDeliveryRecordSchema);
const PeerFeedbackProjectionJsonCodec = createJsonRowCodec(PeerFeedbackProjectionSchema);

export class PeerInitiativeStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private readonly dbOwner: ControlDatabaseHandleOwner;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
    this.dbOwner = createRuntimeControlDatabaseOwner(this.paths, this.dbOptions);
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async upsertCandidate(input: {
    candidate: PeerInitiativeCandidate;
    selectedState: PeerInitiativeSelectedState;
    rejectionReason?: PeerInitiativeRecord["rejection_reason"];
    nextEligibleAt?: string;
    deliveredAt?: string;
    feedbackProjectionRef?: string;
  }): Promise<PeerInitiativeRecord> {
    const candidate = input.candidate;
    const record = PeerInitiativeRecordSchema.parse({
      candidate_id: candidate.candidate_id,
      created_at: candidate.created_at,
      source: candidate.source,
      kind: candidate.kind,
      grounding: candidate.grounding,
      attention_signal_refs: candidate.attention_signal_refs,
      prepared_artifact_ref: preparedArtifactRef(candidate),
      capability_ref: candidate.capability_ref,
      selected_state: PeerInitiativeSelectedStateSchema.parse(input.selectedState),
      rejection_reason: input.rejectionReason,
      delivered_at: input.deliveredAt,
      feedback_projection_ref: input.feedbackProjectionRef,
      next_eligible_at: input.nextEligibleAt,
      idempotency_key: candidate.idempotency_key,
      candidate,
    });
    const db = await this.database();
    db.transaction((sqlite) => upsertPeerInitiative(sqlite, record));
    return record;
  }

  async appendPreparedArtifact(input: PeerPreparedArtifact): Promise<PeerPreparedArtifact> {
    const artifact = PeerPreparedArtifactSchema.parse(input);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT OR REPLACE INTO peer_prepared_artifacts (
          artifact_ref,
          candidate_id,
          preparation_kind,
          created_at,
          artifact_json
        )
        VALUES (?, ?, ?, ?, json(?))
      `).run(
        artifact.artifact_ref,
        artifact.candidate_id,
        artifact.preparation_kind,
        artifact.created_at,
        PeerPreparedArtifactJsonCodec.stringify(artifact),
      );
    });
    return artifact;
  }

  async getPreparedArtifact(artifactRef: string): Promise<PeerPreparedArtifact | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT artifact_json
        FROM peer_prepared_artifacts
        WHERE artifact_ref = ?
      `).get(artifactRef) as { artifact_json: string } | undefined;
      return row ? parsePeerPreparedArtifact(row.artifact_json) : null;
    });
  }

  async recordDelivery(input: PeerDeliveryRecord): Promise<PeerDeliveryRecord> {
    const delivery = PeerDeliveryRecordSchema.parse(input);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT OR REPLACE INTO peer_deliveries (
          delivery_id,
          candidate_id,
          surface,
          status,
          delivered_at,
          delivery_json
        )
        VALUES (?, ?, ?, ?, ?, json(?))
      `).run(
        delivery.delivery_id,
        delivery.candidate_id,
        delivery.surface,
        delivery.status,
        delivery.delivered_at ?? null,
        PeerDeliveryJsonCodec.stringify(delivery),
      );
    });
    return delivery;
  }

  async claimDelivery(input: PeerDeliveryRecord, options: {
    now?: string;
    leaseMs?: number;
  } = {}): Promise<{
    status: "claimed" | "existing";
    record: PeerDeliveryRecord;
  }> {
    const now = options.now ?? new Date().toISOString();
    const leaseMs = Math.max(1, Math.floor(options.leaseMs ?? 10 * 60 * 1000));
    const claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const delivery = PeerDeliveryRecordSchema.parse({
      ...input,
      status: "pending_send",
      claimed_at: now,
      claim_expires_at: claimExpiresAt,
    });
    const db = await this.database();
    return db.transaction((sqlite) => {
      const currentRow = sqlite.prepare(`
        SELECT delivery_json
        FROM peer_deliveries
        WHERE delivery_id = ?
      `).get(delivery.delivery_id) as { delivery_json: string } | undefined;
      const current = currentRow ? parsePeerDelivery(currentRow.delivery_json) : null;
      if (current?.status === "delivered") {
        return {
          status: "existing",
          record: current,
        };
      }
      if (current?.status === "pending_send" && !pendingDeliveryLeaseExpired(current, now)) {
        return {
          status: "existing",
          record: current,
        };
      }
      const claimedDelivery = PeerDeliveryRecordSchema.parse({
        ...delivery,
        claim_attempt: (current?.claim_attempt ?? 0) + 1,
      });
      sqlite.prepare(`
        INSERT INTO peer_deliveries (
          delivery_id,
          candidate_id,
          surface,
          status,
          delivered_at,
          delivery_json
        )
        VALUES (?, ?, ?, ?, ?, json(?))
        ON CONFLICT(delivery_id) DO UPDATE SET
          candidate_id = excluded.candidate_id,
          surface = excluded.surface,
          status = excluded.status,
          delivered_at = excluded.delivered_at,
          delivery_json = excluded.delivery_json
      `).run(
        claimedDelivery.delivery_id,
        claimedDelivery.candidate_id,
        claimedDelivery.surface,
        claimedDelivery.status,
        claimedDelivery.delivered_at ?? null,
        PeerDeliveryJsonCodec.stringify(claimedDelivery),
      );
      return {
        status: "claimed",
        record: claimedDelivery,
      };
    });
  }

  async getDelivery(deliveryId: string): Promise<PeerDeliveryRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT delivery_json
        FROM peer_deliveries
        WHERE delivery_id = ?
      `).get(deliveryId) as { delivery_json: string } | undefined;
      return row ? parsePeerDelivery(row.delivery_json) : null;
    });
  }

  async getLatestDeliveryForCandidate(input: {
    candidateId: string;
    surface?: string;
  }): Promise<PeerDeliveryRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = input.surface
        ? sqlite.prepare(`
            SELECT delivery_json
            FROM peer_deliveries
            WHERE candidate_id = ? AND surface = ?
            ORDER BY COALESCE(delivered_at, json_extract(delivery_json, '$.delivered_at'), '') DESC, delivery_id DESC
            LIMIT 1
          `).all(input.candidateId, input.surface) as Array<{ delivery_json: string }>
        : sqlite.prepare(`
            SELECT delivery_json
            FROM peer_deliveries
            WHERE candidate_id = ?
            ORDER BY COALESCE(delivered_at, json_extract(delivery_json, '$.delivered_at'), '') DESC, delivery_id DESC
            LIMIT 1
          `).all(input.candidateId) as Array<{ delivery_json: string }>;
      const row = rows[0];
      return row ? parsePeerDelivery(row.delivery_json) : null;
    });
  }

  async getLatestDeliveryForActionBinding(input: {
    bindingId: string;
    surface?: string;
  }): Promise<PeerDeliveryRecord | null> {
    const db = await this.database();
    const bindingIds = input.bindingId.startsWith("sab:")
      ? [input.bindingId, input.bindingId.slice("sab:".length)]
      : [input.bindingId, `sab:${input.bindingId}`];
    return db.read((sqlite) => {
      const rows = input.surface
        ? sqlite.prepare(`
            SELECT delivery_json
            FROM peer_deliveries, json_each(peer_deliveries.delivery_json, '$.outbound_message.action_bindings') AS binding
            WHERE surface = ?
              AND json_extract(binding.value, '$.binding_id') IN (?, ?)
            ORDER BY COALESCE(delivered_at, json_extract(delivery_json, '$.delivered_at'), '') DESC, delivery_id DESC
            LIMIT 1
          `).all(input.surface, bindingIds[0], bindingIds[1]) as Array<{ delivery_json: string }>
        : sqlite.prepare(`
            SELECT delivery_json
            FROM peer_deliveries, json_each(peer_deliveries.delivery_json, '$.outbound_message.action_bindings') AS binding
            WHERE json_extract(binding.value, '$.binding_id') IN (?, ?)
            ORDER BY COALESCE(delivered_at, json_extract(delivery_json, '$.delivered_at'), '') DESC, delivery_id DESC
            LIMIT 1
          `).all(bindingIds[0], bindingIds[1]) as Array<{ delivery_json: string }>;
      const row = rows[0];
      return row ? parsePeerDelivery(row.delivery_json) : null;
    });
  }

  async appendFeedbackProjection(input: PeerFeedbackProjection): Promise<PeerFeedbackProjection> {
    const projection = PeerFeedbackProjectionSchema.parse(input);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT OR REPLACE INTO peer_feedback_projection (
          projection_id,
          candidate_id,
          kind,
          structured_outcome,
          source_surface,
          projected_at,
          projection_json
        )
        VALUES (?, ?, ?, ?, ?, ?, json(?))
      `).run(
        projection.projection_id,
        projection.candidate_id,
        projection.kind,
        projection.structured_outcome,
        projection.source_surface,
        projection.projected_at,
        PeerFeedbackProjectionJsonCodec.stringify(projection),
      );
    });
    return projection;
  }

  async getFeedbackProjectionForAction(input: {
    candidateId: string;
    sourceSurface: PeerFeedbackProjection["source_surface"];
    structuredOutcome: PeerFeedbackProjection["structured_outcome"];
  }): Promise<PeerFeedbackProjection | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT projection_json
        FROM peer_feedback_projection
        WHERE candidate_id = ?
          AND source_surface = ?
          AND structured_outcome = ?
        ORDER BY projected_at ASC, projection_id ASC
        LIMIT 1
      `).get(
        input.candidateId,
        input.sourceSurface,
        input.structuredOutcome,
      ) as { projection_json: string } | undefined;
      const projections = row ? parsePeerFeedbackProjection(row.projection_json) : [];
      return projections[0] ?? null;
    });
  }

  async listFeedbackProjections(input: {
    candidateId?: string;
    limit?: number;
  } = {}): Promise<PeerFeedbackProjection[]> {
    const bounded = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = input.candidateId
        ? sqlite.prepare(`
            SELECT projection_json
            FROM peer_feedback_projection
            WHERE candidate_id = ?
            ORDER BY projected_at ASC, projection_id ASC
            LIMIT ?
          `).all(input.candidateId, bounded) as Array<{ projection_json: string }>
        : sqlite.prepare(`
            SELECT projection_json
            FROM peer_feedback_projection
            ORDER BY projected_at ASC, projection_id ASC
            LIMIT ?
          `).all(bounded) as Array<{ projection_json: string }>;
      return rows.flatMap((row) => parsePeerFeedbackProjection(row.projection_json));
    });
  }

  async listRecentCandidates(limit = 50): Promise<PeerInitiativeRecord[]> {
    const db = await this.database();
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM (
          SELECT created_at, record_json
          FROM peer_initiatives
          ORDER BY created_at DESC
          LIMIT ?
        )
        ORDER BY created_at ASC
      `).all(bounded) as Array<{ record_json: string }>;
      return rows.flatMap((row) => parsePeerInitiative(row.record_json));
    });
  }

  private async database(): Promise<ControlDatabase> {
    return this.dbOwner.database();
  }
}

function upsertPeerInitiative(sqlite: SqliteDatabase, record: PeerInitiativeRecord): void {
  sqlite.prepare(`
    INSERT INTO peer_initiatives (
      candidate_id,
      idempotency_key,
      kind,
      selected_state,
      created_at,
      next_eligible_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(candidate_id) DO UPDATE SET
      selected_state = excluded.selected_state,
      next_eligible_at = excluded.next_eligible_at,
      record_json = excluded.record_json
  `).run(
    record.candidate_id,
    record.idempotency_key,
    record.kind,
    record.selected_state,
    record.created_at,
    record.next_eligible_at ?? null,
    PeerInitiativeJsonCodec.stringify(record),
  );
}

function parsePeerInitiative(recordJson: string): PeerInitiativeRecord[] {
  const parsed = PeerInitiativeJsonCodec.safeParse(recordJson);
  return parsed ? [parsed] : [];
}

function parsePeerDelivery(deliveryJson: string): PeerDeliveryRecord | null {
  return PeerDeliveryJsonCodec.safeParse(deliveryJson);
}

function pendingDeliveryLeaseExpired(delivery: PeerDeliveryRecord, now: string): boolean {
  if (!delivery.claim_expires_at) return true;
  const expiresAtMs = Date.parse(delivery.claim_expires_at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return true;
  return expiresAtMs <= nowMs;
}

function parsePeerPreparedArtifact(artifactJson: string): PeerPreparedArtifact | null {
  return PeerPreparedArtifactJsonCodec.safeParse(artifactJson);
}

function parsePeerFeedbackProjection(projectionJson: string): PeerFeedbackProjection[] {
  const parsed = PeerFeedbackProjectionJsonCodec.safeParse(projectionJson);
  return parsed ? [parsed] : [];
}

function preparedArtifactRef(candidate: PeerInitiativeCandidate): string | undefined {
  const plan = candidate.action_plan;
  if (plan.mode === "internal_preparation") return plan.prepared_artifact_ref;
  if (plan.mode === "permissioned_external_action") return plan.prepared_artifact_ref;
  return undefined;
}
