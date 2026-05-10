import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  openControlDatabase,
  openControlDatabaseSync,
  resolveControlDbPath,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../../runtime/store/control-db/index.js";
import {
  loadRelationshipProfile,
  saveRelationshipProfile,
  upsertRelationshipProfileItemInStore,
  retractRelationshipProfileItemInStore,
  RelationshipProfileConsentScopeSchema,
  RelationshipProfileItemKindSchema,
  RelationshipProfileSensitivitySchema,
  RelationshipProfileSourceSchema,
  type RelationshipProfileConsentScope,
  type RelationshipProfileItem,
  type RelationshipProfileItemKind,
  type RelationshipProfileSensitivity,
  type RelationshipProfileSource,
} from "./relationship-profile.js";

export const RelationshipProfileProposalOperationSchema = z.enum(["upsert_item", "retract_item"]);
export const RelationshipProfileProposalSourceSchema = z.enum([
  "cli_proposal",
  "setup_import",
  "proactive_feedback",
  "system_migration",
]);
export const RelationshipProfileProposalStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "applied",
  "superseded",
  "expired",
]);

export const RelationshipProfileProposalItemDataSchema = z.object({
  stable_key: z.string().min(1),
  kind: RelationshipProfileItemKindSchema.optional(),
  value: z.string().min(1).optional(),
  sensitivity: RelationshipProfileSensitivitySchema.default("private"),
  allowed_scopes: z.array(RelationshipProfileConsentScopeSchema).min(1).default(["local_planning", "user_facing_review"]),
});

export const RelationshipProfileChangeProposalSchema = z.object({
  id: z.string().min(1),
  operation: RelationshipProfileProposalOperationSchema,
  proposed_item: RelationshipProfileProposalItemDataSchema,
  source: RelationshipProfileProposalSourceSchema,
  confidence: z.number().min(0).max(1).default(0.7),
  sensitivity: RelationshipProfileSensitivitySchema.default("private"),
  consent_scopes: z.array(RelationshipProfileConsentScopeSchema).min(1).default(["user_facing_review"]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
  approval_state: RelationshipProfileProposalStateSchema.default("pending"),
  rejection_reason: z.string().min(1).optional(),
  approval_reason: z.string().min(1).optional(),
  applied_profile_item_id: z.string().min(1).optional(),
  applied_at: z.string().datetime().nullable().default(null),
  expires_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).superRefine((proposal, ctx) => {
  if (proposal.operation === "upsert_item") {
    if (!proposal.proposed_item.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposed_item", "kind"],
        message: "kind is required for upsert proposals",
      });
    }
    if (!proposal.proposed_item.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposed_item", "value"],
        message: "value is required for upsert proposals",
      });
    }
  }
});

export const RelationshipProfileProposalAuditEventSchema = z.object({
  id: z.string().min(1),
  proposal_id: z.string().min(1),
  at: z.string().datetime(),
  action: z.enum(["created", "approved", "rejected", "applied", "superseded", "expired"]),
  reason: z.string().min(1).optional(),
  profile_item_id: z.string().min(1).optional(),
});

export const RelationshipProfileProposalStoreSchema = z.object({
  schema_version: z.literal(1).default(1),
  profile_id: z.string().min(1).default("default"),
  proposals: z.array(RelationshipProfileChangeProposalSchema).default([]),
  audit_events: z.array(RelationshipProfileProposalAuditEventSchema).default([]),
  updated_at: z.string().datetime().nullable().default(null),
});

export type RelationshipProfileProposalOperation = z.infer<typeof RelationshipProfileProposalOperationSchema>;
export type RelationshipProfileProposalSource = z.infer<typeof RelationshipProfileProposalSourceSchema>;
export type RelationshipProfileProposalState = z.infer<typeof RelationshipProfileProposalStateSchema>;
export type RelationshipProfileChangeProposal = z.infer<typeof RelationshipProfileChangeProposalSchema>;
export type RelationshipProfileProposalStore = z.infer<typeof RelationshipProfileProposalStoreSchema>;
export interface RelationshipProfileProposalStoreOptions extends RuntimeControlDbStoreOptions {}

export interface RelationshipProfileProposalInput {
  operation: RelationshipProfileProposalOperation;
  stableKey: string;
  kind?: RelationshipProfileItemKind;
  value?: string;
  source: RelationshipProfileProposalSource;
  confidence?: number;
  sensitivity?: RelationshipProfileSensitivity;
  consentScopes?: RelationshipProfileConsentScope[];
  allowedScopes?: RelationshipProfileConsentScope[];
  evidenceRefs?: string[];
  rationale: string;
  expiresAt?: string | null;
  now?: string;
}

export function createEmptyRelationshipProfileProposalStore(now: string | null = null): RelationshipProfileProposalStore {
  return RelationshipProfileProposalStoreSchema.parse({
    schema_version: 1,
    profile_id: "default",
    proposals: [],
    audit_events: [],
    updated_at: now,
  });
}

export async function loadRelationshipProfileProposalStore(
  baseDir: string,
  options: RelationshipProfileProposalStoreOptions = {},
): Promise<RelationshipProfileProposalStore> {
  if (!controlDbExists(baseDir, options)) {
    return createEmptyRelationshipProfileProposalStore();
  }
  const db = await openRelationshipProfileProposalControlDatabase(baseDir, options);
  try {
    return db.read((sqlite) => readRelationshipProfileProposalStore(sqlite));
  } finally {
    if (!options.controlDb) {
      db.close();
    }
  }
}

export function loadRelationshipProfileProposalStoreSync(
  baseDir: string,
  options: RelationshipProfileProposalStoreOptions = {},
): RelationshipProfileProposalStore {
  if (!controlDbExists(baseDir, options)) {
    return createEmptyRelationshipProfileProposalStore();
  }
  const db = openRelationshipProfileProposalControlDatabaseSync(baseDir, options);
  try {
    return db.read((sqlite) => readRelationshipProfileProposalStore(sqlite));
  } finally {
    if (!options.controlDb) {
      db.close();
    }
  }
}

export async function saveRelationshipProfileProposalStore(
  baseDir: string,
  store: RelationshipProfileProposalStore,
  options: RelationshipProfileProposalStoreOptions = {},
): Promise<void> {
  const parsed = RelationshipProfileProposalStoreSchema.parse(store);
  const db = await openRelationshipProfileProposalControlDatabase(baseDir, options);
  try {
    db.transaction((sqlite) => replaceRelationshipProfileProposalStore(sqlite, parsed));
  } finally {
    if (!options.controlDb) {
      db.close();
    }
  }
}

function controlDbExists(baseDir: string, options: RelationshipProfileProposalStoreOptions): boolean {
  if (options.controlDb) return true;
  return existsSync(resolveControlDbPath({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  }));
}

function openRelationshipProfileProposalControlDatabase(
  baseDir: string,
  options: RelationshipProfileProposalStoreOptions,
): Promise<ControlDatabase> {
  if (options.controlDb) {
    return Promise.resolve(options.controlDb);
  }
  return openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
}

function openRelationshipProfileProposalControlDatabaseSync(
  baseDir: string,
  options: RelationshipProfileProposalStoreOptions,
): ControlDatabase {
  if (options.controlDb) {
    return options.controlDb;
  }
  return openControlDatabaseSync({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function readRelationshipProfileProposalStore(sqlite: SqliteDatabase): RelationshipProfileProposalStore {
  const metadata = sqlite.prepare(`
    SELECT profile_id, updated_at
    FROM relationship_profile_proposal_metadata
    WHERE profile_id = 'default'
  `).get() as { profile_id: string; updated_at: string | null } | undefined;

  if (!metadata) {
    return createEmptyRelationshipProfileProposalStore();
  }

  const proposalRows = sqlite.prepare(`
    SELECT proposal_json
    FROM relationship_profile_proposals
    WHERE profile_id = ?
    ORDER BY sort_order ASC, created_at ASC, proposal_id ASC
  `).all(metadata.profile_id) as Array<{ proposal_json: string }>;
  const eventRows = sqlite.prepare(`
    SELECT event_json
    FROM relationship_profile_proposal_audit_events
    ORDER BY sort_order ASC, event_timestamp ASC, event_id ASC
  `).all() as Array<{ event_json: string }>;

  return RelationshipProfileProposalStoreSchema.parse({
    schema_version: 1,
    profile_id: metadata.profile_id,
    proposals: proposalRows.map((row) =>
      RelationshipProfileChangeProposalSchema.parse(parseJson<unknown>(row.proposal_json))
    ),
    audit_events: eventRows.map((row) =>
      RelationshipProfileProposalAuditEventSchema.parse(parseJson<unknown>(row.event_json))
    ),
    updated_at: metadata.updated_at,
  });
}

function replaceRelationshipProfileProposalStore(
  sqlite: SqliteDatabase,
  store: RelationshipProfileProposalStore,
): void {
  sqlite.prepare("DELETE FROM relationship_profile_proposal_audit_events").run();
  sqlite.prepare("DELETE FROM relationship_profile_proposals").run();
  sqlite.prepare("DELETE FROM relationship_profile_proposal_metadata").run();

  sqlite.prepare(`
    INSERT INTO relationship_profile_proposal_metadata (profile_id, updated_at, store_json)
    VALUES (?, ?, json(?))
  `).run(store.profile_id, store.updated_at, stringifyJson(store));

  const insertProposal = sqlite.prepare(`
    INSERT INTO relationship_profile_proposals (
      proposal_id,
      profile_id,
      operation,
      approval_state,
      source,
      stable_key,
      created_at,
      updated_at,
      expires_at,
      sort_order,
      proposal_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `);
  store.proposals.forEach((proposal, index) => {
    insertProposal.run(
      proposal.id,
      store.profile_id,
      proposal.operation,
      proposal.approval_state,
      proposal.source,
      proposal.proposed_item.stable_key,
      proposal.created_at,
      proposal.updated_at,
      proposal.expires_at,
      index,
      stringifyJson(proposal),
    );
  });

  const insertEvent = sqlite.prepare(`
    INSERT INTO relationship_profile_proposal_audit_events (
      event_id,
      proposal_id,
      event_timestamp,
      action,
      sort_order,
      event_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
  `);
  store.audit_events.forEach((event, index) => {
    insertEvent.run(
      event.id,
      event.proposal_id,
      event.at,
      event.action,
      index,
      stringifyJson(event),
    );
  });
}

function normalizeProposalInput(input: RelationshipProfileProposalInput): RelationshipProfileProposalInput & {
  stableKey: string;
  rationale: string;
  confidence: number;
  sensitivity: RelationshipProfileSensitivity;
  consentScopes: RelationshipProfileConsentScope[];
  allowedScopes: RelationshipProfileConsentScope[];
  evidenceRefs: string[];
  now: string;
} {
  const stableKey = input.stableKey.trim();
  const rationale = input.rationale.trim();
  const value = input.value?.trim();
  if (!stableKey) throw new Error("stable key is required");
  if (!rationale) throw new Error("proposal rationale is required");
  if (input.operation === "upsert_item") {
    if (!input.kind) throw new Error("kind is required for upsert proposals");
    if (!value) throw new Error("value is required for upsert proposals");
  }
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("proposal confidence must be between 0 and 1");
  }
  const consentScopes: RelationshipProfileConsentScope[] = input.consentScopes && input.consentScopes.length > 0
    ? [...new Set(input.consentScopes)]
    : ["user_facing_review"];
  const allowedScopes: RelationshipProfileConsentScope[] = input.allowedScopes && input.allowedScopes.length > 0
    ? [...new Set(input.allowedScopes)]
    : ["local_planning", "user_facing_review"];
  return {
    ...input,
    stableKey,
    ...(value ? { value } : {}),
    rationale,
    confidence: input.confidence ?? 0.7,
    sensitivity: input.sensitivity ?? "private",
    consentScopes,
    allowedScopes,
    evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
    now: input.now ?? new Date().toISOString(),
  };
}

export function createRelationshipProfileChangeProposalInStore(
  store: RelationshipProfileProposalStore,
  input: RelationshipProfileProposalInput
): { store: RelationshipProfileProposalStore; proposal: RelationshipProfileChangeProposal } {
  const normalized = normalizeProposalInput(input);
  const id = `profile-proposal-${randomUUID()}`;
  const proposal = RelationshipProfileChangeProposalSchema.parse({
    id,
    operation: normalized.operation,
    proposed_item: {
      stable_key: normalized.stableKey,
      ...(normalized.kind ? { kind: normalized.kind } : {}),
      ...(normalized.value ? { value: normalized.value } : {}),
      sensitivity: normalized.sensitivity,
      allowed_scopes: normalized.allowedScopes,
    },
    source: normalized.source,
    confidence: normalized.confidence,
    sensitivity: normalized.sensitivity,
    consent_scopes: normalized.consentScopes,
    evidence_refs: normalized.evidenceRefs,
    rationale: normalized.rationale,
    approval_state: "pending",
    expires_at: normalized.expiresAt ?? null,
    created_at: normalized.now,
    updated_at: normalized.now,
  });
  const event = RelationshipProfileProposalAuditEventSchema.parse({
    id: `profile-proposal-event-${randomUUID()}`,
    proposal_id: proposal.id,
    at: normalized.now,
    action: "created",
  });
  return {
    store: RelationshipProfileProposalStoreSchema.parse({
      ...store,
      proposals: [...store.proposals, proposal],
      audit_events: [...store.audit_events, event],
      updated_at: normalized.now,
    }),
    proposal,
  };
}

export async function createRelationshipProfileChangeProposal(
  baseDir: string,
  input: RelationshipProfileProposalInput
): Promise<{ proposal: RelationshipProfileChangeProposal }> {
  const loaded = await loadRelationshipProfileProposalStore(baseDir);
  const result = createRelationshipProfileChangeProposalInStore(loaded, input);
  await saveRelationshipProfileProposalStore(baseDir, result.store);
  return { proposal: result.proposal };
}

function transitionProposal(
  store: RelationshipProfileProposalStore,
  proposalId: string,
  toState: RelationshipProfileProposalState,
  action: z.infer<typeof RelationshipProfileProposalAuditEventSchema>["action"],
  params: { reason?: string; profileItemId?: string; now?: string } = {}
): { store: RelationshipProfileProposalStore; proposal: RelationshipProfileChangeProposal } {
  const id = proposalId.trim();
  if (!id) throw new Error("proposal id is required");
  const now = params.now ?? new Date().toISOString();
  const existing = store.proposals.find((proposal) => proposal.id === id);
  if (!existing) throw new Error(`relationship profile proposal not found: ${id}`);
  const terminalStates: RelationshipProfileProposalState[] = ["rejected", "applied", "superseded", "expired"];
  if (terminalStates.includes(existing.approval_state)) {
    throw new Error(`cannot transition ${existing.approval_state} proposal: ${id}`);
  }
  if (toState === "approved" && existing.approval_state !== "pending") {
    throw new Error(`only pending proposals can be approved: ${id}`);
  }
  if (toState === "rejected" && existing.approval_state !== "pending") {
    throw new Error(`only pending proposals can be rejected: ${id}`);
  }
  if (toState === "applied" && existing.approval_state !== "approved") {
    throw new Error(`only approved proposals can be applied: ${id}`);
  }

  let updatedProposal: RelationshipProfileChangeProposal | null = null;
  const proposals = store.proposals.map((proposal) => {
    if (proposal.id !== id) return proposal;
    updatedProposal = RelationshipProfileChangeProposalSchema.parse({
      ...proposal,
      approval_state: toState,
      ...(toState === "approved" && params.reason ? { approval_reason: params.reason } : {}),
      ...(toState === "rejected" && params.reason ? { rejection_reason: params.reason } : {}),
      ...(toState === "applied" ? {
        applied_profile_item_id: params.profileItemId,
        applied_at: now,
      } : {}),
      updated_at: now,
    });
    return updatedProposal;
  });
  const event = RelationshipProfileProposalAuditEventSchema.parse({
    id: `profile-proposal-event-${randomUUID()}`,
    proposal_id: id,
    at: now,
    action,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.profileItemId ? { profile_item_id: params.profileItemId } : {}),
  });
  return {
    store: RelationshipProfileProposalStoreSchema.parse({
      ...store,
      proposals,
      audit_events: [...store.audit_events, event],
      updated_at: now,
    }),
    proposal: updatedProposal ?? existing,
  };
}

export async function approveRelationshipProfileChangeProposal(
  baseDir: string,
  proposalId: string,
  params: { reason?: string; now?: string } = {}
): Promise<{ proposal: RelationshipProfileChangeProposal }> {
  const loaded = await loadRelationshipProfileProposalStore(baseDir);
  const result = transitionProposal(loaded, proposalId, "approved", "approved", params);
  await saveRelationshipProfileProposalStore(baseDir, result.store);
  return { proposal: result.proposal };
}

export async function rejectRelationshipProfileChangeProposal(
  baseDir: string,
  proposalId: string,
  params: { reason: string; now?: string }
): Promise<{ proposal: RelationshipProfileChangeProposal }> {
  const loaded = await loadRelationshipProfileProposalStore(baseDir);
  const result = transitionProposal(loaded, proposalId, "rejected", "rejected", params);
  await saveRelationshipProfileProposalStore(baseDir, result.store);
  return { proposal: result.proposal };
}

function profileSourceForProposal(source: RelationshipProfileProposalSource): RelationshipProfileSource {
  if (source === "setup_import") return "setup_import";
  if (source === "system_migration") return "system_migration";
  return "user_correction";
}

export async function applyRelationshipProfileChangeProposal(
  baseDir: string,
  proposalId: string,
  params: { now?: string } = {}
): Promise<{ proposal: RelationshipProfileChangeProposal; item: RelationshipProfileItem }> {
  const proposalStore = await loadRelationshipProfileProposalStore(baseDir);
  const proposal = proposalStore.proposals.find((candidate) => candidate.id === proposalId.trim());
  if (!proposal) throw new Error(`relationship profile proposal not found: ${proposalId}`);
  const now = params.now ?? new Date().toISOString();
  const profileStore = await loadRelationshipProfile(baseDir);
  const linkedProfileEvents = profileStore.audit_events.filter((event) => event.proposal_id === proposal.id);
  const recoveredProfileEvent = proposal.applied_profile_item_id
    ? linkedProfileEvents.find((event) => event.item_id === proposal.applied_profile_item_id)
    : linkedProfileEvents.find((event) => {
      if (proposal.operation === "upsert_item") return event.action === "created" || event.action === "seeded";
      return event.action === "retracted";
    });
  if (recoveredProfileEvent) {
    const recoveredItem = profileStore.items.find((item) => item.id === recoveredProfileEvent.item_id);
    if (!recoveredItem) {
      throw new Error(`proposal ${proposal.id} is linked to missing profile item ${recoveredProfileEvent.item_id}`);
    }
    if (proposal.approval_state === "applied") {
      return { proposal, item: recoveredItem };
    }
    if (proposal.approval_state === "approved") {
      const proposalResult = transitionProposal(proposalStore, proposal.id, "applied", "applied", {
        profileItemId: recoveredItem.id,
        now,
      });
      await saveRelationshipProfileProposalStore(baseDir, proposalResult.store);
      return { proposal: proposalResult.proposal, item: recoveredItem };
    }
  }
  if (proposal.approval_state !== "approved") {
    throw new Error(`only approved proposals can be applied: ${proposalId}`);
  }
  if (proposal.source === "setup_import") {
    const newerActiveItem = profileStore.items.find((item) =>
      item.stable_key === proposal.proposed_item.stable_key &&
      item.status === "active" &&
      item.created_at > proposal.created_at
    );
    if (newerActiveItem) {
      throw new Error(`stale setup import proposal cannot overwrite newer active profile item: ${proposal.id}`);
    }
  }
  let profileResult;
  if (proposal.operation === "upsert_item") {
    const kind = proposal.proposed_item.kind;
    const value = proposal.proposed_item.value;
    if (!kind || !value) {
      throw new Error(`invalid upsert proposal missing kind or value: ${proposal.id}`);
    }
    profileResult = upsertRelationshipProfileItemInStore(profileStore, {
      stableKey: proposal.proposed_item.stable_key,
      kind,
      value,
      source: profileSourceForProposal(proposal.source),
      confidence: proposal.confidence,
      sensitivity: proposal.proposed_item.sensitivity,
      allowedScopes: proposal.proposed_item.allowed_scopes,
      evidenceRef: proposal.evidence_refs[0],
      note: proposal.rationale,
      proposalId: proposal.id,
      now,
    });
  } else {
    profileResult = retractRelationshipProfileItemInStore(profileStore, {
      stableKey: proposal.proposed_item.stable_key,
      reason: proposal.rationale,
      source: profileSourceForProposal(proposal.source),
      proposalId: proposal.id,
      now,
    });
  }
  const item = profileResult.item;
  const proposalResult = transitionProposal(proposalStore, proposal.id, "applied", "applied", {
    profileItemId: item.id,
    now,
  });
  await saveRelationshipProfile(baseDir, profileResult.store);
  await saveRelationshipProfileProposalStore(baseDir, proposalResult.store);
  return { proposal: proposalResult.proposal, item };
}
