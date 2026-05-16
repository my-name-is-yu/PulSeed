import { z } from "zod/v3";
import type {
  InterventionDecision,
  InterventionTargetEffect,
  PersonalAgentCallerPath,
  TaskCandidate,
} from "./contracts.js";
import type { PersonalAgentTraceSnapshot } from "./store.js";

export const PersonalAgentNormalSurfaceProjectionSchema = z.object({
  schema_version: z.literal("personal-agent-normal-surface-projection/v1"),
  surface_target: z.literal("normal_user"),
  why_now: z.string().min(1),
  what_i_will_do: z.string().min(1),
  what_i_need_from_you: z.string().min(1).nullable().default(null),
  confidence_or_uncertainty: z.string().min(1).nullable().default(null),
  readonly_projection: z.literal(true).default(true),
  mutation_performed: z.literal(false).default(false),
  action_authority_increased: z.literal(false).default(false),
  raw_trace_visible: z.literal(false).default(false),
  raw_refs_visible: z.literal(false).default(false),
  raw_evidence_refs_visible: z.literal(false).default(false),
  internal_policy_refs_visible: z.literal(false).default(false),
  capability_catalog_visible: z.literal(false).default(false),
}).strict();

export type PersonalAgentNormalSurfaceProjection = z.infer<typeof PersonalAgentNormalSurfaceProjectionSchema>;

type PersonalAgentNormalSurfaceTraceInput = Pick<
  PersonalAgentTraceSnapshot,
  | "situation_frame"
  | "initiative_events"
  | "task_candidates"
  | "capability_decisions"
  | "intervention_decisions"
  | "memory_audits"
>;

export function projectPersonalAgentNormalSurface(
  trace: PersonalAgentNormalSurfaceTraceInput,
): PersonalAgentNormalSurfaceProjection {
  const decision = latestInterventionDecision(trace.intervention_decisions);
  const candidate = latestTaskCandidate(trace.task_candidates);
  const effect = decision?.target_effect ?? candidate?.desired_effect ?? "none";
  return PersonalAgentNormalSurfaceProjectionSchema.parse({
    schema_version: "personal-agent-normal-surface-projection/v1",
    surface_target: "normal_user",
    why_now: whyNowFor(trace.situation_frame?.caller_path),
    what_i_will_do: whatIWillDoFor(effect, decision),
    what_i_need_from_you: whatINeedFromYouFor(decision),
    confidence_or_uncertainty: uncertaintyFor(trace),
    readonly_projection: true,
    mutation_performed: false,
    action_authority_increased: false,
    raw_trace_visible: false,
    raw_refs_visible: false,
    raw_evidence_refs_visible: false,
    internal_policy_refs_visible: false,
    capability_catalog_visible: false,
  });
}

function latestInterventionDecision(decisions: readonly InterventionDecision[]): InterventionDecision | null {
  return [...decisions].sort((left, right) => left.decided_at.localeCompare(right.decided_at)).at(-1) ?? null;
}

function latestTaskCandidate(candidates: readonly TaskCandidate[]): TaskCandidate | null {
  return [...candidates].sort((left, right) => left.proposed_at.localeCompare(right.proposed_at)).at(-1) ?? null;
}

function whyNowFor(callerPath: PersonalAgentCallerPath | undefined): string {
  switch (callerPath) {
    case "chat_gateway_turn":
    case "tui_turn":
      return "This belongs to the current conversation turn.";
    case "scheduled_wake":
      return "A scheduled wake-up became due.";
    case "resident_proactive":
      return "A resident check found a low-pressure candidate.";
    case "goal_gap_task_generation":
      return "A goal gap was evaluated for possible follow-up work.";
    case "runtime_control":
      return "A runtime-control request needs a clear next step.";
    case "notification_interruption":
      return "A notification path reported an interruption decision.";
    case "memory_correction":
      return "You asked PulSeed to update how a memory may be used.";
    case "reflection":
      return "A reflection cycle produced advisory context.";
    case "task_execution":
      return "A task execution step reached an intervention decision.";
    case "crash_restart_resume":
      return "A restart recovery path checked what can safely resume.";
    case "explicit_user_command":
      return "You invoked an explicit PulSeed command.";
    case "external_signal":
      return "An external signal reached the existing runtime path.";
    default:
      return "A PulSeed runtime event reached a recorded decision.";
  }
}

function whatIWillDoFor(
  effect: InterventionTargetEffect,
  decision: InterventionDecision | null,
): string {
  if (!decision) {
    return "Keep this as read-only diagnostic context until the owning route records a decision.";
  }
  if (decision.decision === "block" || decision.decision === "suppress") {
    return "Stay quiet and avoid taking action.";
  }
  if (decision.decision === "hold") {
    return "Hold this until the owning route can admit a safer surface.";
  }
  if (decision.decision === "confirm_required") {
    return "Wait for your confirmation before acting.";
  }

  switch (effect) {
    case "continue_route":
      return "Continue the selected conversation route without expanding authority.";
    case "create_goal":
      return "Create only the admitted goal through the existing runtime path.";
    case "create_task":
      return "Create only the admitted task through the existing runtime path.";
    case "create_run":
      return "Create only the admitted run through the existing runtime path.";
    case "execute_tool":
      return "Use only the already-authorized tool path selected by policy.";
    case "send_notification":
      return "Send only the admitted notification on the existing delivery path.";
    case "mutate_runtime_control":
      return "Apply the admitted runtime-control change through the existing control path.";
    case "write_memory":
      return "Record the logical memory update so future decisions do not rely on invalidated memory.";
    case "record_reflection":
      return "Record the reflection as advisory context, not execution authority.";
    case "hold_concern":
      return "Hold this concern for the owning surface instead of showing raw trace details.";
    case "none":
      return "Take no action on the normal surface.";
  }
}

function whatINeedFromYouFor(decision: InterventionDecision | null): string | null {
  if (!decision) return null;
  if (decision.decision === "confirm_required" || decision.permission_required) {
    return "Please confirm before I take the next step.";
  }
  return null;
}

function uncertaintyFor(trace: PersonalAgentNormalSurfaceTraceInput): string | null {
  const frame = trace.situation_frame;
  const hiddenOrStaleContextCount = (frame?.withheld_memory_refs.length ?? 0)
    + (frame?.stale_refs.length ?? 0)
    + (frame?.uncertainty_refs.length ?? 0)
    + (frame?.conflict_refs.length ?? 0)
    + trace.memory_audits.filter((audit) =>
      audit.action === "withhold" || audit.invalidated || audit.correction_state !== "current"
    ).length;
  if (hiddenOrStaleContextCount === 0) return null;
  return "Some context was withheld, stale, corrected, or uncertain, so this should stay conservative.";
}
