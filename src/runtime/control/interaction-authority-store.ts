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
  ExecutionAuthorityDecisionSchema,
  ExecutionAuthoritySourceKindSchema,
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
        decision.decision_id,
        decision.decided_at,
        decision.source.kind,
        decision.outcome,
        decision.lifecycle,
        decision.surface ?? null,
        decision.surface_class ?? null,
        decision.bindings.target_binding_ref ?? null,
        decision.bindings.delivery_ref ?? decision.outbound_conversation?.delivery_ref ?? null,
        decision.fail_closed ? 1 : 0,
        decision.stale_target_rejected ? 1 : 0,
        decision.suppressed ? 1 : 0,
        JSON.stringify(decision),
      );
    });
    return decision;
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

function parseDecision(value: string): ExecutionAuthorityDecision | null {
  try {
    const parsed = ExecutionAuthorityDecisionSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
