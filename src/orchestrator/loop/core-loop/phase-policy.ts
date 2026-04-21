import { resolveAgentLoopDefaultProfile } from "../../execution/agent-loop/agent-loop-default-profile.js";
import type { CorePhaseKind } from "../../execution/agent-loop/core-phase-runner.js";
import type { AgentLoopBudget } from "../../execution/agent-loop/agent-loop-budget.js";

export interface CorePhasePolicy {
  enabled: boolean;
  maxInvocationsPerIteration: number;
  budget: Partial<AgentLoopBudget>;
  allowedTools: readonly string[];
  requiredTools: readonly string[];
  failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
}

export interface CorePhasePolicyRegistry {
  get(phase: CorePhaseKind): CorePhasePolicy;
}

const CORE_PHASE_KINDS: readonly CorePhaseKind[] = [
  "observe_evidence",
  "knowledge_refresh",
  "stall_investigation",
  "replanning_options",
  "verification_evidence",
] as const;

function toCorePhasePolicy(phase: CorePhaseKind, override?: CorePhasePolicy): CorePhasePolicy {
  const resolved = resolveAgentLoopDefaultProfile({
    surface: "core_phase",
    phase,
    ...(override?.budget ? { budget: override.budget } : {}),
    toolPolicy: {
      ...(override?.allowedTools ? { allowedTools: override.allowedTools } : {}),
      ...(override?.requiredTools ? { requiredTools: override.requiredTools } : {}),
    },
    ...(override?.enabled !== undefined ? { enabled: override.enabled } : {}),
    ...(override?.maxInvocationsPerIteration !== undefined
      ? { maxInvocationsPerIteration: override.maxInvocationsPerIteration }
      : {}),
    ...(override?.failPolicy ? { failPolicy: override.failPolicy } : {}),
  });

  return {
    enabled: resolved.corePhase?.enabled ?? false,
    maxInvocationsPerIteration: resolved.corePhase?.maxInvocationsPerIteration ?? 1,
    budget: resolved.budget,
    allowedTools: resolved.toolPolicy.allowedTools ?? [],
    requiredTools: resolved.toolPolicy.requiredTools ?? [],
    failPolicy: resolved.corePhase?.failPolicy ?? "fallback_deterministic",
  };
}

export const defaultCorePhasePolicies: Record<CorePhaseKind, CorePhasePolicy> = Object.fromEntries(
  CORE_PHASE_KINDS.map((phase) => [phase, toCorePhasePolicy(phase)]),
) as Record<CorePhaseKind, CorePhasePolicy>;

export class StaticCorePhasePolicyRegistry implements CorePhasePolicyRegistry {
  constructor(
    private readonly policies: Partial<Record<CorePhaseKind, CorePhasePolicy>> = defaultCorePhasePolicies,
  ) {}

  get(phase: CorePhaseKind): CorePhasePolicy {
    return toCorePhasePolicy(phase, this.policies[phase]);
  }
}
