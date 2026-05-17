import { randomUUID } from "node:crypto";
import { z } from "zod/v3";
import {
  AttentionInputSchema,
  dedupeAttentionInputs,
  type AttentionInput,
  type AttentionInputIntakeRecord,
  type AttentionInputIntakeResult,
} from "../attention/attention-input.js";
import {
  CommitmentCandidateSchema,
  applyCommitmentLifecycleControl,
  type CommitmentCandidate,
  type CommitmentLifecycleControl,
} from "../attention/commitment-candidate.js";
import {
  runtimeItemsForAgenda,
} from "../attention/attention-agenda.js";
import type { AttentionAdmissionCandidate } from "../attention/attention-admission.js";
import { attentionScopeKey } from "../attention/attention-scope.js";
import {
  AgendaDecompositionSchema,
  AgentAgendaItemSchema,
  AttentionClusterSchema,
  ExpressionDecisionSchema,
  InhibitionDecisionSchema,
  InitiativeGateDecisionSchema,
  OutcomeDecisionSchema,
  SignalContextSchema,
  UrgeCandidateSchema,
  type AgendaDecomposition,
  type AgentAgendaItem,
  type AttentionCluster,
  type AttentionScope,
  type CompanionAutonomyRef,
  type ExpressionDecision,
  type InhibitionDecision,
  type InitiativeGateDecision,
  type OutcomeDecision,
  type SignalContext,
  type UrgeCandidate,
} from "../types/companion-autonomy.js";
import type { RuntimeItem } from "../types/companion-state.js";
import { ref, refKey, stableId, uniqueRefs } from "../attention/attention-refs.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import {
  appendRuntimeEventEnvelopeInTransaction,
  runtimeEventFromAttentionCommitment,
} from "./runtime-event-log.js";
import type { CompanionWideControl } from "../types/companion-state.js";

export const AttentionStoreLifecycleSchema = z.enum([
  "active",
  "pending",
  "held",
  "suppressed",
  "admitted",
  "stale",
  "terminal",
]);
export type AttentionStoreLifecycle = z.infer<typeof AttentionStoreLifecycleSchema>;

export type AttentionStateStoreOptions = RuntimeControlDbStoreOptions;

export interface AttentionStateCycleInput {
  attentionInputs?: readonly AttentionInput[];
  signalContext?: SignalContext;
  urgeCandidates?: readonly UrgeCandidate[];
  agendaItems?: readonly AgentAgendaItem[];
  inhibitionDecisions?: readonly InhibitionDecision[];
  initiativeGateDecisions?: readonly InitiativeGateDecision[];
  outcomeDecisions?: readonly OutcomeDecision[];
  expressionDecisions?: readonly ExpressionDecision[];
  recordedAt?: string;
}

export interface AttentionAgendaListOptions {
  includeSuppressed?: boolean;
  includeTerminal?: boolean;
  scopeKey?: string | null;
  forceLegacy?: boolean;
}

export interface AttentionAgendaSuppressionInput {
  control: Extract<CompanionWideControl, "stop_all_quiet_work" | "stop_all_watches" | "suppress_nonessential_agenda">;
  reason: string;
  now?: string;
  auditRef?: CompanionAutonomyRef;
}

export interface AttentionAgendaSuppressionResult {
  suppressed_count: number;
  agenda_item_ids: string[];
}

export interface AttentionInvalidationInput {
  refs: readonly CompanionAutonomyRef[];
  reason: string;
  now?: string;
  auditRef?: CompanionAutonomyRef;
}

export interface AttentionInvalidationResult {
  invalidated_count: number;
  agenda_item_ids: string[];
}

export interface AttentionDecisionChainSnapshot {
  attention_inputs: AttentionInput[];
  signal_contexts: SignalContext[];
  urge_candidates: UrgeCandidate[];
  agenda_items: AgentAgendaItem[];
  inhibition_decisions: InhibitionDecision[];
  initiative_gate_decisions: InitiativeGateDecision[];
  outcome_decisions: OutcomeDecision[];
  expression_decisions: ExpressionDecision[];
}

export interface AttentionConcernStateSnapshot {
  clusters: AttentionCluster[];
  agenda_items: AgentAgendaItem[];
  decompositions: AgendaDecomposition[];
}

export interface AttentionConcernStateLoadOptions {
  scope?: AttentionScope;
}

export interface AttentionEventLedgerRecord {
  event_id: string;
  event_type:
    | "signal_observed"
    | "urge_created"
    | "cluster_merged"
    | "cluster_split"
    | "matured"
    | "suppressed"
    | "forgotten"
    | "agenda_projected"
    | "decomposed"
    | "admitted"
    | "rejected"
    | "outcome_recorded"
    | "correction_received"
    | "invalidated";
  scope: AttentionScope;
  policy_epoch: string;
  occurred_at: string;
  mode: "shadow" | "live";
  compactable?: boolean;
  critical?: boolean;
  model_or_classifier_version?: string | null;
  experiment_id?: string | null;
  event: Record<string, unknown>;
}

export interface AttentionMetabolismCycleWriteInput {
  cycle_id: string;
  idempotency_key: string;
  trigger_kind: string;
  scope: AttentionScope;
  expected_projection_revision: number;
  source_high_watermarks: readonly string[];
  clusters: readonly AttentionCluster[];
  agendaItems: readonly AgentAgendaItem[];
  decompositions: readonly AgendaDecomposition[];
  admissionProposals?: readonly AttentionAdmissionCandidate[];
  events?: readonly AttentionEventLedgerRecord[];
  pendingBlocks?: readonly AttentionPendingBlockWriteInput[];
  result: Record<string, unknown>;
  created_at: string;
  no_op_hash?: string | null;
}

export type AttentionMetabolismWriteDisposition =
  | "written"
  | "no_op_elided"
  | "stale_rejected"
  | "budget_dropped";

export interface AttentionMetabolismCycleWriteResult {
  writeDisposition: AttentionMetabolismWriteDisposition;
  projectionRevision: number;
  replayedTriggerKind?: string;
}

export interface AttentionPendingBlockRecord {
  block_id: string;
  scope_key: string;
  trigger_kind: string;
  reason: string;
  created_at: string;
  cleared_at: string | null;
}

export interface AttentionPendingBlockWriteInput {
  blockId?: string;
  scope: AttentionScope;
  triggerKind: string;
  reason: string;
  createdAt: string;
}

export interface AttentionPendingBlockClearResult {
  cleared_count: number;
  block_ids: string[];
}

export interface AttentionAdmissionProposalRecord {
  proposal_id: string;
  child_id: string;
  idempotency_key: string;
  state: AttentionAdmissionCandidate["proposalState"];
  runtime_operation_id: string | null;
  created_at: string;
  updated_at: string;
  proposal: AttentionAdmissionCandidate;
}

export interface AttentionAdmissionProposalListOptions {
  states?: readonly AttentionAdmissionCandidate["proposalState"][];
}

export interface CommitmentCandidateListOptions {
  scope?: AttentionScope;
  states?: readonly CommitmentCandidate["materialization_state"][];
  dueBefore?: string | null;
  includeTerminal?: boolean;
}

export interface CommitmentCandidateWriteResult {
  accepted: CommitmentCandidate[];
  duplicates: CommitmentCandidate[];
}

export class AttentionStateStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: AttentionStateStoreOptions = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async saveCycle(input: AttentionStateCycleInput): Promise<AttentionInputIntakeResult | null> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const intake = input.attentionInputs
        ? appendAttentionInputs(sqlite, input.attentionInputs, input.recordedAt)
        : null;
      if (intake && intake.accepted.length === 0 && intake.duplicates.length > 0) {
        return intake;
      }
      if (input.signalContext) {
        upsertSignalContext(
          sqlite,
          SignalContextSchema.parse(input.signalContext),
          input.attentionInputs ?? []
        );
      }
      for (const candidate of input.urgeCandidates ?? []) upsertUrgeCandidate(sqlite, candidate);
      for (const item of input.agendaItems ?? []) upsertAgendaItem(sqlite, item);
      for (const decision of input.inhibitionDecisions ?? []) upsertInhibitionDecision(sqlite, decision);
      for (const decision of input.initiativeGateDecisions ?? []) upsertInitiativeGateDecision(sqlite, decision);
      for (const decision of input.outcomeDecisions ?? []) upsertOutcomeDecision(sqlite, decision);
      for (const decision of input.expressionDecisions ?? []) upsertExpressionDecision(sqlite, decision);
      return intake;
    });
  }

  async appendAttentionInputs(
    inputs: readonly AttentionInput[],
    recordedAt?: string
  ): Promise<AttentionInputIntakeResult> {
    const db = await this.database();
    return db.transaction((sqlite) => appendAttentionInputs(sqlite, inputs, recordedAt));
  }

  async saveCommitmentCandidates(
    candidates: readonly CommitmentCandidate[]
  ): Promise<CommitmentCandidateWriteResult> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const accepted: CommitmentCandidate[] = [];
      const duplicates: CommitmentCandidate[] = [];
      for (const raw of candidates) {
        const candidate = CommitmentCandidateSchema.parse(raw);
        const existing = readCommitmentCandidateByReplayKey(sqlite, candidate.replay_key);
        if (existing && existing.commitment_id !== candidate.commitment_id) {
          duplicates.push(existing);
          continue;
        }
        if (existing && candidate.updated_at <= existing.updated_at) {
          accepted.push(existing);
          continue;
        }
        appendRuntimeEventEnvelopeInTransaction(sqlite, runtimeEventFromAttentionCommitment({
          operation: "candidate_saved",
          candidate,
          previousCandidate: existing,
        }));
        upsertCommitmentCandidate(sqlite, candidate);
        accepted.push(candidate);
      }
      return { accepted, duplicates };
    });
  }

  async listCommitmentCandidates(
    options: CommitmentCandidateListOptions = {}
  ): Promise<CommitmentCandidate[]> {
    const db = await this.database();
    return db.read((sqlite) => listCommitmentCandidates(sqlite, options));
  }

  async applyCommitmentControl(input: {
    commitmentId: string;
    control: CommitmentLifecycleControl;
    now: string;
    feedbackRef?: string | null;
    snoozeUntil?: string | null;
    reason?: string;
  }): Promise<CommitmentCandidate | null> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const existing = readCommitmentCandidate(sqlite, input.commitmentId);
      if (!existing) return null;
      const updated = applyCommitmentLifecycleControl({
        candidate: existing,
        control: input.control,
        now: input.now,
        feedbackRef: input.feedbackRef,
        snoozeUntil: input.snoozeUntil,
        reason: input.reason,
      });
      appendRuntimeEventEnvelopeInTransaction(sqlite, runtimeEventFromAttentionCommitment({
        operation: "lifecycle_control_applied",
        candidate: updated,
        previousCandidate: existing,
        control: input.control,
        feedbackRef: input.feedbackRef,
        occurredAt: input.now,
      }));
      upsertCommitmentCandidate(sqlite, updated);
      return updated;
    });
  }

  async listAttentionInputs(): Promise<AttentionInput[]> {
    const db = await this.database();
    return db.read((sqlite) => listAttentionInputs(sqlite));
  }

  async loadDecisionChainSnapshot(
    options: AttentionAgendaListOptions = {}
  ): Promise<AttentionDecisionChainSnapshot> {
    const db = await this.database();
    return db.read((sqlite) => ({
      attention_inputs: listAttentionInputs(sqlite),
      signal_contexts: listJsonColumn<SignalContext>(
        sqlite,
        "attention_signal_contexts",
        "context_json",
        "assembled_at ASC, signal_context_id ASC",
        SignalContextSchema,
      ),
      urge_candidates: listJsonColumn<UrgeCandidate>(
        sqlite,
        "attention_urge_candidates",
        "urge_json",
        "updated_at ASC, urge_id ASC",
        UrgeCandidateSchema,
      ),
      agenda_items: listAgendaItems(sqlite, options),
      inhibition_decisions: listJsonColumn<InhibitionDecision>(
        sqlite,
        "attention_inhibition_decisions",
        "decision_json",
        "decided_at ASC, decision_id ASC",
        InhibitionDecisionSchema,
      ),
      initiative_gate_decisions: listJsonColumn<InitiativeGateDecision>(
        sqlite,
        "attention_initiative_gate_decisions",
        "decision_json",
        "decided_at ASC, decision_id ASC",
        InitiativeGateDecisionSchema,
      ),
      outcome_decisions: listJsonColumn<OutcomeDecision>(
        sqlite,
        "attention_outcome_decisions",
        "decision_json",
        "decided_at ASC, outcome_decision_id ASC",
        OutcomeDecisionSchema,
      ),
      expression_decisions: listJsonColumn<ExpressionDecision>(
        sqlite,
        "attention_expression_decisions",
        "decision_json",
        "created_at ASC, expression_decision_id ASC",
        ExpressionDecisionSchema,
      ),
    }));
  }

  async loadDecisionChainSnapshotStrict(
    options: AttentionAgendaListOptions = {}
  ): Promise<AttentionDecisionChainSnapshot> {
    const db = await this.database();
    return db.read((sqlite) => ({
      attention_inputs: listAttentionInputsStrict(sqlite),
      signal_contexts: listJsonColumnStrict<SignalContext>(
        sqlite,
        "attention_signal_contexts",
        "context_json",
        "assembled_at ASC, signal_context_id ASC",
        SignalContextSchema,
      ),
      urge_candidates: listJsonColumnStrict<UrgeCandidate>(
        sqlite,
        "attention_urge_candidates",
        "urge_json",
        "updated_at ASC, urge_id ASC",
        UrgeCandidateSchema,
      ),
      agenda_items: listAgendaItemsStrict(sqlite, options),
      inhibition_decisions: listJsonColumnStrict<InhibitionDecision>(
        sqlite,
        "attention_inhibition_decisions",
        "decision_json",
        "decided_at ASC, decision_id ASC",
        InhibitionDecisionSchema,
      ),
      initiative_gate_decisions: listJsonColumnStrict<InitiativeGateDecision>(
        sqlite,
        "attention_initiative_gate_decisions",
        "decision_json",
        "decided_at ASC, decision_id ASC",
        InitiativeGateDecisionSchema,
      ),
      outcome_decisions: listJsonColumnStrict<OutcomeDecision>(
        sqlite,
        "attention_outcome_decisions",
        "decision_json",
        "decided_at ASC, outcome_decision_id ASC",
        OutcomeDecisionSchema,
      ),
      expression_decisions: listJsonColumnStrict<ExpressionDecision>(
        sqlite,
        "attention_expression_decisions",
        "decision_json",
        "created_at ASC, expression_decision_id ASC",
        ExpressionDecisionSchema,
      ),
    }));
  }

  async loadConcernState(
    options: AttentionConcernStateLoadOptions = {}
  ): Promise<AttentionConcernStateSnapshot> {
    const db = await this.database();
    return db.read((sqlite) => {
      const key = options.scope ? scopeKey(options.scope) : null;
      return {
        clusters: listConcernClusters(sqlite, key),
        agenda_items: listAgendaItems(sqlite, {
          includeSuppressed: true,
          includeTerminal: false,
          scopeKey: key,
        }),
        decompositions: listConcernDecompositions(sqlite, key),
      };
    });
  }

  async loadConcernStateForScope(scope: AttentionScope): Promise<AttentionConcernStateSnapshot> {
    return this.loadConcernState({ scope });
  }

  async listCurrentAgendaItems(options: AttentionAgendaListOptions = {}): Promise<AgentAgendaItem[]> {
    const db = await this.database();
    return db.read((sqlite) => listAgendaItems(sqlite, options));
  }

  async listAdmissionProposals(
    options: AttentionAdmissionProposalListOptions = {}
  ): Promise<AttentionAdmissionProposalRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listAdmissionProposals(sqlite, options));
  }

  async listCycleResults(): Promise<Array<{
    cycle_id: string;
    scope_key: string;
    projection_revision: number;
    write_disposition: AttentionMetabolismWriteDisposition;
    result: Record<string, unknown>;
  }>> {
    const db = await this.database();
    return db.read((sqlite) =>
      (sqlite.prepare(`
        SELECT cycle_id, scope_key, projection_revision, write_disposition, result_json
        FROM attention_cycle_results
        ORDER BY created_at ASC, cycle_id ASC
      `).all() as Array<{
        cycle_id: string;
        scope_key: string;
        projection_revision: number;
        write_disposition: AttentionMetabolismWriteDisposition;
        result_json: string;
      }>).map((row) => ({
        cycle_id: row.cycle_id,
        scope_key: row.scope_key,
        projection_revision: row.projection_revision,
        write_disposition: row.write_disposition,
        result: JSON.parse(row.result_json) as Record<string, unknown>,
      }))
    );
  }

  async markAdmissionProposalState(input: {
    proposalId: string;
    state: AttentionAdmissionCandidate["proposalState"];
    updatedAt: string;
    runtimeOperationId?: string | null;
  }): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        UPDATE attention_admission_proposals
        SET state = ?,
          runtime_operation_id = COALESCE(?, runtime_operation_id),
          updated_at = ?,
          proposal_json = json_set(proposal_json, '$.proposalState', ?)
        WHERE proposal_id = ?
          AND (
            state NOT IN ('confirmed', 'terminal')
            OR (state = 'confirmed' AND ? = 'terminal')
          )
      `).run(
        input.state,
        input.runtimeOperationId ?? null,
        input.updatedAt,
        input.state,
        input.proposalId,
        input.state,
      );
    });
  }

  async reconcileAdmissionProposals(input: {
    orphanBefore: string;
    updatedAt: string;
  }): Promise<{ orphaned_count: number; proposal_ids: string[] }> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT proposal_id
        FROM attention_admission_proposals
        WHERE state IN ('pending_handoff', 'handed_off')
          AND updated_at < ?
        ORDER BY updated_at ASC, proposal_id ASC
      `).all(input.orphanBefore) as Array<{ proposal_id: string }>;
      for (const row of rows) {
        sqlite.prepare(`
          UPDATE attention_admission_proposals
          SET state = 'orphaned_needs_reconcile',
            updated_at = ?,
            proposal_json = json_set(proposal_json, '$.proposalState', 'orphaned_needs_reconcile')
          WHERE proposal_id = ?
        `).run(input.updatedAt, row.proposal_id);
      }
      return {
        orphaned_count: rows.length,
        proposal_ids: rows.map((row) => row.proposal_id),
      };
    });
  }

  async listPendingBlocks(scope?: AttentionScope): Promise<AttentionPendingBlockRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listPendingBlocks(sqlite, scope ? scopeKey(scope) : null));
  }

  async clearPendingBlocks(input: {
    scope: AttentionScope;
    clearedAt: string;
    reason: string;
    triggerKinds?: readonly string[];
  }): Promise<AttentionPendingBlockClearResult> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const key = scopeKey(input.scope);
      const rows = listPendingBlocks(sqlite, key)
        .filter((block) => input.triggerKinds ? input.triggerKinds.includes(block.trigger_kind) : true);
      for (const row of rows) {
        sqlite.prepare(`
          UPDATE attention_pending_blocks
          SET cleared_at = ?,
            reason = ?
          WHERE block_id = ?
        `).run(input.clearedAt, input.reason, row.block_id);
      }
      return {
        cleared_count: rows.length,
        block_ids: rows.map((row) => row.block_id),
      };
    });
  }

  async projectionRevision(scope: AttentionScope): Promise<number> {
    const db = await this.database();
    return db.read((sqlite) => readProjectionRevision(sqlite, scopeKey(scope)));
  }

  async saveMetabolismCycle(
    input: AttentionMetabolismCycleWriteInput
  ): Promise<AttentionMetabolismCycleWriteResult> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const key = scopeKey(input.scope);
      const scopedIdempotencyKey = `${key}:${input.idempotency_key}`;
      const existingCycle = sqlite.prepare(`
        SELECT projection_revision, write_disposition, trigger_kind
        FROM attention_cycle_results
        WHERE idempotency_key = ?
      `).get(scopedIdempotencyKey) as {
        projection_revision: number;
        write_disposition: AttentionMetabolismWriteDisposition;
        trigger_kind: string;
      } | undefined;
      const currentRevision = readProjectionRevision(sqlite, key);
      if (existingCycle && existingCycle.write_disposition !== "stale_rejected") {
        return {
          writeDisposition: "no_op_elided",
          projectionRevision: existingCycle.projection_revision,
          replayedTriggerKind: existingCycle.trigger_kind,
        };
      }
      if (currentRevision !== input.expected_projection_revision) {
        if (!existingCycle) {
          appendCycleResult(sqlite, {
            cycle_id: input.cycle_id,
            idempotency_key: scopedIdempotencyKey,
            trigger_kind: input.trigger_kind,
            scope_key: key,
            projection_revision: currentRevision,
            write_disposition: "stale_rejected",
            created_at: input.created_at,
            result: {
              ...input.result,
              stale_rejected: true,
              expected_projection_revision: input.expected_projection_revision,
              current_projection_revision: currentRevision,
            },
          });
        }
        return {
          writeDisposition: "stale_rejected",
          projectionRevision: currentRevision,
        };
      }
      if (existingCycle?.write_disposition === "stale_rejected") {
        deleteCycleResultByIdempotencyKey(sqlite, scopedIdempotencyKey);
      }

      const nextRevision = currentRevision + 1;
      const clusters = input.clusters.filter((cluster) => scopeKey(cluster.scope) === key);
      const agendaItems = input.agendaItems.filter((item) => scopeKey(item.scope) === key);
      const decompositions = input.decompositions.filter((decomposition) => scopeKey(decomposition.scope) === key);
      const admissionProposals = (input.admissionProposals ?? [])
        .filter((proposal) => scopeKey(proposal.scope) === key);
      for (const event of input.events ?? []) appendAttentionEvent(sqlite, event);
      for (const cluster of clusters) upsertAttentionCluster(sqlite, cluster, nextRevision);
      for (const item of agendaItems) {
        upsertCurrentAgenda(sqlite, item, nextRevision);
      }
      for (const decomposition of decompositions) upsertDecomposition(sqlite, decomposition, nextRevision);
      for (const proposal of admissionProposals) upsertAdmissionProposal(sqlite, proposal, input.created_at);
      upsertWatermark(sqlite, {
        scope_key: key,
        projection_revision: nextRevision,
        high_watermarks: input.source_high_watermarks,
        last_noop_hash: input.no_op_hash ?? null,
        updated_at: input.created_at,
      });
      appendCycleResult(sqlite, {
        cycle_id: input.cycle_id,
        idempotency_key: scopedIdempotencyKey,
        trigger_kind: input.trigger_kind,
        scope_key: key,
        projection_revision: nextRevision,
        write_disposition: "written",
        created_at: input.created_at,
        result: input.result,
      });
      for (const block of input.pendingBlocks ?? []) {
        if (scopeKey(block.scope) === key) upsertPendingBlock(sqlite, block);
      }

      return {
        writeDisposition: "written",
        projectionRevision: nextRevision,
      };
    });
  }

  async addPendingBlock(input: {
    blockId?: string;
    scope: AttentionScope;
    triggerKind: string;
    reason: string;
    createdAt: string;
  }): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => upsertPendingBlock(sqlite, input));
  }

  async listPendingBlockScopeKeys(): Promise<string[]> {
    const db = await this.database();
    return db.read((sqlite) =>
      (sqlite.prepare(`
        SELECT DISTINCT scope_key
        FROM attention_pending_blocks
        WHERE cleared_at IS NULL
        ORDER BY scope_key ASC
      `).all() as Array<{ scope_key: string }>).map((row) => row.scope_key)
    );
  }

  async listAgendaItems(options: AttentionAgendaListOptions = {}): Promise<AgentAgendaItem[]> {
    const db = await this.database();
    return db.read((sqlite) => listAgendaItems(sqlite, options));
  }

  async listRuntimeItems(now: string): Promise<RuntimeItem[]> {
    return runtimeItemsForAgenda(await this.listAgendaItems({
      includeSuppressed: true,
      includeTerminal: false,
    }), now);
  }

  async listRuntimeItemsStrict(now: string): Promise<RuntimeItem[]> {
    return runtimeItemsForAgenda(await this.listAgendaItemsStrict({
      includeSuppressed: true,
      includeTerminal: false,
    }), now);
  }

  async suppressAgendaForControl(
    input: AttentionAgendaSuppressionInput
  ): Promise<AttentionAgendaSuppressionResult> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const now = input.now ?? new Date().toISOString();
      const items = listAgendaItems(sqlite, { includeSuppressed: false, includeTerminal: false })
        .filter((item) => agendaMatchesControl(item, input.control));
      const suppressed = items.map((item) => suppressAgendaItem(item, {
        now,
        reason: input.reason,
        auditRef: input.auditRef,
      }));
      for (const item of suppressed) {
        upsertAgendaItem(sqlite, item, {
          suppressedAt: now,
          suppressionReason: input.reason,
        });
        updateCurrentAgendaItemIfPresent(sqlite, item);
      }
      return {
        suppressed_count: suppressed.length,
        agenda_item_ids: suppressed.map((item) => item.agenda_item_id),
      };
    });
  }

  async invalidateRefs(input: AttentionInvalidationInput): Promise<AttentionInvalidationResult> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const now = input.now ?? new Date().toISOString();
      const staleKeys = new Set(input.refs.map(refKey));
      const items = listAgendaItems(sqlite, { includeSuppressed: true, includeTerminal: false })
        .filter((item) => agendaReferencesAny(item, staleKeys));
      const invalidated = items.map((item) => invalidateAgendaItem(item, {
        now,
        reason: input.reason,
        auditRef: input.auditRef,
      }));
      for (const item of invalidated) {
        upsertAgendaItem(sqlite, item);
        updateCurrentAgendaItemIfPresent(sqlite, item);
      }
      return {
        invalidated_count: invalidated.length,
        agenda_item_ids: invalidated.map((item) => item.agenda_item_id),
      };
    });
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }

  private async listAgendaItemsStrict(options: AttentionAgendaListOptions = {}): Promise<AgentAgendaItem[]> {
    const db = await this.database();
    return db.read((sqlite) => listAgendaItemsStrict(sqlite, options));
  }
}

function listAttentionInputs(sqlite: SqliteDatabase): AttentionInput[] {
  return listJsonColumn<AttentionInput>(
    sqlite,
    "attention_inputs",
    "input_json",
    "emitted_at ASC, attention_input_id ASC",
    AttentionInputSchema,
  );
}

function listAttentionInputsStrict(sqlite: SqliteDatabase): AttentionInput[] {
  return listJsonColumnStrict<AttentionInput>(
    sqlite,
    "attention_inputs",
    "input_json",
    "emitted_at ASC, attention_input_id ASC",
    AttentionInputSchema,
  );
}

function readProjectionRevision(sqlite: SqliteDatabase, key: string): number {
  const row = sqlite.prepare(`
    SELECT projection_revision
    FROM attention_cycle_watermarks
    WHERE scope_key = ?
  `).get(key) as { projection_revision: number } | undefined;
  return row?.projection_revision ?? 0;
}

function appendAttentionEvent(sqlite: SqliteDatabase, event: AttentionEventLedgerRecord): void {
  sqlite.prepare(`
    INSERT INTO attention_event_ledger (
      event_id,
      event_type,
      scope_key,
      policy_epoch,
      model_or_classifier_version,
      experiment_id,
      mode,
      occurred_at,
      compactable,
      critical,
      event_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    event.event_id,
    event.event_type,
    scopeKey(event.scope),
    event.policy_epoch,
    event.model_or_classifier_version ?? null,
    event.experiment_id ?? null,
    event.mode,
    event.occurred_at,
    event.compactable ?? false ? 1 : 0,
    event.critical ?? false ? 1 : 0,
    JSON.stringify(event.event)
  );
}

function upsertAttentionCluster(
  sqlite: SqliteDatabase,
  raw: AttentionCluster,
  projectionRevision: number
): void {
  const cluster = AttentionClusterSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_current_clusters (
      cluster_id,
      lifecycle,
      scope_key,
      policy_epoch,
      projection_revision,
      updated_at,
      cluster_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(cluster_id) DO UPDATE SET
      lifecycle = excluded.lifecycle,
      scope_key = excluded.scope_key,
      policy_epoch = excluded.policy_epoch,
      projection_revision = excluded.projection_revision,
      updated_at = excluded.updated_at,
      cluster_json = excluded.cluster_json
  `).run(
    cluster.id,
    cluster.lifecycle,
    scopeKey(cluster.scope),
    cluster.scope.policyEpoch,
    projectionRevision,
    cluster.updatedAt,
    JSON.stringify(cluster)
  );
}

function upsertCurrentAgenda(
  sqlite: SqliteDatabase,
  raw: AgentAgendaItem,
  projectionRevision: number
): void {
  const item = AgentAgendaItemSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_current_agenda (
      agenda_item_id,
      cluster_id,
      status,
      scope_key,
      policy_epoch,
      projection_revision,
      updated_at,
      agenda_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(agenda_item_id) DO UPDATE SET
      cluster_id = excluded.cluster_id,
      status = excluded.status,
      scope_key = excluded.scope_key,
      policy_epoch = excluded.policy_epoch,
      projection_revision = excluded.projection_revision,
      updated_at = excluded.updated_at,
      agenda_json = excluded.agenda_json
  `).run(
    item.agenda_item_id,
    item.clusterRef?.id ?? null,
    item.current_posture,
    scopeKey(item.scope),
    item.policyEpoch,
    projectionRevision,
    item.updated_at,
    JSON.stringify(item)
  );
}

function updateCurrentAgendaItemIfPresent(
  sqlite: SqliteDatabase,
  raw: AgentAgendaItem,
): void {
  const item = AgentAgendaItemSchema.parse(raw);
  sqlite.prepare(`
    UPDATE attention_current_agenda
    SET cluster_id = ?,
      status = ?,
      scope_key = ?,
      policy_epoch = ?,
      updated_at = ?,
      agenda_json = json(?)
    WHERE agenda_item_id = ?
  `).run(
    item.clusterRef?.id ?? null,
    item.current_posture,
    scopeKey(item.scope),
    item.policyEpoch,
    item.updated_at,
    JSON.stringify(item),
    item.agenda_item_id
  );
}

function upsertDecomposition(
  sqlite: SqliteDatabase,
  raw: AgendaDecomposition,
  projectionRevision: number
): void {
  const decomposition = AgendaDecompositionSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_decompositions (
      decomposition_id,
      agenda_item_id,
      cluster_id,
      status,
      scope_key,
      policy_epoch,
      projection_revision,
      updated_at,
      decomposition_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(decomposition_id) DO UPDATE SET
      agenda_item_id = excluded.agenda_item_id,
      cluster_id = excluded.cluster_id,
      status = excluded.status,
      scope_key = excluded.scope_key,
      policy_epoch = excluded.policy_epoch,
      projection_revision = excluded.projection_revision,
      updated_at = excluded.updated_at,
      decomposition_json = excluded.decomposition_json
  `).run(
    decomposition.id,
    decomposition.agendaRef.id,
    decomposition.clusterRef.id,
    decomposition.status,
    scopeKey(decomposition.scope),
    decomposition.scope.policyEpoch,
    projectionRevision,
    decomposition.updatedAt,
    JSON.stringify(decomposition)
  );
}

function upsertAdmissionProposal(
  sqlite: SqliteDatabase,
  raw: AttentionAdmissionCandidate,
  updatedAt: string
): void {
  sqlite.prepare(`
    INSERT INTO attention_admission_proposals (
      proposal_id,
      child_id,
      idempotency_key,
      state,
      runtime_operation_id,
      created_at,
      updated_at,
      proposal_json
    )
    VALUES (?, ?, ?, ?, NULL, ?, ?, json(?))
    ON CONFLICT(proposal_id) DO UPDATE SET
      state = CASE
        WHEN attention_admission_proposals.state IN ('confirmed', 'terminal')
          THEN attention_admission_proposals.state
        ELSE excluded.state
      END,
      child_id = excluded.child_id,
      idempotency_key = excluded.idempotency_key,
      runtime_operation_id = CASE
        WHEN attention_admission_proposals.state IN ('confirmed', 'terminal')
          THEN attention_admission_proposals.runtime_operation_id
        ELSE NULL
      END,
      updated_at = excluded.updated_at,
      proposal_json = CASE
        WHEN attention_admission_proposals.state IN ('confirmed', 'terminal')
          THEN attention_admission_proposals.proposal_json
        ELSE excluded.proposal_json
      END
  `).run(
    raw.candidateId,
    raw.child.id,
    raw.idempotencyKey,
    raw.proposalState,
    raw.createdAt,
    updatedAt,
    JSON.stringify(raw),
  );
}

function listAdmissionProposals(
  sqlite: SqliteDatabase,
  options: AttentionAdmissionProposalListOptions,
): AttentionAdmissionProposalRecord[] {
  const states = options.states ?? [];
  const where = states.length > 0
    ? `WHERE state IN (${states.map(() => "?").join(", ")})`
    : "";
  const rows = sqlite.prepare(`
    SELECT proposal_id, child_id, idempotency_key, state, runtime_operation_id, created_at, updated_at, proposal_json
    FROM attention_admission_proposals
    ${where}
    ORDER BY updated_at ASC, proposal_id ASC
  `).all(...states) as Array<{
    proposal_id: string;
    child_id: string;
    idempotency_key: string;
    state: AttentionAdmissionCandidate["proposalState"];
    runtime_operation_id: string | null;
    created_at: string;
    updated_at: string;
    proposal_json: string;
  }>;
  return rows.flatMap((row) => {
    try {
      return [{
        proposal_id: row.proposal_id,
        child_id: row.child_id,
        idempotency_key: row.idempotency_key,
        state: row.state,
        runtime_operation_id: row.runtime_operation_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        proposal: JSON.parse(row.proposal_json) as AttentionAdmissionCandidate,
      }];
    } catch {
      return [];
    }
  });
}

function listPendingBlocks(sqlite: SqliteDatabase, key: string | null): AttentionPendingBlockRecord[] {
  const rows = sqlite.prepare(`
    SELECT block_id, scope_key, trigger_kind, reason, created_at, cleared_at
    FROM attention_pending_blocks
    WHERE cleared_at IS NULL
      ${key ? "AND scope_key = ?" : ""}
    ORDER BY created_at ASC, block_id ASC
  `).all(...(key ? [key] : [])) as AttentionPendingBlockRecord[];
  return rows;
}

function upsertPendingBlock(sqlite: SqliteDatabase, input: AttentionPendingBlockWriteInput): void {
  sqlite.prepare(`
    INSERT INTO attention_pending_blocks (
      block_id,
      scope_key,
      trigger_kind,
      reason,
      created_at,
      cleared_at
    )
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(block_id) DO UPDATE SET
      reason = excluded.reason,
      cleared_at = NULL
  `).run(
    input.blockId ?? `attention-block:${stableId(`${scopeKey(input.scope)}:${input.triggerKind}`)}`,
    scopeKey(input.scope),
    input.triggerKind,
    input.reason,
    input.createdAt,
  );
}

function upsertWatermark(
  sqlite: SqliteDatabase,
  input: {
    scope_key: string;
    projection_revision: number;
    high_watermarks: readonly string[];
    last_noop_hash: string | null;
    updated_at: string;
  }
): void {
  sqlite.prepare(`
    INSERT INTO attention_cycle_watermarks (
      scope_key,
      projection_revision,
      last_high_watermarks_json,
      last_noop_hash,
      updated_at
    )
    VALUES (?, ?, json(?), ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      projection_revision = excluded.projection_revision,
      last_high_watermarks_json = excluded.last_high_watermarks_json,
      last_noop_hash = excluded.last_noop_hash,
      updated_at = excluded.updated_at
  `).run(
    input.scope_key,
    input.projection_revision,
    JSON.stringify(input.high_watermarks),
    input.last_noop_hash,
    input.updated_at
  );
}

function appendCycleResult(
  sqlite: SqliteDatabase,
  input: {
    cycle_id: string;
    idempotency_key: string;
    trigger_kind: string;
    scope_key: string;
    projection_revision: number;
    write_disposition: AttentionMetabolismWriteDisposition;
    created_at: string;
    result: Record<string, unknown>;
  }
): void {
  sqlite.prepare(`
    INSERT INTO attention_cycle_results (
      cycle_id,
      idempotency_key,
      trigger_kind,
      scope_key,
      projection_revision,
      write_disposition,
      created_at,
      result_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(
    input.cycle_id,
    input.idempotency_key,
    input.trigger_kind,
    input.scope_key,
    input.projection_revision,
    input.write_disposition,
    input.created_at,
    JSON.stringify(input.result)
  );
}

function deleteCycleResultByIdempotencyKey(sqlite: SqliteDatabase, idempotencyKey: string): void {
  sqlite.prepare(`
    DELETE FROM attention_cycle_results
    WHERE idempotency_key = ?
      AND write_disposition = 'stale_rejected'
  `).run(idempotencyKey);
}

function appendAttentionInputs(
  sqlite: SqliteDatabase,
  inputs: readonly AttentionInput[],
  recordedAt = new Date().toISOString()
): AttentionInputIntakeResult {
  const parsedInputs = inputs.map((input) => AttentionInputSchema.parse(input));
  const existingRows = sqlite.prepare(`
    SELECT input_json
    FROM attention_inputs
    WHERE replay_key IN (${parsedInputs.map(() => "?").join(",") || "NULL"})
  `).all(...parsedInputs.map((input) => input.source.replay_key)) as Array<{ input_json: string }>;
  const previouslySeen = new Map<string, AttentionInput>();
  for (const row of existingRows) {
    const parsed = parseStored<AttentionInput>(row.input_json, AttentionInputSchema)[0];
    if (parsed) previouslySeen.set(parsed.source.replay_key, parsed);
  }
  const intake = dedupeAttentionInputs(parsedInputs, previouslySeen);

  for (const record of intake.records) {
    if (record.disposition === "accepted") {
      upsertAttentionInput(sqlite, record.input, record.disposition);
    }
    appendAttentionReplayRecord(sqlite, record, recordedAt);
  }

  return intake;
}

function upsertCommitmentCandidate(sqlite: SqliteDatabase, raw: CommitmentCandidate): void {
  const candidate = CommitmentCandidateSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_commitment_candidates (
      commitment_id,
      source_ref,
      target_ref,
      replay_key,
      source_epoch,
      source_high_watermark,
      policy_epoch,
      scope_key,
      lifecycle,
      nudge_policy,
      materialization_id,
      next_revisit_at,
      due_start,
      due_end,
      priority_score,
      suppression_ref_count,
      feedback_ref_count,
      created_at,
      updated_at,
      candidate_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(commitment_id) DO UPDATE SET
      source_ref = excluded.source_ref,
      target_ref = excluded.target_ref,
      replay_key = excluded.replay_key,
      source_epoch = excluded.source_epoch,
      source_high_watermark = excluded.source_high_watermark,
      policy_epoch = excluded.policy_epoch,
      scope_key = excluded.scope_key,
      lifecycle = excluded.lifecycle,
      nudge_policy = excluded.nudge_policy,
      materialization_id = excluded.materialization_id,
      next_revisit_at = excluded.next_revisit_at,
      due_start = excluded.due_start,
      due_end = excluded.due_end,
      priority_score = excluded.priority_score,
      suppression_ref_count = excluded.suppression_ref_count,
      feedback_ref_count = excluded.feedback_ref_count,
      updated_at = excluded.updated_at,
      candidate_json = excluded.candidate_json
  `).run(
    candidate.commitment_id,
    refKey(candidate.source_ref),
    refKey(candidate.target_ref),
    candidate.replay_key,
    candidate.source_epoch,
    candidate.source_high_watermark,
    candidate.policy_epoch,
    scopeKey(candidate.scope),
    candidate.materialization_state,
    candidate.nudge_policy,
    candidate.materialization_id,
    candidate.next_revisit_at,
    candidate.due.window_start,
    candidate.due.window_end,
    candidate.priority_evidence.total_score ?? null,
    candidate.suppression_refs.length,
    candidate.feedback_refs.length,
    candidate.created_at,
    candidate.updated_at,
    JSON.stringify(candidate)
  );
}

function readCommitmentCandidate(sqlite: SqliteDatabase, commitmentId: string): CommitmentCandidate | null {
  const row = sqlite.prepare(`
    SELECT candidate_json
    FROM attention_commitment_candidates
    WHERE commitment_id = ?
  `).get(commitmentId) as { candidate_json: string } | undefined;
  return row ? parseStored<CommitmentCandidate>(row.candidate_json, CommitmentCandidateSchema)[0] ?? null : null;
}

function readCommitmentCandidateByReplayKey(sqlite: SqliteDatabase, replayKey: string): CommitmentCandidate | null {
  const row = sqlite.prepare(`
    SELECT candidate_json
    FROM attention_commitment_candidates
    WHERE replay_key = ?
  `).get(replayKey) as { candidate_json: string } | undefined;
  return row ? parseStored<CommitmentCandidate>(row.candidate_json, CommitmentCandidateSchema)[0] ?? null : null;
}

function listCommitmentCandidates(
  sqlite: SqliteDatabase,
  options: CommitmentCandidateListOptions,
): CommitmentCandidate[] {
  const states = options.states ?? [];
  const params: unknown[] = [];
  const where: string[] = [];
  if (options.scope) {
    where.push("scope_key = ?");
    params.push(scopeKey(options.scope));
  }
  if (states.length > 0) {
    where.push(`lifecycle IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  } else if (!options.includeTerminal) {
    where.push("lifecycle NOT IN ('resolved', 'rejected', 'tombstoned')");
  }
  if (options.dueBefore) {
    where.push("(next_revisit_at IS NOT NULL AND next_revisit_at <= ?)");
    params.push(options.dueBefore);
  }
  const rows = sqlite.prepare(`
    SELECT candidate_json
    FROM attention_commitment_candidates
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at ASC, commitment_id ASC
  `).all(...params) as Array<{ candidate_json: string }>;
  return rows.flatMap((row) => parseStored<CommitmentCandidate>(row.candidate_json, CommitmentCandidateSchema));
}

function upsertAttentionInput(
  sqlite: SqliteDatabase,
  input: AttentionInput,
  disposition: AttentionInputIntakeRecord["disposition"]
): void {
  sqlite.prepare(`
    INSERT INTO attention_inputs (
      attention_input_id,
      source_kind,
      source_id,
      source_epoch,
      high_watermark,
      replay_key,
      emitted_at,
      replay_disposition,
      lifecycle,
      suppressed_at,
      cooldown_until,
      revisit_due_at,
      stale_ref_count,
      invalidation_ref_count,
      audit_ref_count,
      input_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(attention_input_id) DO UPDATE SET
      source_kind = excluded.source_kind,
      source_id = excluded.source_id,
      source_epoch = excluded.source_epoch,
      high_watermark = excluded.high_watermark,
      replay_key = excluded.replay_key,
      emitted_at = excluded.emitted_at,
      replay_disposition = excluded.replay_disposition,
      lifecycle = excluded.lifecycle,
      suppressed_at = excluded.suppressed_at,
      cooldown_until = excluded.cooldown_until,
      revisit_due_at = excluded.revisit_due_at,
      stale_ref_count = excluded.stale_ref_count,
      invalidation_ref_count = excluded.invalidation_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      input_json = excluded.input_json
  `).run(
    input.attention_input_id,
    input.source.source_kind,
    input.source.source_id,
    input.source.source_epoch,
    input.source.high_watermark,
    input.source.replay_key,
    input.source.emitted_at,
    disposition,
    attentionInputLifecycle(input),
    null,
    null,
    null,
    input.stale_refs.length,
    input.invalidation_refs.length,
    input.audit_refs.length,
    JSON.stringify(input)
  );
}

function appendAttentionReplayRecord(
  sqlite: SqliteDatabase,
  record: AttentionInputIntakeRecord,
  recordedAt: string
): void {
  sqlite.prepare(`
    INSERT INTO attention_input_replay_records (
      replay_record_id,
      attention_input_id,
      replay_key,
      disposition,
      duplicate_of,
      emitted_at,
      recorded_at,
      input_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
  `).run(
    randomUUID(),
    record.input.attention_input_id,
    record.input.source.replay_key,
    record.disposition,
    record.duplicate_of ?? null,
    record.input.source.emitted_at,
    recordedAt,
    JSON.stringify(record.input)
  );
}

function upsertSignalContext(
  sqlite: SqliteDatabase,
  context: SignalContext,
  attentionInputs: readonly AttentionInput[]
): void {
  sqlite.prepare(`
    INSERT INTO attention_signal_contexts (
      signal_context_id,
      assembled_at,
      source_replay_keys_json,
      stale_ref_count,
      invalidation_ref_count,
      audit_ref_count,
      context_json
    )
    VALUES (?, ?, json(?), ?, ?, ?, json(?))
    ON CONFLICT(signal_context_id) DO UPDATE SET
      assembled_at = excluded.assembled_at,
      source_replay_keys_json = excluded.source_replay_keys_json,
      stale_ref_count = excluded.stale_ref_count,
      invalidation_ref_count = excluded.invalidation_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      context_json = excluded.context_json
  `).run(
    context.signal_context_id,
    context.assembled_at,
    JSON.stringify(attentionInputs.map((input) => input.source.replay_key)),
    context.stale_target_context.stale_refs.length,
    context.stale_target_context.needs_regrounding_refs.length,
    context.audit_refs.length,
    JSON.stringify(context)
  );
}

function upsertUrgeCandidate(sqlite: SqliteDatabase, raw: UrgeCandidate): void {
  const urge = UrgeCandidateSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_urge_candidates (
      urge_id,
      origin,
      target_kind,
      target_id,
      maturation_state,
      lifecycle,
      created_at,
      updated_at,
      stale_ref_count,
      audit_ref_count,
      urge_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(urge_id) DO UPDATE SET
      origin = excluded.origin,
      target_kind = excluded.target_kind,
      target_id = excluded.target_id,
      maturation_state = excluded.maturation_state,
      lifecycle = excluded.lifecycle,
      updated_at = excluded.updated_at,
      stale_ref_count = excluded.stale_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      urge_json = excluded.urge_json
  `).run(
    urge.urge_id,
    urge.origin,
    urge.target.kind,
    urge.target.id,
    urge.maturation.state,
    lifecycleForMaturation(urge.maturation.state),
    urge.maturation.first_seen_at,
    urge.maturation.last_reinforced_at ?? urge.maturation.first_seen_at,
    urge.evidence_refs.filter((source) => source.lifecycle !== "active").length,
    urge.audit_refs.length,
    JSON.stringify(urge)
  );
}

function upsertAgendaItem(
  sqlite: SqliteDatabase,
  raw: AgentAgendaItem,
  options: { suppressedAt?: string | null; suppressionReason?: string | null; cooldownUntil?: string | null } = {}
): void {
  const item = AgentAgendaItemSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_agenda_items (
      agenda_item_id,
      kind,
      origin,
      current_posture,
      control_state,
      lifecycle,
      staleness_state,
      revisit_kind,
      revisit_due_at,
      suppressed_at,
      suppression_reason,
      cooldown_until,
      created_at,
      updated_at,
      stale_ref_count,
      invalidation_ref_count,
      audit_ref_count,
      agenda_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(agenda_item_id) DO UPDATE SET
      kind = excluded.kind,
      origin = excluded.origin,
      current_posture = excluded.current_posture,
      control_state = excluded.control_state,
      lifecycle = excluded.lifecycle,
      staleness_state = excluded.staleness_state,
      revisit_kind = excluded.revisit_kind,
      revisit_due_at = excluded.revisit_due_at,
      suppressed_at = excluded.suppressed_at,
      suppression_reason = excluded.suppression_reason,
      cooldown_until = excluded.cooldown_until,
      updated_at = excluded.updated_at,
      stale_ref_count = excluded.stale_ref_count,
      invalidation_ref_count = excluded.invalidation_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      agenda_json = excluded.agenda_json
  `).run(
    item.agenda_item_id,
    item.kind,
    item.origin,
    item.current_posture,
    item.control_state,
    lifecycleForAgenda(item),
    item.staleness_state,
    item.revisit_condition.kind,
    item.revisit_condition.due_at ?? null,
    options.suppressedAt ?? (item.control_state === "suppressed" ? item.updated_at : null),
    options.suppressionReason ?? null,
    options.cooldownUntil ?? null,
    item.created_at,
    item.updated_at,
    staleRefCountForAgenda(item),
    invalidationRefCountForAgenda(item),
    item.audit_refs.length,
    JSON.stringify(item)
  );
}

function upsertInhibitionDecision(sqlite: SqliteDatabase, raw: InhibitionDecision): void {
  const decision = InhibitionDecisionSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_inhibition_decisions (
      decision_id,
      target_ref,
      decision,
      decided_at,
      lifecycle,
      stale_ref_count,
      audit_ref_count,
      decision_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(decision_id) DO UPDATE SET
      target_ref = excluded.target_ref,
      decision = excluded.decision,
      decided_at = excluded.decided_at,
      lifecycle = excluded.lifecycle,
      stale_ref_count = excluded.stale_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      decision_json = excluded.decision_json
  `).run(
    decision.decision_id,
    refKey(decision.target_ref),
    decision.decision,
    decision.decided_at,
    decision.decision === "reject_stale" ? "stale" : decision.decision === "suppress" ? "suppressed" : "active",
    decision.evidence_refs.filter((source) => source.lifecycle !== "active").length,
    decision.audit_refs.length,
    JSON.stringify(decision)
  );
}

function upsertInitiativeGateDecision(sqlite: SqliteDatabase, raw: InitiativeGateDecision): void {
  const decision = InitiativeGateDecisionSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_initiative_gate_decisions (
      decision_id,
      status,
      decided_at,
      selected_outcome,
      lifecycle,
      stale_ref_count,
      audit_ref_count,
      decision_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(decision_id) DO UPDATE SET
      status = excluded.status,
      decided_at = excluded.decided_at,
      selected_outcome = excluded.selected_outcome,
      lifecycle = excluded.lifecycle,
      stale_ref_count = excluded.stale_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      decision_json = excluded.decision_json
  `).run(
    decision.decision_id,
    decision.status,
    decision.decided_at,
    decision.selected_outcome ?? null,
    decision.status === "blocked" ? "stale" : decision.status === "delayed" ? "held" : "active",
    decision.staleness_checks.filter((check) => check.status === "failed" || check.status === "unknown").length,
    decision.audit_refs.length,
    JSON.stringify(decision)
  );
}

function upsertOutcomeDecision(sqlite: SqliteDatabase, raw: OutcomeDecision): void {
  const decision = OutcomeDecisionSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_outcome_decisions (
      outcome_decision_id,
      initiative_decision_ref,
      admission_status,
      requested_outcome,
      final_outcome,
      decided_at,
      lifecycle,
      stale_ref_count,
      audit_ref_count,
      decision_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(outcome_decision_id) DO UPDATE SET
      initiative_decision_ref = excluded.initiative_decision_ref,
      admission_status = excluded.admission_status,
      requested_outcome = excluded.requested_outcome,
      final_outcome = excluded.final_outcome,
      decided_at = excluded.decided_at,
      lifecycle = excluded.lifecycle,
      stale_ref_count = excluded.stale_ref_count,
      audit_ref_count = excluded.audit_ref_count,
      decision_json = excluded.decision_json
  `).run(
    decision.outcome_decision_id,
    refKey(decision.initiative_decision_ref),
    decision.admission_status,
    decision.requested_outcome,
    decision.final_outcome ?? null,
    decision.decided_at,
    lifecycleForOutcome(decision),
    decision.staleness_checks.filter((check) => check.status === "failed" || check.status === "unknown").length,
    decision.audit_ref ? 1 : 0,
    JSON.stringify(decision)
  );
}

function upsertExpressionDecision(sqlite: SqliteDatabase, raw: ExpressionDecision): void {
  const decision = ExpressionDecisionSchema.parse(raw);
  sqlite.prepare(`
    INSERT INTO attention_expression_decisions (
      expression_decision_id,
      outcome_decision_ref,
      outcome_class,
      decision_status,
      created_at,
      lifecycle,
      audit_ref_count,
      decision_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(expression_decision_id) DO UPDATE SET
      outcome_decision_ref = excluded.outcome_decision_ref,
      outcome_class = excluded.outcome_class,
      decision_status = excluded.decision_status,
      created_at = excluded.created_at,
      lifecycle = excluded.lifecycle,
      audit_ref_count = excluded.audit_ref_count,
      decision_json = excluded.decision_json
  `).run(
    decision.expression_decision_id,
    refKey(decision.outcome_decision_ref),
    decision.outcome_class,
    decision.decision_status,
    decision.created_at,
    decision.decision_status === "withdrawn" ? "terminal" : decision.decision_status === "held" ? "held" : "active",
    decision.audit_ref ? 1 : 0,
    JSON.stringify(decision)
  );
}

function listAgendaItems(sqlite: SqliteDatabase, options: AttentionAgendaListOptions): AgentAgendaItem[] {
  if (options.forceLegacy) return listLegacyAgendaItems(sqlite, options);

  const currentAgenda = listCurrentAgendaItems(sqlite, { scopeKey: options.scopeKey ?? null });
  const legacyAgenda = listLegacyAgendaItems(sqlite, options);
  return mergeCurrentAndLegacyAgendaItems(currentAgenda, legacyAgenda, options);
}

function listAgendaItemsStrict(sqlite: SqliteDatabase, options: AttentionAgendaListOptions): AgentAgendaItem[] {
  if (options.forceLegacy) return listLegacyAgendaItemsStrict(sqlite, options);

  const currentAgenda = listCurrentAgendaItemsStrict(sqlite, { scopeKey: options.scopeKey ?? null });
  const legacyAgenda = listLegacyAgendaItemsStrict(sqlite, options);
  return mergeCurrentAndLegacyAgendaItems(currentAgenda, legacyAgenda, options);
}

function listLegacyAgendaItems(sqlite: SqliteDatabase, options: AttentionAgendaListOptions): AgentAgendaItem[] {
  const rows = sqlite.prepare(`
    SELECT lifecycle, agenda_json
    FROM attention_agenda_items
    ORDER BY updated_at ASC, agenda_item_id ASC
  `).all() as Array<{ lifecycle: AttentionStoreLifecycle; agenda_json: string }>;
  return rows.flatMap((row) => {
    if (!options.includeSuppressed && row.lifecycle === "suppressed") return [];
    if (!options.includeTerminal && (row.lifecycle === "terminal" || row.lifecycle === "stale")) return [];
    return parseStored<AgentAgendaItem>(row.agenda_json, AgentAgendaItemSchema)
      .filter((item) => !options.scopeKey || scopeKey(item.scope) === options.scopeKey);
  });
}

function listLegacyAgendaItemsStrict(sqlite: SqliteDatabase, options: AttentionAgendaListOptions): AgentAgendaItem[] {
  const rows = sqlite.prepare(`
    SELECT lifecycle, agenda_json
    FROM attention_agenda_items
    ORDER BY updated_at ASC, agenda_item_id ASC
  `).all() as Array<{ lifecycle: AttentionStoreLifecycle; agenda_json: string }>;
  return rows.flatMap((row, index) => {
    if (!options.includeSuppressed && row.lifecycle === "suppressed") return [];
    if (!options.includeTerminal && (row.lifecycle === "terminal" || row.lifecycle === "stale")) return [];
    const item = parseStoredStrict<AgentAgendaItem>(
      row.agenda_json,
      AgentAgendaItemSchema,
      `attention_agenda_items.agenda_json[${index}]`
    );
    return !options.scopeKey || scopeKey(item.scope) === options.scopeKey ? [item] : [];
  });
}

function mergeCurrentAndLegacyAgendaItems(
  currentAgenda: readonly AgentAgendaItem[],
  legacyAgenda: readonly AgentAgendaItem[],
  options: AttentionAgendaListOptions,
): AgentAgendaItem[] {
  if (currentAgenda.length === 0) return [...legacyAgenda];

  const legacyById = new Map(legacyAgenda.map((item) => [item.agenda_item_id, item]));
  const current = currentAgenda
    .map((item) => {
      const legacyMutation = legacyById.get(item.agenda_item_id);
      return shouldPreferLegacyAgendaMutation(item, legacyMutation) ? legacyMutation! : item;
    })
    .filter((item) => includeAgendaItem(item, options));
  if (options.scopeKey) return current;

  const currentScopeKeys = new Set(currentAgenda.map((item) => scopeKey(item.scope)));
  const currentItemIds = new Set(currentAgenda.map((item) => item.agenda_item_id));
  return [
    ...current,
    ...legacyAgenda.filter((item) =>
      !currentItemIds.has(item.agenda_item_id) && !currentScopeKeys.has(scopeKey(item.scope))
    ),
  ].sort(compareAgendaItems);
}

function shouldPreferLegacyAgendaMutation(
  current: AgentAgendaItem,
  legacy: AgentAgendaItem | undefined,
): boolean {
  if (!legacy) return false;
  if (legacy.updated_at.localeCompare(current.updated_at) <= 0) return false;
  const legacyLifecycle = lifecycleForAgenda(legacy);
  return legacyLifecycle === "suppressed" || legacyLifecycle === "stale" || legacyLifecycle === "terminal";
}

function compareAgendaItems(left: AgentAgendaItem, right: AgentAgendaItem): number {
  return left.updated_at.localeCompare(right.updated_at)
    || left.agenda_item_id.localeCompare(right.agenda_item_id);
}

function listCurrentAgendaItems(
  sqlite: SqliteDatabase,
  options: { scopeKey?: string | null } = {},
): AgentAgendaItem[] {
  const rows = sqlite.prepare(`
    SELECT agenda_json
    FROM attention_current_agenda
    ${options.scopeKey ? "WHERE scope_key = ?" : ""}
    ORDER BY updated_at ASC, agenda_item_id ASC
  `).all(...(options.scopeKey ? [options.scopeKey] : [])) as Array<{ agenda_json: string }>;
  return rows.flatMap((row) => parseStored<AgentAgendaItem>(row.agenda_json, AgentAgendaItemSchema));
}

function listCurrentAgendaItemsStrict(
  sqlite: SqliteDatabase,
  options: { scopeKey?: string | null } = {},
): AgentAgendaItem[] {
  const rows = sqlite.prepare(`
    SELECT agenda_json
    FROM attention_current_agenda
    ${options.scopeKey ? "WHERE scope_key = ?" : ""}
    ORDER BY updated_at ASC, agenda_item_id ASC
  `).all(...(options.scopeKey ? [options.scopeKey] : [])) as Array<{ agenda_json: string }>;
  return rows.map((row, index) => parseStoredStrict<AgentAgendaItem>(
    row.agenda_json,
    AgentAgendaItemSchema,
    `attention_current_agenda.agenda_json[${index}]`
  ));
}

function listConcernClusters(sqlite: SqliteDatabase, key: string | null): AttentionCluster[] {
  const rows = sqlite.prepare(`
    SELECT cluster_json
    FROM attention_current_clusters
    ${key ? "WHERE scope_key = ?" : ""}
    ORDER BY updated_at ASC, cluster_id ASC
  `).all(...(key ? [key] : [])) as Array<{ cluster_json: string }>;
  return rows.flatMap((row) => parseStored<AttentionCluster>(row.cluster_json, AttentionClusterSchema));
}

function listConcernDecompositions(sqlite: SqliteDatabase, key: string | null): AgendaDecomposition[] {
  const rows = sqlite.prepare(`
    SELECT decomposition_json
    FROM attention_decompositions
    ${key ? "WHERE scope_key = ?" : ""}
    ORDER BY updated_at ASC, decomposition_id ASC
  `).all(...(key ? [key] : [])) as Array<{ decomposition_json: string }>;
  return rows.flatMap((row) => parseStored<AgendaDecomposition>(row.decomposition_json, AgendaDecompositionSchema));
}

function includeAgendaItem(item: AgentAgendaItem, options: AttentionAgendaListOptions): boolean {
  const lifecycle = lifecycleForAgenda(item);
  if (!options.includeSuppressed && lifecycle === "suppressed") return false;
  if (!options.includeTerminal && (lifecycle === "terminal" || lifecycle === "stale")) return false;
  return true;
}

function listJsonColumn<T>(
  sqlite: SqliteDatabase,
  tableName: string,
  columnName: string,
  orderBy: string,
  schema: z.ZodType
): T[] {
  const rows = sqlite.prepare(`
    SELECT ${columnName} AS value_json
    FROM ${tableName}
    ORDER BY ${orderBy}
  `).all() as Array<{ value_json: string }>;
  return rows.flatMap((row) => parseStored<T>(row.value_json, schema));
}

function listJsonColumnStrict<T>(
  sqlite: SqliteDatabase,
  tableName: string,
  columnName: string,
  orderBy: string,
  schema: z.ZodType
): T[] {
  const rows = sqlite.prepare(`
    SELECT ${columnName} AS value_json
    FROM ${tableName}
    ORDER BY ${orderBy}
  `).all() as Array<{ value_json: string }>;
  return rows.map((row, index) => parseStoredStrict<T>(
    row.value_json,
    schema,
    `${tableName}.${columnName}[${index}]`
  ));
}

function parseStored<T>(json: string, schema: z.ZodType): T[] {
  try {
    const parsed = schema.safeParse(JSON.parse(json) as unknown);
    return parsed.success ? [parsed.data as T] : [];
  } catch {
    return [];
  }
}

function parseStoredStrict<T>(json: string, schema: z.ZodType, context: string): T {
  try {
    const parsedJson = JSON.parse(json) as unknown;
    const parsed = schema.safeParse(parsedJson);
    if (parsed.success) return parsed.data as T;
    throw new Error(parsed.error.message);
  } catch (error) {
    throw new Error(`invalid durable attention state row in ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function attentionInputLifecycle(input: AttentionInput): "active" | "suppressed" | "stale" | "terminal" {
  if (input.stale_refs.length > 0 || input.invalidation_refs.length > 0) return "stale";
  return "active";
}

function lifecycleForMaturation(state: UrgeCandidate["maturation"]["state"]): AttentionStoreLifecycle {
  switch (state) {
    case "new":
    case "warming":
      return "pending";
    case "held":
    case "prepared":
    case "decayed":
    case "mature":
      return "held";
    case "suppressed":
      return "suppressed";
    case "expressed":
      return "admitted";
    case "expired":
      return "terminal";
    case "rejected_stale":
      return "stale";
  }
}

function lifecycleForAgenda(item: AgentAgendaItem): AttentionStoreLifecycle {
  if (item.control_state === "suppressed" || item.current_posture === "suppressed") return "suppressed";
  if (item.current_posture === "admitted") return "admitted";
  if (item.current_posture === "expired") return "terminal";
  if (item.current_posture === "rejected_stale" || item.staleness_state === "rejected") return "stale";
  if (item.control_state === "held" || item.control_state === "paused") return "held";
  return "pending";
}

function lifecycleForOutcome(decision: OutcomeDecision): AttentionStoreLifecycle {
  switch (decision.admission_status) {
    case "admitted":
    case "downgraded":
      return "admitted";
    case "held":
      return "held";
    case "rejected":
      return "stale";
    case "expired":
      return "terminal";
  }
}

function staleRefCountForAgenda(item: AgentAgendaItem): number {
  return [
    ...item.related_goal_refs,
    ...item.related_memory_refs,
    ...item.related_surface_refs,
    ...item.related_runtime_refs,
  ].filter((candidate) => item.staleness_state !== "current" && candidate).length;
}

function invalidationRefCountForAgenda(item: AgentAgendaItem): number {
  return item.staleness_state === "needs_regrounding" || item.staleness_state === "rejected" ? 1 : 0;
}

function agendaMatchesControl(item: AgentAgendaItem, control: AttentionAgendaSuppressionInput["control"]): boolean {
  if (
    item.current_posture === "suppressed"
    || item.current_posture === "expired"
    || item.current_posture === "rejected_stale"
    || item.current_posture === "admitted"
  ) {
    return false;
  }
  if (control === "suppress_nonessential_agenda") {
    return item.kind !== "permission_boundary" && item.kind !== "commitment_guard";
  }
  if (control === "stop_all_watches") {
    return item.kind === "curiosity_followup" || item.kind === "surface_staleness" || item.current_posture === "prepared";
  }
  return item.current_posture === "held"
    || item.current_posture === "prepared"
    || item.current_posture === "ready_for_gate"
    || item.current_posture === "warming"
    || item.current_posture === "new";
}

function suppressAgendaItem(
  item: AgentAgendaItem,
  input: { now: string; reason: string; auditRef?: CompanionAutonomyRef }
): AgentAgendaItem {
  return AgentAgendaItemSchema.parse({
    ...item,
    current_posture: "suppressed",
    control_state: "suppressed",
    maturation: {
      ...item.maturation,
      state: "suppressed",
      blocker_refs: item.maturation.blocker_refs,
    },
    revisit_condition: {
      kind: "manual_review",
      refs: [],
      reason: input.reason,
    },
    updated_at: input.now,
    audit_refs: uniqueRefs([
      ...item.audit_refs,
      input.auditRef ?? ref("audit_trace", `attention-suppression:${item.agenda_item_id}:${input.now}`),
    ]),
  });
}

function invalidateAgendaItem(
  item: AgentAgendaItem,
  input: { now: string; reason: string; auditRef?: CompanionAutonomyRef }
): AgentAgendaItem {
  return AgentAgendaItemSchema.parse({
    ...item,
    current_posture: "rejected_stale",
    control_state: "expired",
    staleness_state: "rejected",
    maturation: {
      ...item.maturation,
      state: "rejected_stale",
    },
    revisit_condition: {
      kind: "none",
      refs: [],
      reason: input.reason,
    },
    updated_at: input.now,
    audit_refs: uniqueRefs([
      ...item.audit_refs,
      input.auditRef ?? ref("audit_trace", `attention-invalidation:${item.agenda_item_id}:${input.now}`),
    ]),
  });
}

function agendaReferencesAny(item: AgentAgendaItem, refs: ReadonlySet<string>): boolean {
  const candidates = [
    ...item.related_goal_refs,
    ...item.related_memory_refs,
    ...item.related_surface_refs,
    ...item.related_runtime_refs,
    ...item.source_urge_refs,
  ];
  return candidates.some((candidate) => refs.has(refKey(candidate)));
}

function scopeKey(scope: AttentionScope): string {
  return attentionScopeKey(scope);
}
