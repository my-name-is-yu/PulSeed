import { randomUUID } from "node:crypto";
import { z } from "zod/v3";
import {
  ProactiveInterruptionBudgetSchema,
  ProactivePolicyStateSchema,
  type ProactiveInterruptionBudget,
  type ProactivePolicyState,
} from "../attention/proactive-policy.js";
import {
  ProactiveDeliveryKindSchema,
  deliveryKindRank,
  type ProactiveDeliveryKind,
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

export const ResidentActivationScopeSchema = z.enum(["peer_initiative_telegram"]);
export type ResidentActivationScope = z.infer<typeof ResidentActivationScopeSchema>;

export const ResidentActivationSurfaceSchema = z.enum(["telegram"]);
export type ResidentActivationSurface = z.infer<typeof ResidentActivationSurfaceSchema>;

export const ResidentActivationProposalStatusSchema = z.enum(["proposed", "accepted", "declined", "revoked"]);
export type ResidentActivationProposalStatus = z.infer<typeof ResidentActivationProposalStatusSchema>;

export const ResidentActivationBindingStatusSchema = z.enum(["active", "revoked"]);
export type ResidentActivationBindingStatus = z.infer<typeof ResidentActivationBindingStatusSchema>;

export const ResidentActivationMaxDeliveryKindSchema = ProactiveDeliveryKindSchema.extract(["digest", "suggest", "notify"]);
export type ResidentActivationMaxDeliveryKind = z.infer<typeof ResidentActivationMaxDeliveryKindSchema>;

export const ResidentActivationBudgetSchema = z.object({
  max_notify: z.number().int().nonnegative().safe(),
  max_ask: z.number().int().nonnegative().safe(),
  max_prepare: z.number().int().nonnegative().safe(),
}).strict();
export type ResidentActivationBudget = z.infer<typeof ResidentActivationBudgetSchema>;

export const ResidentActivationProposalSchema = z.object({
  schema_version: z.literal("resident-activation-proposal/v1"),
  proposal_id: z.string().min(1),
  scope: ResidentActivationScopeSchema,
  surface: ResidentActivationSurfaceSchema,
  status: ResidentActivationProposalStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  requested_max_delivery_kind: ResidentActivationMaxDeliveryKindSchema,
  daily_budget: ResidentActivationBudgetSchema,
  dogfood_duration_hours: z.number().int().positive().safe().max(168),
  reason: z.string().min(1),
  normal_surface_claim: z.string().min(1),
  raw_refs_visible: z.literal(false).default(false),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ResidentActivationProposal = z.infer<typeof ResidentActivationProposalSchema>;

export const ResidentActivationBindingSchema = z.object({
  schema_version: z.literal("resident-activation-binding/v1"),
  binding_id: z.string().min(1),
  proposal_id: z.string().min(1),
  scope: ResidentActivationScopeSchema,
  surface: ResidentActivationSurfaceSchema,
  status: ResidentActivationBindingStatusSchema,
  activated_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  max_delivery_kind: ResidentActivationMaxDeliveryKindSchema,
  interruption_budget: ProactiveInterruptionBudgetSchema,
  expires_at: z.string().datetime(),
  raw_refs_visible: z.literal(false).default(false),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ResidentActivationBinding = z.infer<typeof ResidentActivationBindingSchema>;

export const ResidentActivationStatusProjectionSchema = z.object({
  schema_version: z.literal("resident-activation-status/v1"),
  generated_at: z.string().datetime(),
  scope: ResidentActivationScopeSchema,
  surface: ResidentActivationSurfaceSchema,
  active: z.boolean(),
  active_binding: z.object({
    binding_id: z.string().min(1),
    max_delivery_kind: ResidentActivationMaxDeliveryKindSchema,
    budget: ResidentActivationBudgetSchema,
    expires_at: z.string().datetime(),
  }).strict().nullable(),
  pending_proposal_count: z.number().int().nonnegative(),
  raw_refs_visible: z.literal(false).default(false),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ResidentActivationStatusProjection = z.infer<typeof ResidentActivationStatusProjectionSchema>;

export const DEFAULT_RESIDENT_ACTIVATION_SCOPE: ResidentActivationScope = "peer_initiative_telegram";
export const DEFAULT_RESIDENT_ACTIVATION_POLICY_ID = "peer-initiative:telegram";
export const DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND: ResidentActivationMaxDeliveryKind = "notify";
export const DEFAULT_RESIDENT_ACTIVATION_DAILY_NOTIFY_BUDGET = 4;

export interface ResidentActivationProposalInput {
  scope?: ResidentActivationScope;
  surface?: ResidentActivationSurface;
  requestedMaxDeliveryKind?: ResidentActivationMaxDeliveryKind;
  dailyBudget?: Partial<ResidentActivationBudget>;
  dogfoodDurationHours?: number;
  reason?: string;
  now?: string;
}

export class ResidentActivationStore {
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

  async propose(input: ResidentActivationProposalInput = {}): Promise<ResidentActivationProposal> {
    const now = input.now ?? new Date().toISOString();
    const scope = input.scope ?? DEFAULT_RESIDENT_ACTIVATION_SCOPE;
    const surface = input.surface ?? "telegram";
    const requestedMaxDeliveryKind = input.requestedMaxDeliveryKind ?? DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND;
    const proposal = ResidentActivationProposalSchema.parse({
      schema_version: "resident-activation-proposal/v1",
      proposal_id: `resident-activation:${randomUUID()}`,
      scope,
      surface,
      status: "proposed",
      created_at: now,
      updated_at: now,
      requested_max_delivery_kind: requestedMaxDeliveryKind,
      daily_budget: normalizeBudget(requestedMaxDeliveryKind, input.dailyBudget),
      dogfood_duration_hours: input.dogfoodDurationHours ?? 24,
      reason: input.reason ?? "Intentional one-day resident proactivity dogfood.",
      normal_surface_claim: normalSurfaceClaim(requestedMaxDeliveryKind),
      raw_refs_visible: false,
      runtime_authority: false,
    });
    const db = await this.database();
    db.transaction((sqlite) => writeProposal(sqlite, proposal));
    return proposal;
  }

  async accept(proposalId: string, acceptedAt = new Date().toISOString()): Promise<ResidentActivationBinding> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const proposal = readProposal(sqlite, proposalId);
      if (!proposal) throw new Error(`Resident activation proposal not found: ${proposalId}`);
      if (proposal.status !== "proposed") {
        throw new Error(`Resident activation proposal is not proposed: ${proposalId}`);
      }
      const acceptedProposal = ResidentActivationProposalSchema.parse({
        ...proposal,
        status: "accepted",
        updated_at: acceptedAt,
      });
      writeProposal(sqlite, acceptedProposal);
      revokeActiveBindings(sqlite, proposal.scope, proposal.surface, acceptedAt);
      const binding = ResidentActivationBindingSchema.parse({
        schema_version: "resident-activation-binding/v1",
        binding_id: `resident-binding:${randomUUID()}`,
        proposal_id: proposal.proposal_id,
        scope: proposal.scope,
        surface: proposal.surface,
        status: "active",
        activated_at: acceptedAt,
        updated_at: acceptedAt,
        max_delivery_kind: proposal.requested_max_delivery_kind,
        interruption_budget: createInterruptionBudget({
          bindingId: proposal.proposal_id,
          surface: proposal.surface,
          budget: proposal.daily_budget,
          activatedAt: acceptedAt,
          durationHours: proposal.dogfood_duration_hours,
        }),
        expires_at: addHoursIso(acceptedAt, proposal.dogfood_duration_hours),
        raw_refs_visible: false,
        runtime_authority: false,
      });
      writeBinding(sqlite, binding);
      return binding;
    });
  }

  async loadProposal(proposalId: string): Promise<ResidentActivationProposal | null> {
    const db = await this.database();
    return db.read((sqlite) => readProposal(sqlite, proposalId));
  }

  async listProposals(input: {
    scope?: ResidentActivationScope;
    status?: ResidentActivationProposalStatus;
    limit?: number;
  } = {}): Promise<ResidentActivationProposal[]> {
    const db = await this.database();
    return db.read((sqlite) => listProposals(sqlite, input));
  }

  async loadActiveBinding(
    scope: ResidentActivationScope = DEFAULT_RESIDENT_ACTIVATION_SCOPE,
    surface: ResidentActivationSurface = "telegram",
    activeAt = new Date().toISOString()
  ): Promise<ResidentActivationBinding | null> {
    const db = await this.database();
    const binding = db.read((sqlite) => readActiveBinding(sqlite, scope, surface));
    return binding && binding.expires_at > activeAt ? binding : null;
  }

  async projectStatus(input: {
    generatedAt?: string;
    scope?: ResidentActivationScope;
    surface?: ResidentActivationSurface;
  } = {}): Promise<ResidentActivationStatusProjection> {
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const scope = input.scope ?? DEFAULT_RESIDENT_ACTIVATION_SCOPE;
    const surface = input.surface ?? "telegram";
    const [activeBinding, pendingProposals] = await Promise.all([
      this.loadActiveBinding(scope, surface, generatedAt),
      this.listProposals({ scope, status: "proposed", limit: 100 }),
    ]);
    return ResidentActivationStatusProjectionSchema.parse({
      schema_version: "resident-activation-status/v1",
      generated_at: generatedAt,
      scope,
      surface,
      active: activeBinding !== null,
      active_binding: activeBinding
        ? {
            binding_id: activeBinding.binding_id,
            max_delivery_kind: activeBinding.max_delivery_kind,
            budget: budgetProjection(activeBinding.interruption_budget),
            expires_at: activeBinding.expires_at,
          }
        : null,
      pending_proposal_count: pendingProposals.length,
      raw_refs_visible: false,
      runtime_authority: false,
    });
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

export function applyResidentActivationBindingToPolicyState(input: {
  state: ProactivePolicyState;
  binding: ResidentActivationBinding | null;
  now: string;
}): ProactivePolicyState {
  if (!input.binding) return input.state;
  const maxDeliveryKind = input.state.feedback_refs.length === 0
    ? input.binding.max_delivery_kind
    : minDelivery(input.state.max_delivery_kind, input.binding.max_delivery_kind);
  const existingBudget = input.state.interruption_budget;
  const bindingBudget = input.binding.interruption_budget;
  const currentDebits = existingBudget?.budget_id === bindingBudget.budget_id
    ? existingBudget.current_debits
    : bindingBudget.current_debits;
  return ProactivePolicyStateSchema.parse({
    ...input.state,
    max_delivery_kind: maxDeliveryKind,
    interruption_budget: {
      ...bindingBudget,
      current_debits: currentDebits,
    },
    updated_at: input.now,
    runtime_authority: false,
  });
}

export function clearInactiveResidentActivationBudgetFromPolicyState(input: {
  state: ProactivePolicyState;
  now: string;
}): ProactivePolicyState {
  const budget = input.state.interruption_budget;
  if (!budget || !budget.budget_id.startsWith("resident-activation-budget:")) {
    return input.state;
  }
  const { interruption_budget: _budget, ...rest } = input.state;
  const maxDeliveryKind = input.state.mode === "active" && input.state.cooldown_refs.length === 0
    ? input.state.default_profile.default_max_delivery_kind
    : input.state.max_delivery_kind;
  return ProactivePolicyStateSchema.parse({
    ...rest,
    max_delivery_kind: maxDeliveryKind,
    updated_at: input.now,
    runtime_authority: false,
  });
}

interface ProposalRow {
  proposal_json: string;
}

interface BindingRow {
  binding_json: string;
}

function writeProposal(sqlite: SqliteDatabase, proposal: ResidentActivationProposal): void {
  sqlite.prepare(`
    INSERT INTO resident_activation_proposals (
      proposal_id,
      scope,
      surface,
      status,
      created_at,
      updated_at,
      proposal_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(proposal_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      proposal_json = excluded.proposal_json
  `).run(
    proposal.proposal_id,
    proposal.scope,
    proposal.surface,
    proposal.status,
    proposal.created_at,
    proposal.updated_at,
    JSON.stringify(proposal),
  );
}

function readProposal(sqlite: SqliteDatabase, proposalId: string): ResidentActivationProposal | null {
  const row = sqlite.prepare(`
    SELECT proposal_json
    FROM resident_activation_proposals
    WHERE proposal_id = ?
  `).get(proposalId) as ProposalRow | undefined;
  if (!row) return null;
  return parseProposal(row.proposal_json);
}

function listProposals(
  sqlite: SqliteDatabase,
  input: { scope?: ResidentActivationScope; status?: ResidentActivationProposalStatus; limit?: number }
): ResidentActivationProposal[] {
  const rows = sqlite.prepare(`
    SELECT proposal_json
    FROM resident_activation_proposals
    WHERE (? IS NULL OR scope = ?)
      AND (? IS NULL OR status = ?)
    ORDER BY updated_at DESC, proposal_id DESC
    LIMIT ?
  `).all(
    input.scope ?? null,
    input.scope ?? null,
    input.status ?? null,
    input.status ?? null,
    Math.max(1, Math.floor(input.limit ?? 100)),
  ) as ProposalRow[];
  return rows.flatMap((row) => {
    const parsed = parseProposal(row.proposal_json);
    return parsed ? [parsed] : [];
  });
}

function writeBinding(sqlite: SqliteDatabase, binding: ResidentActivationBinding): void {
  sqlite.prepare(`
    INSERT INTO resident_activation_bindings (
      binding_id,
      proposal_id,
      scope,
      surface,
      status,
      activated_at,
      updated_at,
      binding_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(binding_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      binding_json = excluded.binding_json
  `).run(
    binding.binding_id,
    binding.proposal_id,
    binding.scope,
    binding.surface,
    binding.status,
    binding.activated_at,
    binding.updated_at,
    JSON.stringify(binding),
  );
}

function readActiveBinding(
  sqlite: SqliteDatabase,
  scope: ResidentActivationScope,
  surface: ResidentActivationSurface
): ResidentActivationBinding | null {
  const row = sqlite.prepare(`
    SELECT binding_json
    FROM resident_activation_bindings
    WHERE scope = ?
      AND surface = ?
      AND status = 'active'
    ORDER BY updated_at DESC, binding_id DESC
    LIMIT 1
  `).get(scope, surface) as BindingRow | undefined;
  if (!row) return null;
  return parseBinding(row.binding_json);
}

function revokeActiveBindings(
  sqlite: SqliteDatabase,
  scope: ResidentActivationScope,
  surface: ResidentActivationSurface,
  revokedAt: string
): void {
  const active = readActiveBinding(sqlite, scope, surface);
  if (!active) return;
  writeBinding(sqlite, ResidentActivationBindingSchema.parse({
    ...active,
    status: "revoked",
    updated_at: revokedAt,
  }));
}

function parseProposal(value: string): ResidentActivationProposal | null {
  try {
    const parsed = ResidentActivationProposalSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseBinding(value: string): ResidentActivationBinding | null {
  try {
    const parsed = ResidentActivationBindingSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeBudget(
  requestedMaxDeliveryKind: ResidentActivationMaxDeliveryKind,
  budget: Partial<ResidentActivationBudget> | undefined
): ResidentActivationBudget {
  const defaults: ResidentActivationBudget = requestedMaxDeliveryKind === "notify"
    ? { max_notify: DEFAULT_RESIDENT_ACTIVATION_DAILY_NOTIFY_BUDGET, max_ask: 0, max_prepare: 0 }
    : { max_notify: 0, max_ask: 0, max_prepare: 0 };
  return ResidentActivationBudgetSchema.parse({
    ...defaults,
    ...budget,
  });
}

function createInterruptionBudget(input: {
  bindingId: string;
  surface: ResidentActivationSurface;
  budget: ResidentActivationBudget;
  activatedAt: string;
  durationHours: number;
}): ProactiveInterruptionBudget {
  return ProactiveInterruptionBudgetSchema.parse({
    budget_id: `resident-activation-budget:${input.bindingId}`,
    scope: "surface",
    surface: "gateway",
    window_started_at: input.activatedAt,
    window_ends_at: addHoursIso(input.activatedAt, input.durationHours),
    max_notify: input.budget.max_notify,
    max_ask: input.budget.max_ask,
    max_prepare: input.budget.max_prepare,
    current_debits: 0,
    quiet_mode_active: false,
  });
}

function budgetProjection(budget: ProactiveInterruptionBudget): ResidentActivationBudget {
  return {
    max_notify: budget.max_notify,
    max_ask: budget.max_ask,
    max_prepare: budget.max_prepare,
  };
}

function normalSurfaceClaim(maxDeliveryKind: ResidentActivationMaxDeliveryKind): string {
  if (maxDeliveryKind === "notify") {
    return "Resident peer initiatives may send a limited Telegram notification during the dogfood window.";
  }
  if (maxDeliveryKind === "suggest") {
    return "Resident peer initiatives may send low-pressure Telegram suggestions during the dogfood window.";
  }
  return "Resident peer initiatives are collected for digest review during the dogfood window.";
}

function addHoursIso(value: string, hours: number): string {
  return new Date(new Date(value).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function minDelivery(left: ProactiveDeliveryKind, right: ProactiveDeliveryKind): ProactiveDeliveryKind {
  return deliveryKindRank(left) <= deliveryKindRank(right) ? left : right;
}
