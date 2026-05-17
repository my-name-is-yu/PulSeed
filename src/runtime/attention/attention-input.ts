import { z } from "zod/v3";
import {
  CompanionAutonomyRefSchema,
  CompanionAutonomySourceRefSchema,
  SignalSourceSchema,
  type CompanionAutonomyContentLifecycle,
  type CompanionAutonomyRef,
  type CompanionAutonomySourceRef,
  type SignalContext,
  type SignalSource,
} from "../types/companion-autonomy.js";
import { assembleSignalContext } from "./attention-metabolism.js";
import type { AttentionSignalRefInput, SignalContextAssemblyInput } from "./attention-metabolism-types.js";
import { ref, refKey, stableId, uniqueRefs, uniqueSourceRefs } from "./attention-refs.js";

export const AttentionInputSourceKindSchema = z.enum([
  "schedule",
  "daemon_tick",
  "resident_curiosity",
  "resident_proactive_maintenance",
  "runtime_event",
  "observation_event",
  "gateway_user_activity",
  "surface_memory",
  "feedback",
]);
export type AttentionInputSourceKind = z.infer<typeof AttentionInputSourceKindSchema>;

export const AttentionInputEffectPolicySchema = z.object({
  wake: z.boolean().default(true),
  notify: z.literal(false).default(false),
  speak: z.literal(false).default(false),
  act: z.literal(false).default(false),
}).strict();
export type AttentionInputEffectPolicy = z.infer<typeof AttentionInputEffectPolicySchema>;

export const AttentionInputAdmissionEligibilitySchema = z.enum(["normal", "diagnostic_only"]);
export type AttentionInputAdmissionEligibility = z.infer<typeof AttentionInputAdmissionEligibilitySchema>;

export const AttentionInputSourceSchema = z.object({
  source_kind: AttentionInputSourceKindSchema,
  source_id: z.string().min(1),
  source_epoch: z.string().min(1),
  high_watermark: z.string().min(1),
  replay_key: z.string().min(1),
  emitted_at: z.string().datetime(),
}).strict();
export type AttentionInputSource = z.infer<typeof AttentionInputSourceSchema>;

const AttentionInputBaseSchema = z.object({
  schema_version: z.literal("attention-input-v1").default("attention-input-v1"),
  attention_input_id: z.string().min(1),
  source: AttentionInputSourceSchema,
  signal_source: SignalSourceSchema,
  signal_ref: CompanionAutonomySourceRefSchema,
  admission_eligibility: AttentionInputAdmissionEligibilitySchema.default("normal"),
  may_mature: z.boolean().default(true),
  effect_policy: AttentionInputEffectPolicySchema.default({ wake: true }),
  payload_class: z.string().min(1),
  summary: z.string().min(1),
  active_surface_ref: CompanionAutonomyRefSchema.nullable().default(null),
  current_session_refs: z.array(CompanionAutonomyRefSchema).default([]),
  current_goal_refs: z.array(CompanionAutonomyRefSchema).default([]),
  runtime_state_refs: z.array(CompanionAutonomyRefSchema).default([]),
  relationship_permission_refs: z.array(CompanionAutonomyRefSchema).default([]),
  user_activity_refs: z.array(CompanionAutonomyRefSchema).default([]),
  memory_refs: z.array(CompanionAutonomyRefSchema).default([]),
  feedback_refs: z.array(CompanionAutonomyRefSchema).default([]),
  stale_refs: z.array(CompanionAutonomyRefSchema).default([]),
  invalidation_refs: z.array(CompanionAutonomyRefSchema).default([]),
  audit_refs: z.array(CompanionAutonomyRefSchema).default([]),
}).strict();
export const AttentionInputSchema = AttentionInputBaseSchema.superRefine((input, ctx) => {
  if (!isSignalSourceAllowedForAttentionInputKind(input.source.source_kind, input.signal_source)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["signal_source"],
      message: `signal_source "${input.signal_source}" is not allowed for attention input source_kind "${input.source.source_kind}"`,
    });
  }

  if (!isSignalRefAllowedForSignalSource(input.signal_ref.ref, input.signal_source)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["signal_ref", "ref", "kind"],
      message: `signal_ref kind "${input.signal_ref.ref.kind}" is not allowed for attention input signal_source "${input.signal_source}"`,
    });
  }

  if (input.admission_eligibility === "diagnostic_only") {
    if (input.source.source_kind !== "runtime_event" || input.signal_source !== "runtime_event") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["admission_eligibility"],
        message: "diagnostic_only attention inputs must originate from runtime_event signals",
      });
    }
    if (!input.payload_class.startsWith("experience_learning.")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload_class"],
        message: "diagnostic_only learning attention inputs require an experience_learning payload class",
      });
    }
    if (input.may_mature) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["may_mature"],
        message: "diagnostic_only learning attention inputs may not mature",
      });
    }
    if (input.effect_policy.wake || input.effect_policy.notify || input.effect_policy.speak || input.effect_policy.act) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect_policy"],
        message: "diagnostic_only learning attention inputs cannot wake, notify, speak, or act",
      });
    }
    if (input.active_surface_ref !== null || input.relationship_permission_refs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active_surface_ref"],
        message: "diagnostic_only learning attention inputs cannot carry active surface or permission refs",
      });
    }
  }
});
export type AttentionInput = z.infer<typeof AttentionInputSchema>;

export type AttentionInputFactoryInput = {
  source_kind: AttentionInputSourceKind;
  source_id: string;
  emitted_at: string;
  payload_class: string;
  summary: string;
  signal_ref?: CompanionAutonomyRef;
  signal_ref_lifecycle?: CompanionAutonomyContentLifecycle;
  signal_source?: AllowedSignalSourceForAttentionInputKind;
  admission_eligibility?: AttentionInputAdmissionEligibility;
  may_mature?: boolean;
  source_epoch?: string;
  high_watermark?: string;
  replay_key?: string;
  effect_policy?: Partial<AttentionInputEffectPolicy>;
  active_surface_ref?: CompanionAutonomyRef | null;
  current_session_refs?: CompanionAutonomyRef[];
  current_goal_refs?: CompanionAutonomyRef[];
  runtime_state_refs?: CompanionAutonomyRef[];
  relationship_permission_refs?: CompanionAutonomyRef[];
  user_activity_refs?: CompanionAutonomyRef[];
  memory_refs?: CompanionAutonomyRef[];
  feedback_refs?: CompanionAutonomyRef[];
  stale_refs?: CompanionAutonomyRef[];
  invalidation_refs?: CompanionAutonomyRef[];
  audit_refs?: CompanionAutonomyRef[];
};

export type SchedulerWakeAttentionInputsInput = {
  entry_id: string;
  fired_at: string;
  scheduled_for?: string | null;
  goal_ref?: CompanionAutonomyRef;
  wait_ref?: CompanionAutonomyRef;
  runtime_state_ref?: CompanionAutonomyRef;
};

type AttentionInputSignalSourceMap = {
  schedule: "schedule_tick" | "wait_expiry";
  daemon_tick: "daemon";
  resident_curiosity: "curiosity";
  resident_proactive_maintenance: "resident";
  runtime_event: "runtime_event";
  observation_event: "observation";
  gateway_user_activity: "user_activity";
  surface_memory: "surface" | "memory";
  feedback: "feedback";
};

type AllowedSignalSourceForAttentionInputKind =
  AttentionInputSignalSourceMap[AttentionInputSourceKind];

export type AttentionInputIntakeDisposition =
  | "accepted"
  | "duplicate_replay_key";

export type AttentionInputIntakeRecord = {
  input: AttentionInput;
  disposition: AttentionInputIntakeDisposition;
  duplicate_of?: string;
};

export type AttentionInputIntakeResult = {
  accepted: AttentionInput[];
  duplicates: AttentionInputIntakeRecord[];
  records: AttentionInputIntakeRecord[];
};

export type AttentionInputSignalContextInput = Omit<SignalContextAssemblyInput, "signals"> & {
  inputs: readonly AttentionInput[];
};

export interface AttentionInputIntakePort {
  ingest(inputs: readonly AttentionInput[]): Promise<AttentionInputIntakeResult>;
}

export function createAttentionInput(input: AttentionInputFactoryInput): AttentionInput {
  if (input.source_kind === "observation_event") {
    throw new Error(
      "observation_event attention inputs require ObservationSession and ObservationEvent validation"
    );
  }
  const source = buildAttentionInputSource(input);
  const signalSource = signalSourceForAttentionInputKind(input.source_kind, input.signal_source);
  const signalRef = sourceRefForAttentionInput(input, signalSource);

  return AttentionInputSchema.parse({
    attention_input_id: input.replay_key
      ? `attention-input:${input.source_kind}:${stableId(input.replay_key)}`
      : `attention-input:${input.source_kind}:${stableId(source.replay_key)}`,
    source,
    signal_source: signalSource,
    signal_ref: signalRef,
    admission_eligibility: input.admission_eligibility ?? "normal",
    may_mature: input.may_mature ?? true,
    effect_policy: AttentionInputEffectPolicySchema.parse({
      wake: input.effect_policy?.wake ?? true,
      notify: input.effect_policy?.notify ?? false,
      speak: input.effect_policy?.speak ?? false,
      act: input.effect_policy?.act ?? false,
    }),
    payload_class: input.payload_class,
    summary: input.summary,
    active_surface_ref: input.active_surface_ref ?? null,
    current_session_refs: input.current_session_refs ?? [],
    current_goal_refs: input.current_goal_refs ?? [],
    runtime_state_refs: input.runtime_state_refs ?? refsForSourceKind(input, "runtime_event"),
    relationship_permission_refs: input.relationship_permission_refs ?? [],
    user_activity_refs: input.user_activity_refs ?? refsForSourceKind(input, "user_activity"),
    memory_refs: input.memory_refs ?? refsForSourceKind(input, "memory"),
    feedback_refs: input.feedback_refs ?? refsForSourceKind(input, "feedback"),
    stale_refs: input.stale_refs ?? [],
    invalidation_refs: input.invalidation_refs ?? [],
    audit_refs: input.audit_refs ?? [],
  });
}

export function createExperienceLearningDiagnosticAttentionInput(input: {
  runtime_event_id: string;
  emitted_at: string;
  summary: string;
  learning_ref: CompanionAutonomyRef;
  replay_key?: string;
  current_goal_refs?: CompanionAutonomyRef[];
  audit_refs?: CompanionAutonomyRef[];
}): AttentionInput {
  const learningRuntimeStateRefs = input.learning_ref.kind === "runtime_event" || input.learning_ref.kind === "runtime_item"
    ? [input.learning_ref]
    : [];
  return createAttentionInput({
    source_kind: "runtime_event",
    source_id: input.runtime_event_id,
    emitted_at: input.emitted_at,
    payload_class: "experience_learning.diagnostic",
    summary: input.summary,
    signal_source: "runtime_event",
    signal_ref: ref("runtime_event", input.runtime_event_id),
    admission_eligibility: "diagnostic_only",
    may_mature: false,
    effect_policy: { wake: false, notify: false, speak: false, act: false },
    active_surface_ref: null,
    current_goal_refs: input.current_goal_refs ?? [],
    runtime_state_refs: uniqueRefs([
      ref("runtime_event", input.runtime_event_id),
      ...learningRuntimeStateRefs,
    ]),
    audit_refs: [
      ref("audit_trace", `experience-learning:${stableId(input.runtime_event_id)}`),
      ...(input.audit_refs ?? []),
    ],
    ...(input.replay_key ? { replay_key: input.replay_key } : {}),
  });
}

export function buildSchedulerWakeAttentionInputs(input: SchedulerWakeAttentionInputsInput): AttentionInput[] {
  const waitRef = input.wait_ref ?? ref("wait", input.entry_id);
  const runtimeStateRef = input.runtime_state_ref ?? ref("runtime_event", `runtime-event:schedule-wake:${input.entry_id}`);
  const currentGoalRefs = input.goal_ref ? [input.goal_ref] : [];
  const sourceEpoch = `schedule:${input.entry_id}`;
  const highWatermark = input.scheduled_for ?? input.fired_at;

  return [
    createAttentionInput({
      source_kind: "schedule",
      source_id: `schedule_tick:${input.entry_id}`,
      source_epoch: sourceEpoch,
      high_watermark: highWatermark,
      emitted_at: input.fired_at,
      payload_class: "schedule.wait_resume.tick",
      summary: "Wait-resume schedule tick woke internal attention.",
      signal_ref: ref("schedule_tick", input.entry_id),
      signal_source: "schedule_tick",
      current_goal_refs: currentGoalRefs,
      runtime_state_refs: [runtimeStateRef],
    }),
    createAttentionInput({
      source_kind: "schedule",
      source_id: `wait_expiry:${waitRef.id}`,
      source_epoch: sourceEpoch,
      high_watermark: highWatermark,
      emitted_at: input.fired_at,
      payload_class: "schedule.wait_resume.wait_expiry",
      summary: "Wait-expiry signal woke internal attention.",
      signal_ref: waitRef,
      signal_source: "wait_expiry",
      current_goal_refs: currentGoalRefs,
      runtime_state_refs: [runtimeStateRef],
    }),
  ];
}

export function createAttentionInputIntakePort(): AttentionInputIntakePort {
  const seenReplayKeys = new Map<string, AttentionInput>();
  return {
    async ingest(inputs: readonly AttentionInput[]): Promise<AttentionInputIntakeResult> {
      const result = dedupeAttentionInputs(inputs, seenReplayKeys);
      for (const input of result.accepted) {
        seenReplayKeys.set(input.source.replay_key, input);
      }
      return result;
    },
  };
}

export function dedupeAttentionInputs(
  inputs: readonly AttentionInput[],
  previouslySeen: ReadonlyMap<string, AttentionInput> = new Map()
): AttentionInputIntakeResult {
  const accepted: AttentionInput[] = [];
  const duplicates: AttentionInputIntakeRecord[] = [];
  const records: AttentionInputIntakeRecord[] = [];
  const seen = new Map(previouslySeen);

  for (const input of inputs) {
    const existing = seen.get(input.source.replay_key);
    if (existing) {
      const record: AttentionInputIntakeRecord = {
        input,
        disposition: "duplicate_replay_key",
        duplicate_of: existing.attention_input_id,
      };
      duplicates.push(record);
      records.push(record);
      continue;
    }
    seen.set(input.source.replay_key, input);
    accepted.push(input);
    records.push({
      input,
      disposition: "accepted",
    });
  }

  return { accepted, duplicates, records };
}

export function buildSignalContextFromAttentionInputs(input: AttentionInputSignalContextInput): SignalContext {
  const activeInputs = input.inputs.filter((candidate) =>
    candidate.admission_eligibility !== "diagnostic_only" && candidate.may_mature
  );
  const activeSurfaceRef = input.active_surface_ref
    ?? activeInputs.find((candidate) => candidate.active_surface_ref)?.active_surface_ref
    ?? null;

  return assembleSignalContext({
    ...input,
    signals: uniqueSignalInputs(activeInputs.flatMap(signalInputsForAttentionInput)),
    active_surface_ref: activeSurfaceRef,
    current_session_refs: uniqueRefs([
      ...(input.current_session_refs ?? []),
      ...activeInputs.flatMap((candidate) => candidate.current_session_refs),
    ]),
    current_goal_refs: uniqueRefs([
      ...(input.current_goal_refs ?? []),
      ...activeInputs.flatMap((candidate) => candidate.current_goal_refs),
    ]),
    runtime_state_refs: uniqueRefs([
      ...(input.runtime_state_refs ?? []),
      ...input.inputs.flatMap((candidate) => candidate.runtime_state_refs),
    ]),
    relationship_permission_refs: uniqueRefs([
      ...(input.relationship_permission_refs ?? []),
      ...input.inputs.flatMap((candidate) => candidate.relationship_permission_refs),
    ]),
    user_activity_refs: uniqueRefs([
      ...(input.user_activity_refs ?? []),
      ...input.inputs.flatMap((candidate) => candidate.user_activity_refs),
    ]),
    stale_target_context: {
      ...input.stale_target_context,
      stale_refs: uniqueRefs([
        ...(input.stale_target_context?.stale_refs ?? []),
        ...input.inputs.flatMap((candidate) => candidate.stale_refs),
      ]),
      needs_regrounding_refs: uniqueRefs([
        ...(input.stale_target_context?.needs_regrounding_refs ?? []),
        ...input.inputs.flatMap((candidate) => candidate.invalidation_refs),
      ]),
    },
    audit_refs: uniqueRefs([
      ...(input.audit_refs ?? []),
      ...input.inputs.flatMap((candidate) => candidate.audit_refs),
    ]),
  });
}

export function attentionInputEvidenceRefs(inputs: readonly AttentionInput[]): CompanionAutonomySourceRef[] {
  return uniqueSourceRefs(inputs.map((input) => input.signal_ref));
}

function buildAttentionInputSource(input: AttentionInputFactoryInput): AttentionInputSource {
  const sourceEpoch = input.source_epoch ?? defaultSourceEpochForAttentionInput(input);
  const highWatermark = input.high_watermark ?? defaultHighWatermarkForAttentionInput(input);
  const replayKey = input.replay_key
    ?? `${input.source_kind}:${input.source_id}:${sourceEpoch}:${highWatermark}`;

  return AttentionInputSourceSchema.parse({
    source_kind: input.source_kind,
    source_id: input.source_id,
    source_epoch: sourceEpoch,
    high_watermark: highWatermark,
    replay_key: replayKey,
    emitted_at: input.emitted_at,
  });
}

function sourceRefForAttentionInput(
  input: AttentionInputFactoryInput,
  signalSource: SignalSource
): CompanionAutonomySourceRef {
  if (input.signal_source && !input.signal_ref && requiresExplicitSignalRef(input.signal_source)) {
    throw new Error(`signal_ref is required for attention input signal_source "${input.signal_source}"`);
  }
  const signalRef = input.signal_ref ?? defaultSignalRefForAttentionInput(input);
  assertSignalRefMatchesSignalSource(signalRef, signalSource);

  return sourceRefForRef(
    signalRef,
    input.signal_ref_lifecycle ?? "active"
  );
}

function sourceRefForRef(value: CompanionAutonomyRef, lifecycle: CompanionAutonomyContentLifecycle): CompanionAutonomySourceRef {
  return CompanionAutonomySourceRefSchema.parse({
    ref: value,
    lifecycle,
  });
}

function defaultSignalRefForAttentionInput(input: AttentionInputFactoryInput): CompanionAutonomyRef {
  switch (input.source_kind) {
    case "schedule":
      return ref("schedule_tick", input.source_id);
    case "daemon_tick":
      return ref("runtime_event", `daemon:${input.source_id}`);
    case "resident_curiosity":
      return ref("curiosity", input.source_id);
    case "resident_proactive_maintenance":
      return ref("runtime_event", `resident-proactive:${input.source_id}`);
    case "runtime_event":
      return ref("runtime_event", input.source_id);
    case "observation_event":
      return ref("observation_event", input.source_id);
    case "gateway_user_activity":
      return ref("user_activity", input.source_id);
    case "surface_memory":
      return ref("memory", input.source_id);
    case "feedback":
      return ref("feedback", input.source_id);
  }
}

function signalSourceForAttentionInputKind(
  kind: AttentionInputSourceKind,
  explicit?: AllowedSignalSourceForAttentionInputKind
): SignalSource {
  if (explicit && !isSignalSourceAllowedForAttentionInputKind(kind, explicit)) {
    throw new Error(`signal_source "${explicit}" is not allowed for attention input source_kind "${kind}"`);
  }
  if (explicit) return explicit;

  switch (kind) {
    case "schedule":
      return "schedule_tick";
    case "daemon_tick":
      return "daemon";
    case "resident_curiosity":
      return "curiosity";
    case "resident_proactive_maintenance":
      return "resident";
    case "runtime_event":
      return "runtime_event";
    case "observation_event":
      return "observation";
    case "gateway_user_activity":
      return "user_activity";
    case "surface_memory":
      return "memory";
    case "feedback":
      return "feedback";
  }
}

function allowedSignalSourcesForAttentionInputKind(kind: AttentionInputSourceKind): readonly SignalSource[] {
  switch (kind) {
    case "schedule":
      return ["schedule_tick", "wait_expiry"];
    case "daemon_tick":
      return ["daemon"];
    case "resident_curiosity":
      return ["curiosity"];
    case "resident_proactive_maintenance":
      return ["resident"];
    case "runtime_event":
      return ["runtime_event"];
    case "observation_event":
      return ["observation"];
    case "gateway_user_activity":
      return ["user_activity"];
    case "surface_memory":
      return ["surface", "memory"];
    case "feedback":
      return ["feedback"];
  }
}

function isSignalSourceAllowedForAttentionInputKind(kind: AttentionInputSourceKind, source: SignalSource): boolean {
  return allowedSignalSourcesForAttentionInputKind(kind).includes(source);
}

function requiresExplicitSignalRef(source: SignalSource): boolean {
  return source === "wait_expiry" || source === "surface";
}

function assertSignalRefMatchesSignalSource(refValue: CompanionAutonomyRef, source: SignalSource): void {
  if (!isSignalRefAllowedForSignalSource(refValue, source)) {
    throw new Error(
      `signal_ref kind "${refValue.kind}" is not allowed for attention input signal_source "${source}"`
    );
  }
}

function isSignalRefAllowedForSignalSource(refValue: CompanionAutonomyRef, source: SignalSource): boolean {
  return allowedRefKindsForSignalSource(source).includes(refValue.kind);
}

function allowedRefKindsForSignalSource(source: SignalSource): readonly CompanionAutonomyRef["kind"][] {
  switch (source) {
    case "schedule_tick":
      return ["schedule_tick"];
    case "wait_expiry":
      return ["wait"];
    case "daemon":
    case "resident":
    case "runtime_event":
      return ["runtime_event"];
    case "observation":
      return ["observation_event"];
    case "curiosity":
      return ["curiosity"];
    case "user_activity":
      return ["user_activity"];
    case "surface":
      return ["surface"];
    case "memory":
      return ["memory"];
    case "feedback":
      return ["feedback"];
    case "drive":
      return ["drive"];
    case "goal":
      return ["goal"];
    case "task":
      return ["task"];
    case "dream_artifact":
      return ["dream_artifact"];
    case "soil_retrieval":
      return ["soil_retrieval"];
    case "correction":
      return ["correction"];
    case "automation":
      return ["automation"];
    case "guardrail":
      return ["guardrail"];
    case "session":
      return ["session"];
    case "backpressure":
      return ["backpressure"];
  }
}

function defaultSourceEpochForAttentionInput(input: AttentionInputFactoryInput): string {
  switch (input.source_kind) {
    case "schedule":
    case "resident_proactive_maintenance":
    case "gateway_user_activity":
      return input.source_id;
    case "daemon_tick":
    case "resident_curiosity":
    case "runtime_event":
    case "observation_event":
    case "surface_memory":
    case "feedback":
      return "default";
  }
}

function defaultHighWatermarkForAttentionInput(input: AttentionInputFactoryInput): string {
  switch (input.source_kind) {
    case "schedule":
    case "resident_proactive_maintenance":
    case "gateway_user_activity":
      return input.source_id;
    case "daemon_tick":
    case "resident_curiosity":
    case "runtime_event":
    case "observation_event":
    case "surface_memory":
    case "feedback":
      return input.emitted_at;
  }
}

function signalInputsForAttentionInput(input: AttentionInput): AttentionSignalRefInput[] {
  return [
    {
      source: input.signal_source,
      ref: input.signal_ref.ref,
      lifecycle: input.signal_ref.lifecycle,
      redaction_reason: input.signal_ref.redaction_reason,
    },
    ...(input.active_surface_ref ? [{ source: "surface" as const, ref: input.active_surface_ref }] : []),
    ...input.memory_refs.map((memoryRef) => ({ source: "memory" as const, ref: memoryRef })),
    ...input.feedback_refs.map((feedbackRef) => ({ source: "feedback" as const, ref: feedbackRef })),
  ];
}

function uniqueSignalInputs(inputs: readonly AttentionSignalRefInput[]): AttentionSignalRefInput[] {
  const seen = new Set<string>();
  const result: AttentionSignalRefInput[] = [];
  for (const input of inputs) {
    const key = `${input.source}:${refKey(input.ref)}:${input.lifecycle ?? "active"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(input);
  }
  return result;
}

function refsForSourceKind(
  input: AttentionInputFactoryInput,
  refKind: CompanionAutonomyRef["kind"]
): CompanionAutonomyRef[] {
  const signalRef = input.signal_ref ?? defaultSignalRefForAttentionInput(input);
  return signalRef.kind === refKind ? [signalRef] : [];
}
