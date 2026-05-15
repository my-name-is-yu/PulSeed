import { z } from "zod";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../store/control-db/index.js";
import {
  AttentionTransitionSchema,
  CapabilityRegistryDecisionSchema,
  InitiativeEventSchema,
  InterventionDecisionSchema,
  PersonalAgentDecisionTraceSchema,
  RelationshipMemoryAuditSchema,
  RuntimeGraphEdgeSchema,
  RuntimeGraphNodeSchema,
  SituationFrameSchema,
  TaskCandidateSchema,
  type AttentionTransition,
  type CapabilityRegistryDecision,
  type InitiativeEvent,
  type InterventionDecision,
  type PersonalAgentDecisionTrace,
  type RelationshipMemoryAudit,
  type RuntimeGraphEdge,
  type RuntimeGraphNode,
  type RuntimeGraphNodeKind,
  type SituationFrame,
  type TaskCandidate,
} from "./contracts.js";

export interface PersonalAgentRuntimeStoreOptions extends RuntimeControlDbStoreOptions {}

export interface PersonalAgentTraceSnapshot {
  trace_id: string;
  replay_key: string;
  situation_frame: SituationFrame | null;
  initiative_events: InitiativeEvent[];
  attention_transitions: AttentionTransition[];
  task_candidates: TaskCandidate[];
  capability_decisions: CapabilityRegistryDecision[];
  intervention_decisions: InterventionDecision[];
  runtime_graph_nodes: RuntimeGraphNode[];
  runtime_graph_edges: RuntimeGraphEdge[];
  memory_audits: RelationshipMemoryAudit[];
}

export interface PendingConcernSnapshot {
  task_candidates: TaskCandidate[];
  attention_transitions: AttentionTransition[];
  held_or_blocked_decisions: InterventionDecision[];
}

const LimitSchema = z.number().int().positive().max(500).default(100);

export class PersonalAgentRuntimeStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: PersonalAgentRuntimeStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async recordTrace(trace: PersonalAgentDecisionTrace): Promise<PersonalAgentTraceSnapshot> {
    const parsed = PersonalAgentDecisionTraceSchema.parse(trace);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertSituationFrame(sqlite, parsed.situation_frame);
      for (const event of parsed.initiative_events) insertInitiativeEvent(sqlite, event);
      for (const transition of parsed.attention_transitions) upsertAttentionTransition(sqlite, transition);
      for (const candidate of parsed.task_candidates) upsertTaskCandidate(sqlite, candidate);
      for (const decision of parsed.capability_decisions) upsertCapabilityDecision(sqlite, decision);
      for (const decision of parsed.intervention_decisions) upsertInterventionDecision(sqlite, decision);
      for (const node of parsed.runtime_graph_nodes) upsertRuntimeGraphNode(sqlite, node, { immutable: true });
      for (const edge of parsed.runtime_graph_edges) insertRuntimeGraphEdge(sqlite, edge);
      for (const audit of parsed.memory_audits) upsertMemoryAudit(sqlite, audit);
    });
    return this.loadTrace(parsed.trace_id) as Promise<PersonalAgentTraceSnapshot>;
  }

  async loadSituationFrame(frameId: string): Promise<SituationFrame | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT frame_json
        FROM personal_agent_situation_frames
        WHERE frame_id = ?
      `).get(frameId) as { frame_json: string } | undefined;
      return row ? SituationFrameSchema.parse(JSON.parse(row.frame_json) as unknown) : null;
    });
  }

  async loadTrace(ref: string): Promise<PersonalAgentTraceSnapshot | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const traceId = resolveTraceId(sqlite, ref);
      if (!traceId) return null;
      return readTrace(sqlite, traceId);
    });
  }

  async loadInterventionDecision(decisionId: string): Promise<InterventionDecision | null> {
    const db = await this.database();
    return db.read((sqlite) => readSingleJson(
      sqlite,
      "personal_agent_intervention_decisions",
      "decision_id",
      decisionId,
      "decision_json",
      InterventionDecisionSchema,
    ));
  }

  async loadCapabilityDecision(decisionId: string): Promise<CapabilityRegistryDecision | null> {
    const db = await this.database();
    return db.read((sqlite) => readSingleJson(
      sqlite,
      "personal_agent_capability_decisions",
      "decision_id",
      decisionId,
      "decision_json",
      CapabilityRegistryDecisionSchema,
    ));
  }

  async loadRuntimeGraphNode(nodeIdOrRef: string): Promise<RuntimeGraphNode | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT node_json
        FROM personal_agent_runtime_graph_nodes
        WHERE node_id = ? OR ref = ?
        ORDER BY
          CASE
            WHEN json_extract(node_json, '$.payload.runtime_graph_role') = 'source_of_truth' THEN 0
            ELSE 1
          END,
          updated_at DESC
        LIMIT 1
      `).get(nodeIdOrRef, nodeIdOrRef) as { node_json: string } | undefined;
      return row ? RuntimeGraphNodeSchema.parse(JSON.parse(row.node_json) as unknown) : null;
    });
  }

  async upsertRuntimeGraph(
    nodes: RuntimeGraphNode[],
    edges: RuntimeGraphEdge[] = [],
  ): Promise<void> {
    const parsedNodes = nodes.map((node) => RuntimeGraphNodeSchema.parse(node));
    const parsedEdges = edges.map((edge) => RuntimeGraphEdgeSchema.parse(edge));
    const db = await this.database();
    db.transaction((sqlite) => {
      for (const node of parsedNodes) upsertRuntimeGraphNode(sqlite, node);
      for (const edge of parsedEdges) insertRuntimeGraphEdge(sqlite, edge);
    });
  }

  async listRuntimeGraphSourceNodes(nodeKind?: RuntimeGraphNodeKind): Promise<RuntimeGraphNode[]> {
    const db = await this.database();
    return db.read((sqlite) => listJson<RuntimeGraphNode>(
      sqlite,
      `SELECT node_json AS json
       FROM personal_agent_runtime_graph_nodes
       WHERE json_extract(node_json, '$.payload.runtime_graph_role') = 'source_of_truth'
         AND (? IS NULL OR node_kind = ?)
       ORDER BY updated_at DESC, node_id ASC`,
      RuntimeGraphNodeSchema,
      nodeKind ?? null,
      nodeKind ?? null,
    ));
  }

  async listPendingConcerns(limit = 100): Promise<PendingConcernSnapshot> {
    const parsedLimit = LimitSchema.parse(limit);
    const db = await this.database();
    return db.read((sqlite) => ({
      task_candidates: listJson<TaskCandidate>(
        sqlite,
        `SELECT candidate_json AS json
         FROM personal_agent_task_candidates
         WHERE materialization_state IN ('candidate', 'held', 'blocked', 'suppressed')
         ORDER BY proposed_at DESC, candidate_id DESC
         LIMIT ?`,
        TaskCandidateSchema,
        parsedLimit,
      ),
      attention_transitions: listJson<AttentionTransition>(
        sqlite,
        `SELECT transition_json AS json
         FROM personal_agent_attention_transitions
         WHERE to_state IN ('held', 'blocked', 'suppressed', 'warming')
         ORDER BY occurred_at DESC, transition_id DESC
         LIMIT ?`,
        AttentionTransitionSchema,
        parsedLimit,
      ),
      held_or_blocked_decisions: listJson<InterventionDecision>(
        sqlite,
        `SELECT decision_json AS json
         FROM personal_agent_intervention_decisions
         WHERE decision IN ('hold', 'block', 'suppress', 'confirm_required')
         ORDER BY decided_at DESC, decision_id DESC
         LIMIT ?`,
        InterventionDecisionSchema,
        parsedLimit,
      ),
    }));
  }

  async listTaskCandidates(limit = 100): Promise<TaskCandidate[]> {
    const parsedLimit = LimitSchema.parse(limit);
    const db = await this.database();
    return db.read((sqlite) => listJson<TaskCandidate>(
      sqlite,
      `SELECT candidate_json AS json
       FROM personal_agent_task_candidates
       ORDER BY proposed_at DESC, candidate_id DESC
       LIMIT ?`,
      TaskCandidateSchema,
      parsedLimit,
    ));
  }

  async listMemoryAudits(limit = 100): Promise<RelationshipMemoryAudit[]> {
    const parsedLimit = LimitSchema.parse(limit);
    const db = await this.database();
    return db.read((sqlite) => listJson<RelationshipMemoryAudit>(
      sqlite,
      `SELECT audit_json AS json
       FROM personal_agent_relationship_memory_audits
       ORDER BY recorded_at DESC, audit_id DESC
       LIMIT ?`,
      RelationshipMemoryAuditSchema,
      parsedLimit,
    ));
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) return this.options.controlDb;
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}

function upsertSituationFrame(sqlite: SqliteDatabase, frame: SituationFrame): void {
  const parsed = SituationFrameSchema.parse(frame);
  sqlite.prepare(`
    INSERT INTO personal_agent_situation_frames (
      frame_id, caller_path, source_kind, replay_key, assembled_at, frame_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(frame_id) DO NOTHING
  `).run(
    parsed.frame_id,
    parsed.caller_path,
    parsed.source_kind,
    parsed.replay_key,
    parsed.assembled_at,
    JSON.stringify(parsed),
  );
}

function insertInitiativeEvent(sqlite: SqliteDatabase, event: InitiativeEvent): void {
  const parsed = InitiativeEventSchema.parse(event);
  sqlite.prepare(`
    INSERT INTO personal_agent_initiative_events (
      event_id, trace_id, event_type, sequence, idempotency_key, occurred_at,
      situation_frame_id, event_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    parsed.event_id,
    parsed.trace_id,
    parsed.event_type,
    parsed.sequence,
    parsed.idempotency_key,
    parsed.occurred_at,
    parsed.situation_frame_id,
    JSON.stringify(parsed),
  );
}

function upsertAttentionTransition(sqlite: SqliteDatabase, transition: AttentionTransition): void {
  const parsed = AttentionTransitionSchema.parse(transition);
  sqlite.prepare(`
    INSERT INTO personal_agent_attention_transitions (
      transition_id, trace_id, to_state, occurred_at, situation_frame_id,
      initiative_event_id, transition_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(transition_id) DO NOTHING
  `).run(
    parsed.transition_id,
    parsed.trace_id,
    parsed.to_state,
    parsed.occurred_at,
    parsed.situation_frame_id,
    parsed.initiative_event_id,
    JSON.stringify(parsed),
  );
}

function upsertTaskCandidate(sqlite: SqliteDatabase, candidate: TaskCandidate): void {
  const parsed = TaskCandidateSchema.parse(candidate);
  sqlite.prepare(`
    INSERT INTO personal_agent_task_candidates (
      candidate_id, trace_id, target_kind, target_ref, materialization_state,
      desired_effect, proposed_at, situation_frame_id, source_event_id, candidate_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(candidate_id) DO NOTHING
  `).run(
    parsed.candidate_id,
    parsed.trace_id,
    parsed.target_kind,
    parsed.target_ref.ref,
    parsed.materialization_state,
    parsed.desired_effect,
    parsed.proposed_at,
    parsed.situation_frame_id,
    parsed.source_event_id,
    JSON.stringify(parsed),
  );
}

function upsertCapabilityDecision(sqlite: SqliteDatabase, decision: CapabilityRegistryDecision): void {
  const parsed = CapabilityRegistryDecisionSchema.parse(decision);
  sqlite.prepare(`
    INSERT INTO personal_agent_capability_decisions (
      decision_id, trace_id, candidate_id, decision, decided_at, decision_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(decision_id) DO NOTHING
  `).run(
    parsed.decision_id,
    parsed.trace_id,
    parsed.candidate_id,
    parsed.decision,
    parsed.decided_at,
    JSON.stringify(parsed),
  );
}

function upsertInterventionDecision(sqlite: SqliteDatabase, decision: InterventionDecision): void {
  const parsed = InterventionDecisionSchema.parse(decision);
  sqlite.prepare(`
    INSERT INTO personal_agent_intervention_decisions (
      decision_id, trace_id, candidate_id, capability_decision_id, decision,
      target_effect, permission_required, decided_at, decision_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(decision_id) DO NOTHING
  `).run(
    parsed.decision_id,
    parsed.trace_id,
    parsed.candidate_id,
    parsed.capability_decision_id,
    parsed.decision,
    parsed.target_effect,
    parsed.permission_required ? 1 : 0,
    parsed.decided_at,
    JSON.stringify(parsed),
  );
}

function upsertRuntimeGraphNode(
  sqlite: SqliteDatabase,
  node: RuntimeGraphNode,
  options: { immutable?: boolean } = {},
): void {
  const parsed = RuntimeGraphNodeSchema.parse(node);
  const conflictClause = options.immutable
    ? "ON CONFLICT(node_id) DO NOTHING"
    : `ON CONFLICT(node_id) DO UPDATE SET
      node_kind = excluded.node_kind,
      ref = excluded.ref,
      updated_at = excluded.updated_at,
      node_json = excluded.node_json`;
  sqlite.prepare(`
    INSERT INTO personal_agent_runtime_graph_nodes (
      node_id, node_kind, ref, created_at, updated_at, node_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ${conflictClause}
  `).run(
    parsed.node_id,
    parsed.node_kind,
    parsed.ref.ref,
    parsed.created_at,
    parsed.updated_at,
    JSON.stringify(parsed),
  );
}

function insertRuntimeGraphEdge(sqlite: SqliteDatabase, edge: RuntimeGraphEdge): void {
  const parsed = RuntimeGraphEdgeSchema.parse(edge);
  sqlite.prepare(`
    INSERT INTO personal_agent_runtime_graph_edges (
      edge_id, edge_kind, from_node_id, to_node_id, created_at, edge_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(edge_id) DO NOTHING
  `).run(
    parsed.edge_id,
    parsed.edge_kind,
    parsed.from_node_id,
    parsed.to_node_id,
    parsed.created_at,
    JSON.stringify(parsed),
  );
}

function upsertMemoryAudit(sqlite: SqliteDatabase, audit: RelationshipMemoryAudit): void {
  const parsed = RelationshipMemoryAuditSchema.parse(audit);
  sqlite.prepare(`
    INSERT INTO personal_agent_relationship_memory_audits (
      audit_id, trace_id, memory_ref, action, correction_state, invalidated,
      recorded_at, audit_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(audit_id) DO NOTHING
  `).run(
    parsed.audit_id,
    parsed.trace_id,
    parsed.memory_ref.ref,
    parsed.action,
    parsed.correction_state,
    parsed.invalidated ? 1 : 0,
    parsed.recorded_at,
    JSON.stringify(parsed),
  );
}

function resolveTraceId(sqlite: SqliteDatabase, ref: string): string | null {
  const directEvent = sqlite.prepare(`
    SELECT trace_id FROM personal_agent_initiative_events
    WHERE trace_id = ? OR event_id = ? OR situation_frame_id = ?
    LIMIT 1
  `).get(ref, ref, ref) as { trace_id: string } | undefined;
  if (directEvent) return directEvent.trace_id;

  for (const [table, idColumn] of [
    ["personal_agent_task_candidates", "candidate_id"],
    ["personal_agent_capability_decisions", "decision_id"],
    ["personal_agent_intervention_decisions", "decision_id"],
    ["personal_agent_attention_transitions", "transition_id"],
    ["personal_agent_relationship_memory_audits", "audit_id"],
  ] as const) {
    const row = sqlite.prepare(`
      SELECT trace_id FROM ${table}
      WHERE trace_id = ? OR ${idColumn} = ?
      LIMIT 1
    `).get(ref, ref) as { trace_id: string } | undefined;
    if (row) return row.trace_id;
  }

  const graphNode = sqlite.prepare(`
    SELECT node_json
    FROM personal_agent_runtime_graph_nodes
    WHERE node_id = ? OR ref = ?
    LIMIT 1
  `).get(ref, ref) as { node_json: string } | undefined;
  if (!graphNode) return null;
  const node = RuntimeGraphNodeSchema.parse(JSON.parse(graphNode.node_json) as unknown);
  const provenance = node.provenance_refs.find((candidate) => candidate.kind === "initiative_event");
  return provenance ? resolveTraceId(sqlite, provenance.ref) : null;
}

function readTrace(sqlite: SqliteDatabase, traceId: string): PersonalAgentTraceSnapshot {
  const situation = sqlite.prepare(`
    SELECT frame_json
    FROM personal_agent_situation_frames
    WHERE frame_id IN (
      SELECT situation_frame_id
      FROM personal_agent_initiative_events
      WHERE trace_id = ?
      ORDER BY sequence ASC
      LIMIT 1
    )
  `).get(traceId) as { frame_json: string } | undefined;
  const replay = situation
    ? SituationFrameSchema.parse(JSON.parse(situation.frame_json) as unknown).replay_key
    : traceId;
  return {
    trace_id: traceId,
    replay_key: replay,
    situation_frame: situation ? SituationFrameSchema.parse(JSON.parse(situation.frame_json) as unknown) : null,
    initiative_events: listJson(sqlite, `
      SELECT event_json AS json
      FROM personal_agent_initiative_events
      WHERE trace_id = ?
      ORDER BY sequence ASC, event_id ASC
    `, InitiativeEventSchema, traceId),
    attention_transitions: listJson(sqlite, `
      SELECT transition_json AS json
      FROM personal_agent_attention_transitions
      WHERE trace_id = ?
      ORDER BY occurred_at ASC, transition_id ASC
    `, AttentionTransitionSchema, traceId),
    task_candidates: listJson(sqlite, `
      SELECT candidate_json AS json
      FROM personal_agent_task_candidates
      WHERE trace_id = ?
      ORDER BY proposed_at ASC, candidate_id ASC
    `, TaskCandidateSchema, traceId),
    capability_decisions: listJson(sqlite, `
      SELECT decision_json AS json
      FROM personal_agent_capability_decisions
      WHERE trace_id = ?
      ORDER BY decided_at ASC, decision_id ASC
    `, CapabilityRegistryDecisionSchema, traceId),
    intervention_decisions: listJson(sqlite, `
      SELECT decision_json AS json
      FROM personal_agent_intervention_decisions
      WHERE trace_id = ?
      ORDER BY decided_at ASC, decision_id ASC
    `, InterventionDecisionSchema, traceId),
    runtime_graph_nodes: listJson(sqlite, `
      SELECT node_json AS json
      FROM personal_agent_runtime_graph_nodes
      WHERE node_id LIKE ?
      ORDER BY created_at ASC, node_id ASC
    `, RuntimeGraphNodeSchema, `${traceId}:%`),
    runtime_graph_edges: listJson(sqlite, `
      SELECT edge_json AS json
      FROM personal_agent_runtime_graph_edges
      WHERE edge_id LIKE ?
      ORDER BY created_at ASC, edge_id ASC
    `, RuntimeGraphEdgeSchema, `${traceId}:%`),
    memory_audits: listJson(sqlite, `
      SELECT audit_json AS json
      FROM personal_agent_relationship_memory_audits
      WHERE trace_id = ?
      ORDER BY recorded_at ASC, audit_id ASC
    `, RelationshipMemoryAuditSchema, traceId),
  };
}

function readSingleJson<T>(
  sqlite: SqliteDatabase,
  table: string,
  idColumn: string,
  id: string,
  jsonColumn: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T | null {
  const row = sqlite.prepare(`
    SELECT ${jsonColumn} AS json
    FROM ${table}
    WHERE ${idColumn} = ?
  `).get(id) as { json: string } | undefined;
  return row ? schema.parse(JSON.parse(row.json) as unknown) : null;
}

function listJson<T>(
  sqlite: SqliteDatabase,
  sql: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ...params: unknown[]
): T[] {
  const rows = sqlite.prepare(sql).all(...params) as Array<{ json: string }>;
  return rows.map((row) => schema.parse(JSON.parse(row.json) as unknown));
}
