import { randomUUID } from "node:crypto";
import { cwd as processCwd } from "node:process";
import type { Goal } from "../../../base/types/goal.js";
import type { Task } from "../../../base/types/task.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopModelInfo, AgentLoopModelRef, AgentLoopReasoningEffort } from "./agent-loop-model.js";
import type { AgentLoopCompletionValidationResult } from "./agent-loop-result.js";
import type { AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import type { AgentLoopToolPolicy, AgentLoopTurnContext } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import { TaskAgentLoopOutputSchema, type TaskAgentLoopOutput } from "./task-agent-loop-result.js";
import { buildAgentLoopBaseInstructions } from "./agent-loop-prompts.js";
import { isTaskRelevantVerificationCommand } from "./task-agent-loop-verification.js";
import type { ExecutionPolicy, SubagentRole } from "./execution-policy.js";
import type { CompanionDecisionFrame } from "../../../runtime/decision/index.js";
import { verifyTaskArtifactContract } from "../task/task-artifact-contract.js";

function formatArtifactContractSection(task: Task): string {
  if (!task.artifact_contract) return "";
  return [
    "Artifact contract:",
    JSON.stringify(task.artifact_contract, null, 2),
    "If this task creates a --check-contract mode or equivalent validator, it must validate the exact required_artifacts, required_fields, and field_types above. The metrics writer must emit those exact keys before status=done.",
    "Do not make --check-contract reject otherwise valid artifacts only because they predate the --check-contract process. PulSeed enforces fresh_after_task_start relative to the task start time.",
  ].join("\n");
}

export interface TaskAgentLoopContextInput {
  task: Task;
  artifactGoal?: Pick<Goal, "constraints"> | null;
  model: AgentLoopModelRef;
  modelInfo: AgentLoopModelInfo;
  session: AgentLoopSession;
  workspaceContext?: string;
  knowledgeContext?: string;
  systemPrompt?: string;
  userPrompt?: string;
  cwd?: string;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  toolCallContext?: Partial<ToolCallContext>;
  resumeState?: AgentLoopSessionState;
  abortSignal?: AbortSignal;
  role?: SubagentRole;
  profileName?: string;
  reasoningEffort?: AgentLoopReasoningEffort;
  executionPolicy?: ExecutionPolicy;
  companionDecisionFrame?: CompanionDecisionFrame;
}

export function buildTaskAgentLoopTurnContext(
  input: TaskAgentLoopContextInput,
): AgentLoopTurnContext<TaskAgentLoopOutput> {
  const cwd = input.cwd ?? processCwd();
  const executionPolicy = input.toolCallContext?.executionPolicy ?? input.executionPolicy;
  const verificationPlan = {
    requiredCommands: input.task.success_criteria
      .filter((criterion) => criterion.is_blocking)
      .map((criterion) => criterion.verification_method.trim())
      .filter(Boolean),
  };
  const baseSystemPrompt = buildAgentLoopBaseInstructions({
    mode: "task",
    extraRules: [
      "When you return status=done, include concrete completionEvidence.",
      "Final JSON status must be one of done, blocked, partial, or failed. Do not use completed.",
      "Final JSON completionEvidence, verificationHints, blockers, and filesChanged must be arrays of strings, not objects.",
      input.modelInfo.capabilities.toolCalling === false
        ? "If files changed or you claim files changed, include the exact focused verification command and outcome in completionEvidence before the final answer."
        : "If files changed or you claim files changed, run at least one focused verification command through tools before the final answer.",
      "Do not return status=done while blockers remain.",
    ],
    role: input.role,
  });
  const userPrompt = input.userPrompt ?? [
    `Task: ${input.task.work_description}`,
    `Approach: ${input.task.approach}`,
    `Success criteria:\n${input.task.success_criteria.map((c) => `- ${c.description} (verify: ${c.verification_method})`).join("\n")}`,
    formatArtifactContractSection(input.task),
    input.workspaceContext ? `Workspace context:\n${input.workspaceContext}` : "",
    input.knowledgeContext ? `Knowledge context:\n${input.knowledgeContext}` : "",
    "Return final output as JSON matching the required schema.",
  ].filter(Boolean).join("\n\n");

  return {
    session: input.session,
    turnId: randomUUID(),
    goalId: input.task.goal_id,
    taskId: input.task.id,
    ...(input.profileName ? { profileName: input.profileName } : {}),
    cwd,
    model: input.model,
    modelInfo: input.modelInfo,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
    ...(input.companionDecisionFrame ? { decisionContext: { companion: input.companionDecisionFrame } } : {}),
    messages: [
      {
        role: "system",
        content: [baseSystemPrompt, input.systemPrompt?.trim() ?? ""].filter(Boolean).join("\n\n"),
      },
      { role: "user", content: userPrompt },
    ],
    outputSchema: TaskAgentLoopOutputSchema,
    budget: withDefaultBudget(input.budget),
    toolPolicy: input.toolPolicy ?? {},
    verificationPlan,
    completionValidator: async ({ output, changedFiles, commandResults }): Promise<AgentLoopCompletionValidationResult> => {
      if (output.status !== "done") return { ok: true, reasons: [] };

      const reasons: string[] = [];
      const artifactVerification = await verifyTaskArtifactContract(input.task, cwd, {
        goal: input.artifactGoal,
      });
      const artifactContractPassed = artifactVerification.applicable && artifactVerification.passed;
      // CLI-wrapping agents can edit and verify outside PulSeed's function-call protocol.
      // A fresh artifact contract is the production-observed evidence boundary for those runs.
      const artifactContractCanStandInForRuntimeVerification =
        artifactContractPassed && input.modelInfo.capabilities.toolCalling === false;
      const externalAgentCompletionEvidenceCanDeferToTaskVerification =
        input.modelInfo.capabilities.toolCalling === false
        && (output.completionEvidence ?? []).some((item) => item.trim().length > 0);
      const runtimeVerifiedCommands = commandResults.filter((result) =>
        result.success && isTaskRelevantVerificationCommand(input.task, result)
      );
      const claimedChangedFiles = [...new Set([...(output.filesChanged ?? []), ...changedFiles])];
      const completionEvidenceCount =
        (output.completionEvidence ?? []).filter((item) => item.trim().length > 0).length
        + runtimeVerifiedCommands.length
        + (artifactContractPassed ? 1 : 0);

      if (!output.finalAnswer.trim()) {
        reasons.push("finalAnswer is empty.");
      }
      if ((output.blockers ?? []).length > 0) {
        reasons.push("status=done cannot include blockers.");
      }
      if (completionEvidenceCount < 1) {
        reasons.push("Provide at least one concrete completionEvidence item or one successful runtime verification command.");
      }
      if (
        claimedChangedFiles.length > 0
        && runtimeVerifiedCommands.length < 1
        && !artifactContractCanStandInForRuntimeVerification
        && !externalAgentCompletionEvidenceCanDeferToTaskVerification
      ) {
        reasons.push(`You claimed changed files (${claimedChangedFiles.slice(0, 5).join(", ")}) but no successful runtime verification command was observed.`);
      }
      if (artifactVerification.applicable && !artifactVerification.passed) {
        reasons.push(artifactVerification.description);
      }

      return {
        ok: reasons.length === 0,
        reasons,
      };
    },
    toolCallContext: {
      cwd,
      goalId: input.task.goal_id,
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => false,
      ...(executionPolicy ? { executionPolicy } : {}),
      agentRole: input.role,
      ...input.toolCallContext,
    },
    ...(input.resumeState ? { resumeState: input.resumeState } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
}
