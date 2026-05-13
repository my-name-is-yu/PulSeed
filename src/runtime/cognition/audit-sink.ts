import {
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
