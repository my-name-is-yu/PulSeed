import { z } from "zod/v3";

export const ARC_AGI3_TOOL_POLICY_VERSION = "arc-agi-3-tool-policy-v1";
export const ARC_AGI3_CLAIM_MODE = "community_online_scorecard";
export const ARC_AGI3_RUN_SCHEMA_VERSION = "pulseed.arc_agi_3.run/v1";
export const ARC_AGI3_DEFAULT_BASE_URL = "https://three.arcprize.org";
export const ARC_AGI3_REPLAY_BASE_URL = "https://arcprize.org/scorecards";

export const ArcAgi3GameSchema = z.object({
  game_id: z.string().min(1),
  title: z.string().min(1),
}).passthrough();
export type ArcAgi3Game = z.infer<typeof ArcAgi3GameSchema>;

export const ArcAgi3GameStateSchema = z.enum(["NOT_FINISHED", "NOT_STARTED", "WIN", "GAME_OVER"]);
export type ArcAgi3GameState = z.infer<typeof ArcAgi3GameStateSchema>;

export const ArcAgi3SnapshotSchema = z.object({
  game_id: z.string().min(1),
  guid: z.string().min(1),
  frame: z.array(z.array(z.array(z.number().int().min(0).max(15)))),
  state: ArcAgi3GameStateSchema,
  levels_completed: z.number().int().min(0).max(254),
  win_levels: z.number().int().min(0).max(254),
  action_input: z.record(z.unknown()),
  available_actions: z.array(z.number().int().min(1).max(7)),
}).passthrough();
export type ArcAgi3Snapshot = z.infer<typeof ArcAgi3SnapshotSchema>;

export const ArcAgi3OpenScorecardResponseSchema = z.object({
  card_id: z.string().min(1),
}).passthrough();
export type ArcAgi3OpenScorecardResponse = z.infer<typeof ArcAgi3OpenScorecardResponseSchema>;

export const ArcAgi3ScorecardSchema = z.object({
  card_id: z.string().min(1),
  score: z.number().optional(),
  total_environments_completed: z.number().optional(),
  total_environments: z.number().optional(),
  total_levels_completed: z.number().optional(),
  total_levels: z.number().optional(),
  total_actions: z.number().optional(),
  environments: z.array(z.unknown()).optional(),
}).passthrough();
export type ArcAgi3Scorecard = z.infer<typeof ArcAgi3ScorecardSchema>;

export const ArcAgi3RunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const ArcAgi3ActionNameSchema = z.enum([
  "RESET",
  "ACTION1",
  "ACTION2",
  "ACTION3",
  "ACTION4",
  "ACTION5",
  "ACTION6",
  "ACTION7",
]);
export type ArcAgi3ActionName = z.infer<typeof ArcAgi3ActionNameSchema>;

export const ArcAgi3ListGamesInputSchema = z.object({}).strict();
export type ArcAgi3ListGamesInput = z.infer<typeof ArcAgi3ListGamesInputSchema>;

export const ArcAgi3StartInputSchema = z.object({
  game_id: z.string().min(1),
  run_id: ArcAgi3RunIdSchema.optional(),
  model_provider: z.string().min(1).default("openai"),
  model_id: z.string().min(1).default("gpt-5.5"),
  source_url: z.string().url().optional(),
  tags: z.array(z.string().min(1)).max(16).optional(),
}).strict();
export type ArcAgi3StartInput = z.infer<typeof ArcAgi3StartInputSchema>;

export const ArcAgi3ObserveInputSchema = z.object({
  run_id: ArcAgi3RunIdSchema,
}).strict();
export type ArcAgi3ObserveInput = z.infer<typeof ArcAgi3ObserveInputSchema>;

export const ArcAgi3ActInputSchema = z.object({
  run_id: ArcAgi3RunIdSchema,
  action: ArcAgi3ActionNameSchema,
  x: z.number().int().min(0).max(63).optional(),
  y: z.number().int().min(0).max(63).optional(),
  reasoning: z.record(z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action !== "ACTION6") {
    if (value.x !== undefined || value.y !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["x"],
        message: "Only ACTION6 accepts x,y coordinates.",
      });
    }
    return;
  }
  if (value.x === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["x"], message: "ACTION6 requires x." });
  }
  if (value.y === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["y"], message: "ACTION6 requires y." });
  }
});
export type ArcAgi3ActInput = z.infer<typeof ArcAgi3ActInputSchema>;

export const ArcAgi3FinishInputSchema = z.object({
  run_id: ArcAgi3RunIdSchema,
  close_scorecard: z.boolean().default(true),
}).strict();
export type ArcAgi3FinishInput = z.infer<typeof ArcAgi3FinishInputSchema>;

export const ArcAgi3ScorecardInputSchema = z.object({
  run_id: ArcAgi3RunIdSchema,
  game_only: z.boolean().default(false),
}).strict();
export type ArcAgi3ScorecardInput = z.infer<typeof ArcAgi3ScorecardInputSchema>;

export const ArcAgi3PolicyInputSchema = z.object({}).strict();
export type ArcAgi3PolicyInput = z.infer<typeof ArcAgi3PolicyInputSchema>;

export const ArcAgi3ActionLogEntrySchema = z.object({
  at: z.string().datetime(),
  action: ArcAgi3ActionNameSchema,
  x: z.number().int().min(0).max(63).optional(),
  y: z.number().int().min(0).max(63).optional(),
  state_after: ArcAgi3GameStateSchema.optional(),
  levels_completed_after: z.number().int().min(0).max(254).optional(),
  available_actions_after: z.array(z.number().int().min(1).max(7)).optional(),
  reasoning_provided: z.boolean().default(false),
}).strict();
export type ArcAgi3ActionLogEntry = z.infer<typeof ArcAgi3ActionLogEntrySchema>;

export const ArcAgi3RunArtifactSchema = z.object({
  schema_version: z.literal(ARC_AGI3_RUN_SCHEMA_VERSION),
  claim_mode: z.literal(ARC_AGI3_CLAIM_MODE),
  run_id: ArcAgi3RunIdSchema,
  mode: z.literal("online_api"),
  game_id: z.string().min(1),
  model_provider: z.string().min(1),
  model_id: z.string().min(1),
  pulseed_commit: z.string().nullable(),
  tool_policy_version: z.literal(ARC_AGI3_TOOL_POLICY_VERSION),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  card_id: z.string().min(1),
  guid: z.string().min(1).nullable(),
  replay_url: z.string().url(),
  action_count: z.number().int().nonnegative(),
  reset_count: z.number().int().nonnegative(),
  submitted_action_log: z.array(ArcAgi3ActionLogEntrySchema),
  latest_snapshot: ArcAgi3SnapshotSchema.nullable(),
  official_scorecard_id: z.string().min(1),
  official_score: z.number().nullable(),
  scorecard: ArcAgi3ScorecardSchema.nullable(),
  model_turns: z.number().int().nonnegative().nullable(),
  tool_calls: z.number().int().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
  failure_reason: z.string().nullable(),
}).strict();
export type ArcAgi3RunArtifact = z.infer<typeof ArcAgi3RunArtifactSchema>;
