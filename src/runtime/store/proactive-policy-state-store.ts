import { z } from "zod/v3";
import {
  ProactivePolicyEventSchema,
  ProactivePolicyStateSchema,
  createProactivePolicyState,
  reduceProactivePolicyState,
  type ProactiveInterruptionBudget,
  type ProactivePolicyEvent,
  type ProactivePolicyState,
} from "../attention/proactive-policy.js";
import type {
  CognitionRef,
  ProactiveDeliveryKind,
} from "../cognition/index.js";
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

export const ProactivePolicyStateApplyResultSchema = z.object({
  schema_version: z.literal("proactive-policy-state-apply-result/v1"),
  policy_id: z.string().min(1),
  applied_event_count: z.number().int().nonnegative(),
  skipped_existing_event_count: z.number().int().nonnegative(),
  before_max_delivery_kind: z.string().min(1),
  after_max_delivery_kind: z.string().min(1),
  feedback_ref_count: z.number().int().nonnegative(),
  cooldown_ref_count: z.number().int().nonnegative(),
  budget_debit_count: z.number().int().nonnegative(),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ProactivePolicyStateApplyResult = z.infer<typeof ProactivePolicyStateApplyResultSchema>;

export interface ProactivePolicyStateLoadOrCreateInput {
  policyId: string;
  now: string;
  mode?: ProactivePolicyState["mode"];
  maxDeliveryKind?: ProactiveDeliveryKind;
  budget?: ProactiveInterruptionBudget;
}

export class ProactivePolicyStateStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {}
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

  async load(policyId: string): Promise<ProactivePolicyState | null> {
    const db = await this.database();
    return db.read((sqlite) => readPolicyState(sqlite, policyId));
  }

  async loadOrCreate(input: ProactivePolicyStateLoadOrCreateInput): Promise<ProactivePolicyState> {
    const existing = await this.load(input.policyId);
    if (existing) return existing;
    return this.save(createProactivePolicyState({
      policyId: input.policyId,
      now: input.now,
      mode: input.mode,
      maxDeliveryKind: input.maxDeliveryKind,
      budget: input.budget,
    }));
  }

  async save(state: ProactivePolicyState): Promise<ProactivePolicyState> {
    const parsed = ProactivePolicyStateSchema.parse(state);
    const db = await this.database();
    db.transaction((sqlite) => writePolicyState(sqlite, parsed));
    return parsed;
  }

  async applyEvents(input: ProactivePolicyStateLoadOrCreateInput & {
    events: readonly ProactivePolicyEvent[];
  }): Promise<{
    state: ProactivePolicyState;
    result: ProactivePolicyStateApplyResult;
  }> {
    const initial = await this.loadOrCreate(input);
    let state = initial;
    let applied = 0;
    let skipped = 0;

    for (const event of input.events.map((candidate) => ProactivePolicyEventSchema.parse(candidate))) {
      if (event.kind === "feedback" && hasFeedbackRef(state, event.feedback_ref)) {
        skipped += 1;
        continue;
      }
      state = reduceProactivePolicyState(state, event);
      applied += 1;
    }

    if (applied > 0) {
      state = await this.save(state);
    }

    return {
      state,
      result: ProactivePolicyStateApplyResultSchema.parse({
        schema_version: "proactive-policy-state-apply-result/v1",
        policy_id: state.policy_id,
        applied_event_count: applied,
        skipped_existing_event_count: skipped,
        before_max_delivery_kind: initial.max_delivery_kind,
        after_max_delivery_kind: state.max_delivery_kind,
        feedback_ref_count: state.feedback_refs.length,
        cooldown_ref_count: state.cooldown_refs.length,
        budget_debit_count: state.interruption_budget?.current_debits ?? 0,
        runtime_authority: false,
      }),
    };
  }

  async recordBudgetDebit(input: {
    policyId: string;
    amount: number;
    debitedAt: string;
  }): Promise<ProactivePolicyState | null> {
    const amount = Math.max(0, Math.floor(input.amount));
    if (amount === 0) return this.load(input.policyId);
    const existing = await this.load(input.policyId);
    if (!existing?.interruption_budget) return existing;
    return this.save(ProactivePolicyStateSchema.parse({
      ...existing,
      interruption_budget: {
        ...existing.interruption_budget,
        current_debits: existing.interruption_budget.current_debits + amount,
      },
      updated_at: input.debitedAt,
      runtime_authority: false,
    }));
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface ProactivePolicyStateRow {
  state_json: string;
}

function readPolicyState(sqlite: SqliteDatabase, policyId: string): ProactivePolicyState | null {
  const row = sqlite.prepare(`
    SELECT state_json
    FROM proactive_policy_states
    WHERE policy_id = ?
  `).get(policyId) as ProactivePolicyStateRow | undefined;
  if (!row) return null;
  return parsePolicyState(row.state_json);
}

function writePolicyState(sqlite: SqliteDatabase, state: ProactivePolicyState): void {
  sqlite.prepare(`
    INSERT INTO proactive_policy_states (
      policy_id,
      updated_at,
      state_json
    )
    VALUES (?, ?, json(?))
    ON CONFLICT(policy_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      state_json = excluded.state_json
  `).run(
    state.policy_id,
    state.updated_at,
    JSON.stringify(state),
  );
}

function parsePolicyState(value: string): ProactivePolicyState | null {
  try {
    const parsed = ProactivePolicyStateSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function hasFeedbackRef(state: ProactivePolicyState, ref: CognitionRef): boolean {
  return state.feedback_refs.some((candidate) => candidate.kind === ref.kind && candidate.ref === ref.ref);
}
