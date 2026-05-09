import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";

export const RelationshipProfileItemKindSchema = z.enum([
  "identity_fact",
  "preference",
  "dislike",
  "value",
  "boundary",
  "communication_style",
  "notification_preference",
  "long_term_goal",
  "life_context",
  "intervention_policy",
]);

export const RelationshipProfileConsentScopeSchema = z.enum([
  "local_planning",
  "resident_behavior",
  "memory_retrieval",
  "user_facing_review",
]);

export const RelationshipProfileSensitivitySchema = z.enum(["public", "private", "sensitive"]);
export const RelationshipProfileItemStatusSchema = z.enum(["active", "superseded", "retracted"]);
export const RelationshipProfileSourceSchema = z.enum([
  "setup_user",
  "setup_import",
  "cli_update",
  "user_correction",
  "system_migration",
]);
const RelationshipProfilePositiveSafeIntSchema = z.number().int().positive().safe();

export const RelationshipProfileItemSchema = z.object({
  id: z.string().min(1),
  stable_key: z.string().min(1),
  kind: RelationshipProfileItemKindSchema,
  value: z.string().min(1),
  status: RelationshipProfileItemStatusSchema.default("active"),
  version: RelationshipProfilePositiveSafeIntSchema,
  confidence: z.number().min(0).max(1).default(0.8),
  sensitivity: RelationshipProfileSensitivitySchema.default("private"),
  allowed_scopes: z.array(RelationshipProfileConsentScopeSchema).min(1).default(["local_planning", "user_facing_review"]),
  provenance: z.object({
    source: RelationshipProfileSourceSchema,
    evidence_ref: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  superseded_at: z.string().datetime().nullable().default(null),
  superseded_by: z.string().nullable().default(null),
});

export const RelationshipProfileAuditEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime(),
  action: z.enum(["created", "superseded", "retracted", "seeded"]),
  item_id: z.string().min(1),
  stable_key: z.string().min(1),
  version: RelationshipProfilePositiveSafeIntSchema,
  source: RelationshipProfileSourceSchema,
  previous_item_id: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  proposal_id: z.string().min(1).optional(),
});

export const RelationshipProfileStoreSchema = z.object({
  schema_version: z.literal(1).default(1),
  profile_id: z.string().min(1).default("default"),
  items: z.array(RelationshipProfileItemSchema).default([]),
  audit_events: z.array(RelationshipProfileAuditEventSchema).default([]),
  updated_at: z.string().datetime().nullable().default(null),
});

export type RelationshipProfileItemKind = z.infer<typeof RelationshipProfileItemKindSchema>;
export type RelationshipProfileConsentScope = z.infer<typeof RelationshipProfileConsentScopeSchema>;
export type RelationshipProfileSensitivity = z.infer<typeof RelationshipProfileSensitivitySchema>;
export type RelationshipProfileSource = z.infer<typeof RelationshipProfileSourceSchema>;
export type RelationshipProfileItem = z.infer<typeof RelationshipProfileItemSchema>;
export type RelationshipProfileStore = z.infer<typeof RelationshipProfileStoreSchema>;

export interface RelationshipProfileItemInput {
  stableKey: string;
  kind: RelationshipProfileItemKind;
  value: string;
  source: RelationshipProfileSource;
  confidence?: number;
  sensitivity?: RelationshipProfileSensitivity;
  allowedScopes?: RelationshipProfileConsentScope[];
  evidenceRef?: string;
  note?: string;
  proposalId?: string;
  now?: string;
}

export interface RelationshipProfileRetractionInput {
  stableKey: string;
  reason: string;
  source?: RelationshipProfileSource;
  proposalId?: string;
  now?: string;
}

export function relationshipProfilePath(baseDir: string): string {
  return path.join(baseDir, "relationship-profile.json");
}

export function createEmptyRelationshipProfile(now: string | null = null): RelationshipProfileStore {
  return RelationshipProfileStoreSchema.parse({
    schema_version: 1,
    profile_id: "default",
    items: [],
    audit_events: [],
    updated_at: now,
  });
}

export async function loadRelationshipProfile(baseDir: string): Promise<RelationshipProfileStore> {
  const raw = await readJsonFileOrNull(relationshipProfilePath(baseDir));
  const parsed = RelationshipProfileStoreSchema.safeParse(raw);
  return parsed.success ? parsed.data : createEmptyRelationshipProfile();
}

export function loadRelationshipProfileSync(baseDir: string): RelationshipProfileStore {
  try {
    const raw = JSON.parse(fs.readFileSync(relationshipProfilePath(baseDir), "utf-8")) as unknown;
    const parsed = RelationshipProfileStoreSchema.safeParse(raw);
    return parsed.success ? parsed.data : createEmptyRelationshipProfile();
  } catch {
    return createEmptyRelationshipProfile();
  }
}

export async function saveRelationshipProfile(baseDir: string, store: RelationshipProfileStore): Promise<void> {
  await writeJsonFileAtomic(relationshipProfilePath(baseDir), RelationshipProfileStoreSchema.parse(store), {
    mode: 0o600,
    directoryMode: 0o700,
  });
}

function normalizeProfileInput(input: RelationshipProfileItemInput): RelationshipProfileItemInput {
  const stableKey = input.stableKey.trim();
  const value = input.value.trim();
  if (!stableKey) throw new Error("stable key is required");
  if (!value) throw new Error("profile value is required");
  const allowedScopes: RelationshipProfileConsentScope[] = input.allowedScopes && input.allowedScopes.length > 0
    ? [...new Set(input.allowedScopes)]
    : ["local_planning", "user_facing_review"];
  return { ...input, stableKey, value, allowedScopes };
}

function nextVersion(store: RelationshipProfileStore, stableKey: string): number {
  return store.items
    .filter((item) => item.stable_key === stableKey)
    .reduce((max, item) => Math.max(max, item.version), 0) + 1;
}

export function upsertRelationshipProfileItemInStore(
  store: RelationshipProfileStore,
  input: RelationshipProfileItemInput
): { store: RelationshipProfileStore; item: RelationshipProfileItem; superseded: RelationshipProfileItem[] } {
  const normalized = normalizeProfileInput(input);
  const now = normalized.now ?? new Date().toISOString();
  const itemId = `profile-item-${randomUUID()}`;
  const superseded: RelationshipProfileItem[] = [];

  const items = store.items.map((item) => {
    if (item.stable_key !== normalized.stableKey || item.status !== "active") return item;
    const updated = RelationshipProfileItemSchema.parse({
      ...item,
      status: "superseded",
      superseded_at: now,
      superseded_by: itemId,
      updated_at: now,
    });
    superseded.push(updated);
    return updated;
  });

  const item = RelationshipProfileItemSchema.parse({
    id: itemId,
    stable_key: normalized.stableKey,
    kind: normalized.kind,
    value: normalized.value,
    status: "active",
    version: nextVersion(store, normalized.stableKey),
    confidence: normalized.confidence ?? 0.8,
    sensitivity: normalized.sensitivity ?? "private",
    allowed_scopes: normalized.allowedScopes,
    provenance: {
      source: normalized.source,
      ...(normalized.evidenceRef ? { evidence_ref: normalized.evidenceRef } : {}),
      ...(normalized.note ? { note: normalized.note } : {}),
    },
    created_at: now,
    updated_at: now,
    superseded_at: null,
    superseded_by: null,
  });

  const auditEvents = [
    ...store.audit_events,
    ...superseded.map((previous) => RelationshipProfileAuditEventSchema.parse({
      id: `profile-event-${randomUUID()}`,
      at: now,
      action: "superseded",
      item_id: previous.id,
      stable_key: previous.stable_key,
      version: previous.version,
      source: normalized.source,
      previous_item_id: previous.id,
      ...(normalized.proposalId ? { proposal_id: normalized.proposalId } : {}),
    })),
    RelationshipProfileAuditEventSchema.parse({
      id: `profile-event-${randomUUID()}`,
      at: now,
      action: store.items.some((existing) => existing.stable_key === normalized.stableKey) ? "created" : "seeded",
      item_id: item.id,
      stable_key: item.stable_key,
      version: item.version,
      source: normalized.source,
      previous_item_id: superseded.at(-1)?.id,
      ...(normalized.proposalId ? { proposal_id: normalized.proposalId } : {}),
    }),
  ];

  return {
    store: RelationshipProfileStoreSchema.parse({
      ...store,
      items: [...items, item],
      audit_events: auditEvents,
      updated_at: now,
    }),
    item,
    superseded,
  };
}

export async function upsertRelationshipProfileItem(
  baseDir: string,
  input: RelationshipProfileItemInput
): Promise<{ item: RelationshipProfileItem; superseded: RelationshipProfileItem[] }> {
  const loaded = await loadRelationshipProfile(baseDir);
  const result = upsertRelationshipProfileItemInStore(loaded, input);
  await saveRelationshipProfile(baseDir, result.store);
  return { item: result.item, superseded: result.superseded };
}

function normalizeRetractionInput(input: RelationshipProfileRetractionInput): RelationshipProfileRetractionInput & {
  stableKey: string;
  reason: string;
  source: RelationshipProfileSource;
  now: string;
} {
  const stableKey = input.stableKey.trim();
  const reason = input.reason.trim();
  if (!stableKey) throw new Error("stable key is required");
  if (!reason) throw new Error("retraction reason is required");
  return {
    stableKey,
    reason,
    source: input.source ?? "cli_update",
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    now: input.now ?? new Date().toISOString(),
  };
}

export function retractRelationshipProfileItemInStore(
  store: RelationshipProfileStore,
  input: RelationshipProfileRetractionInput
): { store: RelationshipProfileStore; item: RelationshipProfileItem } {
  const normalized = normalizeRetractionInput(input);
  const active = store.items.filter((item) => item.stable_key === normalized.stableKey && item.status === "active");
  if (active.length === 0) {
    throw new Error(`no active relationship profile item found for key: ${normalized.stableKey}`);
  }
  if (active.length > 1) {
    throw new Error(`multiple active relationship profile items found for key: ${normalized.stableKey}`);
  }

  const target = active[0]!;
  let retracted: RelationshipProfileItem | null = null;
  const items = store.items.map((item) => {
    if (item.id !== target.id) return item;
    retracted = RelationshipProfileItemSchema.parse({
      ...item,
      status: "retracted",
      updated_at: normalized.now,
    });
    return retracted;
  });

  const event = RelationshipProfileAuditEventSchema.parse({
    id: `profile-event-${randomUUID()}`,
    at: normalized.now,
    action: "retracted",
    item_id: target.id,
    stable_key: target.stable_key,
    version: target.version,
    source: normalized.source,
    reason: normalized.reason,
    ...(normalized.proposalId ? { proposal_id: normalized.proposalId } : {}),
  });

  return {
    store: RelationshipProfileStoreSchema.parse({
      ...store,
      items,
      audit_events: [...store.audit_events, event],
      updated_at: normalized.now,
    }),
    item: retracted ?? target,
  };
}

export async function retractRelationshipProfileItem(
  baseDir: string,
  input: RelationshipProfileRetractionInput
): Promise<{ item: RelationshipProfileItem }> {
  const loaded = await loadRelationshipProfile(baseDir);
  const result = retractRelationshipProfileItemInStore(loaded, input);
  await saveRelationshipProfile(baseDir, result.store);
  return { item: result.item };
}

export function getRelationshipProfileHistory(
  store: RelationshipProfileStore,
  stableKey: string
): { stable_key: string; items: RelationshipProfileItem[]; audit_events: z.infer<typeof RelationshipProfileAuditEventSchema>[] } {
  const key = stableKey.trim();
  if (!key) throw new Error("stable key is required");
  return {
    stable_key: key,
    items: store.items
      .filter((item) => item.stable_key === key)
      .sort((a, b) => a.version - b.version),
    audit_events: store.audit_events
      .filter((event) => event.stable_key === key)
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}

export function selectActiveRelationshipProfileItems(
  store: RelationshipProfileStore,
  scope: RelationshipProfileConsentScope,
  options: { includeSensitive?: boolean } = {}
): RelationshipProfileItem[] {
  return store.items
    .filter((item) => item.status === "active")
    .filter((item) => item.allowed_scopes.includes(scope))
    .filter((item) => options.includeSensitive === true || item.sensitivity !== "sensitive")
    .sort((a, b) => {
      const kindCompare = a.kind.localeCompare(b.kind);
      if (kindCompare !== 0) return kindCompare;
      return a.stable_key.localeCompare(b.stable_key);
    });
}

export function formatRelationshipProfilePromptBlock(
  store: RelationshipProfileStore,
  scope: RelationshipProfileConsentScope,
  options: { includeSensitive?: boolean } = {}
): string {
  const activeItems = selectActiveRelationshipProfileItems(store, scope, options);
  if (activeItems.length === 0) return "";
  const lines = [
    `Relationship Profile (active items only; consent scope: ${scope})`,
    "- Use these items as user-provided relationship context.",
    "- Ignore superseded or retracted profile items even if they appear in older memory.",
    ...activeItems.map((item) => {
      const confidence = item.confidence.toFixed(2);
      return `- [${item.kind}] ${item.stable_key}: ${item.value} (confidence=${confidence}; sensitivity=${item.sensitivity}; status=${item.status}; version=${item.version})`;
    }),
  ];
  return lines.join("\n");
}

export function loadRelationshipProfilePromptBlock(
  baseDir: string,
  scope: RelationshipProfileConsentScope,
  options: { includeSensitive?: boolean } = {}
): string {
  return formatRelationshipProfilePromptBlock(loadRelationshipProfileSync(baseDir), scope, options);
}

export async function seedRelationshipProfileFromSetup(params: {
  baseDir: string;
  userName?: string;
  importedUserContent?: string;
  now?: string;
}): Promise<RelationshipProfileStore> {
  const store = await loadRelationshipProfile(params.baseDir);
  let next = store;
  const now = params.now ?? new Date().toISOString();

  const userName = params.userName?.trim();
  if (userName && userName !== "Imported USER.md") {
    next = upsertRelationshipProfileItemInStore(next, {
      stableKey: "user.identity.name",
      kind: "identity_fact",
      value: userName,
      source: "setup_user",
      confidence: 0.9,
      sensitivity: "private",
      allowedScopes: ["local_planning", "resident_behavior", "memory_retrieval", "user_facing_review"],
      evidenceRef: "setup:userName",
      now,
    }).store;
  }

  const imported = params.importedUserContent?.trim();
  if (imported) {
    next = upsertRelationshipProfileItemInStore(next, {
      stableKey: "user.imported_user_md",
      kind: "life_context",
      value: imported,
      source: "setup_import",
      confidence: 0.7,
      sensitivity: "private",
      allowedScopes: ["user_facing_review"],
      evidenceRef: "setup:USER.md",
      note: "Imported raw USER.md remains compatible as USER.md and is review-only until structured profile items are explicitly added.",
      now,
    }).store;
  }

  if (next !== store) {
    await saveRelationshipProfile(params.baseDir, next);
  } else {
    await fsp.mkdir(params.baseDir, { recursive: true });
  }
  return next;
}
