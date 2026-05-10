import { z } from "zod";
import { RuntimeReplyTargetSchema } from "../../runtime/session-registry/types.js";
import { RunSpecSchema } from "../../runtime/run-spec/index.js";
import { SetupDialoguePublicStateSchema } from "./setup-dialogue.js";
import { SetupSecretIntakeItemSchema } from "./setup-secret-intake.js";
import { ChatSessionUsageSchema } from "./chat-usage-contracts.js";

const ChatSafeNonnegativeIntSchema = z.number().finite().int().nonnegative().safe();

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(),
  turnIndex: ChatSafeNonnegativeIntSchema,
  setupSecretIntake: z.array(SetupSecretIntakeItemSchema.omit({ value: true })).optional(),
}).passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatSessionAgentLoopMetadataSchema = z.object({
  statePath: z.string().nullable().optional(),
  status: z.enum(["running", "completed", "failed"]).nullable().optional(),
  resumable: z.boolean().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
}).passthrough();
export type ChatSessionAgentLoopMetadata = z.infer<typeof ChatSessionAgentLoopMetadataSchema>;

export const ChatTurnContextSnapshotSchema = z.object({
  schema_version: z.string(),
  modelVisible: z.unknown(),
}).passthrough();
export type ChatTurnContextSnapshot = z.infer<typeof ChatTurnContextSnapshotSchema>;

export const ChatRolloutJournalRecordKindSchema = z.enum([
  "user_input",
  "turn_context",
  "model_output",
  "tool_call",
  "tool_result",
  "permission_decision",
  "display_event",
  "completion_state",
]);
export type ChatRolloutJournalRecordKind = z.infer<typeof ChatRolloutJournalRecordKindSchema>;

export const ChatRolloutJournalRecordSchema = z.object({
  schema_version: z.literal("chat-rollout-journal-record-v1"),
  id: z.string(),
  sessionId: z.string(),
  runId: z.string().nullable(),
  turnId: z.string().nullable(),
  sequence: ChatSafeNonnegativeIntSchema,
  createdAt: z.string(),
  kind: ChatRolloutJournalRecordKindSchema,
  source: z.enum(["chat_history", "chat_event", "agent_timeline", "approval_store"]).default("chat_history"),
  visibility: z.enum(["model_visible", "display", "debug", "host_only"]),
  payload: z.unknown(),
}).passthrough();
export type ChatRolloutJournalRecord = z.infer<typeof ChatRolloutJournalRecordSchema>;

export const CHAT_COMPACTION_RECORD_SCHEMA_VERSION = "chat-compaction-record-v1";

export const ChatCompactionRecordSchema = z.object({
  schema_version: z.literal(CHAT_COMPACTION_RECORD_SCHEMA_VERSION),
  id: z.string(),
  sessionId: z.string(),
  sequence: ChatSafeNonnegativeIntSchema,
  createdAt: z.string(),
  reason: z.enum(["manual_command", "auto_context_limit"]).default("manual_command"),
  inputMessageCount: ChatSafeNonnegativeIntSchema,
  outputMessageCount: ChatSafeNonnegativeIntSchema,
  removedMessageCount: ChatSafeNonnegativeIntSchema,
  retainedMessageCount: ChatSafeNonnegativeIntSchema,
  summary: z.string(),
  modelVisibleSummary: z.string(),
  archivedUserMessages: z.array(ChatMessageSchema),
  archivedAssistantMessages: z.array(ChatMessageSchema),
  retainedMessages: z.array(ChatMessageSchema),
  pendingPermissions: z.array(z.object({
    sequence: ChatSafeNonnegativeIntSchema,
    source: z.string(),
    status: z.enum(["requested", "resolved", "unknown"]),
    invalidatedByCompaction: z.boolean(),
    payload: z.unknown(),
  }).passthrough()),
  decisions: z.array(z.object({
    sequence: ChatSafeNonnegativeIntSchema,
    kind: ChatRolloutJournalRecordKindSchema,
    source: z.string(),
    visibility: z.string(),
    payload: z.unknown(),
  }).passthrough()),
  activeTargets: z.array(z.object({
    source: z.string(),
    state: z.enum(["retained", "session"]),
    payload: z.unknown(),
  }).passthrough()),
  replacementHistory: z.object({
    removedTurnIndexes: z.array(ChatSafeNonnegativeIntSchema),
    retainedOriginalTurnIndexes: z.array(ChatSafeNonnegativeIntSchema),
    rewrittenTurnIndexes: z.array(ChatSafeNonnegativeIntSchema),
    rolloutJournalSequences: z.array(ChatSafeNonnegativeIntSchema),
    turnContextCount: ChatSafeNonnegativeIntSchema,
  }).passthrough(),
}).passthrough();
export type ChatCompactionRecord = z.infer<typeof ChatCompactionRecordSchema>;

export const RunSpecConfirmationStateSchema = z.object({
  state: z.enum(["pending", "confirmed", "cancelled"]),
  spec: RunSpecSchema,
  prompt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();
export type RunSpecConfirmationState = z.infer<typeof RunSpecConfirmationStateSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  spawnedBySessionId: z.string().nullable().optional(),
  spawnedByRuntimeSessionId: z.string().nullable().optional(),
  spawnedAt: z.string().nullable().optional(),
  sessionStatus: z.enum(["idle", "queued", "running", "waiting", "completed", "failed"]).nullable().optional(),
  sessionSummary: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  strategyId: z.string().nullable().optional(),
  notificationPolicy: z.enum(["silent", "important_only", "periodic", "all_terminal"]).nullable().optional(),
  ownerId: z.string().nullable().optional(),
  ownerClaimedAt: z.string().nullable().optional(),
  waitingUntil: z.string().nullable().optional(),
  waitingCondition: z.string().nullable().optional(),
  retryCount: ChatSafeNonnegativeIntSchema.nullable().optional(),
  lastRetryAt: z.string().nullable().optional(),
  lastResumedAt: z.string().nullable().optional(),
  notificationReplyTarget: RuntimeReplyTargetSchema.nullable().optional(),
  parentNotificationStatus: z.enum(["none", "pending", "sent", "failed"]).nullable().optional(),
  parentNotificationSummary: z.string().nullable().optional(),
  parentNotifiedAt: z.string().nullable().optional(),
  setupDialogue: SetupDialoguePublicStateSchema.nullable().optional(),
  runSpecConfirmation: RunSpecConfirmationStateSchema.nullable().optional(),
  messages: z.array(ChatMessageSchema),
  compactionSummary: z.string().optional(),
  compactionRecords: z.array(ChatCompactionRecordSchema).optional(),
  agentLoopSessionId: z.string().nullable().optional(),
  agentLoopTraceId: z.string().nullable().optional(),
  agentLoopStatePath: z.string().nullable().optional(),
  agentLoopStatus: z.enum(["running", "completed", "failed"]).nullable().optional(),
  agentLoopResumable: z.boolean().nullable().optional(),
  agentLoopUpdatedAt: z.string().nullable().optional(),
  agentLoop: ChatSessionAgentLoopMetadataSchema.optional(),
  turnContexts: z.array(ChatTurnContextSnapshotSchema).optional(),
  rolloutJournal: z.array(ChatRolloutJournalRecordSchema).optional(),
  usage: ChatSessionUsageSchema.optional(),
}).passthrough();
export type ChatSession = z.infer<typeof ChatSessionSchema>;
