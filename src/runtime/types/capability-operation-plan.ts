import { z } from "zod";
import {
  AdmissionOperationScopeSchema,
} from "../control/admission-policy.js";
import {
  AutonomyOperationPlanSchema,
} from "../control/autonomy-governor.js";

export const CapabilityOperationPlanAssemblyStatusSchema = z.enum([
  "planned",
  "no_supported_plan",
  "clarification_required",
  "fail_closed",
]);
export type CapabilityOperationPlanAssemblyStatus = z.infer<typeof CapabilityOperationPlanAssemblyStatusSchema>;

export const CapabilityOperationPlanSourceSchema = z.object({
  kind: z.enum(["schedule_tick", "attention_projection", "internal_proposal"]),
  source_ref: z.string().min(1),
  source_epoch: z.string().min(1).optional(),
  emitted_at: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CapabilityOperationPlanSource = z.infer<typeof CapabilityOperationPlanSourceSchema>;

export const CapabilityOperationPlanCandidateSchema = z.object({
  plan_id: z.string().min(1),
  source_ref: z.string().min(1),
  operation_plan: AutonomyOperationPlanSchema,
  admission_scope: AdmissionOperationScopeSchema,
  readiness_snapshot_refs: z.array(z.string().min(1)).default([]),
  required_approvals: z.array(z.string().min(1)).default([]),
  reversible_preparation_steps: z.array(z.string().min(1)).default([]),
  not_allowed_steps: z.array(z.string().min(1)).default([]),
  user_visible_summary: z.string().min(1),
  audit_seed: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CapabilityOperationPlanCandidate = z.infer<typeof CapabilityOperationPlanCandidateSchema>;
export type CapabilityOperationPlanCandidateInput = z.input<typeof CapabilityOperationPlanCandidateSchema>;

export const CapabilityOperationPlanAssemblySchema = z.object({
  schema_version: z.literal("capability-operation-plan-assembly/v1"),
  assembly_id: z.string().min(1),
  assembled_at: z.string().min(1),
  source: CapabilityOperationPlanSourceSchema,
  status: CapabilityOperationPlanAssemblyStatusSchema,
  reason: z.string().min(1),
  candidate_plans: z.array(CapabilityOperationPlanCandidateSchema).default([]),
}).strict();
export type CapabilityOperationPlanAssembly = z.infer<typeof CapabilityOperationPlanAssemblySchema>;
export type CapabilityOperationPlanAssemblyInput = z.input<typeof CapabilityOperationPlanAssemblySchema>;
