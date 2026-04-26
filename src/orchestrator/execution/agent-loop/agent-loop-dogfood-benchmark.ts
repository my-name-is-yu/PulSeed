import type { AgentLoopResult } from "./agent-loop-result.js";
import type { TaskAgentLoopOutput } from "./task-agent-loop-result.js";

export interface TaskAgentLoopDogfoodExpectations {
  mutationExpected?: boolean;
  expectedChangedFiles?: string[];
  minSuccessfulVerificationCommands?: number;
  requireRelevantVerification?: boolean;
  requireIsolatedWorkspace?: boolean;
  allowFailedVerificationCommands?: boolean;
  maxModelTurns?: number;
  maxToolCalls?: number;
  maxElapsedMs?: number;
}

export interface TaskAgentLoopDogfoodScore {
  passed: boolean;
  reasons: string[];
  signals: {
    completed: boolean;
    doneStatus: boolean;
    changedFiles: string[];
    successfulVerificationCommands: number;
    failedVerificationCommands: number;
    isolatedWorkspace: boolean;
    modelTurns: number;
    toolCalls: number;
    elapsedMs: number;
  };
}

export interface TaskAgentLoopDogfoodCase {
  name: string;
  run: () => Promise<AgentLoopResult<TaskAgentLoopOutput>>;
  expectations?: TaskAgentLoopDogfoodExpectations;
}

export interface TaskAgentLoopDogfoodCaseResult {
  name: string;
  result: AgentLoopResult<TaskAgentLoopOutput>;
  score: TaskAgentLoopDogfoodScore;
}

export interface TaskAgentLoopDogfoodBenchmarkCriteria {
  minPassRate: number;
  requireEveryCasePassed: boolean;
}

export interface TaskAgentLoopDogfoodBenchmarkSummary {
  totalCases: number;
  passedCases: number;
  passRate: number;
  ready: boolean;
  reasons: string[];
  results: TaskAgentLoopDogfoodCaseResult[];
}

export interface TaskAgentLoopToolProfile {
  name: string;
  requiredToolNames: readonly string[];
  recommendedToolNames: readonly string[];
}

export interface TaskAgentLoopToolProfileAssessment {
  profileName: string;
  ready: boolean;
  availableToolNames: string[];
  missingRequiredToolNames: string[];
  missingRecommendedToolNames: string[];
  requiredCoverage: number;
  recommendedCoverage: number;
}

export const nativeTaskAgentLoopToolProfile: TaskAgentLoopToolProfile = {
  name: "native-task-agentloop",
  requiredToolNames: [
    "code_search",
    "code_read_context",
    "code_search_repair",
    "list_dir",
    "apply_patch",
    "shell_command",
    "git_diff",
  ],
  recommendedToolNames: [
    "tool_search",
    "read",
    "grep",
    "glob",
    "file_edit",
    "file_write",
    "test-runner",
    "git_log",
    "json_query",
    "env_info",
    "update_plan",
    "github_read",
    "github_pr_create",
    "process_session_start",
    "process_session_read",
    "process_session_write",
    "process_session_stop",
    "process_session_list",
    "mcp_list_tools",
    "mcp_call_tool",
  ],
};

export const defaultTaskAgentLoopDogfoodExpectations: Required<Pick<
  TaskAgentLoopDogfoodExpectations,
  "minSuccessfulVerificationCommands" | "requireRelevantVerification" | "allowFailedVerificationCommands"
>> = {
  minSuccessfulVerificationCommands: 1,
  requireRelevantVerification: true,
  allowFailedVerificationCommands: false,
};

export const defaultTaskAgentLoopDogfoodBenchmarkCriteria: TaskAgentLoopDogfoodBenchmarkCriteria = {
  minPassRate: 0.9,
  requireEveryCasePassed: true,
};

export function scoreTaskAgentLoopDogfoodResult(
  result: AgentLoopResult<TaskAgentLoopOutput>,
  expectations: TaskAgentLoopDogfoodExpectations = {},
): TaskAgentLoopDogfoodScore {
  const resolved = { ...defaultTaskAgentLoopDogfoodExpectations, ...expectations };
  const changedFiles = unique([
    ...result.changedFiles,
    ...(result.output?.filesChanged ?? []),
  ]);
  const relevantVerificationCommands = result.commandResults.filter((command) =>
    command.evidenceEligible
    && (!resolved.requireRelevantVerification || command.relevantToTask !== false)
  );
  const successfulVerificationCommands = relevantVerificationCommands.filter((command) => command.success);
  const failedVerificationCommands = relevantVerificationCommands.filter((command) => !command.success);
  const reasons: string[] = [];

  if (!result.success) {
    reasons.push(`result success was false (${result.stopReason})`);
  }
  if (result.stopReason !== "completed") {
    reasons.push(`stopReason ${result.stopReason} was not completed`);
  }
  if (result.output?.status !== "done") {
    reasons.push(`output status ${result.output?.status ?? "missing"} was not done`);
  }
  if (expectations.mutationExpected === true && changedFiles.length === 0) {
    reasons.push("mutation was expected but no changed files were reported");
  }
  if (expectations.mutationExpected === false && changedFiles.length > 0) {
    reasons.push(`no mutation was expected but changed files were reported: ${changedFiles.join(", ")}`);
  }
  for (const expectedPath of expectations.expectedChangedFiles ?? []) {
    if (!changedFiles.includes(expectedPath)) {
      reasons.push(`expected changed file was not reported: ${expectedPath}`);
    }
  }
  if (successfulVerificationCommands.length < resolved.minSuccessfulVerificationCommands) {
    reasons.push(
      `successful verification commands ${successfulVerificationCommands.length} < ${resolved.minSuccessfulVerificationCommands}`,
    );
  }
  if (!resolved.allowFailedVerificationCommands && failedVerificationCommands.length > 0) {
    reasons.push(`failed verification commands were reported: ${failedVerificationCommands.map((command) => command.command).join(", ")}`);
  }
  if (expectations.requireIsolatedWorkspace === true && result.workspace?.isolated !== true) {
    reasons.push("isolated worktree execution was required but not reported");
  }
  if (expectations.maxModelTurns !== undefined && result.modelTurns > expectations.maxModelTurns) {
    reasons.push(`modelTurns ${result.modelTurns} > ${expectations.maxModelTurns}`);
  }
  if (expectations.maxToolCalls !== undefined && result.toolCalls > expectations.maxToolCalls) {
    reasons.push(`toolCalls ${result.toolCalls} > ${expectations.maxToolCalls}`);
  }
  if (expectations.maxElapsedMs !== undefined && result.elapsedMs > expectations.maxElapsedMs) {
    reasons.push(`elapsedMs ${result.elapsedMs} > ${expectations.maxElapsedMs}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    signals: {
      completed: result.success && result.stopReason === "completed",
      doneStatus: result.output?.status === "done",
      changedFiles,
      successfulVerificationCommands: successfulVerificationCommands.length,
      failedVerificationCommands: failedVerificationCommands.length,
      isolatedWorkspace: result.workspace?.isolated === true,
      modelTurns: result.modelTurns,
      toolCalls: result.toolCalls,
      elapsedMs: result.elapsedMs,
    },
  };
}

export async function runTaskAgentLoopDogfoodBenchmark(
  cases: readonly TaskAgentLoopDogfoodCase[],
  criteria: Partial<TaskAgentLoopDogfoodBenchmarkCriteria> = {},
): Promise<TaskAgentLoopDogfoodBenchmarkSummary> {
  const resolvedCriteria = { ...defaultTaskAgentLoopDogfoodBenchmarkCriteria, ...criteria };
  const results: TaskAgentLoopDogfoodCaseResult[] = [];

  for (const benchmarkCase of cases) {
    const result = await benchmarkCase.run();
    results.push({
      name: benchmarkCase.name,
      result,
      score: scoreTaskAgentLoopDogfoodResult(result, benchmarkCase.expectations),
    });
  }

  const totalCases = results.length;
  const passedCases = results.filter((entry) => entry.score.passed).length;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;
  const reasons: string[] = [];

  if (passRate < resolvedCriteria.minPassRate) {
    reasons.push(`passRate ${passRate.toFixed(2)} < ${resolvedCriteria.minPassRate.toFixed(2)}`);
  }
  if (resolvedCriteria.requireEveryCasePassed) {
    for (const result of results.filter((entry) => !entry.score.passed)) {
      reasons.push(`${result.name}: ${result.score.reasons.join("; ")}`);
    }
  }

  return {
    totalCases,
    passedCases,
    passRate,
    ready: reasons.length === 0,
    reasons,
    results,
  };
}

export function assessTaskAgentLoopToolProfile(
  availableToolNames: Iterable<string>,
  profile: TaskAgentLoopToolProfile = nativeTaskAgentLoopToolProfile,
): TaskAgentLoopToolProfileAssessment {
  const available = unique([...availableToolNames]).sort();
  const availableSet = new Set(available);
  const missingRequiredToolNames = profile.requiredToolNames.filter((name) => !availableSet.has(name));
  const missingRecommendedToolNames = profile.recommendedToolNames.filter((name) => !availableSet.has(name));

  return {
    profileName: profile.name,
    ready: missingRequiredToolNames.length === 0,
    availableToolNames: available,
    missingRequiredToolNames,
    missingRecommendedToolNames,
    requiredCoverage: coverage(profile.requiredToolNames.length, missingRequiredToolNames.length),
    recommendedCoverage: coverage(profile.recommendedToolNames.length, missingRecommendedToolNames.length),
  };
}

export function assessTaskAgentLoopToolProfileFromTools(
  tools: readonly { metadata: { name: string } }[],
  profile: TaskAgentLoopToolProfile = nativeTaskAgentLoopToolProfile,
): TaskAgentLoopToolProfileAssessment {
  return assessTaskAgentLoopToolProfile(tools.map((tool) => tool.metadata.name), profile);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function coverage(total: number, missing: number): number {
  if (total === 0) return 1;
  return (total - missing) / total;
}
