import { createHash } from "node:crypto";
import { z } from "zod/v3";
import type {
  ProactiveInterventionSummary,
} from "../store/proactive-intervention-store.js";
import type {
  PeerFeedbackProjection,
} from "./store.js";

const PeerInitiativeDiagnosticSurfaceSchema = z.enum([
  "telegram",
  "discord",
  "whatsapp",
  "slack",
  "gui",
  "gateway",
]);

export const PeerInitiativeCurrentCapabilityProjectionSchema = z.object({
  schema_version: z.literal("peer-initiative-current-capability/v1"),
  read_only: z.literal(true).default(true),
  mutation_performed: z.literal(false).default(false),
  current_capability: z.literal("telegram_outbound_peer_initiative_mvp"),
  delivery_surfaces: z.array(z.object({
    surface: PeerInitiativeDiagnosticSurfaceSchema,
    current_status: z.enum(["implemented_mvp", "contract_only_future"]),
    normal_user_claim: z.string().min(1),
  }).strict()).min(1),
  channel_budget_required_before_expansion: z.literal(true).default(true),
  explicit_opt_in_required_before_expansion: z.literal(true).default(true),
  raw_refs_visible: z.literal(false).default(false),
  capability_internals_visible: z.literal(false).default(false),
}).strict();
export type PeerInitiativeCurrentCapabilityProjection = z.infer<typeof PeerInitiativeCurrentCapabilityProjectionSchema>;

export const PeerInitiativeRelationshipReviewItemSchema = z.object({
  schema_version: z.literal("peer-initiative-relationship-review-item/v1"),
  review_item_id: z.string().min(1),
  source_surface: PeerInitiativeDiagnosticSurfaceSchema,
  kind: z.string().min(1),
  created_at: z.string().datetime(),
  review_reason: z.literal("wrong_read_feedback"),
  normal_summary: z.string().min(1),
  relationship_profile_write_performed: z.literal(false).default(false),
  raw_refs_visible: z.literal(false).default(false),
}).strict();
export type PeerInitiativeRelationshipReviewItem = z.infer<typeof PeerInitiativeRelationshipReviewItemSchema>;

export const PeerInitiativeCalibrationReportSchema = z.object({
  schema_version: z.literal("peer-initiative-calibration-report/v1"),
  generated_at: z.string().datetime(),
  read_only: z.literal(true).default(true),
  mutation_performed: z.literal(false).default(false),
  surface_scope: z.literal("telegram_mvp"),
  source_counts: z.object({
    proactive_intervention_feedback_count: z.number().int().nonnegative(),
    peer_feedback_projection_count: z.number().int().nonnegative(),
  }).strict(),
  threshold_tuning_evidence: z.object({
    accepted_count: z.number().int().nonnegative(),
    dismissed_count: z.number().int().nonnegative(),
    corrected_count: z.number().int().nonnegative(),
    overreach_count: z.number().int().nonnegative(),
    wrong_read_count: z.number().int().nonnegative(),
    more_like_this_count: z.number().int().nonnegative(),
    less_like_this_count: z.number().int().nonnegative(),
    not_now_count: z.number().int().nonnegative(),
    mute_this_kind_count: z.number().int().nonnegative(),
  }).strict(),
  recommendation: z.enum([
    "insufficient_feedback",
    "keep_threshold_pending_more_feedback",
    "keep_or_lower_threshold_cautiously",
    "raise_threshold_or_narrow_scope",
    "review_relationship_reading",
  ]),
  automatic_threshold_change_performed: z.literal(false).default(false),
  relationship_profile_write_performed: z.literal(false).default(false),
  relationship_review: z.object({
    review_item_count: z.number().int().nonnegative(),
    pending_wrong_read_count: z.number().int().nonnegative(),
    items: z.array(PeerInitiativeRelationshipReviewItemSchema).default([]),
    raw_refs_visible: z.literal(false).default(false),
    relationship_profile_write_performed: z.literal(false).default(false),
  }).strict(),
  raw_refs_visible: z.literal(false).default(false),
}).strict();
export type PeerInitiativeCalibrationReport = z.infer<typeof PeerInitiativeCalibrationReportSchema>;

export function projectPeerInitiativeCurrentCapability(): PeerInitiativeCurrentCapabilityProjection {
  return PeerInitiativeCurrentCapabilityProjectionSchema.parse({
    schema_version: "peer-initiative-current-capability/v1",
    read_only: true,
    mutation_performed: false,
    current_capability: "telegram_outbound_peer_initiative_mvp",
    delivery_surfaces: [
      {
        surface: "telegram",
        current_status: "implemented_mvp",
        normal_user_claim: "Resident peer initiatives can currently deliver low-pressure outbound messages through the Telegram MVP path.",
      },
      ...(["discord", "whatsapp", "slack", "gui"] as const).map((surface) => ({
        surface,
        current_status: "contract_only_future" as const,
        normal_user_claim: "Not a current delivery surface until channel budgets, opt-in, and feedback calibration exist.",
      })),
    ],
    channel_budget_required_before_expansion: true,
    explicit_opt_in_required_before_expansion: true,
    raw_refs_visible: false,
    capability_internals_visible: false,
  });
}

export function createPeerInitiativeCalibrationReport(input: {
  generatedAt: string;
  proactiveSummary: ProactiveInterventionSummary;
  peerFeedbackProjections: readonly PeerFeedbackProjection[];
}): PeerInitiativeCalibrationReport {
  const peerCounts = countPeerFeedback(input.peerFeedbackProjections);
  const relationshipReviewItems = createPeerInitiativeRelationshipReviewItems(input.peerFeedbackProjections);
  const accepted = input.proactiveSummary.accepted_count + peerCounts.more_like_this_count;
  const dismissed = input.proactiveSummary.dismissed_count
    + peerCounts.less_like_this_count
    + peerCounts.not_now_count
    + peerCounts.mute_this_kind_count;
  const corrected = input.proactiveSummary.corrected_count + peerCounts.wrong_read_count;

  return PeerInitiativeCalibrationReportSchema.parse({
    schema_version: "peer-initiative-calibration-report/v1",
    generated_at: input.generatedAt,
    read_only: true,
    mutation_performed: false,
    surface_scope: "telegram_mvp",
    source_counts: {
      proactive_intervention_feedback_count: input.proactiveSummary.response_count,
      peer_feedback_projection_count: input.peerFeedbackProjections.length,
    },
    threshold_tuning_evidence: {
      accepted_count: accepted,
      dismissed_count: dismissed,
      corrected_count: corrected,
      overreach_count: input.proactiveSummary.overreach_count,
      ...peerCounts,
    },
    recommendation: recommendationFor({
      accepted,
      dismissed,
      corrected,
      overreach: input.proactiveSummary.overreach_count,
      wrongRead: peerCounts.wrong_read_count,
    }),
    automatic_threshold_change_performed: false,
    relationship_profile_write_performed: false,
    relationship_review: {
      review_item_count: relationshipReviewItems.length,
      pending_wrong_read_count: relationshipReviewItems.length,
      items: relationshipReviewItems,
      raw_refs_visible: false,
      relationship_profile_write_performed: false,
    },
    raw_refs_visible: false,
  });
}

export function createPeerInitiativeRelationshipReviewItems(
  projections: readonly PeerFeedbackProjection[]
): PeerInitiativeRelationshipReviewItem[] {
  return projections
    .filter((projection) => projection.structured_outcome === "wrong_read")
    .map((projection) => PeerInitiativeRelationshipReviewItemSchema.parse({
      schema_version: "peer-initiative-relationship-review-item/v1",
      review_item_id: `relationship-review:${stableToken(projection.projection_id)}`,
      source_surface: projection.source_surface,
      kind: projection.kind,
      created_at: projection.projected_at,
      review_reason: "wrong_read_feedback",
      normal_summary: "User marked this proactive read as wrong; review the relationship reading before changing stable memory.",
      relationship_profile_write_performed: false,
      raw_refs_visible: false,
    }));
}

function countPeerFeedback(projections: readonly PeerFeedbackProjection[]) {
  const counts = {
    wrong_read_count: 0,
    more_like_this_count: 0,
    less_like_this_count: 0,
    not_now_count: 0,
    mute_this_kind_count: 0,
  };
  for (const projection of projections) {
    switch (projection.structured_outcome) {
      case "wrong_read":
        counts.wrong_read_count += 1;
        break;
      case "more_like_this":
        counts.more_like_this_count += 1;
        break;
      case "less_like_this":
        counts.less_like_this_count += 1;
        break;
      case "not_now":
        counts.not_now_count += 1;
        break;
      case "mute_this_kind":
        counts.mute_this_kind_count += 1;
        break;
    }
  }
  return counts;
}

function recommendationFor(input: {
  accepted: number;
  dismissed: number;
  corrected: number;
  overreach: number;
  wrongRead: number;
}): PeerInitiativeCalibrationReport["recommendation"] {
  const total = input.accepted + input.dismissed + input.corrected + input.overreach;
  if (total === 0) return "insufficient_feedback";
  if (input.wrongRead > 0) return "review_relationship_reading";
  if (input.dismissed + input.overreach > input.accepted) return "raise_threshold_or_narrow_scope";
  if (input.accepted > input.dismissed + input.corrected + input.overreach) return "keep_or_lower_threshold_cautiously";
  return "keep_threshold_pending_more_feedback";
}

function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
