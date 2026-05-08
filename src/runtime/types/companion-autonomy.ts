import { z } from "zod";
import {
  PermissionGrantCapabilitySchema,
  PermissionGrantExcludedCapabilitySchema,
} from "../store/permission-grant-store.js";

export const CompanionAutonomyRefSchema = z.object({
  kind: z.enum([
    "runtime_item",
    "surface",
    "memory",
    "permission_grant",
    "approval",
    "tool_call",
    "conversation",
    "audit_trace",
  ]),
  id: z.string().min(1),
  version: z.string().min(1).optional(),
}).strict();
export type CompanionAutonomyRef = z.infer<typeof CompanionAutonomyRefSchema>;

export const CompanionAutonomyContentLifecycleSchema = z.enum([
  "active",
  "redacted",
  "tombstone",
  "deleted",
]);
export type CompanionAutonomyContentLifecycle = z.infer<typeof CompanionAutonomyContentLifecycleSchema>;

export const CompanionAutonomySourceRefSchema = z.object({
  ref: CompanionAutonomyRefSchema,
  lifecycle: CompanionAutonomyContentLifecycleSchema.default("active"),
  redaction_reason: z.string().min(1).optional(),
}).strict();
export type CompanionAutonomySourceRef = z.infer<typeof CompanionAutonomySourceRefSchema>;

export const UrgeCandidateKindSchema = z.enum([
  "curiosity",
  "drive",
  "schedule_wake",
  "watch_update",
  "feedback",
  "repair_need",
]);
export type UrgeCandidateKind = z.infer<typeof UrgeCandidateKindSchema>;

export const AgentAgendaItemKindSchema = z.enum([
  "hold",
  "watch",
  "quiet_prepare",
  "digest",
  "approval_request",
  "expression",
  "escalation",
]);
export type AgentAgendaItemKind = z.infer<typeof AgentAgendaItemKindSchema>;

export const OutcomeClassSchema = z.enum([
  "silence",
  "hold",
  "watch",
  "quiet_prepare",
  "digest_item",
  "approval_request",
  "expression",
  "escalation",
]);
export type OutcomeClass = z.infer<typeof OutcomeClassSchema>;

export const UrgeCandidateSchema = z.object({
  schema_version: z.literal("urge-candidate-v1").default("urge-candidate-v1"),
  urge_id: z.string().min(1),
  kind: UrgeCandidateKindSchema,
  created_at: z.number().int().nonnegative(),
  source_refs: z.array(CompanionAutonomySourceRefSchema).min(1),
  proposed_agenda_kind: AgentAgendaItemKindSchema,
  priority_hint: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  confidence: z.number().min(0).max(1),
  maturation: z.object({
    state: z.enum(["candidate", "maturing", "ready", "decayed", "inhibited"]),
    eligible_at: z.number().int().nonnegative().optional(),
    decays_at: z.number().int().nonnegative().optional(),
  }).strict(),
  inhibition_refs: z.array(CompanionAutonomyRefSchema).default([]),
}).strict();
export type UrgeCandidate = z.infer<typeof UrgeCandidateSchema>;

export const AgentAgendaItemSchema = z.object({
  schema_version: z.literal("agent-agenda-item-v1").default("agent-agenda-item-v1"),
  agenda_item_id: z.string().min(1),
  kind: AgentAgendaItemKindSchema,
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  state: z.enum(["pending", "held", "ready_for_gate", "admitted", "suppressed", "expired"]),
  source_urge_ids: z.array(z.string().min(1)).min(1),
  source_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  gate_after: z.number().int().nonnegative().optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type AgentAgendaItem = z.infer<typeof AgentAgendaItemSchema>;

export const InitiativeGateDecisionSchema = z.object({
  schema_version: z.literal("initiative-gate-decision-v1").default("initiative-gate-decision-v1"),
  decision_id: z.string().min(1),
  agenda_item_id: z.string().min(1),
  decided_at: z.number().int().nonnegative(),
  status: z.enum(["admitted", "blocked", "delayed", "narrowed"]),
  selected_outcome: OutcomeClassSchema.optional(),
  blocked_by_refs: z.array(CompanionAutonomyRefSchema).default([]),
  rationale_refs: z.array(CompanionAutonomyRefSchema).default([]),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((decision, ctx) => {
  if (decision.status === "admitted" && !decision.selected_outcome) {
    ctx.addIssue({
      code: "custom",
      path: ["selected_outcome"],
      message: "admitted initiative gate decisions require selected_outcome",
    });
  }
  if (decision.status !== "admitted" && decision.selected_outcome) {
    ctx.addIssue({
      code: "custom",
      path: ["selected_outcome"],
      message: "blocked, delayed, and narrowed gate decisions must not create an outcome",
    });
  }
});
export type InitiativeGateDecision = z.infer<typeof InitiativeGateDecisionSchema>;

export const OutcomeDecisionStatusSchema = z.enum([
  "admitted",
  "rejected",
  "downgraded",
  "expired",
  "held",
]);
export type OutcomeDecisionStatus = z.infer<typeof OutcomeDecisionStatusSchema>;

export const OutcomeDecisionSchema = z.object({
  schema_version: z.literal("outcome-decision-v1").default("outcome-decision-v1"),
  outcome_decision_id: z.string().min(1),
  gate_decision_id: z.string().min(1),
  decided_at: z.number().int().nonnegative(),
  requested_outcome: OutcomeClassSchema,
  status: OutcomeDecisionStatusSchema,
  final_outcome: OutcomeClassSchema.optional(),
  runtime_check_refs: z.array(CompanionAutonomyRefSchema).default([]),
  rejection: z.object({
    code: z.enum([
      "permission_denied",
      "stale_context",
      "control_suppressed",
      "visibility_blocked",
      "expired",
      "unknown_authority",
    ]),
    evidence_refs: z.array(CompanionAutonomyRefSchema).default([]),
  }).strict().optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((decision, ctx) => {
  if ((decision.status === "admitted" || decision.status === "downgraded") && !decision.final_outcome) {
    ctx.addIssue({
      code: "custom",
      path: ["final_outcome"],
      message: "admitted and downgraded outcome decisions require a final outcome class",
    });
  }
  if ((decision.status === "rejected" || decision.status === "expired") && decision.final_outcome) {
    ctx.addIssue({
      code: "custom",
      path: ["final_outcome"],
      message: "rejected and expired outcome decisions must not invent a final outcome",
    });
  }
  if (decision.status === "rejected" && !decision.rejection) {
    ctx.addIssue({
      code: "custom",
      path: ["rejection"],
      message: "rejected outcome decisions require rejection evidence",
    });
  }
});
export type OutcomeDecision = z.infer<typeof OutcomeDecisionSchema>;

export const ExpressionModeSchema = z.enum([
  "immediate",
  "digest_item",
  "approval_request",
  "escalation_notice",
]);
export type ExpressionMode = z.infer<typeof ExpressionModeSchema>;

export const ExpressionDecisionSchema = z.object({
  schema_version: z.literal("expression-decision-v1").default("expression-decision-v1"),
  expression_decision_id: z.string().min(1),
  outcome_decision_id: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  expression_mode: ExpressionModeSchema,
  surface_refs: z.array(CompanionAutonomyRefSchema).default([]),
  visibility_policy_ref: CompanionAutonomyRefSchema.optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type ExpressionDecision = z.infer<typeof ExpressionDecisionSchema>;

export const VisibilityModeSchema = z.enum([
  "hidden_by_default",
  "inspectable",
  "audit_visible",
  "debug_visible",
  "digest_only",
  "never_directly_shown",
]);
export type VisibilityMode = z.infer<typeof VisibilityModeSchema>;

export const VisibilityPolicySchema = z.object({
  schema_version: z.literal("visibility-policy-v1").default("visibility-policy-v1"),
  policy_id: z.string().min(1),
  mode: VisibilityModeSchema,
  applies_to: z.array(CompanionAutonomyRefSchema).min(1),
  content_lifecycle: CompanionAutonomyContentLifecycleSchema.default("active"),
  redaction_required: z.boolean().default(false),
  raw_content_allowed: z.boolean().default(false),
  inspectable_summary: z.string().min(1).optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((policy, ctx) => {
  if ((policy.content_lifecycle === "deleted" || policy.content_lifecycle === "tombstone") && policy.raw_content_allowed) {
    ctx.addIssue({
      code: "custom",
      path: ["raw_content_allowed"],
      message: "deleted and tombstone content cannot be exposed through visibility policy",
    });
  }
  if ((policy.content_lifecycle === "deleted" || policy.content_lifecycle === "tombstone") && !policy.redaction_required) {
    ctx.addIssue({
      code: "custom",
      path: ["redaction_required"],
      message: "deleted and tombstone content require redaction",
    });
  }
});
export type VisibilityPolicy = z.infer<typeof VisibilityPolicySchema>;

export const AuditTraceEventSchema = z.object({
  event_id: z.string().min(1),
  kind: z.enum([
    "action_taken",
    "action_withheld",
    "permission_checked",
    "stale_context",
    "suppressed_alternative",
    "repair_option",
    "visibility_applied",
  ]),
  occurred_at: z.number().int().nonnegative(),
  subject_ref: CompanionAutonomyRefSchema.optional(),
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  permission_grant_refs: z.array(z.string().min(1)).default([]),
  repair_options: z.array(z.enum(["stop", "narrow", "revoke", "forget", "reground"])).default([]),
  redaction_applied: z.boolean().default(false),
}).strict().superRefine((event, ctx) => {
  const hasDeletedEvidence = event.evidence_refs.some((ref) =>
    ref.lifecycle === "deleted" || ref.lifecycle === "tombstone"
  );
  if (hasDeletedEvidence && !event.redaction_applied) {
    ctx.addIssue({
      code: "custom",
      path: ["redaction_applied"],
      message: "audit events with deleted or tombstone evidence require redaction",
    });
  }
});
export type AuditTraceEvent = z.infer<typeof AuditTraceEventSchema>;

export const AuditTraceSchema = z.object({
  schema_version: z.literal("audit-trace-v1").default("audit-trace-v1"),
  trace_id: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  subject_refs: z.array(CompanionAutonomyRefSchema).min(1),
  events: z.array(AuditTraceEventSchema).min(1),
  visibility_policy_refs: z.array(CompanionAutonomyRefSchema).default([]),
}).strict();
export type AuditTrace = z.infer<typeof AuditTraceSchema>;

export const PermissionGrantBoundarySchema = z.object({
  schema_version: z.literal("permission-grant-boundary-v1").default("permission-grant-boundary-v1"),
  grant_id: z.string().min(1),
  state: z.enum(["proposed", "active", "expired", "revoked", "superseded"]),
  capabilities: z.array(PermissionGrantCapabilitySchema).min(1),
  excluded_capabilities: z.array(PermissionGrantExcludedCapabilitySchema).min(1),
  visibility_policy_ref: CompanionAutonomyRefSchema.optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type PermissionGrantBoundary = z.infer<typeof PermissionGrantBoundarySchema>;

export function canVisibilityPolicyExposeRawContent(policy: VisibilityPolicy): boolean {
  if (policy.content_lifecycle === "deleted" || policy.content_lifecycle === "tombstone") return false;
  if (policy.redaction_required) return false;
  return policy.raw_content_allowed;
}
