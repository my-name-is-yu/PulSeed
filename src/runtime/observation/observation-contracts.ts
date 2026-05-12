import { z } from "zod";
import {
  AttentionInputSchema,
  ref,
  type AttentionInput,
  type AttentionInputEffectPolicy,
} from "../attention/index.js";
import { stableId } from "../attention/attention-refs.js";
import {
  CompanionAutonomyRefSchema,
  CompanionAutonomySourceRefSchema,
  type CompanionAutonomyRef,
} from "../types/companion-autonomy.js";

const ObservationIsoTimestampSchema = z.string().datetime();
const ObservationBoundedDurationMsSchema = z.number().int().positive().safe().max(86_400_000);
const ObservationMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function refWithKind(...allowedKinds: CompanionAutonomyRef["kind"][]) {
  return CompanionAutonomyRefSchema.refine((value) => allowedKinds.includes(value.kind), {
    message: `ref kind must be one of: ${allowedKinds.join(", ")}`,
  });
}

const ApprovalRefSchema = refWithKind("approval");
const MemoryPromotionRefSchema = refWithKind("memory", "memory_candidate");
const ObservationSessionRefSchema = refWithKind("observation_session");
const ObservationEventRefSchema = refWithKind("observation_event");
const SurfaceRefSchema = refWithKind("surface");

export const ObservationModalitySchema = z.enum([
  "camera",
  "microphone",
  "screen",
  "image",
  "audio",
  "video",
  "multimodal",
]);
export type ObservationModality = z.infer<typeof ObservationModalitySchema>;

export const ObservationSourceKindSchema = z.enum([
  "device",
  "screen_capture",
  "file_attachment",
  "gateway_attachment",
  "runtime_connector",
  "manual_upload",
  "future_sensor",
  "dev_connector",
]);
export type ObservationSourceKind = z.infer<typeof ObservationSourceKindSchema>;

export const ObservationPurposeSchema = z.enum([
  "user_requested_context",
  "runtime_status",
  "environment_change",
  "evidence_collection",
  "safety_check",
  "attention_signal",
  "memory_candidate_review",
]);
export type ObservationPurpose = z.infer<typeof ObservationPurposeSchema>;

export const ObservationSessionStateSchema = z.enum([
  "requested",
  "active",
  "ended",
  "expired",
  "denied",
  "failed",
]);
export type ObservationSessionState = z.infer<typeof ObservationSessionStateSchema>;

export const ObservationEventKindSchema = z.enum([
  "session_requested",
  "session_started",
  "sample_observed",
  "summary_available",
  "permission_denied",
  "session_ended",
  "session_expired",
  "stale",
  "memory_candidate_created",
]);
export type ObservationEventKind = z.infer<typeof ObservationEventKindSchema>;

export const ObservationVisibleIndicatorStateSchema = z.enum([
  "pending",
  "shown",
  "not_available_fail_closed",
]);
export type ObservationVisibleIndicatorState = z.infer<typeof ObservationVisibleIndicatorStateSchema>;

export const ObservationVisibleIndicatorSchema = z.object({
  required: z.literal(true).default(true),
  state: ObservationVisibleIndicatorStateSchema,
  shown_at: ObservationIsoTimestampSchema.nullable().default(null),
  surface_ref: SurfaceRefSchema.nullable().default(null),
  reason: z.string().min(1),
}).strict().superRefine((indicator, ctx) => {
  if (indicator.state === "shown" && !indicator.shown_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shown_at"],
      message: "shown visible indicators require shown_at",
    });
  }
  if (indicator.state !== "shown" && indicator.shown_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shown_at"],
      message: "visible indicator timestamps are only valid when state is shown",
    });
  }
});
export type ObservationVisibleIndicator = z.infer<typeof ObservationVisibleIndicatorSchema>;

export const ObservationMemoryPromotionStatusSchema = z.enum([
  "not_requested",
  "candidate_pending_approval",
  "approved_for_derived_summary",
  "denied",
]);
export type ObservationMemoryPromotionStatus = z.infer<typeof ObservationMemoryPromotionStatusSchema>;

export const ObservationMemoryPromotionPolicySchema = z.object({
  status: ObservationMemoryPromotionStatusSchema.default("not_requested"),
  requires_approval: z.literal(true).default(true),
  approval_ref: ApprovalRefSchema.optional(),
  promoted_ref: MemoryPromotionRefSchema.optional(),
  reason: z.string().min(1),
}).strict().superRefine((promotion, ctx) => {
  if (promotion.status === "approved_for_derived_summary" && !promotion.approval_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approval_ref"],
      message: "approved observation memory promotion requires an approval_ref",
    });
  }
  if (promotion.status !== "approved_for_derived_summary" && promotion.promoted_ref?.kind === "memory") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["promoted_ref"],
      message: "durable memory refs require approved observation memory promotion",
    });
  }
});
export type ObservationMemoryPromotionPolicy = z.infer<typeof ObservationMemoryPromotionPolicySchema>;

export const ObservationMemoryPolicySchema = z.object({
  raw_media_persistence: z.literal("not_persisted").default("not_persisted"),
  raw_media_retention: z.literal("none").default("none"),
  derived_metadata_retention: z.enum(["session_only", "runtime_audit", "attention_signal"]),
  memory_promotion: ObservationMemoryPromotionPolicySchema,
}).strict();
export type ObservationMemoryPolicy = z.infer<typeof ObservationMemoryPolicySchema>;

export const ObservationSourceSchema = z.object({
  source_kind: ObservationSourceKindSchema,
  source_id: z.string().min(1),
  source_epoch: z.string().min(1),
  modality: ObservationModalitySchema,
}).strict();
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

export const ObservationSessionSchema = z.object({
  schema_version: z.literal("observation-session-v1").default("observation-session-v1"),
  session_id: z.string().min(1),
  source: ObservationSourceSchema,
  purpose: ObservationPurposeSchema,
  requested_at: ObservationIsoTimestampSchema,
  started_at: ObservationIsoTimestampSchema.nullable().default(null),
  expires_at: ObservationIsoTimestampSchema,
  max_duration_ms: ObservationBoundedDurationMsSchema,
  state: ObservationSessionStateSchema,
  visible_indicator: ObservationVisibleIndicatorSchema,
  memory_policy: ObservationMemoryPolicySchema,
  approval_ref: ApprovalRefSchema.optional(),
  created_by_ref: CompanionAutonomyRefSchema.optional(),
  no_continuous_sensing: z.literal(true).default(true),
  gui_capture_ui_included: z.literal(false).default(false),
  raw_media_persistence_enabled: z.literal(false).default(false),
  audit_refs: z.array(refWithKind("audit_trace")).default([]),
}).strict().superRefine((session, ctx) => {
  const startBoundary = session.started_at ?? session.requested_at;
  const duration = Date.parse(session.expires_at) - Date.parse(startBoundary);
  if (!Number.isFinite(duration) || duration <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "observation sessions require a future expires_at boundary",
    });
  }
  if (Number.isFinite(duration) && duration > session.max_duration_ms) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_duration_ms"],
      message: "observation session duration cannot exceed max_duration_ms",
    });
  }
  if (["active", "ended", "expired"].includes(session.state) && !session.started_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["started_at"],
      message: "started observation sessions require started_at",
    });
  }
  if (["active", "ended", "expired"].includes(session.state) && session.visible_indicator.state !== "shown") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visible_indicator", "state"],
      message: "started observation sessions require a shown visible indicator",
    });
  }
  if (session.started_at && session.visible_indicator.shown_at) {
    const shownAt = Date.parse(session.visible_indicator.shown_at);
    const startedAt = Date.parse(session.started_at);
    if (Number.isFinite(shownAt) && Number.isFinite(startedAt) && shownAt > startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visible_indicator", "shown_at"],
        message: "visible indicator must be shown before observation session starts",
      });
    }
  }
});
export type ObservationSession = z.infer<typeof ObservationSessionSchema>;

export const ObservationAttentionSignalPolicySchema = z.object({
  enters_attention: z.literal(true).default(true),
  direct_action: z.literal(false).default(false),
  effect_policy: z.object({
    wake: z.boolean().default(true),
    notify: z.literal(false).default(false),
    speak: z.literal(false).default(false),
    act: z.literal(false).default(false),
  }).strict().default({ wake: true }),
}).strict();
export type ObservationAttentionSignalPolicy = z.infer<typeof ObservationAttentionSignalPolicySchema>;

export const ObservationEventSchema = z.object({
  schema_version: z.literal("observation-event-v1").default("observation-event-v1"),
  event_id: z.string().min(1),
  session_ref: ObservationSessionRefSchema,
  source_event_id: z.string().min(1).optional(),
  observed_at: ObservationIsoTimestampSchema,
  modality: ObservationModalitySchema,
  event_kind: ObservationEventKindSchema,
  summary: z.string().min(1),
  attention_signal: ObservationAttentionSignalPolicySchema.default({}),
  derived_metadata: z.record(ObservationMetadataValueSchema).default({}),
  derived_evidence_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  memory_policy: ObservationMemoryPolicySchema,
  observation_ref: ObservationEventRefSchema.optional(),
  raw_media: z.never().optional(),
  raw_media_ref: z.never().optional(),
  audit_refs: z.array(refWithKind("audit_trace")).default([]),
}).strict();
export type ObservationEvent = z.infer<typeof ObservationEventSchema>;

export interface CreateObservationSessionInput extends z.input<typeof ObservationSessionSchema> {}
export interface CreateObservationEventInput extends z.input<typeof ObservationEventSchema> {}

export interface ObservationEventAttentionInput {
  session: ObservationSession;
  event: ObservationEvent;
  emitted_at?: string;
  active_surface_ref?: CompanionAutonomyRef | null;
  current_session_refs?: CompanionAutonomyRef[];
  current_goal_refs?: CompanionAutonomyRef[];
  feedback_refs?: CompanionAutonomyRef[];
  stale_refs?: CompanionAutonomyRef[];
  invalidation_refs?: CompanionAutonomyRef[];
}

export function createObservationSession(input: CreateObservationSessionInput): ObservationSession {
  return ObservationSessionSchema.parse(input);
}

export function createObservationEvent(input: CreateObservationEventInput): ObservationEvent {
  return ObservationEventSchema.parse(input);
}

export function observationEventToAttentionInput(input: ObservationEventAttentionInput): AttentionInput {
  const session = ObservationSessionSchema.parse(input.session);
  const event = ObservationEventSchema.parse(input.event);
  const sessionRef = ref("observation_session", session.session_id);
  if (event.session_ref.id !== sessionRef.id) {
    throw new Error(`observation event "${event.event_id}" does not belong to session "${session.session_id}"`);
  }
  if (event.modality !== session.source.modality && session.source.modality !== "multimodal") {
    throw new Error(
      `observation event modality "${event.modality}" does not match session modality "${session.source.modality}"`
    );
  }
  assertObservationEventWithinSession(session, event);
  assertObservationSessionCanEmitEvent(session, event);

  const effectPolicy = event.attention_signal.effect_policy satisfies AttentionInputEffectPolicy;
  const replayKey = `observation:${session.session_id}:${event.event_id}`;
  return AttentionInputSchema.parse({
    attention_input_id: `attention-input:observation_event:${stableId(replayKey)}`,
    source: {
      source_kind: "observation_event",
      source_id: event.event_id,
      source_epoch: session.source.source_epoch,
      high_watermark: event.observed_at,
      replay_key: replayKey,
      emitted_at: input.emitted_at ?? event.observed_at,
    },
    signal_source: "observation",
    signal_ref: {
      ref: event.observation_ref ?? ref("observation_event", event.event_id),
      lifecycle: "active",
    },
    effect_policy: effectPolicy,
    payload_class: `observation.${event.event_kind}`,
    summary: event.summary,
    active_surface_ref: input.active_surface_ref ?? null,
    current_session_refs: input.current_session_refs ?? [],
    current_goal_refs: input.current_goal_refs ?? [],
    feedback_refs: input.feedback_refs ?? [],
    stale_refs: input.stale_refs ?? [],
    invalidation_refs: input.invalidation_refs ?? [],
  });
}

function assertObservationSessionCanEmitEvent(session: ObservationSession, event: ObservationEvent): void {
  if (!observationEventRequiresStartedSession(event.event_kind)) return;
  if (!session.started_at || !["active", "ended", "expired"].includes(session.state)) {
    throw new Error(
      `observation event "${event.event_id}" requires a started observation session with a shown visible indicator`
    );
  }
  if (session.visible_indicator.state !== "shown" || !session.visible_indicator.shown_at) {
    throw new Error(
      `observation event "${event.event_id}" requires a started observation session with a shown visible indicator`
    );
  }
  const shownAt = Date.parse(session.visible_indicator.shown_at);
  const observedAt = Date.parse(event.observed_at);
  if (!Number.isFinite(shownAt) || !Number.isFinite(observedAt) || shownAt > observedAt) {
    throw new Error(`observation event "${event.event_id}" occurred before the visible indicator was shown`);
  }
}

function assertObservationEventWithinSession(session: ObservationSession, event: ObservationEvent): void {
  const sessionStartedAt = session.started_at ?? session.requested_at;
  const observedAt = Date.parse(event.observed_at);
  const startsAt = Date.parse(sessionStartedAt);
  const expiresAt = Date.parse(session.expires_at);
  if (!Number.isFinite(observedAt) || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt)) {
    throw new Error(`observation event "${event.event_id}" has ambiguous session timing`);
  }
  if (observedAt < startsAt || (observedAt > expiresAt && !isTerminalObservationEvent(event.event_kind))) {
    throw new Error(
      `observation event "${event.event_id}" occurred outside session "${session.session_id}" bounded window`
    );
  }
  if (event.event_kind === "session_expired" && observedAt < expiresAt) {
    throw new Error(`observation event "${event.event_id}" cannot expire session "${session.session_id}" before expires_at`);
  }
}

function observationEventRequiresStartedSession(kind: ObservationEventKind): boolean {
  return kind !== "session_requested" && kind !== "permission_denied";
}

function isTerminalObservationEvent(kind: ObservationEventKind): boolean {
  return kind === "session_ended" || kind === "session_expired";
}
