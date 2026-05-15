import { z } from "zod/v3";
import {
  MemoryWritebackProposalSchema,
  type MemoryWritebackProposal,
} from "./contracts.js";

export const MemoryLifecycleProposedTargetSchema = MemoryWritebackProposalSchema.shape.proposed_target;
export type MemoryLifecycleProposedTarget = MemoryWritebackProposal["proposed_target"];

export const MemoryLifecycleCanonicalOwnerSchema = z.enum([
  "profile",
  "soil",
  "knowledge",
  "dream",
  "attention_feedback",
  "procedural",
  "reflection",
  "cognition_replay",
]);
export type MemoryLifecycleCanonicalOwner = z.infer<typeof MemoryLifecycleCanonicalOwnerSchema>;

export const MemoryLifecycleWritebackOwnerSchema = z.enum([
  "dream",
  "profile",
  "soil",
  "knowledge",
  "procedural",
  "attention_feedback",
  "reflection",
]);
export type MemoryLifecycleWritebackOwner = z.infer<typeof MemoryLifecycleWritebackOwnerSchema>;

export const MemoryLifecycleOwnerRoutingRuleSchema = z.object({
  proposed_target: MemoryLifecycleProposedTargetSchema,
  canonical_owner: MemoryLifecycleCanonicalOwnerSchema,
  acceptance_rule_ref: z.string().min(1),
  normal_surface_rule_ref: z.string().min(1),
  owner_review_required: z.literal(true).default(true),
  cognition_is_owner: z.literal(false).default(false),
}).strict();
export type MemoryLifecycleOwnerRoutingRule = z.infer<typeof MemoryLifecycleOwnerRoutingRuleSchema>;

export const MEMORY_LIFECYCLE_OWNER_ROUTING_TABLE: Readonly<Record<MemoryLifecycleProposedTarget, MemoryLifecycleOwnerRoutingRule>> = {
  profile: MemoryLifecycleOwnerRoutingRuleSchema.parse({
    proposed_target: "profile",
    canonical_owner: "profile",
    acceptance_rule_ref: "memory-lifecycle:profile:user-or-owner-approved-profile-change",
    normal_surface_rule_ref: "memory-lifecycle:profile:surface-current-lifecycle-correction-sensitivity",
  }),
  soil: MemoryLifecycleOwnerRoutingRuleSchema.parse({
    proposed_target: "soil",
    canonical_owner: "soil",
    acceptance_rule_ref: "memory-lifecycle:soil:structured-record-owner-acceptance",
    normal_surface_rule_ref: "memory-lifecycle:soil:knowledge-work-memory-with-source-refs",
  }),
  knowledge: MemoryLifecycleOwnerRoutingRuleSchema.parse({
    proposed_target: "knowledge",
    canonical_owner: "knowledge",
    acceptance_rule_ref: "memory-lifecycle:knowledge:source-reliability-validity-owner-check",
    normal_surface_rule_ref: "memory-lifecycle:knowledge:not-profile-truth-without-profile-proposal",
  }),
  dream: MemoryLifecycleOwnerRoutingRuleSchema.parse({
    proposed_target: "dream",
    canonical_owner: "dream",
    acceptance_rule_ref: "memory-lifecycle:dream:playbook-seed-reflection-owner-acceptance",
    normal_surface_rule_ref: "memory-lifecycle:dream:no-normal-surface-before-owner-acceptance",
  }),
  attention_feedback: MemoryLifecycleOwnerRoutingRuleSchema.parse({
    proposed_target: "attention_feedback",
    canonical_owner: "attention_feedback",
    acceptance_rule_ref: "memory-lifecycle:attention-feedback:explicit-feedback-or-outcome-evidence",
    normal_surface_rule_ref: "memory-lifecycle:attention-feedback:downgrade-only-without-separate-authority",
  }),
  reflection: MemoryLifecycleOwnerRoutingRuleSchema.parse({
    proposed_target: "reflection",
    canonical_owner: "reflection",
    acceptance_rule_ref: "memory-lifecycle:reflection:verified-run-and-owner-decision-for-procedural-promotion",
    normal_surface_rule_ref: "memory-lifecycle:reflection:planning-hint-only-until-promoted",
  }),
};

export function ownerRoutingRuleForProposal(proposal: MemoryWritebackProposal | unknown): MemoryLifecycleOwnerRoutingRule {
  const parsed = MemoryWritebackProposalSchema.parse(proposal);
  if (parsed.proposal_kind === "procedural_skill_candidate") {
    return MemoryLifecycleOwnerRoutingRuleSchema.parse({
      ...MEMORY_LIFECYCLE_OWNER_ROUTING_TABLE.reflection,
      canonical_owner: "procedural",
    });
  }
  return MEMORY_LIFECYCLE_OWNER_ROUTING_TABLE[parsed.proposed_target];
}

export function ownerForMemoryWritebackProposal(proposal: MemoryWritebackProposal | unknown): MemoryLifecycleWritebackOwner {
  return MemoryLifecycleWritebackOwnerSchema.parse(ownerRoutingRuleForProposal(proposal).canonical_owner);
}
