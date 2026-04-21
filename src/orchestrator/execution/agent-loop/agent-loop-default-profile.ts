import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { CorePhaseKind } from "./core-phase-runner.js";
import type { AgentLoopSecurityConfig, ExecutionPolicy } from "./execution-policy.js";
import { resolveExecutionPolicy } from "./execution-policy.js";
import type { AgentLoopReasoningEffort } from "./agent-loop-model.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import type { AgentLoopWorktreePolicy } from "./task-agent-loop-worktree.js";

export type AgentLoopDefaultProfileName =
  | "task"
  | "chat"
  | "review"
  | `core_phase:${CorePhaseKind}`;

export interface AgentLoopResolvedProfile {
  name: AgentLoopDefaultProfileName;
  budget: AgentLoopBudget;
  toolPolicy: AgentLoopToolPolicy;
  executionPolicy?: ExecutionPolicy;
  reasoningEffort?: AgentLoopReasoningEffort;
  worktreePolicy?: AgentLoopWorktreePolicy;
  corePhase?: {
    enabled: boolean;
    maxInvocationsPerIteration: number;
    failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
  };
}

export interface AgentLoopResolvedProfileSummary {
  profileId: AgentLoopDefaultProfileName;
  resolvedPosture: string;
}

interface CorePhaseProfileDefaults {
  enabled: boolean;
  maxInvocationsPerIteration: number;
  budget: Partial<AgentLoopBudget>;
  toolPolicy: AgentLoopToolPolicy;
  failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
}

const DEFAULT_SURFACE_PROFILE = {
  budget: {} as Partial<AgentLoopBudget>,
  toolPolicy: {} as AgentLoopToolPolicy,
};

const DEFAULT_CORE_PHASE_BUDGET: Partial<AgentLoopBudget> = {
  maxModelTurns: 6,
  maxToolCalls: 12,
  maxWallClockMs: 90_000,
  maxConsecutiveToolErrors: 2,
  maxRepeatedToolCalls: 2,
  maxSchemaRepairAttempts: 1,
  maxCompletionValidationAttempts: 1,
  maxCompactions: 1,
  compactionMaxMessages: 6,
};

const CORE_PHASE_PROFILE_DEFAULTS: Record<CorePhaseKind, CorePhaseProfileDefaults> = {
  observe_evidence: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET,
    toolPolicy: {
      allowedTools: [
        "read_pulseed_file",
        "glob",
        "grep",
        "git_log",
        "shell_command",
        "soil_query",
        "tool_search",
      ],
    },
    failPolicy: "fallback_deterministic",
  },
  knowledge_refresh: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET,
    toolPolicy: {
      allowedTools: [
        "soil_query",
        "knowledge_query",
        "memory_recall",
        "glob",
        "grep",
        "read_pulseed_file",
      ],
      requiredTools: ["soil_query"],
    },
    failPolicy: "return_low_confidence",
  },
  stall_investigation: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET,
    toolPolicy: {
      allowedTools: [
        "progress_history",
        "session_history",
        "git_log",
        "shell_command",
        "soil_query",
        "task_get",
      ],
    },
    failPolicy: "return_low_confidence",
  },
  replanning_options: {
    enabled: false,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET,
    toolPolicy: {
      allowedTools: [
        "task_get",
        "goal_state",
        "soil_query",
        "read_plan",
        "session_history",
        "memory_recall",
      ],
    },
    failPolicy: "fallback_deterministic",
  },
  verification_evidence: {
    enabled: true,
    maxInvocationsPerIteration: 1,
    budget: DEFAULT_CORE_PHASE_BUDGET,
    toolPolicy: {
      allowedTools: [
        "test_runner",
        "shell_command",
        "git_diff",
        "read_pulseed_file",
        "grep",
        "soil_query",
      ],
    },
    failPolicy: "fallback_deterministic",
  },
};

interface SurfaceProfileInput {
  surface: "task" | "chat" | "review";
  workspaceRoot: string;
  security?: AgentLoopSecurityConfig;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
}

interface CorePhaseProfileInput {
  surface: "core_phase";
  phase: CorePhaseKind;
  workspaceRoot?: string;
  security?: AgentLoopSecurityConfig;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  enabled?: boolean;
  maxInvocationsPerIteration?: number;
  failPolicy?: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
}

export function resolveAgentLoopDefaultProfile(
  input: SurfaceProfileInput | CorePhaseProfileInput,
): AgentLoopResolvedProfile {
  if (input.surface === "core_phase") {
    const defaults = CORE_PHASE_PROFILE_DEFAULTS[input.phase];
    return {
      name: `core_phase:${input.phase}`,
      budget: withDefaultBudget({ ...defaults.budget, ...input.budget }),
      toolPolicy: mergeToolPolicy(defaults.toolPolicy, input.toolPolicy),
      ...(input.workspaceRoot
        ? {
            executionPolicy: resolveExecutionPolicy({
              workspaceRoot: input.workspaceRoot,
              security: input.security,
            }),
          }
        : {}),
      corePhase: {
        enabled: input.enabled ?? defaults.enabled,
        maxInvocationsPerIteration: input.maxInvocationsPerIteration ?? defaults.maxInvocationsPerIteration,
        failPolicy: input.failPolicy ?? defaults.failPolicy,
      },
    };
  }

  return {
    name: input.surface,
    budget: withDefaultBudget({ ...DEFAULT_SURFACE_PROFILE.budget, ...input.budget }),
    toolPolicy: mergeToolPolicy(DEFAULT_SURFACE_PROFILE.toolPolicy, input.toolPolicy),
    executionPolicy: resolveExecutionPolicy({
      workspaceRoot: input.workspaceRoot,
      security: input.security,
    }),
  };
}

export function summarizeAgentLoopResolvedProfile(
  profile: Pick<AgentLoopResolvedProfile, "name" | "executionPolicy">,
  executionPolicy = profile.executionPolicy,
): AgentLoopResolvedProfileSummary {
  return {
    profileId: profile.name,
    resolvedPosture: executionPolicy
      ? `sandbox=${executionPolicy.sandboxMode} approval=${executionPolicy.approvalPolicy} network=${executionPolicy.networkAccess ? "on" : "off"}`
      : "no_execution_policy",
  };
}

export function formatAgentLoopResolvedProfileSummary(
  summary: AgentLoopResolvedProfileSummary,
): string {
  return [
    `profile_id: ${summary.profileId}`,
    `resolved_posture: ${summary.resolvedPosture}`,
  ].join("\n");
}

function mergeToolPolicy(
  base: AgentLoopToolPolicy,
  override?: AgentLoopToolPolicy,
): AgentLoopToolPolicy {
  const allowedTools = override?.allowedTools ?? base.allowedTools;
  const requiredTools = override?.requiredTools ?? base.requiredTools;
  const deniedTools = override?.deniedTools ?? base.deniedTools;
  const includeDeferred = override?.includeDeferred ?? base.includeDeferred;

  return {
    ...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
    ...(requiredTools ? { requiredTools: [...requiredTools] } : {}),
    ...(deniedTools ? { deniedTools: [...deniedTools] } : {}),
    ...(includeDeferred !== undefined ? { includeDeferred } : {}),
  };
}
