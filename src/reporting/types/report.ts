import { z } from "zod/v3";
import { ReportTypeEnum, VerbosityLevelEnum } from "../../base/types/core.js";
import { VerificationFileDiffSchema } from "../../base/types/task.js";

// --- Report ---

export const ReportSchema = z.object({
  id: z.string(),
  report_type: ReportTypeEnum,
  goal_id: z.string().nullable().default(null),
  title: z.string(),
  content: z.string(),
  verbosity: VerbosityLevelEnum.default("standard"),
  generated_at: z.string(),
  delivered_at: z.string().nullable().default(null),
  read: z.boolean().default(false),
  // Structured data stored at generation time to avoid re-parsing Markdown later
  metadata: z
    .object({
      loop_index: z.number().optional(),
      gap_aggregate: z.number().optional(),
      stall_detected: z.boolean().optional(),
      pivot_occurred: z.boolean().optional(),
      elapsed_ms: z.number().optional(),
      task_id: z.string().nullable().optional(),
      task_action: z.string().nullable().optional(),
      task_verification_diffs: z.array(VerificationFileDiffSchema).optional(),
      task_diff_evidence_source: z.enum(["git", "filesystem_artifact", "unavailable"]).nullable().optional(),
      wait_status: z.object({
        strategyId: z.string().optional(),
        status: z.string(),
        details: z.string().optional(),
        approvalId: z.string().optional(),
        observeOnly: z.boolean().optional(),
        suppressed: z.boolean().optional(),
        expired: z.boolean().optional(),
        skipReason: z.string().optional(),
      }).nullable().optional(),
      finalization_status: z.unknown().nullable().optional(),
      execution_mode: z.object({
        mode: z.enum(["exploration", "consolidation", "finalization"]),
        source: z.enum(["default", "deadline_finalization", "operator", "dream"]),
        reason: z.string(),
        changed_at: z.string(),
        finalization_mode: z.enum(["no_deadline", "exploration", "consolidation", "finalization", "missed_deadline"]).optional(),
        approval_required_to_explore: z.boolean().optional(),
      }).nullable().optional(),
      loops_run: z.number().optional(),
      stall_count: z.number().optional(),
      pivot_count: z.number().optional(),
      progress_change: z.string().optional(),
      total_loops: z.number().optional(),
      total_stalls: z.number().optional(),
      total_pivots: z.number().optional(),
    })
    .optional(),
});
export type Report = z.infer<typeof ReportSchema>;
