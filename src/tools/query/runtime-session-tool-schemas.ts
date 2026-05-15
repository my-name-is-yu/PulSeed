import { z } from "zod/v3";

import { BackgroundRunStatusSchema } from "../../runtime/session-registry/types.js";

export const RuntimeSessionsListInputSchema = z.object({
  scope: z.enum(["self", "tree", "all"]).default("tree"),
  kinds: z.array(z.enum(["conversation", "agent", "coreloop"])).optional(),
  activeOnly: z.boolean().default(false),
  includeRuns: z.boolean().default(false),
}).strict();
export type RuntimeSessionsScope = z.infer<typeof RuntimeSessionsListInputSchema>["scope"];
export type RuntimeSessionsListInput = z.infer<typeof RuntimeSessionsListInputSchema>;

export const RuntimeRunsObserveInputSchema = z.object({
  scope: z.enum(["self", "tree", "all"]).default("tree"),
  run_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  statuses: z.array(BackgroundRunStatusSchema).optional(),
  activeOnly: z.boolean().default(false),
  includeSessions: z.boolean().default(true),
  limit: z.number().int().positive().max(50).default(20),
}).strict();
export type RuntimeRunsObserveInput = z.infer<typeof RuntimeRunsObserveInputSchema>;

export const RuntimeSessionsHistoryInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  limit: z.number().int().positive().max(100).default(20),
}).strict();
export type RuntimeSessionsHistoryInput = z.infer<typeof RuntimeSessionsHistoryInputSchema>;

export const RuntimeSessionsReadInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
}).strict();
export type RuntimeSessionsReadInput = z.infer<typeof RuntimeSessionsReadInputSchema>;

export const RuntimeSessionsChildrenInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
}).strict();
export type RuntimeSessionsChildrenInput = z.infer<typeof RuntimeSessionsChildrenInputSchema>;

export const RuntimeSessionsSpawnInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  goal_id: z.string().trim().min(1).optional(),
  strategy_id: z.string().trim().min(1).optional(),
  notification_policy: z.enum(["silent", "important_only", "periodic", "all_terminal"]).optional(),
  owner_id: z.string().trim().min(1).optional(),
  copy_recent_messages: z.boolean().default(false),
  recent_message_limit: z.number().int().positive().max(20).default(6),
}).strict();
export type RuntimeSessionsSpawnInput = z.infer<typeof RuntimeSessionsSpawnInputSchema>;

export const RuntimeSessionsSendInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  message: z.string().trim().min(1, "message is required"),
}).strict();
export type RuntimeSessionsSendInput = z.infer<typeof RuntimeSessionsSendInputSchema>;

export const RuntimeSessionsUpdateInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  status: z.enum(["queued", "running", "waiting", "completed", "failed"]),
  summary: z.string().trim().min(1).optional(),
  goal_id: z.string().trim().min(1).optional(),
  strategy_id: z.string().trim().min(1).optional(),
  notification_policy: z.enum(["silent", "important_only", "periodic", "all_terminal"]).optional(),
  waiting_until: z.string().trim().min(1).nullable().optional(),
  waiting_condition: z.string().trim().min(1).nullable().optional(),
  append_assistant_message: z.boolean().default(false),
  notify_parent: z.boolean().default(false),
  completed_at: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === "completed" || value.status === "failed") && !value.summary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "summary is required when marking a session completed or failed",
    });
  }
  if (value.status === "waiting" && !value.waiting_until && !value.waiting_condition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["waiting_until"],
      message: "waiting_until or waiting_condition is required when marking a session waiting",
    });
  }
});
export type RuntimeSessionsUpdateInput = z.infer<typeof RuntimeSessionsUpdateInputSchema>;

export const RuntimeSessionsClaimInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  owner_id: z.string().trim().min(1, "owner_id is required"),
}).strict();
export type RuntimeSessionsClaimInput = z.infer<typeof RuntimeSessionsClaimInputSchema>;

export const RuntimeSessionsCancelInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  reason: z.string().trim().min(1, "reason is required"),
}).strict();
export type RuntimeSessionsCancelInput = z.infer<typeof RuntimeSessionsCancelInputSchema>;

export const RuntimeSessionsRetryInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  message: z.string().trim().min(1).optional(),
}).strict();
export type RuntimeSessionsRetryInput = z.infer<typeof RuntimeSessionsRetryInputSchema>;
