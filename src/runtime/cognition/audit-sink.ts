import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  RelationshipStateProjectionSchema,
  CognitionReplayStableOutputSchema,
  CognitionReplayRecordSchema,
  type CognitionEventRef,
  type CognitionReplayRecord,
  type CompanionCognitionInput,
  type CompanionCognitionOutput,
} from "./contracts.js";
import type { CognitionAuditSink } from "./ports.js";

export const COGNITION_AUDIT_STORAGE_PLAN = {
  schema_version: "cognition-audit-storage-plan/v1",
  physical_single_event_log: false,
  control_db_migration_required: false,
  caller_path_stores: {
    chat_user_turn: "chat_history",
    resident_proactive_check: "attention_ledger",
    long_running_task_turn: "runtime_operation",
  },
} as const;

export function createCognitionReplayRecord(input: {
  recordId: string;
  createdAt: string;
  input: Pick<CompanionCognitionInput, "cognition_id" | "caller_path" | "event_refs">;
  output?: CompanionCognitionOutput;
  failure?: { message: string; retryable?: boolean };
}): CognitionReplayRecord {
  return CognitionReplayRecordSchema.parse({
    schema_version: "cognition-replay-record/v1",
    record_id: input.recordId,
    cognition_id: input.input.cognition_id,
    caller_path: input.input.caller_path,
    created_at: input.createdAt,
    event_refs: input.input.event_refs,
    ...(input.output
      ? {
          stable_output: CognitionReplayStableOutputSchema.parse({
            cognition_id: input.output.cognition_id,
            caller_path: input.output.caller_path,
            situation_model: input.output.situation_model,
            relationship_state: replayRelationshipState(input.output.relationship_state),
            selected_intention: input.output.selected_intention,
            response_plan: input.output.response_plan,
            tool_candidates: input.output.tool_candidates,
            authorization_requests: input.output.authorization_requests,
            memory_writeback: input.output.memory_writeback,
            reflection_hints: input.output.reflection_hints,
            audit_refs: input.output.audit_refs,
            uncertainty: input.output.uncertainty,
          }),
        }
      : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    retention_policy: {
      materialized_content: false,
      refs_only: true,
      invalidates_on_source_tombstone: true,
    },
  });
}

function replayRelationshipState(
  relationshipState: CompanionCognitionOutput["relationship_state"],
): CompanionCognitionOutput["relationship_state"] {
  return RelationshipStateProjectionSchema.parse({
    ...relationshipState,
    relationship_refs: relationshipState.relationship_refs.map((source) => {
      const { excerpt: _excerpt, ...refsOnlySource } = source;
      return refsOnlySource;
    }),
  });
}

export function cognitionAuditEventRef(record: CognitionReplayRecord): CognitionEventRef {
  return {
    ref: record.record_id,
    source_store: "cognition_audit",
    source_event_type: "cognition_replay_record",
    schema_version: 1,
    replay_key: record.record_id,
    redaction_policy: "metadata_only",
  };
}

export class InMemoryCognitionAuditSink implements CognitionAuditSink {
  private readonly records: CognitionReplayRecord[] = [];

  async recordCognition(record: CognitionReplayRecord): Promise<void> {
    this.records.push(CognitionReplayRecordSchema.parse(record));
  }

  list(): CognitionReplayRecord[] {
    return [...this.records];
  }
}

export class FileCognitionAuditSink implements CognitionAuditSink {
  constructor(private readonly baseDir: string, private readonly relativePath = "runtime/cognition-audit-records.json") {}

  async recordCognition(record: CognitionReplayRecord): Promise<void> {
    const parsed = CognitionReplayRecordSchema.parse(record);
    const records = await this.list();
    const next = [...records.filter((existing) => existing.record_id !== parsed.record_id), parsed];
    await mkdir(dirname(this.path()), { recursive: true });
    await writeFile(this.path(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  async list(): Promise<CognitionReplayRecord[]> {
    try {
      const text = await readFile(this.path(), "utf8");
      return z.array(CognitionReplayRecordSchema).parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private path(): string {
    return join(this.baseDir, this.relativePath);
  }
}
