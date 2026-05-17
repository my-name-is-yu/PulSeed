// ─── pulseed run command ───

import * as readline from "node:readline";

import type { StateManager } from "../../../base/state/state-manager.js";
import type { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import type { DurableLoop, LoopConfig } from "../../../orchestrator/loop/durable-loop.js";
import { resolveLoopRunPolicy } from "../../../orchestrator/loop/run-policy.js";
import type { Task } from "../../../base/types/task.js";
import { reconcileInterruptedExecutions } from "../../../runtime/daemon/runner-recovery.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import {
  buildAutoApprovalFn,
  buildLoopLogger,
  buildProgressHandler,
  runLoopWithSignals,
} from "../utils/loop-runner.js";
import { formatWholeMinuteDurationMs } from "./display-format.js";
import { recordExplicitCommandDecision, stableId } from "../../../runtime/personal-agent/index.js";

function buildApprovalFn(rl: readline.Interface): (task: Task) => Promise<boolean> {
  return (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.pause();
      process.stdout.write("\n--- Approval Required ---\n");
      process.stdout.write(`Task: ${task.work_description}\n`);
      process.stdout.write(`Rationale: ${task.rationale}\n`);
      process.stdout.write(`Reversibility: ${task.reversibility}\n`);
      rl.resume();
      rl.question("Approve this task? [y/N] ", (answer) => {
        process.stdout.write("\n");
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  };
}

export async function cmdRun(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  goalId: string,
  loopConfig?: LoopConfig,
  autoApprove?: boolean,
  verbose?: boolean,
  activeDurableLoopRef?: { value: DurableLoop | null },
  workspacePath?: string,
): Promise<number> {
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const rl = autoApprove
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

  const approvalFn = autoApprove ? buildAutoApprovalFn() : buildApprovalFn(rl!);
  const logger = buildLoopLogger(stateManager.getBaseDir());
  const onProgress = buildProgressHandler();

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps(stateManager, characterConfigManager, loopConfig, approvalFn, logger, onProgress, workspacePath);
  } catch (err) {
    rl?.close();
    logger.error(formatOperationError("initialise dependencies", err));
    if (verbose || process.env.DEBUG) {
      logger.error(err instanceof Error ? err.stack ?? String(err) : String(err));
    }
    return 1;
  }

  const { coreLoop: durableLoop } = deps;

  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    rl?.close();
    logger.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`Running PulSeed loop for goal: ${goalId}`);
  console.log(`Goal: ${goal.title}`);
  if (loopConfig?.treeMode) {
    console.log("Tree mode enabled — iterating across all tree nodes");
  }
  console.log("Press Ctrl+C to stop.\n");

  if (activeDurableLoopRef) {
    activeDurableLoopRef.value = durableLoop;
  }

  const runPolicy = resolveLoopRunPolicy(loopConfig);
  if (runPolicy.mode === "resident") {
    try {
      const recoveredGoalIds = await reconcileInterruptedExecutions({
        baseDir: stateManager.getBaseDir(),
        stateManager,
        logger,
        interruptedOutputMessage: "[RECOVERED] Task execution was interrupted before resident CLI startup.",
        failedEventReason: "task execution interrupted before resident CLI startup",
        retryEventReason: "resident CLI startup preserved task for retry",
        recoverySource: "resident_cli_startup",
      });
      if (recoveredGoalIds.length > 0) {
        console.log(`Recovered interrupted task executions for ${recoveredGoalIds.length} goal(s) before resident loop startup.`);
      }
    } catch (err) {
      logger.error(formatOperationError("reconcile interrupted resident tasks", err));
      if (activeDurableLoopRef) activeDurableLoopRef.value = null;
      rl?.close();
      return 1;
    }
  }

  let result: Awaited<ReturnType<typeof durableLoop.run>>;
  try {
    const runReplayKey = [
      "cli_run",
      goalId,
      runPolicy.mode,
      runPolicy.mode === "bounded" ? runPolicy.maxIterations : "resident",
      workspacePath ?? "workspace:none",
    ].join(":");
    await recordExplicitCommandDecision({
      baseDir: stateManager.getBaseDir(),
      surface: "cli",
      command: "pulseed run",
      sourceId: `pulseed run:${goalId}`,
      sourceEpoch: goal.updated_at,
      replayKey: runReplayKey,
      target: {
        kind: "run",
        ref: { kind: "run", ref: `run:cli:${stableId(runReplayKey)}` },
        effect: "create_run",
        summary: `Run goal "${goal.title}" from CLI.`,
      },
      decisionReason: "Explicit CLI run was allowed to start durable goal work.",
      capabilityRefs: [{ kind: "capability", ref: "durable_loop_goal_run" }],
      currentRefs: [
        { kind: "goal", ref: goalId },
        ...(workspacePath ? [{ kind: "workspace", ref: workspacePath }] : []),
      ],
      auditRefs: [{ kind: "goal", ref: goalId }],
    });
    result = await runLoopWithSignals(durableLoop, goalId);
  } catch (err) {
    if (runPolicy.mode === "resident") {
      await reconcileResidentShutdownTasks(stateManager, logger, "resident_cli_error");
    }
    logger.error(formatOperationError(`run DurableLoop for goal "${goalId}"`, err));
    logger.error(`Hint: Check ~/.pulseed/logs/ for details or re-run with DEBUG=1 for stack traces.`);
    if (verbose || process.env.DEBUG) {
      logger.error(err instanceof Error ? err.stack ?? String(err) : String(err));
    }
    if (activeDurableLoopRef) activeDurableLoopRef.value = null;
    rl?.close();
    return 1;
  }

  if (runPolicy.mode === "resident") {
    await reconcileResidentShutdownTasks(stateManager, logger, "resident_cli_shutdown");
  }

  if (activeDurableLoopRef) activeDurableLoopRef.value = null;
  rl?.close();

  console.log(`\n--- Loop Result ---`);
  console.log(`Goal ID:          ${result.goalId}`);
  console.log(`Final status:     ${result.finalStatus}`);
  console.log(`Total iterations: ${result.totalIterations}`);
  console.log(`Started at:       ${result.startedAt}`);
  console.log(`Completed at:     ${result.completedAt}`);
  const executionMode = result.iterations.at(-1)?.executionMode;
  if (executionMode) {
    console.log(`Execution mode:   ${executionMode.mode} (${executionMode.reason})`);
  }
  const finalizationStatus = result.iterations.at(-1)?.finalizationStatus;
  if (finalizationStatus && finalizationStatus.mode !== "no_deadline") {
    console.log(`Finalization:     ${finalizationStatus.mode}`);
    console.log(`Exploration left: ${formatWholeMinuteDurationMs(finalizationStatus.remaining_exploration_ms)}`);
    console.log(`Reserved buffer:  ${formatWholeMinuteDurationMs(finalizationStatus.reserved_finalization_ms)}`);
    const plan = finalizationStatus.finalization_plan;
    if (plan?.best_artifact) {
      console.log(`Best artifact:    ${plan.best_artifact.label}`);
    }
    if (plan && plan.approval_required_actions.length > 0) {
      console.log(
        `Approval needed:  ${plan.approval_required_actions.map((action) => action.label).join(", ")}`
      );
    }
  }

  switch (result.finalStatus) {
    case "completed":
      return 0;
    case "stalled":
      logger.error("Goal stalled — escalation level reached maximum.");
      return 2;
    case "error":
      console.error(`Error: ${result.errorMessage || "Loop ended with error. Check ~/.pulseed/logs/ for details."}`);
      return 1;
    default:
      return 0;
  }
}

async function reconcileResidentShutdownTasks(
  stateManager: StateManager,
  logger: ReturnType<typeof buildLoopLogger>,
  recoverySource: "resident_cli_shutdown" | "resident_cli_error",
): Promise<void> {
  try {
    await reconcileInterruptedExecutions({
      baseDir: stateManager.getBaseDir(),
      stateManager,
      logger,
      interruptedOutputMessage: "[STOPPED] Task execution was interrupted by resident CLI shutdown; no live worker remains attached.",
      failedEventReason: "task execution interrupted during resident CLI shutdown; no live worker remains attached",
      retryEventReason: "resident CLI shutdown marked task terminal",
      recoverySource,
      terminalStatus: "cancelled",
      stoppedReason: "cancelled",
    });
  } catch (err) {
    logger.warn(formatOperationError("reconcile interrupted resident shutdown tasks", err));
  }
}
