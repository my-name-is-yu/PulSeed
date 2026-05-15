import { z } from "zod/v3";

export const MemorySensitivitySchema = z.enum(["public", "local", "private", "secret"]);
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;

export const MemoryConsentScopeSchema = z.object({
  scope_id: z.string().min(1).default("local_planning"),
  allowed_contexts: z.array(z.string().min(1)).default(["local_planning"]),
  source_actor: z.string().min(1).default("user"),
  collection_context: z.string().min(1).default("memory_save"),
  granted_at: z.string().datetime().optional(),
}).strict();
export type MemoryConsentScope = z.infer<typeof MemoryConsentScopeSchema>;

export const MemoryRetentionPolicySchema = z.object({
  policy_id: z.string().min(1).default("retain_until_retracted"),
  retain_until: z.string().datetime().nullable().default(null),
  review_after: z.string().datetime().nullable().default(null),
  delete_requires_approval: z.boolean().default(true),
}).strict();
export type MemoryRetentionPolicy = z.infer<typeof MemoryRetentionPolicySchema>;

export const MemoryGovernanceSchema = z.object({
  sensitivity: MemorySensitivitySchema.default("local"),
  consent: MemoryConsentScopeSchema.default({}),
  retention: MemoryRetentionPolicySchema.default({}),
  export_visibility: z.enum(["listed", "redacted", "hidden"]).default("listed"),
  owner_ref: z.string().min(1).default("user"),
}).strict();
export type MemoryGovernance = z.infer<typeof MemoryGovernanceSchema>;
export type MemoryGovernanceInput = z.input<typeof MemoryGovernanceSchema>;

const sensitivityRank: Record<MemorySensitivity, number> = {
  public: 0,
  local: 1,
  private: 2,
  secret: 3,
};

export function isSensitivityAllowed(actual: MemorySensitivity, max: MemorySensitivity): boolean {
  return sensitivityRank[actual] <= sensitivityRank[max];
}
