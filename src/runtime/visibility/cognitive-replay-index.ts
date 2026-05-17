import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v3";
import {
  withJsonFileMutationLock,
  writeJsonFileAtomic,
} from "../../base/utils/json-io.js";
import {
  CognitionEventRefSchema,
  CognitionRefSchema,
  CognitionReplayRecordSchema,
  CognitionRedactionPolicySchema,
  CognitionSourceStoreSchema,
  CompanionCognitionCallerPathSchema,
  CompanionCognitionSurfaceTargetSchema,
  type CognitionEventRef,
  type CognitionReplayRecord,
  type CognitionSourceStore,
  type CompanionCognitionCallerPath,
  type CompanionCognitionSurfaceTarget,
} from "../cognition/contracts.js";
import { cognitionAuditEventRef } from "../cognition/audit-sink.js";

export const CognitiveReplayIndexSourceStateSchema = z.enum([
  "current",
  "missing_source",
  "deleted_or_tombstoned",
]);
export type CognitiveReplayIndexSourceState = z.infer<typeof CognitiveReplayIndexSourceStateSchema>;

export const CognitiveReplayIndexInvalidationStateSchema = z.enum([
  "valid",
  "invalidated",
  "failed_closed",
]);
export type CognitiveReplayIndexInvalidationState = z.infer<typeof CognitiveReplayIndexInvalidationStateSchema>;

export const CognitiveReplayIndexEntrySchema = z.object({
  schema_version: z.literal("cognitive-replay-index-entry/v1"),
  index_entry_id: z.string().min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  owner_store: CognitionSourceStoreSchema,
  owner_ref: CognitionEventRefSchema,
  cognition_replay_ref: CognitionEventRefSchema,
  created_at: z.string().datetime(),
  source_refs: z.array(CognitionEventRefSchema).min(1),
  source_state: CognitiveReplayIndexSourceStateSchema.default("current"),
  invalidation_state: CognitiveReplayIndexInvalidationStateSchema.default("valid"),
  invalidation_refs: z.array(CognitionEventRefSchema).default([]),
  fail_closed_reason: z.string().min(1).optional(),
  retention_policy: z.object({
    materialized_content: z.literal(false).default(false),
    refs_only: z.literal(true).default(true),
    invalidates_on_source_tombstone: z.literal(true).default(true),
  }).strict().default({}),
  redaction_policy: CognitionRedactionPolicySchema,
  normal_surface_visible: z.literal(false).default(false),
  operator_inspectable: z.literal(true).default(true),
  cognition_service_is_owner: z.literal(false).default(false),
}).strict().superRefine((entry, ctx) => {
  if (!ownerStoreAllowedForCallerPath(entry.caller_path, entry.owner_store)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["owner_store"],
      message: `owner store ${entry.owner_store} is not valid for caller path ${entry.caller_path}`,
    });
  }
  if (entry.cognition_replay_ref.source_store !== "cognition_audit") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cognition_replay_ref", "source_store"],
      message: "replay index entries must point to a cognition_audit replay ref",
    });
  }
  if (entry.source_state !== "current" && entry.invalidation_state === "valid") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invalidation_state"],
      message: "missing, deleted, or tombstoned source refs must invalidate or fail closed",
    });
  }
  if (entry.invalidation_state !== "valid" && entry.source_state === "current") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_state"],
      message: "invalidated replay index entries cannot keep current source state",
    });
  }
  if (entry.source_state !== "current" && entry.redaction_policy !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_policy"],
      message: "invalidated replay index entries must use redacted inspection policy",
    });
  }
  if (entry.invalidation_state !== "failed_closed" && entry.fail_closed_reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fail_closed_reason"],
      message: "fail-closed reason must be present only while replay invalidation is failed closed",
    });
  }
  if (
    (entry.invalidation_state === "invalidated" || entry.invalidation_state === "failed_closed")
    && entry.invalidation_refs.length === 0
    && !entry.fail_closed_reason
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invalidation_refs"],
      message: "invalidated replay index entries require invalidation refs or a fail-closed reason",
    });
  }
});
export type CognitiveReplayIndexEntry = z.infer<typeof CognitiveReplayIndexEntrySchema>;

export interface CognitiveReplayIndexStore {
  upsert(entry: CognitiveReplayIndexEntry): Promise<CognitiveReplayIndexEntry>;
  list(): Promise<CognitiveReplayIndexEntry[]>;
}

export const CognitiveReplayInspectionItemSchema = z.object({
  index_entry_id: z.string().min(1),
  cognition_id: z.string().min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  owner_store: CognitionSourceStoreSchema,
  replay_record_ref: CognitionEventRefSchema,
  source_refs: z.array(CognitionEventRefSchema).default([]),
  invalidation_state: CognitiveReplayIndexInvalidationStateSchema,
  redaction_policy: CognitionRedactionPolicySchema,
  response_plan_ref: CognitionRefSchema.optional(),
  tool_authority_stages: z.array(z.enum(["read", "suggest", "prepare", "execute"])).default([]),
  writeback_proposal_refs: z.array(CognitionRefSchema).default([]),
  raw_content_visible: z.literal(false).default(false),
  debug_refs_visible: z.boolean().default(false),
}).strict();
export type CognitiveReplayInspectionItem = z.infer<typeof CognitiveReplayInspectionItemSchema>;

export const CognitiveReplayInspectionViewSchema = z.object({
  schema_version: z.literal("cognitive-replay-inspection-view/v1"),
  view_id: z.string().min(1),
  surface_target: CompanionCognitionSurfaceTargetSchema,
  items: z.array(CognitiveReplayInspectionItemSchema).default([]),
  normal_surface_debug_visible: z.literal(false).default(false),
  raw_memory_visible: z.literal(false).default(false),
  raw_prompt_visible: z.literal(false).default(false),
}).strict().superRefine((view, ctx) => {
  if (view.surface_target === "normal_user") {
    for (const [index, item] of view.items.entries()) {
      if (item.debug_refs_visible) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "debug_refs_visible"],
          message: "normal user replay inspection cannot expose debug refs",
        });
      }
    }
  }
});
export type CognitiveReplayInspectionView = z.infer<typeof CognitiveReplayInspectionViewSchema>;

const OWNER_STORES_BY_CALLER_PATH: Record<CompanionCognitionCallerPath, readonly CognitionSourceStore[]> = {
  chat_user_turn: ["chat_history", "chat_events"],
  resident_proactive_check: ["attention_ledger", "proactive_intervention"],
  long_running_task_turn: ["runtime_operation"],
  schedule_wake: ["schedule", "runtime_event_log"],
  runtime_control_response: ["runtime_operation", "runtime_event_log"],
  memory_truth_operation: ["memory_truth", "profile", "knowledge", "soil"],
};

export function ownerStoreAllowedForCallerPath(
  callerPath: CompanionCognitionCallerPath,
  ownerStore: CognitionSourceStore
): boolean {
  return OWNER_STORES_BY_CALLER_PATH[callerPath].includes(ownerStore);
}

export function defaultCognitiveReplayOwnerStore(
  callerPath: CompanionCognitionCallerPath
): CognitionSourceStore {
  return OWNER_STORES_BY_CALLER_PATH[callerPath][0]!;
}

export function createCognitiveReplayIndexEntry(input: {
  indexEntryId: string;
  record: CognitionReplayRecord;
  createdAt?: string;
  ownerRef?: CognitionEventRef;
  sourceState?: CognitiveReplayIndexSourceState;
  invalidationRefs?: CognitionEventRef[];
  failClosedReason?: string;
}): CognitiveReplayIndexEntry {
  const record = CognitionReplayRecordSchema.parse(input.record);
  const ownerRef = input.ownerRef ?? defaultOwnerRefForRecord(record);
  const sourceState = input.sourceState ?? "current";
  const invalidationRefs = input.invalidationRefs ?? [];
  const invalidationState = sourceState === "current"
    ? "valid"
    : sourceState === "deleted_or_tombstoned"
      ? "invalidated"
      : "failed_closed";

  return CognitiveReplayIndexEntrySchema.parse({
    schema_version: "cognitive-replay-index-entry/v1",
    index_entry_id: input.indexEntryId,
    caller_path: record.caller_path,
    owner_store: ownerRef.source_store,
    owner_ref: ownerRef,
    cognition_replay_ref: cognitionAuditEventRef(record),
    created_at: input.createdAt ?? record.created_at,
    source_refs: record.event_refs,
    source_state: sourceState,
    invalidation_state: invalidationState,
    invalidation_refs: invalidationRefs,
    ...(input.failClosedReason ? { fail_closed_reason: input.failClosedReason } : {}),
    retention_policy: record.retention_policy,
    redaction_policy: sourceState === "current" ? "metadata_only" : "redacted",
    normal_surface_visible: false,
    operator_inspectable: true,
    cognition_service_is_owner: false,
  });
}

export function createCognitiveReplayInspectionView(input: {
  viewId: string;
  surfaceTarget: CompanionCognitionSurfaceTarget;
  indexEntries: CognitiveReplayIndexEntry[];
  replayRecords?: CognitionReplayRecord[];
}): CognitiveReplayInspectionView {
  const recordsByRef = new Map((input.replayRecords ?? []).map((record) => [record.record_id, CognitionReplayRecordSchema.parse(record)]));
  const debugVisible = input.surfaceTarget === "operator_debug" || input.surfaceTarget === "internal_audit";
  return CognitiveReplayInspectionViewSchema.parse({
    schema_version: "cognitive-replay-inspection-view/v1",
    view_id: input.viewId,
    surface_target: input.surfaceTarget,
    items: input.indexEntries.map((entry) => {
      const parsedEntry = CognitiveReplayIndexEntrySchema.parse(entry);
      const replayRecord = recordsByRef.get(parsedEntry.cognition_replay_ref.ref);
      return CognitiveReplayInspectionItemSchema.parse({
        index_entry_id: parsedEntry.index_entry_id,
        cognition_id: replayRecord?.cognition_id ?? parsedEntry.cognition_replay_ref.ref,
        caller_path: parsedEntry.caller_path,
        owner_store: parsedEntry.owner_store,
        replay_record_ref: parsedEntry.cognition_replay_ref,
        source_refs: debugVisible ? parsedEntry.source_refs : [],
        invalidation_state: parsedEntry.invalidation_state,
        redaction_policy: parsedEntry.redaction_policy,
        response_plan_ref: replayRecord?.stable_output?.response_plan
          ? { kind: "response_plan", ref: replayRecord.stable_output.response_plan.plan_id }
          : undefined,
        tool_authority_stages: replayRecord?.stable_output?.tool_candidates.map((candidate) => candidate.authority_stage) ?? [],
        writeback_proposal_refs: replayRecord?.stable_output?.memory_writeback.map((proposal) => ({
          kind: "memory_writeback_proposal",
          ref: proposal.proposal_id,
        })) ?? [],
        raw_content_visible: false,
        debug_refs_visible: debugVisible,
      });
    }),
    normal_surface_debug_visible: false,
    raw_memory_visible: false,
    raw_prompt_visible: false,
  });
}

export function refreshCognitiveReplayIndexEntriesForSourceInvalidation(input: {
  indexEntries: readonly unknown[];
  invalidatedSourceRefs: readonly CognitionEventRef[];
  invalidationRefs?: readonly CognitionEventRef[];
  sourceState?: CognitiveReplayIndexSourceState;
  failClosedReason?: string;
}): CognitiveReplayIndexEntry[] {
  const invalidatedSourceRefs = z.array(CognitionEventRefSchema).min(1).parse(input.invalidatedSourceRefs);
  const invalidationRefs = z.array(CognitionEventRefSchema).parse(input.invalidationRefs ?? []);
  if (input.sourceState === "current") {
    throw new Error("source invalidation refresh cannot keep affected replay entries current");
  }
  const sourceState = input.sourceState ?? (invalidationRefs.length > 0 ? "deleted_or_tombstoned" : "missing_source");
  return input.indexEntries.map((entry) => {
    const parsedEntry = CognitiveReplayIndexEntrySchema.parse(entry);
    const affected = parsedEntry.source_refs.some((sourceRef) =>
      invalidatedSourceRefs.some((invalidatedRef) => cognitionEventRefsEqual(sourceRef, invalidatedRef))
    );
    if (!affected) return parsedEntry;

    const invalidationState: CognitiveReplayIndexInvalidationState =
      sourceState !== "missing_source" && invalidationRefs.length > 0
        ? "invalidated"
        : "failed_closed";
    const failClosedReason = invalidationState === "failed_closed"
      ? input.failClosedReason ?? "source invalidation was observed without a complete invalidation dependency"
      : undefined;
    const { fail_closed_reason: _staleFailClosedReason, ...entryWithoutFailClosedReason } = parsedEntry;

    return CognitiveReplayIndexEntrySchema.parse({
      ...entryWithoutFailClosedReason,
      source_state: sourceState,
      invalidation_state: invalidationState,
      invalidation_refs: uniqueCognitionEventRefs([...parsedEntry.invalidation_refs, ...invalidationRefs]),
      ...(failClosedReason ? { fail_closed_reason: failClosedReason } : {}),
      redaction_policy: "redacted",
      normal_surface_visible: false,
      cognition_service_is_owner: false,
    });
  });
}

function defaultOwnerRefForRecord(record: CognitionReplayRecord): CognitionEventRef {
  const sourceStore = defaultCognitiveReplayOwnerStore(record.caller_path);
  return CognitionEventRefSchema.parse({
    ref: `${sourceStore}:${record.record_id}`,
    source_store: sourceStore,
    source_event_type: "cognitive_replay_index_owner",
    schema_version: 1,
    replay_key: record.record_id,
    redaction_policy: "metadata_only",
  });
}

function cognitionEventRefsEqual(left: CognitionEventRef, right: CognitionEventRef): boolean {
  return left.source_store === right.source_store
    && left.source_event_type === right.source_event_type
    && left.schema_version === right.schema_version
    && left.ref === right.ref;
}

function uniqueCognitionEventRefs(refs: readonly CognitionEventRef[]): CognitionEventRef[] {
  const seen = new Set<string>();
  const unique: CognitionEventRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.source_store,
      ref.source_event_type,
      ref.schema_version,
      ref.ref,
      ref.source_epoch ?? "",
      ref.high_watermark ?? "",
      ref.replay_key ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

export class FileCognitiveReplayIndexStore implements CognitiveReplayIndexStore {
  constructor(
    private readonly baseDir: string,
    private readonly relativePath = "runtime/cognitive-replay-index.json",
    private readonly options: { lockTimeoutMs?: number } = {},
  ) {}

  async upsert(entry: CognitiveReplayIndexEntry): Promise<CognitiveReplayIndexEntry> {
    const parsed = CognitiveReplayIndexEntrySchema.parse(entry);
    await withJsonFileMutationLock(
      this.path(),
      async () => {
        const entries = await this.list();
        const next = [...entries.filter((existing) => existing.index_entry_id !== parsed.index_entry_id), parsed];
        await writeJsonFileAtomic(this.path(), next);
      },
      this.options.lockTimeoutMs !== undefined ? { timeoutMs: this.options.lockTimeoutMs } : {},
    );
    return parsed;
  }

  async list(): Promise<CognitiveReplayIndexEntry[]> {
    try {
      const text = await readFile(this.path(), "utf8");
      return z.array(CognitiveReplayIndexEntrySchema).parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private path(): string {
    return join(this.baseDir, this.relativePath);
  }
}
