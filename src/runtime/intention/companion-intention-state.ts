import { z } from "zod";
import {
  CognitionEventRefSchema,
  CognitionRefSchema,
  GoalRefSchema,
  IntentionLifecycleSchema,
  type CognitionEventRef,
  type CognitionRef,
  type IntentionLifecycle,
} from "../cognition/contracts.js";

export const IntentionExecutionOwnerSchema = z.enum([
  "chat_runner",
  "agent_loop",
  "resident_attention",
  "runtime_control",
]);
export type IntentionExecutionOwner = z.infer<typeof IntentionExecutionOwnerSchema>;

export const CompanionIntentionRecordSchema = z.object({
  schema_version: z.literal("companion-intention-record/v1"),
  intention_id: z.string().min(1),
  lifecycle: IntentionLifecycleSchema,
  goal_ref: GoalRefSchema.optional(),
  selected_path_ref: CognitionRefSchema.optional(),
  permission_wait_ref: CognitionRefSchema.optional(),
  runtime_item_refs: z.array(CognitionRefSchema).default([]),
  resident_agenda_ref: CognitionRefSchema.optional(),
  source_refs: z.array(CognitionEventRefSchema).min(1),
  stale_target_refs: z.array(CognitionRefSchema).default([]),
  regrounding_reason_refs: z.array(CognitionEventRefSchema).default([]),
  transition_refs: z.array(CognitionRefSchema).default([]),
  execution_owner: IntentionExecutionOwnerSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  runtime_authority: z.literal(false).default(false),
  memory_authority: z.literal(false).default(false),
}).strict().superRefine((record, ctx) => {
  if (record.stale_target_refs.length > 0 && record.lifecycle !== "requires_regrounding" && record.lifecycle !== "obsolete") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lifecycle"],
      message: "intentions with stale target refs must require regrounding or be obsolete",
    });
  }
  if (record.lifecycle === "awaiting_approval" && !record.permission_wait_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["permission_wait_ref"],
      message: "awaiting approval intentions must carry a permission wait ref",
    });
  }
  if (
    (record.lifecycle === "selected" || record.lifecycle === "active")
    && !record.selected_path_ref
    && !record.goal_ref
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selected_path_ref"],
      message: "selected or active intentions must carry a selected path or goal ref",
    });
  }
});
export type CompanionIntentionRecord = z.infer<typeof CompanionIntentionRecordSchema>;

export const IntentionTransitionSchema = z.object({
  transition_id: z.string().min(1),
  from: IntentionLifecycleSchema,
  to: IntentionLifecycleSchema,
  decided_at: z.string().datetime(),
  reason_refs: z.array(CognitionEventRefSchema).min(1),
  permission_wait_ref: CognitionRefSchema.optional(),
  stale_target_refs: z.array(CognitionRefSchema).default([]),
  selected_path_ref: CognitionRefSchema.optional(),
  runtime_item_refs: z.array(CognitionRefSchema).default([]),
}).strict().superRefine((transition, ctx) => {
  if (!allowedNextLifecycles(transition.from).includes(transition.to)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: `cannot transition intention from ${transition.from} to ${transition.to}`,
    });
  }
  if (transition.to === "awaiting_approval" && !transition.permission_wait_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["permission_wait_ref"],
      message: "awaiting approval transitions must carry a permission wait ref",
    });
  }
  if (transition.stale_target_refs.length > 0 && transition.to !== "requires_regrounding" && transition.to !== "obsolete") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: "stale target transitions must require regrounding or mark the intention obsolete",
    });
  }
});
export type IntentionTransition = z.infer<typeof IntentionTransitionSchema>;
export type IntentionTransitionInput = Omit<z.input<typeof IntentionTransitionSchema>, "from">;

const ALLOWED_TRANSITIONS: Record<IntentionLifecycle, readonly IntentionLifecycle[]> = {
  candidate: ["selected", "blocked"],
  selected: ["awaiting_approval", "active", "blocked", "requires_regrounding", "obsolete", "revoked"],
  awaiting_approval: ["active", "blocked", "requires_regrounding", "revoked"],
  active: ["completed", "blocked", "obsolete", "revoked"],
  blocked: ["requires_regrounding", "obsolete"],
  completed: [],
  obsolete: [],
  revoked: [],
  requires_regrounding: ["selected", "blocked", "obsolete"],
};

export function allowedNextLifecycles(from: IntentionLifecycle): readonly IntentionLifecycle[] {
  return ALLOWED_TRANSITIONS[from];
}

export function createCompanionIntentionRecord(input: {
  intentionId: string;
  lifecycle?: IntentionLifecycle;
  sourceRefs: CognitionEventRef[];
  createdAt: string;
  goalRef?: CompanionIntentionRecord["goal_ref"];
  selectedPathRef?: CognitionRef;
  permissionWaitRef?: CognitionRef;
  runtimeItemRefs?: CognitionRef[];
  residentAgendaRef?: CognitionRef;
  staleTargetRefs?: CognitionRef[];
  executionOwner?: IntentionExecutionOwner;
}): CompanionIntentionRecord {
  const lifecycle = input.staleTargetRefs?.length ? "requires_regrounding" : input.lifecycle ?? "candidate";
  return CompanionIntentionRecordSchema.parse({
    schema_version: "companion-intention-record/v1",
    intention_id: input.intentionId,
    lifecycle,
    ...(input.goalRef ? { goal_ref: input.goalRef } : {}),
    ...(input.selectedPathRef ? { selected_path_ref: input.selectedPathRef } : {}),
    ...(input.permissionWaitRef ? { permission_wait_ref: input.permissionWaitRef } : {}),
    runtime_item_refs: input.runtimeItemRefs ?? [],
    ...(input.residentAgendaRef ? { resident_agenda_ref: input.residentAgendaRef } : {}),
    source_refs: input.sourceRefs,
    stale_target_refs: input.staleTargetRefs ?? [],
    regrounding_reason_refs: input.staleTargetRefs?.length ? input.sourceRefs : [],
    transition_refs: [],
    ...(input.executionOwner ? { execution_owner: input.executionOwner } : {}),
    created_at: input.createdAt,
    updated_at: input.createdAt,
    runtime_authority: false,
    memory_authority: false,
  });
}

export function transitionCompanionIntention(
  record: CompanionIntentionRecord,
  transition: IntentionTransitionInput
): CompanionIntentionRecord {
  const parsedRecord = CompanionIntentionRecordSchema.parse(record);
  const parsedTransition = IntentionTransitionSchema.parse({
    ...transition,
    from: parsedRecord.lifecycle,
  });

  return CompanionIntentionRecordSchema.parse({
    ...parsedRecord,
    lifecycle: parsedTransition.to,
    ...(parsedTransition.selected_path_ref ? { selected_path_ref: parsedTransition.selected_path_ref } : {}),
    ...(parsedTransition.permission_wait_ref ? { permission_wait_ref: parsedTransition.permission_wait_ref } : {}),
    runtime_item_refs: parsedTransition.runtime_item_refs.length > 0
      ? parsedTransition.runtime_item_refs
      : parsedRecord.runtime_item_refs,
    stale_target_refs: parsedTransition.stale_target_refs,
    regrounding_reason_refs: parsedTransition.stale_target_refs.length > 0
      ? parsedTransition.reason_refs
      : parsedRecord.regrounding_reason_refs,
    transition_refs: [
      ...parsedRecord.transition_refs,
      { kind: "intention_transition", ref: parsedTransition.transition_id },
    ],
    updated_at: parsedTransition.decided_at,
  });
}
