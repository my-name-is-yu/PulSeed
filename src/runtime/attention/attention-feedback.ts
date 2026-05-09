import { uniqueRefs } from "./attention-refs.js";
import type {
  AgentAgendaItemKind,
  AttentionSensitivity,
  CompanionAutonomyRef,
  OutcomeClass,
  UrgeOrigin,
} from "../types/companion-autonomy.js";

export const AttentionFeedbackKindValues = [
  "accepted",
  "dismissed",
  "correction",
  "overreach",
  "permission_revoked",
  "surface_narrowed",
] as const;
export type AttentionFeedbackKind = typeof AttentionFeedbackKindValues[number];

export type AttentionFeedbackEvent = {
  feedback_ref: CompanionAutonomyRef;
  kind: AttentionFeedbackKind;
  agenda_kind?: AgentAgendaItemKind;
  urge_origin?: UrgeOrigin;
  route?: OutcomeClass;
  surface_ref?: CompanionAutonomyRef;
  permission_ref?: CompanionAutonomyRef;
  sensitivity?: AttentionSensitivity;
};

export type AttentionFeedbackPolicyAdjustment = {
  cooldown_refs: CompanionAutonomyRef[];
  suppressed_agenda_kinds: AgentAgendaItemKind[];
  approval_required_outcomes: OutcomeClass[];
  narrowed_surface_refs: CompanionAutonomyRef[];
  sensitive_urge_origins: UrgeOrigin[];
  permission_update_refs: CompanionAutonomyRef[];
  audit_refs: CompanionAutonomyRef[];
  threshold_effects: Array<"raise_expression_threshold" | "raise_attention_threshold" | "preserve_thresholds">;
};

export function applyAttentionFeedbackConservatively(
  feedbackEvents: AttentionFeedbackEvent[]
): AttentionFeedbackPolicyAdjustment {
  const cooldownRefs: CompanionAutonomyRef[] = [];
  const suppressedAgendaKinds = new Set<AgentAgendaItemKind>();
  const approvalRequiredOutcomes = new Set<OutcomeClass>();
  const narrowedSurfaceRefs: CompanionAutonomyRef[] = [];
  const sensitiveUrgeOrigins = new Set<UrgeOrigin>();
  const permissionUpdateRefs: CompanionAutonomyRef[] = [];
  const auditRefs: CompanionAutonomyRef[] = [];
  const thresholdEffects = new Set<AttentionFeedbackPolicyAdjustment["threshold_effects"][number]>();
  const dismissalsByAgendaKind = new Map<AgentAgendaItemKind, number>();

  for (const event of feedbackEvents) {
    auditRefs.push(event.feedback_ref);

    switch (event.kind) {
      case "accepted": {
        thresholdEffects.add("preserve_thresholds");
        break;
      }
      case "dismissed":
      case "overreach": {
        cooldownRefs.push(event.feedback_ref);
        thresholdEffects.add("raise_expression_threshold");
        if (event.route) approvalRequiredOutcomes.add(event.route);
        if (event.agenda_kind) {
          dismissalsByAgendaKind.set(event.agenda_kind, (dismissalsByAgendaKind.get(event.agenda_kind) ?? 0) + 1);
        }
        if (event.urge_origin) sensitiveUrgeOrigins.add(event.urge_origin);
        break;
      }
      case "correction": {
        thresholdEffects.add("raise_attention_threshold");
        if (event.route) approvalRequiredOutcomes.add(event.route);
        if (event.urge_origin) sensitiveUrgeOrigins.add(event.urge_origin);
        break;
      }
      case "permission_revoked": {
        if (event.permission_ref) permissionUpdateRefs.push(event.permission_ref);
        if (event.route) approvalRequiredOutcomes.add(event.route);
        thresholdEffects.add("raise_expression_threshold");
        break;
      }
      case "surface_narrowed": {
        if (event.surface_ref) narrowedSurfaceRefs.push(event.surface_ref);
        thresholdEffects.add("raise_attention_threshold");
        break;
      }
    }
  }

  for (const [kind, count] of dismissalsByAgendaKind) {
    if (count >= 2) suppressedAgendaKinds.add(kind);
  }

  if (thresholdEffects.size === 0) thresholdEffects.add("preserve_thresholds");

  return {
    cooldown_refs: uniqueRefs(cooldownRefs),
    suppressed_agenda_kinds: [...suppressedAgendaKinds],
    approval_required_outcomes: [...approvalRequiredOutcomes],
    narrowed_surface_refs: uniqueRefs(narrowedSurfaceRefs),
    sensitive_urge_origins: [...sensitiveUrgeOrigins],
    permission_update_refs: uniqueRefs(permissionUpdateRefs),
    audit_refs: uniqueRefs(auditRefs),
    threshold_effects: [...thresholdEffects],
  };
}
