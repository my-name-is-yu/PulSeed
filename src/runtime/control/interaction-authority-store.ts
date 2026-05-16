import { z } from "zod/v3";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "../store/runtime-paths.js";
import {
  createRuntimeControlDatabaseOwner,
  type ControlDatabase,
  type ControlDatabaseHandleOwner,
  type RuntimeControlDbStoreOptions,
} from "../store/control-db/index.js";
import {
  RuntimeEventLogStore,
  type RuntimeEventAppendResult,
} from "../store/runtime-event-log.js";
import {
  ExecutionAuthorityDecisionSchema,
  ExecutionAuthoritySourceKindSchema,
  type ExecutionAuthorityDecisionInput,
  type ExecutionAuthorityDecision,
  type ExecutionAuthoritySourceKind,
} from "./execution-authority-decision.js";

const LimitSchema = z.number().int().positive().max(500).default(100);

export interface InteractionAuthorityStoreListOptions {
  sourceKind?: ExecutionAuthoritySourceKind;
  surface?: string;
  limit?: number;
}

export interface InteractionAuthorityDecisionSummary {
  decision_id: string;
  decided_at: string;
  source_kind: ExecutionAuthoritySourceKind;
  outcome: ExecutionAuthorityDecision["outcome"];
  lifecycle: ExecutionAuthorityDecision["lifecycle"];
  surface?: string;
  surface_class?: ExecutionAuthorityDecision["surface_class"];
  target_binding_ref?: string;
  delivery_ref?: string;
  fail_closed: boolean;
  stale_target_rejected: boolean;
  suppressed: boolean;
}

export class InteractionAuthorityStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private readonly dbOwner: ControlDatabaseHandleOwner;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
    this.dbOwner = createRuntimeControlDatabaseOwner(this.paths, this.dbOptions);
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async recordDecision(input: ExecutionAuthorityDecision): Promise<ExecutionAuthorityDecision> {
    const decision = ExecutionAuthorityDecisionSchema.parse(input);
    const eventLog = new RuntimeEventLogStore(this.paths, this.dbOptions);
    const appendResult = await eventLog.appendAuthorityDecisionWithDisposition(decision);
    const decisionToRecord = shouldSuppressSideEffectReplay(decision, appendResult)
      ? suppressSideEffectReplayDecision(decision, appendResult)
      : decision;
    if (decisionToRecord !== decision) {
      await eventLog.appendAuthorityDecision(decisionToRecord);
    }
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO interaction_authority_decisions (
          decision_id,
          decided_at,
          source_kind,
          outcome,
          lifecycle,
          surface,
          surface_class,
          target_binding_ref,
          delivery_ref,
          fail_closed,
          stale_target_rejected,
          suppressed,
          decision_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(decision_id) DO UPDATE SET
          decided_at = excluded.decided_at,
          source_kind = excluded.source_kind,
          outcome = excluded.outcome,
          lifecycle = excluded.lifecycle,
          surface = excluded.surface,
          surface_class = excluded.surface_class,
          target_binding_ref = excluded.target_binding_ref,
          delivery_ref = excluded.delivery_ref,
          fail_closed = excluded.fail_closed,
          stale_target_rejected = excluded.stale_target_rejected,
          suppressed = excluded.suppressed,
          decision_json = excluded.decision_json
      `).run(
        decisionToRecord.decision_id,
        decisionToRecord.decided_at,
        decisionToRecord.source.kind,
        decisionToRecord.outcome,
        decisionToRecord.lifecycle,
        decisionToRecord.surface ?? null,
        decisionToRecord.surface_class ?? null,
        decisionToRecord.bindings.target_binding_ref ?? null,
        decisionToRecord.bindings.delivery_ref ?? decisionToRecord.outbound_conversation?.delivery_ref ?? null,
        decisionToRecord.fail_closed ? 1 : 0,
        decisionToRecord.stale_target_rejected ? 1 : 0,
        decisionToRecord.suppressed ? 1 : 0,
        JSON.stringify(decisionToRecord),
      );
    });
    return decisionToRecord;
  }

  async getDecision(decisionId: string): Promise<ExecutionAuthorityDecision | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT decision_json
        FROM interaction_authority_decisions
        WHERE decision_id = ?
      `).get(decisionId) as { decision_json: string } | undefined;
      return row ? parseDecision(row.decision_json) : null;
    });
  }

  async listDecisions(options: InteractionAuthorityStoreListOptions = {}): Promise<ExecutionAuthorityDecision[]> {
    const limit = LimitSchema.parse(options.limit ?? 100);
    const sourceKind = options.sourceKind ? ExecutionAuthoritySourceKindSchema.parse(options.sourceKind) : null;
    const surface = options.surface ?? null;
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT decision_json
        FROM interaction_authority_decisions
        WHERE (? IS NULL OR source_kind = ?)
          AND (? IS NULL OR surface = ?)
        ORDER BY decided_at DESC, decision_id DESC
        LIMIT ?
      `).all(sourceKind, sourceKind, surface, surface, limit) as Array<{ decision_json: string }>;
      return rows.flatMap((row) => {
        const parsed = parseDecision(row.decision_json);
        return parsed ? [parsed] : [];
      });
    });
  }

  async summarizeDecisions(options: InteractionAuthorityStoreListOptions = {}): Promise<InteractionAuthorityDecisionSummary[]> {
    return (await this.listDecisions(options)).map((decision) => ({
      decision_id: decision.decision_id,
      decided_at: decision.decided_at,
      source_kind: decision.source.kind,
      outcome: decision.outcome,
      lifecycle: decision.lifecycle,
      ...(decision.surface ? { surface: decision.surface } : {}),
      ...(decision.surface_class ? { surface_class: decision.surface_class } : {}),
      ...(decision.bindings.target_binding_ref ? { target_binding_ref: decision.bindings.target_binding_ref } : {}),
      ...(decision.bindings.delivery_ref ? { delivery_ref: decision.bindings.delivery_ref } : {}),
      fail_closed: decision.fail_closed,
      stale_target_rejected: decision.stale_target_rejected,
      suppressed: decision.suppressed,
    }));
  }

  private async database(): Promise<ControlDatabase> {
    return this.dbOwner.database();
  }
}

function shouldSuppressSideEffectReplay(
  decision: ExecutionAuthorityDecision,
  appendResult: RuntimeEventAppendResult,
): boolean {
  if (appendResult.disposition === "inserted") return false;
  if (decision.metadata["runtime_event_replay_suppressed"] === true) return false;
  if (appendResult.event.replay_policy.mode !== "side_effect_guard") return false;
  if (!appendResult.event.side_effect_ref) return false;
  return decision.can_execute || decision.can_send || decision.can_notify;
}

function suppressSideEffectReplayDecision(
  decision: ExecutionAuthorityDecision,
  appendResult: RuntimeEventAppendResult,
): ExecutionAuthorityDecision {
  const input: ExecutionAuthorityDecisionInput = {
    ...decision,
    decision_id: `${decision.decision_id}:runtime-event-replay-suppressed`,
    decided_at: new Date().toISOString(),
    lifecycle: "terminal",
    outcome: "suppressed",
    reason: `Runtime event log suppressed replay of side-effect boundary ${appendResult.event.event_id}.`,
    can_prepare: false,
    can_execute: false,
    can_send: false,
    can_notify: false,
    can_ask: false,
    can_hold: false,
    can_suppress: true,
    requires_approval: false,
    fail_closed: false,
    suppressed: true,
    evidence_refs: [
      ...decision.evidence_refs,
      `runtime-event:${appendResult.event.event_id}`,
      `runtime-event-dedupe:${appendResult.event.idempotency_key}`,
    ],
    metadata: {
      ...decision.metadata,
      runtime_event_replay_suppressed: true,
      runtime_event_replay_disposition: appendResult.disposition,
      runtime_event_replay_event_id: appendResult.event.event_id,
      runtime_event_replay_side_effect_ref: appendResult.event.side_effect_ref
        ? `${appendResult.event.side_effect_ref.kind}:${appendResult.event.side_effect_ref.ref}`
        : null,
    },
  };
  return ExecutionAuthorityDecisionSchema.parse(input);
}

function parseDecision(value: string): ExecutionAuthorityDecision | null {
  try {
    const parsed = ExecutionAuthorityDecisionSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
