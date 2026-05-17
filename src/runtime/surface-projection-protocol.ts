import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  SurfaceProjectionSchema as GroundingSurfaceProjectionSchema,
  type SurfaceProjection as GroundingSurfaceProjection,
} from "../grounding/surface-contracts.js";
import {
  CompanionActionProjectionSchema,
  type CompanionActionProjection,
} from "./control/companion-action-projection.js";
import {
  SurfaceDeliveryProjectionSchema as AttentionSurfaceDeliveryProjectionSchema,
  type SurfaceDeliveryProjection as AttentionSurfaceDeliveryProjection,
} from "./attention/surface-delivery.js";

export const SurfaceProtocolSchemaVersion = "surface-projection-protocol/v1" as const;

export const SurfaceKindSchema = z.enum([
  "chat",
  "gateway",
  "cli_status",
  "cli_report",
  "runtime_status",
  "tui_status",
  "telegram_peer_delivery",
  "approval",
  "memory_profile_summary",
  "operator_debug",
  "gui",
]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const SurfaceViewSchema = z.enum(["normal", "operator_debug"]);
export type SurfaceView = z.infer<typeof SurfaceViewSchema>;

export const SurfaceRedactionClassSchema = z.enum([
  "normal_safe",
  "normal_redacted",
  "operator_debug",
  "transport_secret_redacted",
]);
export type SurfaceRedactionClass = z.infer<typeof SurfaceRedactionClassSchema>;

export const SurfaceRefVisibilitySchema = z.enum(["normal_safe", "operator_debug"]);
export type SurfaceRefVisibility = z.infer<typeof SurfaceRefVisibilitySchema>;

export const SurfaceSourceEventRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  event_type: z.string().min(1).optional(),
  occurred_at: z.string().datetime().optional(),
  replay_key: z.string().min(1).optional(),
  visibility: SurfaceRefVisibilitySchema.default("normal_safe"),
}).strict();
export type SurfaceSourceEventRef = z.infer<typeof SurfaceSourceEventRefSchema>;

export const SurfaceRuntimeGraphRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  role: z.enum(["source", "target", "decision", "binding", "evidence", "projection"]).default("source"),
  visibility: SurfaceRefVisibilitySchema.default("normal_safe"),
}).strict();
export type SurfaceRuntimeGraphRef = z.infer<typeof SurfaceRuntimeGraphRefSchema>;

export const SurfaceProjectionRefSchema = z.object({
  kind: z.enum([
    "grounding_surface",
    "companion_action",
    "surface_delivery",
    "execution_authority",
    "memory_summary",
    "status_summary",
    "approval_prompt",
  ]),
  ref: z.string().min(1),
  visibility: SurfaceRefVisibilitySchema.default("normal_safe"),
}).strict();
export type SurfaceProjectionRef = z.infer<typeof SurfaceProjectionRefSchema>;

export const SurfacePanelSchema = z.object({
  panel_id: z.string().min(1),
  title: z.string().min(1).optional(),
  body: z.string().min(1),
  tone: z.enum(["plain", "success", "warning", "danger", "muted"]).default("plain"),
  priority: z.number().int().nonnegative().default(0),
}).strict();
export type SurfacePanel = z.infer<typeof SurfacePanelSchema>;

export const SurfaceArtifactCardSchema = z.object({
  artifact_id: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).strict();
export type SurfaceArtifactCard = z.infer<typeof SurfaceArtifactCardSchema>;

export const SurfaceActionKindSchema = z.enum([
  "approve",
  "reject",
  "show_prepared",
  "use_once",
  "approve_external_action",
  "more_like_this",
  "less_like_this",
  "not_now",
  "wrong_read",
  "mute_this_kind",
  "open",
  "inspect",
  "dismiss",
]);
export type SurfaceActionKind = z.infer<typeof SurfaceActionKindSchema>;

export const SurfaceActionTargetSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  session_id: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  transport_message_ref: z.string().min(1).optional(),
  surface_instance_ref: z.string().min(1).optional(),
}).strict();
export type SurfaceActionTarget = z.infer<typeof SurfaceActionTargetSchema>;

export const SurfaceActionBindingSchema = z.object({
  schema_version: z.literal(SurfaceProtocolSchemaVersion).default(SurfaceProtocolSchemaVersion),
  binding_id: z.string().min(1),
  action_kind: SurfaceActionKindSchema,
  surface: SurfaceKindSchema,
  surface_instance_ref: z.string().min(1),
  target: SurfaceActionTargetSchema,
  source_projection_id: z.string().min(1),
  source_event_refs: z.array(SurfaceSourceEventRefSchema).default([]),
  runtime_graph_refs: z.array(SurfaceRuntimeGraphRefSchema).default([]),
  operation_ref: z.string().min(1).optional(),
  replay_key: z.string().min(1),
  redaction_class: SurfaceRedactionClassSchema,
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable().default(null),
  status: z.enum(["active", "stale", "expired"]).default("active"),
}).strict();
export type SurfaceActionBinding = z.infer<typeof SurfaceActionBindingSchema>;

export const SurfaceActionSchema = z.object({
  action_id: z.string().min(1),
  kind: SurfaceActionKindSchema,
  label: z.string().min(1),
  style: z.enum(["primary", "secondary", "danger", "muted"]).default("secondary"),
  binding_id: z.string().min(1).optional(),
  disabled: z.boolean().default(false),
  disabled_reason: z.string().min(1).optional(),
}).strict();
export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

export const SurfaceApprovalPromptSchema = z.object({
  approval_id: z.string().min(1),
  prompt: z.string().min(1),
  action: z.string().min(1),
  target_summary: z.string().min(1),
  risk_class: z.string().min(1).optional(),
  expires_at: z.string().datetime().optional(),
  approve_binding_id: z.string().min(1),
  reject_binding_id: z.string().min(1),
}).strict();
export type SurfaceApprovalPrompt = z.infer<typeof SurfaceApprovalPromptSchema>;

export const SurfaceMemorySummarySchema = z.object({
  summary_id: z.string().min(1),
  projection_ref: z.string().min(1).optional(),
  title: z.string().min(1),
  included_count: z.number().int().nonnegative(),
  withheld_count: z.number().int().nonnegative(),
  normal_text: z.string().min(1),
  redaction_applied: z.boolean().default(true),
}).strict();
export type SurfaceMemorySummary = z.infer<typeof SurfaceMemorySummarySchema>;

export const SurfaceStatusSummarySchema = z.object({
  summary_id: z.string().min(1),
  subject_kind: z.string().min(1),
  subject_label: z.string().min(1),
  lifecycle: z.string().min(1),
  liveness: z.string().min(1).optional(),
  updated_at: z.string().datetime().nullable().default(null),
  attention_required: z.boolean().default(false),
  blockers: z.array(z.string().min(1)).default([]),
}).strict();
export type SurfaceStatusSummary = z.infer<typeof SurfaceStatusSummarySchema>;

export const SurfaceDeliveryProjectionSchema = z.object({
  delivery_id: z.string().min(1),
  surface: SurfaceKindSchema,
  mode: z.enum(["body_message", "approval_request", "digest_item", "status", "quiet_audit", "transport"]),
  text: z.string().min(1).optional(),
  should_render: z.boolean(),
  action_binding_ids: z.array(z.string().min(1)).default([]),
  transport_ref: z.string().min(1).optional(),
  source_delivery_projection_ref: z.string().min(1).optional(),
}).strict();
export type SurfaceDeliveryProjection = z.infer<typeof SurfaceDeliveryProjectionSchema>;

export const SurfaceNormalViewSchema = z.object({
  view: z.literal("normal"),
  projection_id: z.string().min(1),
  surface: SurfaceKindSchema,
  title: z.string().min(1).optional(),
  panels: z.array(SurfacePanelSchema).default([]),
  artifact_cards: z.array(SurfaceArtifactCardSchema).default([]),
  actions: z.array(SurfaceActionSchema).default([]),
  approval_prompt: SurfaceApprovalPromptSchema.optional(),
  memory_summary: SurfaceMemorySummarySchema.optional(),
  status_summary: SurfaceStatusSummarySchema.optional(),
  delivery: SurfaceDeliveryProjectionSchema.optional(),
  redaction: z.object({
    raw_trace_ids_visible: z.literal(false).default(false),
    raw_evidence_refs_visible: z.literal(false).default(false),
    policy_rationale_visible: z.literal(false).default(false),
    memory_truth_internals_visible: z.literal(false).default(false),
    approval_fingerprints_visible: z.literal(false).default(false),
    operator_refs_visible: z.literal(false).default(false),
  }).strict().default({}),
}).strict();
export type SurfaceNormalView = z.infer<typeof SurfaceNormalViewSchema>;

export const SurfaceOperatorDebugViewSchema = z.object({
  view: z.literal("operator_debug"),
  projection_id: z.string().min(1),
  surface: SurfaceKindSchema,
  title: z.string().min(1).optional(),
  panels: z.array(SurfacePanelSchema).default([]),
  artifact_cards: z.array(SurfaceArtifactCardSchema).default([]),
  actions: z.array(SurfaceActionSchema).default([]),
  source_event_refs: z.array(SurfaceSourceEventRefSchema).default([]),
  runtime_graph_refs: z.array(SurfaceRuntimeGraphRefSchema).default([]),
  projection_refs: z.array(SurfaceProjectionRefSchema).default([]),
  action_bindings: z.array(SurfaceActionBindingSchema).default([]),
  operator_notes: z.array(z.string().min(1)).default([]),
}).strict();
export type SurfaceOperatorDebugView = z.infer<typeof SurfaceOperatorDebugViewSchema>;

const SurfaceProjectionObjectSchema = z.object({
  schema_version: z.literal(SurfaceProtocolSchemaVersion).default(SurfaceProtocolSchemaVersion),
  projection_id: z.string().min(1),
  replay_key: z.string().min(1),
  surface: SurfaceKindSchema,
  view: SurfaceViewSchema,
  purpose: z.string().min(1),
  redaction_class: SurfaceRedactionClassSchema,
  projected_at: z.string().datetime(),
  source_event_refs: z.array(SurfaceSourceEventRefSchema).default([]),
  runtime_graph_refs: z.array(SurfaceRuntimeGraphRefSchema).default([]),
  projection_refs: z.array(SurfaceProjectionRefSchema).default([]),
  panels: z.array(SurfacePanelSchema).default([]),
  artifact_cards: z.array(SurfaceArtifactCardSchema).default([]),
  actions: z.array(SurfaceActionSchema).default([]),
  action_bindings: z.array(SurfaceActionBindingSchema).default([]),
  approval_prompt: SurfaceApprovalPromptSchema.optional(),
  memory_summary: SurfaceMemorySummarySchema.optional(),
  status_summary: SurfaceStatusSummarySchema.optional(),
  delivery: SurfaceDeliveryProjectionSchema.optional(),
  normal_view: SurfaceNormalViewSchema.optional(),
  operator_debug_view: SurfaceOperatorDebugViewSchema.optional(),
}).strict();

export const SurfaceProjectionSchema = SurfaceProjectionObjectSchema.superRefine((projection, ctx) => {
  if (projection.view === "normal") {
    if (projection.redaction_class === "operator_debug") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction_class"],
        message: "normal SurfaceProjection cannot use operator_debug redaction class",
      });
    }
    if (projection.operator_debug_view) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator_debug_view"],
        message: "normal SurfaceProjection cannot carry an operator_debug_view",
      });
    }
    const operatorRef = [
      ...projection.source_event_refs,
      ...projection.runtime_graph_refs,
      ...projection.projection_refs,
    ].find((ref) => ref.visibility === "operator_debug");
    if (operatorRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_event_refs"],
        message: "normal SurfaceProjection cannot expose operator/debug refs",
      });
    }
  }
  if (projection.view === "operator_debug" && !projection.operator_debug_view) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operator_debug_view"],
      message: "operator/debug SurfaceProjection must carry an operator_debug_view",
    });
  }
});
export type SurfaceProjection = z.infer<typeof SurfaceProjectionSchema>;
export type SurfaceProjectionInput = z.input<typeof SurfaceProjectionSchema>;

export type SurfaceActionBindingValidationInput = {
  binding: SurfaceActionBinding;
  surface: SurfaceKind;
  surfaceInstanceRef: string;
  actionKind?: SurfaceActionKind;
  conversationId?: string;
  sessionId?: string;
  messageId?: string;
  transportMessageRef?: string;
  replayKey?: string;
  now?: string;
};

export type SurfaceActionBindingValidationResult =
  | { status: "accepted"; binding: SurfaceActionBinding }
  | { status: "rejected"; reason: "stale" | "expired" | "surface_mismatch" | "target_mismatch" | "action_mismatch" | "replay_mismatch"; binding: SurfaceActionBinding };

export function createSurfaceProjection(input: Omit<SurfaceProjectionInput, "schema_version" | "projection_id" | "normal_view" | "operator_debug_view"> & {
  projection_id?: string;
}): SurfaceProjection {
  const replayKey = input.replay_key;
  const projectionId = input.projection_id ?? `surface:${stableToken({
    replayKey,
    surface: input.surface,
    view: input.view,
    purpose: input.purpose,
    sourceRefs: input.source_event_refs ?? [],
    runtimeRefs: input.runtime_graph_refs ?? [],
  })}`;
  const base = {
    ...input,
    schema_version: SurfaceProtocolSchemaVersion,
    projection_id: projectionId,
  };
  const parsedBase = SurfaceProjectionObjectSchema.omit({
    normal_view: true,
    operator_debug_view: true,
  }).parse(base);
  const normalView = parsedBase.view === "normal"
    ? createSurfaceNormalView(parsedBase)
    : undefined;
  const operatorDebugView = parsedBase.view === "operator_debug"
    ? createSurfaceOperatorDebugView(parsedBase)
    : undefined;
  return SurfaceProjectionSchema.parse({
    ...parsedBase,
    ...(normalView ? { normal_view: normalView } : {}),
    ...(operatorDebugView ? { operator_debug_view: operatorDebugView } : {}),
  });
}

export function createSurfaceNormalView(projection: Omit<SurfaceProjection, "normal_view" | "operator_debug_view">): SurfaceNormalView {
  if (projection.view !== "normal") {
    throw new Error("Cannot create a normal Surface view from an operator/debug projection.");
  }
  return SurfaceNormalViewSchema.parse({
    view: "normal",
    projection_id: projection.projection_id,
    surface: projection.surface,
    panels: projection.panels,
    artifact_cards: projection.artifact_cards,
    actions: projection.actions,
    approval_prompt: projection.approval_prompt,
    memory_summary: projection.memory_summary,
    status_summary: projection.status_summary,
    delivery: projection.delivery,
    redaction: {},
  });
}

export function createSurfaceOperatorDebugView(projection: Omit<SurfaceProjection, "normal_view" | "operator_debug_view">): SurfaceOperatorDebugView {
  if (projection.view !== "operator_debug") {
    throw new Error("Cannot create an operator/debug Surface view from a normal projection.");
  }
  return SurfaceOperatorDebugViewSchema.parse({
    view: "operator_debug",
    projection_id: projection.projection_id,
    surface: projection.surface,
    panels: projection.panels,
    artifact_cards: projection.artifact_cards,
    actions: projection.actions,
    source_event_refs: projection.source_event_refs,
    runtime_graph_refs: projection.runtime_graph_refs,
    projection_refs: projection.projection_refs,
    action_bindings: projection.action_bindings,
  });
}

export function createSurfaceActionBinding(input: Omit<z.input<typeof SurfaceActionBindingSchema>, "schema_version" | "binding_id"> & {
  binding_id?: string;
}): SurfaceActionBinding {
  const replayKey = input.replay_key;
  const bindingId = input.binding_id ?? `sab:${stableToken({
    replayKey,
    actionKind: input.action_kind,
    surface: input.surface,
    surfaceInstanceRef: input.surface_instance_ref,
    target: input.target,
    sourceProjectionId: input.source_projection_id,
  }).slice(0, 24)}`;
  return SurfaceActionBindingSchema.parse({
    ...input,
    schema_version: SurfaceProtocolSchemaVersion,
    binding_id: bindingId,
  });
}

export function validateSurfaceActionBinding(input: SurfaceActionBindingValidationInput): SurfaceActionBindingValidationResult {
  const binding = SurfaceActionBindingSchema.parse(input.binding);
  if (binding.status !== "active") return { status: "rejected", reason: "stale", binding };
  if (binding.expires_at && Date.parse(input.now ?? new Date().toISOString()) > Date.parse(binding.expires_at)) {
    return { status: "rejected", reason: "expired", binding };
  }
  if (binding.surface !== input.surface || binding.surface_instance_ref !== input.surfaceInstanceRef) {
    return { status: "rejected", reason: "surface_mismatch", binding };
  }
  if (input.actionKind && binding.action_kind !== input.actionKind) {
    return { status: "rejected", reason: "action_mismatch", binding };
  }
  if (input.replayKey && binding.replay_key !== input.replayKey) {
    return { status: "rejected", reason: "replay_mismatch", binding };
  }
  const targetChecks: Array<[string | undefined, string | undefined]> = [
    [binding.target.conversation_id, input.conversationId],
    [binding.target.session_id, input.sessionId],
    [binding.target.message_id, input.messageId],
    [binding.target.transport_message_ref, input.transportMessageRef],
  ];
  if (targetChecks.some(([expected, actual]) => expected !== undefined && expected !== actual)) {
    return { status: "rejected", reason: "target_mismatch", binding };
  }
  return { status: "accepted", binding };
}

export function surfaceActionBindingToken(binding: SurfaceActionBinding): string {
  return binding.binding_id.replace(/^sab:/, "");
}

export function findSurfaceActionBindingByToken(
  bindings: readonly SurfaceActionBinding[],
  token: string
): SurfaceActionBinding | null {
  return bindings.find((binding) =>
    binding.binding_id === token || surfaceActionBindingToken(binding) === token
  ) ?? null;
}

export function normalSourceEventRef(input: Omit<SurfaceSourceEventRef, "ref" | "visibility"> & { ref: string }): SurfaceSourceEventRef {
  return SurfaceSourceEventRefSchema.parse({
    ...input,
    ref: `surface-event:${stableToken([input.kind, input.ref, input.event_type ?? "", input.replay_key ?? ""])}`,
    visibility: "normal_safe",
  });
}

export function operatorSourceEventRef(input: Omit<SurfaceSourceEventRef, "visibility">): SurfaceSourceEventRef {
  return SurfaceSourceEventRefSchema.parse({ ...input, visibility: "operator_debug" });
}

export function normalRuntimeGraphRef(input: Omit<SurfaceRuntimeGraphRef, "ref" | "visibility"> & { ref: string }): SurfaceRuntimeGraphRef {
  return SurfaceRuntimeGraphRefSchema.parse({
    ...input,
    ref: `runtime-graph:${stableToken([input.kind, input.ref, input.role ?? "source"])}`,
    visibility: "normal_safe",
  });
}

export function operatorRuntimeGraphRef(input: Omit<SurfaceRuntimeGraphRef, "visibility">): SurfaceRuntimeGraphRef {
  return SurfaceRuntimeGraphRefSchema.parse({ ...input, visibility: "operator_debug" });
}

export function projectionRefFromGroundingSurface(projection: GroundingSurfaceProjection): SurfaceProjectionRef {
  const parsed = GroundingSurfaceProjectionSchema.parse(projection);
  return SurfaceProjectionRefSchema.parse({
    kind: "grounding_surface",
    ref: parsed.id,
    visibility: "normal_safe",
  });
}

export function projectionRefFromCompanionAction(projection: CompanionActionProjection): SurfaceProjectionRef {
  const parsed = CompanionActionProjectionSchema.parse(projection);
  return SurfaceProjectionRefSchema.parse({
    kind: "companion_action",
    ref: parsed.projection_id,
    visibility: parsed.surface_expression_policy.surface_kind === "normal_companion" ? "normal_safe" : "operator_debug",
  });
}

export function deliveryFromAttentionSurfaceProjection(
  projection: AttentionSurfaceDeliveryProjection,
  surface: SurfaceKind
): SurfaceDeliveryProjection {
  const parsed = AttentionSurfaceDeliveryProjectionSchema.parse(projection);
  return SurfaceDeliveryProjectionSchema.parse({
    delivery_id: parsed.delivery_id,
    surface,
    mode: parsed.delivery_mode === "watch_status" ? "status" : parsed.delivery_mode,
    text: parsed.user_facing_text,
    should_render: parsed.should_render,
    source_delivery_projection_ref: parsed.delivery_id,
  });
}

export function projectTextSurface(input: {
  surface: SurfaceKind;
  text: string;
  purpose: string;
  projectedAt: string;
  replayKey: string;
  sourceEventRefs?: SurfaceSourceEventRef[];
  runtimeGraphRefs?: SurfaceRuntimeGraphRef[];
  projectionRefs?: SurfaceProjectionRef[];
  delivery?: SurfaceDeliveryProjection;
  view?: SurfaceView;
}): SurfaceProjection {
  const view = input.view ?? "normal";
  const redactionClass: SurfaceRedactionClass = view === "normal" ? "normal_safe" : "operator_debug";
  return createSurfaceProjection({
    surface: input.surface,
    view,
    purpose: input.purpose,
    redaction_class: redactionClass,
    projected_at: input.projectedAt,
    replay_key: input.replayKey,
    source_event_refs: input.sourceEventRefs ?? [],
    runtime_graph_refs: input.runtimeGraphRefs ?? [],
    projection_refs: input.projectionRefs ?? [],
    panels: [{
      panel_id: `panel:${stableToken([input.replayKey, input.text]).slice(0, 16)}`,
      body: input.text,
      tone: "plain",
      priority: 0,
    }],
    delivery: input.delivery,
  });
}

export function projectStatusSummarySurface(input: {
  surface: SurfaceKind;
  summary: SurfaceStatusSummary;
  purpose: string;
  projectedAt: string;
  replayKey: string;
  sourceEventRefs?: SurfaceSourceEventRef[];
  runtimeGraphRefs?: SurfaceRuntimeGraphRef[];
  view?: SurfaceView;
}): SurfaceProjection {
  const status = SurfaceStatusSummarySchema.parse(input.summary);
  return createSurfaceProjection({
    surface: input.surface,
    view: input.view ?? "normal",
    purpose: input.purpose,
    redaction_class: input.view === "operator_debug" ? "operator_debug" : "normal_safe",
    projected_at: input.projectedAt,
    replay_key: input.replayKey,
    source_event_refs: input.sourceEventRefs ?? [],
    runtime_graph_refs: input.runtimeGraphRefs ?? [],
    status_summary: status,
    panels: [{
      panel_id: `status:${stableToken(status.summary_id).slice(0, 16)}`,
      title: status.subject_label,
      body: [
        `Status: ${status.lifecycle}`,
        status.liveness ? `Liveness: ${status.liveness}` : null,
        status.attention_required ? "Attention required." : null,
        ...status.blockers.map((blocker) => `Blocker: ${blocker}`),
      ].filter((line): line is string => line !== null).join("\n"),
      tone: status.attention_required ? "warning" : "plain",
    }],
  });
}

export function projectMemorySummarySurface(input: {
  summary: SurfaceMemorySummary;
  purpose: string;
  projectedAt: string;
  replayKey: string;
  sourceEventRefs?: SurfaceSourceEventRef[];
  runtimeGraphRefs?: SurfaceRuntimeGraphRef[];
  projectionRefs?: SurfaceProjectionRef[];
  view?: SurfaceView;
}): SurfaceProjection {
  const summary = SurfaceMemorySummarySchema.parse(input.summary);
  return createSurfaceProjection({
    surface: "memory_profile_summary",
    view: input.view ?? "normal",
    purpose: input.purpose,
    redaction_class: input.view === "operator_debug" ? "operator_debug" : "normal_redacted",
    projected_at: input.projectedAt,
    replay_key: input.replayKey,
    source_event_refs: input.sourceEventRefs ?? [],
    runtime_graph_refs: input.runtimeGraphRefs ?? [],
    projection_refs: input.projectionRefs ?? [],
    memory_summary: summary,
    panels: [{
      panel_id: `memory:${stableToken(summary.summary_id).slice(0, 16)}`,
      title: summary.title,
      body: summary.normal_text,
      tone: summary.withheld_count > 0 ? "muted" : "plain",
    }],
  });
}

export function renderSurfaceProjectionText(projectionInput: SurfaceProjection | SurfaceNormalView): string {
  const projection = "schema_version" in projectionInput
    ? (projectionInput.normal_view ?? createSurfaceNormalView(projectionInput))
    : SurfaceNormalViewSchema.parse(projectionInput);
  const lines = [
    ...projection.panels.map((panel) => panel.title ? `${panel.title}\n${panel.body}` : panel.body),
    ...(projection.approval_prompt ? [projection.approval_prompt.prompt] : []),
    ...(projection.actions.length > 0
      ? [`Actions: ${projection.actions.map((action) => action.label).join(", ")}`]
      : []),
  ];
  return lines.filter((line) => line.trim().length > 0).join("\n\n");
}

export function stableToken(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
