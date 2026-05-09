import { z } from "zod";
import { TaskArtifactContractSchema } from "../../../base/types/task.js";

const GeneratedVerificationMethodSchema = z.string()
  .trim()
  .min(1)
  .refine(
    (value) => !/[\r\n]/.test(value) && !value.includes("<<"),
    "verification_method must be a single-line command and must not use heredocs or multiline inline scripts"
  );

export const LLMGeneratedCriterionSchema = z.object({
  description: z.string(),
  verification_method: GeneratedVerificationMethodSchema,
  is_blocking: z.boolean().default(true),
});

export const LLMGeneratedTaskSchema = z.object({
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),
  success_criteria: z.array(LLMGeneratedCriterionSchema),
  scope_boundary: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    blast_radius: z.string(),
  }),
  constraints: z.array(z.string()),
  risk_profile: z.object({
    external_action: z.object({
      required: z.boolean().default(true),
      approval_required: z.boolean().default(true),
      action_kind: z.enum(["none", "submission", "publication", "notification", "deployment", "external_mutation", "unknown"]).default("unknown"),
      rationale: z.string().nullable().default(null),
    }).default({}),
  }).default({}),
  artifact_contract: TaskArtifactContractSchema.default({}),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),
  estimated_duration: z
    .object({
      value: z.number(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
    })
    .nullable()
    .default(null),
});
export type LLMGeneratedTask = z.infer<typeof LLMGeneratedTaskSchema>;
