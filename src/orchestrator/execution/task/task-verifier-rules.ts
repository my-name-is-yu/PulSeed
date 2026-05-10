import * as path from "node:path";
import * as fs from "node:fs";
import type { Task } from "../../../base/types/task.js";
import type { VerificationResult } from "../../../base/types/task.js";
import type { AgentTask, AgentResult, IAdapter } from "../adapter-layer.js";
import type { RevertAttemptResult, VerifierDeps } from "./task-verifier-types.js";
import { syncTaskOutcomeSummary } from "./task-outcome-ledger.js";
import { computeActualElapsedMs } from "./task-history-metrics.js";
import { resolveTaskWorkspacePath } from "./task-workspace.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";

// ─── runMechanicalVerification ───

const MECHANICAL_VERIFICATION_PREFIXES = [
  "npm",
  "npx",
  "pytest",
  "sh",
  "bash",
  "node",
  "python ",
  "python3 ",
  ".venv/bin/python ",
  "make",
  "cargo",
  "go ",
  "gh ",
  "rg ",
  "grep ",
  "test ",
  "ls ",
];

export function isMechanicalVerificationMethod(verificationMethod: string): boolean {
  const method = verificationMethod.toLowerCase().trim();
  return MECHANICAL_VERIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export async function runMechanicalVerification(
  deps: VerifierDeps,
  task: Task
): Promise<{ applicable: boolean; passed: boolean; description: string }> {
  const blockingMechanicalCriteria = task.success_criteria.filter(
    (c) => c.is_blocking && isMechanicalVerificationMethod(c.verification_method)
  );

  if (blockingMechanicalCriteria.length === 0) {
    return {
      applicable: false,
      passed: false,
      description: "No blocking mechanical verification criteria applicable",
    };
  }

  const verificationCommands = blockingMechanicalCriteria.map((c) => c.verification_method.trim());
  verificationCommands.sort((left, right) => {
    const leftIsTestCommand = /^(npm|npx|pytest|sh|bash|node|make|cargo|go )/.test(left.toLowerCase());
    const rightIsTestCommand = /^(npm|npx|pytest|sh|bash|node|make|cargo|go )/.test(right.toLowerCase());
    return Number(rightIsTestCommand) - Number(leftIsTestCommand);
  });

  const verificationCwd = await resolveTaskWorkspacePath({
    stateManager: deps.stateManager,
    task,
    fallbackCwd: deps.revertCwd,
  });
  const verificationTimeoutMs = 30_000; // 30 seconds default for L1 mechanical checks
  const commandPlans = verificationCommands.map((command) => ({
    command,
    directLocal: Boolean(verificationCwd && canRunAsCheapLocalVerification(command)),
  }));
  const needsAdapter = commandPlans.some((plan) => !plan.directLocal);

  if (needsAdapter && !deps.adapterRegistry) {
    const directFailure = await runDirectLocalPlansBeforeAdapterFallback(
      commandPlans,
      verificationCwd,
      verificationTimeoutMs
    );
    if (directFailure) return directFailure;
    return failClosedMechanicalVerification(commandPlans, "no adapter registry is configured");
  }

  // Select the first available adapter from the registry for command execution
  const availableAdapters = deps.adapterRegistry?.listAdapters() ?? [];
  if (needsAdapter && availableAdapters.length === 0) {
    const directFailure = await runDirectLocalPlansBeforeAdapterFallback(
      commandPlans,
      verificationCwd,
      verificationTimeoutMs
    );
    if (directFailure) return directFailure;
    return failClosedMechanicalVerification(commandPlans, "no adapters are registered");
  }

  const adapterType =
    deps.preferredAdapterType && availableAdapters.includes(deps.preferredAdapterType)
      ? deps.preferredAdapterType
      : availableAdapters[0]!;
  let adapter: IAdapter | undefined;
  try {
    adapter = needsAdapter ? deps.adapterRegistry?.getAdapter(adapterType) : undefined;
  } catch {
    const directFailure = await runDirectLocalPlansBeforeAdapterFallback(
      commandPlans,
      verificationCwd,
      verificationTimeoutMs
    );
    if (directFailure) return directFailure;
    return failClosedMechanicalVerification(commandPlans, `adapter lookup failed for ${adapterType}`);
  }

  const passedCommands: string[] = [];

  for (const plan of commandPlans) {
    const verificationCommand = plan.command;
    if (plan.directLocal && verificationCwd) {
      const result = await runCheapLocalVerification(verificationCommand, verificationCwd, verificationTimeoutMs);
      if (!result.passed) {
        const detail = formatMechanicalCommandError(result.errorText);
        return {
          applicable: true,
          passed: false,
          description: `Mechanical verification failed after ${passedCommands.length}/${verificationCommands.length} command(s) (exit ${result.exitCode ?? "null"}): ${verificationCommand}${detail}`,
        };
      }
      passedCommands.push(verificationCommand);
      continue;
    }

    if (!adapter) {
      return failClosedMechanicalVerification(commandPlans, `adapter unavailable for ${adapterType}`);
    }

    const agentTask: AgentTask = {
      prompt: verificationCommand,
      timeout_ms: verificationTimeoutMs,
      adapter_type: adapterType,
      ...(verificationCwd ? { cwd: verificationCwd } : {}),
    };

    let result: AgentResult;
    try {
      result = await adapter.execute(agentTask);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.logger?.error("runMechanicalVerification: adapter.execute() threw", { error: errMsg });
      return failClosedMechanicalVerification(
        [{ command: verificationCommand, directLocal: false }],
        `adapter execution failed for ${adapterType}: ${errMsg}`,
        "command(s) did not run to completion"
      );
    }

    if (result.stopped_reason === "timeout") {
      return {
        applicable: true,
        passed: false,
        description: `Mechanical verification timed out after ${verificationTimeoutMs}ms (command: ${verificationCommand})`,
      };
    }

    if (result.exit_code !== 0 || !result.success) {
      return {
        applicable: true,
        passed: false,
        description: `Mechanical verification failed after ${passedCommands.length}/${verificationCommands.length} command(s) (exit ${result.exit_code ?? "null"}): ${verificationCommand}${result.error ? ` — ${result.error}` : ""}`,
      };
    }

    passedCommands.push(verificationCommand);
  }

  return {
    applicable: true,
    passed: true,
    description: `Mechanical verification passed (${passedCommands.length} command(s)): ${passedCommands.join("; ")}`,
  };
}

function failClosedMechanicalVerification(
  commandPlans: Array<{ command: string; directLocal: boolean }>,
  reason: string,
  commandStatus = "command(s) did not run"
): { applicable: true; passed: false; description: string } {
  const unexecutedCommands = commandPlans
    .filter((plan) => !plan.directLocal)
    .map((plan) => plan.command);
  const commandSummary =
    unexecutedCommands.length > 0
      ? `${commandStatus}: ${unexecutedCommands.join("; ")}`
      : "blocking command did not run";
  return {
    applicable: true,
    passed: false,
    description:
      `Mechanical verification could not execute blocking command(s) (${reason}); ` +
      `${unexecutedCommands.length}/${commandPlans.length} ${commandSummary}. ` +
      "Result is unknown/Uncertain and fails closed.",
  };
}

interface CheapLocalCommand {
  cmd: "test" | "rg" | "grep" | "ls" | "node" | "python" | "python3" | ".venv/bin/python";
  args: string[];
}

async function runDirectLocalPlansBeforeAdapterFallback(
  commandPlans: Array<{ command: string; directLocal: boolean }>,
  verificationCwd: string | undefined,
  timeoutMs: number
): Promise<{ applicable: true; passed: false; description: string } | null> {
  if (!verificationCwd) return null;
  const passedCommands: string[] = [];
  for (const plan of commandPlans) {
    if (!plan.directLocal) continue;
    const result = await runCheapLocalVerification(plan.command, verificationCwd, timeoutMs);
    if (!result.passed) {
      const detail = formatMechanicalCommandError(result.errorText);
      return {
        applicable: true,
        passed: false,
        description: `Mechanical verification failed after ${passedCommands.length}/${commandPlans.length} command(s) (exit ${result.exitCode ?? "null"}): ${plan.command}${detail}`,
      };
    }
    passedCommands.push(plan.command);
  }
  return null;
}

async function runCheapLocalVerification(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ passed: boolean; exitCode: number | null; errorText: string }> {
  const parsed = parseCheapLocalVerification(command);
  if (!parsed) {
    return { passed: false, exitCode: null, errorText: "cheap local verification command was not parseable" };
  }
  for (const step of parsed) {
    const result = await execFileNoThrow(step.cmd, step.args, { cwd, timeoutMs });
    if (result.exitCode !== 0) {
      return { passed: false, exitCode: result.exitCode, errorText: result.stderr || result.stdout };
    }
  }
  return { passed: true, exitCode: 0, errorText: "" };
}

function canRunAsCheapLocalVerification(command: string): boolean {
  return parseCheapLocalVerification(command) !== null;
}

function parseCheapLocalVerification(command: string): CheapLocalCommand[] | null {
  const segments = command.split(/\s+&&\s+/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  const parsed: CheapLocalCommand[] = [];
  for (const segment of segments) {
    if (hasDisallowedShellToken(segment)) return null;
    const tokens = tokenizeCheapCommandSegment(segment);
    if (!tokens || tokens.length === 0) return null;
    const [cmd, ...args] = tokens;
    if (!isCheapCommandName(cmd)) return null;
    if (!areSafeCheapCommandArgs(cmd, args)) return null;
    parsed.push({ cmd, args });
  }
  return parsed;
}

function tokenizeCheapCommandSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isCheapCommandName(value: string | undefined): value is CheapLocalCommand["cmd"] {
  return value === "test" ||
    value === "rg" ||
    value === "grep" ||
    value === "ls" ||
    value === "node" ||
    value === "python" ||
    value === "python3" ||
    value === ".venv/bin/python";
}

function areSafeCheapCommandArgs(cmd: CheapLocalCommand["cmd"], args: string[]): boolean {
  if (args.some((arg) => arg.includes("\0"))) return false;
  if (cmd === "test") {
    return args.length === 2 && ["-f", "-d", "-e", "-s"].includes(args[0]!) && isWorkspaceRelativeOperand(args[1]!);
  }
  if (cmd === "rg" || cmd === "grep") {
    const allowedFlags = new Set(["-n", "--line-number", "-q", "--quiet", "-i", "--ignore-case", "-F", "--fixed-strings"]);
    const positionalArgs: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (!allowedFlags.has(arg)) return false;
        continue;
      }
      positionalArgs.push(arg);
    }
    const pathOperands = positionalArgs.slice(1);
    return positionalArgs.length >= 2 && pathOperands.every(isWorkspaceRelativeOperand);
  }
  if (cmd === "python" || cmd === "python3" || cmd === ".venv/bin/python") {
    const [scriptPath, ...scriptArgs] = args;
    if (!scriptPath || !scriptPath.endsWith(".py") || !isWorkspaceRelativeOperand(scriptPath)) return false;
    return scriptArgs.every(isSafePythonScriptArg);
  }
  if (cmd === "node") {
    const [scriptPath, ...scriptArgs] = args;
    if (!scriptPath || !/\.(?:cjs|mjs|js)$/.test(scriptPath) || !isWorkspaceRelativeOperand(scriptPath)) return false;
    return scriptArgs.every(isSafeNodeScriptArg);
  }
  const allowedLsFlags = new Set(["-a", "-l", "-la", "-al"]);
  return args.every((arg) =>
    arg.startsWith("-") ? allowedLsFlags.has(arg) : isWorkspaceRelativeOperand(arg)
  );
}

function isSafePythonScriptArg(value: string): boolean {
  if (!value || value.includes("\0") || /[\r\n<>`$|&;]/.test(value)) return false;
  if (value === "-c" || value === "-m" || value === "-") return false;
  return /^[A-Za-z0-9._=:/,+-]+$/.test(value);
}

function isSafeNodeScriptArg(value: string): boolean {
  if (!value || value.includes("\0") || /[\r\n<>`$|&;]/.test(value)) return false;
  if (value === "-e" || value === "--eval" || value === "-p" || value === "--print" || value === "-") return false;
  return /^[A-Za-z0-9._=:/,+-]+$/.test(value);
}

function isWorkspaceRelativeOperand(value: string): boolean {
  if (!value || value.includes("\0") || path.isAbsolute(value)) return false;
  if (/[*?[\]{}]/.test(value)) return false;
  const segments = value.replace(/\\/g, "/").split("/");
  return !segments.includes("..");
}

function hasDisallowedShellToken(segment: string): boolean {
  return /(&|;|\|\|?|\$\(|`|[<>]|\n|\r)/.test(segment);
}

function formatMechanicalCommandError(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  return ` — ${trimmed.slice(0, 500)}`;
}

// ─── P0 Guard 1: dimension_updates change magnitude limit (§3.2) ───

/**
 * Clamp a proposed dimension update to within ±30% absolute or ±30% relative
 * of the current value (whichever is larger). Logs a warning when clamping occurs.
 *
 * Exported for unit testing.
 */
export function clampDimensionUpdate(
  current: number,
  proposed: number,
  logger?: import("../../../runtime/logger.js").Logger,
  dimName?: string
): number {
  const absLimit = 0.3;
  const relLimit = Math.abs(current) * 0.3;
  const maxDelta = Math.max(absLimit, relLimit);
  const clamped = Math.max(current - maxDelta, Math.min(current + maxDelta, proposed));
  if (clamped !== proposed) {
    logger?.warn(
      `dimension_update clamped: dim=${dimName}, proposed=${proposed}, applied=${clamped}, current=${current}`
    );
  }
  return clamped;
}

// ─── §4.5 Guard: dimension_updates direction check ───

/**
 * Check whether a proposed dimension update moves in the intended direction.
 * Returns true if the update should be applied, false if it should be skipped.
 *
 * Exported for unit testing.
 */
export function checkDimensionDirection(
  intendedDirection: "increase" | "decrease" | "neutral" | undefined,
  currentValue: number,
  proposedValue: number,
  logger?: { warn: (msg: string) => void },
  dimName?: string,
): boolean {
  if (!intendedDirection || intendedDirection === "neutral") return true;

  const actualDirection =
    proposedValue > currentValue
      ? "increase"
      : proposedValue < currentValue
        ? "decrease"
        : "neutral";

  if (intendedDirection === "increase" && actualDirection === "decrease") {
    logger?.warn(
      `dimension_update direction mismatch: task intended ${intendedDirection}, but update suggests ${actualDirection} for dim ${dimName ?? "unknown"}`
    );
    return false;
  }
  if (intendedDirection === "decrease" && actualDirection === "increase") {
    logger?.warn(
      `dimension_update direction mismatch: task intended ${intendedDirection}, but update suggests ${actualDirection} for dim ${dimName ?? "unknown"}`
    );
    return false;
  }
  return true;
}

// ─── parseExecutorReport ───

export function parseExecutorReport(executionResult: AgentResult): import("./task-verifier-types.js").ExecutorReport {
  const completionEvidence = executionResult.agentLoop?.completionEvidence ?? [];
  const verificationHints = executionResult.agentLoop?.verificationHints ?? [];
  const stopReason = executionResult.agentLoop?.stopReason ?? executionResult.stopped_reason;
  const summaryParts = [
    executionResult.output.slice(0, 500),
    completionEvidence.length > 0 ? `completion evidence: ${completionEvidence.join("; ")}` : "",
  ].filter((part) => part.length > 0);

  return {
    completed: executionResult.success,
    summary: summaryParts.join("\n"),
    partial_results: completionEvidence,
    blockers: [
      ...(executionResult.error ? [executionResult.error] : []),
      ...(executionResult.success || stopReason === "completed" ? [] : [`stop reason: ${stopReason}`]),
    ],
    stop_reason: stopReason,
    completion_evidence: completionEvidence,
    verification_hints: verificationHints,
    trace_id: executionResult.agentLoop?.traceId,
    session_id: executionResult.agentLoop?.sessionId,
    turn_id: executionResult.agentLoop?.turnId,
  };
}

// ─── isDirectionCorrect ───

export function isDirectionCorrect(verificationResult: VerificationResult): boolean {
  return verificationResult.verdict === "partial";
}

// ─── attemptRevert ───

async function resolveRevertCwd(deps: VerifierDeps, task: Task): Promise<string | null> {
  return await resolveTaskWorkspacePath({
    stateManager: deps.stateManager,
    task,
    fallbackCwd: deps.revertCwd?.trim() || undefined,
  }) ?? null;
}

function hasGitMetadata(cwd: string): boolean {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRelativeGitPath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes("\0") || path.isAbsolute(trimmed)) {
    return false;
  }
  const segments = trimmed.replace(/\\/g, "/").split("/");
  return !segments.includes("..");
}

function shellStdout(data: unknown): string {
  return data &&
    typeof data === "object" &&
    "stdout" in data &&
    typeof (data as { stdout?: unknown }).stdout === "string"
    ? (data as { stdout: string }).stdout
    : "";
}

export async function attemptRevert(
  deps: VerifierDeps,
  task: Task,
  opts: { concretePaths?: string[]; unsafePaths?: string[] } = {}
): Promise<RevertAttemptResult> {
  const filesToRestore = [
    ...new Set((opts.concretePaths ?? []).map((filePath) => filePath.trim()).filter(Boolean)),
  ];
  const unsafePaths = [
    ...new Set((opts.unsafePaths ?? []).map((filePath) => filePath.trim()).filter(Boolean)),
  ];
  const revertCwd = await resolveRevertCwd(deps, task);
  if (!revertCwd) {
    deps.logger?.warn?.("[attemptRevert] skipping raw git restore because no workspace_path/revertCwd was configured");
    return {
      success: false,
      concretePaths: filesToRestore,
      reason: "missing_explicit_workspace",
    };
  }

  if (!hasGitMetadata(revertCwd)) {
    deps.logger?.warn?.("[attemptRevert] skipping git restore because workspace is not a git repository");
    const pathSummary = [...filesToRestore, ...unsafePaths].join(", ");
    return {
      success: false,
      concretePaths: filesToRestore,
      unsafePaths,
      reason: unsafePaths.length > 0
        ? `git restore is unavailable because workspace is not a git repository; unsafe task changes share pre-existing dirty paths: ${unsafePaths.join(", ")}`
        : filesToRestore.length > 0
        ? `git restore is unavailable because workspace is not a git repository; changed filesystem paths require operator review: ${pathSummary}`
        : "git restore is unavailable because workspace is not a git repository; no concrete changed paths were captured",
      method: "git_unavailable",
    };
  }

  if (filesToRestore.length === 0) {
    if (unsafePaths.length > 0) {
      deps.logger?.warn?.("[attemptRevert] skipping raw git restore because task changes share pre-existing dirty paths");
      return {
        success: false,
        concretePaths: [],
        unsafePaths,
        reason: `unsafe task changes share pre-existing dirty paths: ${unsafePaths.join(", ")}`,
      };
    }
    deps.logger?.warn?.("[attemptRevert] skipping raw git restore because no concrete changed paths were captured");
    return {
      success: false,
      concretePaths: [],
      reason: "no_concrete_changed_paths",
    };
  }

  const allSafe = [...filesToRestore, ...unsafePaths].every(isRelativeGitPath);
  if (!allSafe) {
    deps.logger?.warn?.("[attemptRevert] concrete changed path failed git-restore path validation; refusing revert");
    return {
      success: false,
      concretePaths: filesToRestore,
      unsafePaths,
      reason: "invalid_concrete_changed_path",
    };
  }

  try {
    if (deps.toolExecutor) {
      // Use ToolExecutor (preferred): keeps all shell ops in the tool pipeline.
      const ctx: import("../../../tools/types.js").ToolCallContext = {
        cwd: revertCwd,
        goalId: task.goal_id,
        trustBalance: 100,
        preApproved: true,
        trusted: true,
        approvalFn: async () => true,
      };
      const pathArgs = filesToRestore.map(quoteShellArg).join(" ");
      const result = await deps.toolExecutor.execute(
        "shell",
        { command: "git restore --staged --worktree -- " + pathArgs },
        ctx
      );
      if (result.success) {
        const statusResult = await deps.toolExecutor.execute(
          "shell",
          { command: "git status --porcelain -- " + pathArgs },
          ctx
        );
        const statusOutput = shellStdout(statusResult.data).trim();
        if (!statusResult.success || statusOutput.length > 0) {
          return {
            success: false,
            concretePaths: filesToRestore,
            reason: statusOutput.length > 0
              ? `git restore left changes for concrete paths: ${statusOutput}`
              : statusResult.error ?? statusResult.summary ?? "git_status_after_restore_failed",
          };
        }
        deps.logger?.info?.(`[attemptRevert] git restore succeeded for ${filesToRestore.length} files (via ToolExecutor)`);
        if (unsafePaths.length > 0) {
          return {
            success: false,
            concretePaths: filesToRestore,
            unsafePaths,
            reason: `unsafe task changes share pre-existing dirty paths: ${unsafePaths.join(", ")}`,
            method: "git_restore_tool",
          };
        }
        return {
          success: true,
          concretePaths: filesToRestore,
          unsafePaths,
          reason: "git_restore_succeeded",
          method: "git_restore_tool",
        };
      }
      return {
        success: false,
        concretePaths: filesToRestore,
        unsafePaths,
        reason: result.error ?? result.summary ?? "git_restore_failed",
      };
    }

    const { execFileSync } = await import("child_process");
    execFileSync("git", ["restore", "--staged", "--worktree", "--", ...filesToRestore], {
      cwd: revertCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const statusOutput = execFileSync("git", ["status", "--porcelain", "--", ...filesToRestore], {
      cwd: revertCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (statusOutput.length > 0) {
      return {
        success: false,
        concretePaths: filesToRestore,
        reason: `git restore left changes for concrete paths: ${statusOutput}`,
      };
    }
    deps.logger?.info?.(`[attemptRevert] git restore succeeded for ${filesToRestore.length} files`);
    if (unsafePaths.length > 0) {
      return {
        success: false,
        concretePaths: filesToRestore,
        unsafePaths,
        reason: `unsafe task changes share pre-existing dirty paths: ${unsafePaths.join(", ")}`,
        method: "git_restore_child_process",
      };
    }
    return {
      success: true,
      concretePaths: filesToRestore,
      unsafePaths,
      reason: "git_restore_succeeded",
      method: "git_restore_child_process",
    };
  } catch (error) {
    return {
      success: false,
      concretePaths: filesToRestore,
      unsafePaths,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── setDimensionIntegrity ───

export async function setDimensionIntegrity(
  deps: VerifierDeps,
  goalId: string,
  dimensionName: string,
  integrity: "ok" | "uncertain"
): Promise<void> {
  const goal = await deps.stateManager.loadGoal(goalId);
  if (!goal) return;
  const dimensions = goal.dimensions.map((dim) => dim.name === dimensionName
    ? { ...dim, state_integrity: integrity }
    : dim);
  if (dimensions.some((dim, index) => dim !== goal.dimensions[index])) {
    await deps.stateManager.saveGoal({ ...goal, dimensions });
  }
}

// ─── appendTaskHistory ───

export async function appendTaskHistory(deps: VerifierDeps, goalId: string, task: Task): Promise<void> {
  const history = await deps.stateManager.loadTaskHistory(goalId);

  const actual_elapsed_ms = computeActualElapsedMs(task.started_at, task.completed_at);

  const estimated_duration_ms = task.estimated_duration
    ? deps.durationToMs(task.estimated_duration)
    : null;

  history.push({
    id: task.id,
    task_id: task.id,
    work_description: task.work_description,
    status: task.status,
    primary_dimension: task.primary_dimension,
    consecutive_failure_count: task.consecutive_failure_count,
    verification_verdict: task.verification_verdict ?? null,
    verification_evidence: task.verification_evidence ?? [],
    completed_at: task.completed_at ?? new Date().toISOString(),
    actual_elapsed_ms,
    estimated_duration_ms,
  });
  await deps.stateManager.saveTaskHistory(goalId, history);
  await syncTaskOutcomeSummary(deps.stateManager, task);
}
