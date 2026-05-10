// ─── pulseed goal read commands (read-only) ───

import * as path from "node:path";

import type { StateManager } from "../../../base/state/state-manager.js";
import { ReportingEngine } from "../../../reporting/reporting-engine.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { dimensionProgress } from "../../../platform/drive/gap-calculator.js";
import { resolvePulSeedExecutionProfile } from "../../../orchestrator/execution/agent-loop/self-protection.js";
import type { Task } from "../../../base/types/task.js";
import { createRuntimeSessionRegistry } from "../../../runtime/session-registry/index.js";
import { RuntimeOperatorHandoffStore } from "../../../runtime/store/operator-handoff-store.js";
import { RuntimeBudgetStore } from "../../../runtime/store/budget-store.js";
import {
  formatCurrentGoalChoiceList,
  formatCurrentGoalSummary,
  isCurrentGoalCandidate,
} from "../../current-goal-summary.js";
import { formatGoalStatusDetails } from "../../goal-status-display.js";
import {
  createRuntimeBudgetProjections,
  type RuntimeBudgetProjection,
} from "../../runtime-budget-summary.js";

async function printActiveGoals(
  stateManager: StateManager,
  opts: { diagnostic?: boolean } = {},
): Promise<void> {
  const goalIds = await stateManager.listGoalIds();
  if (goalIds.length === 0) {
    console.log("No goals registered. Use `pulseed goal add` to create one.");
    return;
  }

  const allGoals: Array<{ id: string; title: string; status: string; dimensions: number; isSubgoal: boolean }> = [];
  for (const goalId of goalIds) {
    const goal = await stateManager.loadGoal(goalId);
    if (!goal) {
      allGoals.push({ id: goalId, title: "(could not load)", status: "unknown", dimensions: 0, isSubgoal: false });
    } else {
      allGoals.push({
        id: goalId,
        title: goal.title,
        status: goal.status,
        dimensions: goal.dimensions.length,
        isSubgoal: !!goal.parent_id,
      });
    }
  }

  const rootGoals = allGoals.filter((g) => !g.isSubgoal);
  const subgoalCount = allGoals.length - rootGoals.length;

  if (rootGoals.length === 0) {
    console.log("No root goals found.");
  } else {
    console.log(`Found ${rootGoals.length} root goal(s):\n`);
    for (const g of rootGoals) {
      if (opts.diagnostic) {
        console.log(`[${g.id}] status: ${g.status} — ${g.title} (dimensions: ${g.dimensions})`);
      } else {
        console.log(`- ${g.title} — ${formatGoalListStatus(g.status)} (${g.dimensions} progress signal${g.dimensions === 1 ? "" : "s"})`);
      }
    }
  }

  if (subgoalCount > 0) {
    console.log(`\n(${subgoalCount} subgoal(s) hidden — use \`pulseed goal show <id>\` for tree details)`);
  }
}

async function printArchivedGoals(
  stateManager: StateManager,
  archivedIds: string[],
  opts: { diagnostic?: boolean } = {},
): Promise<void> {
  if (archivedIds.length === 0) {
    console.log(`\nNo archived goals found.`);
    return;
  }

  console.log(`\nArchived goals (${archivedIds.length}):\n`);
  for (const goalId of archivedIds) {
    let title = "(could not load)";
    let status = "unknown";
    let dimCount = 0;
    try {
      const goal = await stateManager.loadGoal(goalId);
      if (goal !== null) {
        title = goal.title;
        status = goal.status;
        dimCount = goal.dimensions.length;
      }
    } catch (err) {
      getCliLogger().error(formatOperationError(`read archived goal metadata for "${goalId}"`, err));
    }
    if (opts.diagnostic) {
      console.log(`[${goalId}] status: ${status} — ${title} (dimensions: ${dimCount})`);
    } else {
      console.log(`- ${title} — ${formatGoalListStatus(status)} (${dimCount} progress signal${dimCount === 1 ? "" : "s"})`);
    }
  }
}

export async function cmdGoalList(
  stateManager: StateManager,
  opts: { archived?: boolean; diagnostic?: boolean } = {}
): Promise<number> {
  const archivedIds = await stateManager.listArchivedGoals();

  if (opts.archived) {
    await printArchivedGoals(stateManager, archivedIds, { diagnostic: opts.diagnostic });
  } else {
    await printActiveGoals(stateManager, { diagnostic: opts.diagnostic });
    console.log(`\nArchived goals: ${archivedIds.length} (use \`pulseed goal list --archived\` to show)`);
  }

  return 0;
}

export async function cmdStatus(
  stateManager: StateManager,
  goalId: string,
  reportingEngine?: ReportingEngine,
  opts: { diagnostic?: boolean } = {},
): Promise<number> {
  const engine = reportingEngine ?? new ReportingEngine(stateManager);
  const diagnostic = opts.diagnostic ?? false;

  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    getCliLogger().error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  const registry = createRuntimeSessionRegistry({ stateManager });
  const baseDir = stateManager.getBaseDir();
  const runtimeRoot = path.join(baseDir, "runtime");
  const [runtimeSnapshot, handoffs, runtimeBudgets] = await Promise.all([
    registry.snapshot(),
    new RuntimeOperatorHandoffStore(runtimeRoot, { controlBaseDir: baseDir }).listOpen(),
    loadRuntimeBudgetProjections(stateManager),
  ]);

  if (isCurrentGoalCandidate(goal)) {
    console.log(formatCurrentGoalSummary(goal, {
      runtimeSnapshot,
      handoffs,
      runtimeBudgets,
      detail: diagnostic ? "diagnostic" : "default",
    }));
  }
  console.log(`\n# Status: ${goal.title}\n`);
  console.log(formatGoalStatusDetails(goal, { diagnostic }));
  if (resolvePulSeedExecutionProfile() === "dev") {
    console.log("**Execution profile**: dev");
  }

  const reports = await engine.listReports(goalId);
  const execReports = reports
    .filter((r) => r.report_type === "execution_summary")
    .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));
  const latestTask = await loadLatestTaskForStatus(stateManager, goalId);

  if (execReports.length > 0) {
    const latest = execReports[0];
    console.log(`\n## Latest Execution Summary\n`);
    if (diagnostic) {
      console.log(latest.content);
    } else {
      console.log(`- ${latest.title}`);
      console.log(`- Generated: ${latest.generated_at}`);
      console.log("Use detailed status when you need exact IDs and full report content.");
    }
    if (diagnostic && latestTask && !latest.content.includes(latestTask.id)) {
      printLatestTaskRecord(latestTask);
    }
  } else {
    console.log(diagnostic
      ? `\n_No execution reports yet. Run \`pulseed run --goal ${goalId}\` to start._`
      : "\n_No execution reports yet. Ask PulSeed to start work on this goal when you are ready._");
    if (diagnostic && latestTask) {
      printLatestTaskRecord(latestTask);
    }
  }

  return 0;
}

export async function cmdCurrentStatus(
  stateManager: StateManager,
  opts: { diagnostic?: boolean } = {},
): Promise<number> {
  const diagnostic = opts.diagnostic ?? false;
  const goalIds = await stateManager.listGoalIds();
  const goals = (await Promise.all(goalIds.map((goalId) => stateManager.loadGoal(goalId))))
    .filter((goal): goal is NonNullable<typeof goal> => goal !== null)
    .filter(isCurrentGoalCandidate);

  if (goals.length === 0) {
    console.log("No active goals found.");
    console.log("Describe what you want PulSeed to work on, or run `pulseed goal list` to inspect saved goals.");
    return 0;
  }

  const registry = createRuntimeSessionRegistry({ stateManager });
  const baseDir = stateManager.getBaseDir();
  const runtimeRoot = path.join(baseDir, "runtime");
  const [runtimeSnapshot, handoffs, runtimeBudgets] = await Promise.all([
    registry.snapshot(),
    new RuntimeOperatorHandoffStore(runtimeRoot, { controlBaseDir: baseDir }).listOpen(),
    loadRuntimeBudgetProjections(stateManager),
  ]);

  console.log(goals.length === 1
    ? formatCurrentGoalSummary(goals[0]!, {
      runtimeSnapshot,
      handoffs,
      runtimeBudgets,
      detail: diagnostic ? "diagnostic" : "default",
    })
    : formatCurrentGoalChoiceList(goals, {
      runtimeSnapshot,
      handoffs,
      runtimeBudgets,
      detail: diagnostic ? "diagnostic" : "default",
    }));
  return 0;
}

async function loadRuntimeBudgetProjections(stateManager: StateManager): Promise<RuntimeBudgetProjection[]> {
  try {
    const baseDir = stateManager.getBaseDir();
    const store = new RuntimeBudgetStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    return createRuntimeBudgetProjections(store, await store.list());
  } catch {
    return [];
  }
}

async function loadLatestTaskForStatus(stateManager: StateManager, goalId: string): Promise<Task | null> {
  try {
    const tasks = await stateManager.listTasks(goalId);
    return tasks[0] ?? null;
  } catch {
    return null;
  }
}

function printLatestTaskRecord(task: Task): void {
  console.log(`\n## Latest Task Record\n`);
  console.log(`- **Task ID**: ${task.id}`);
  console.log(`- **Status**: ${task.status}`);
  console.log(`- **Dimension**: ${task.primary_dimension}`);
  if (task.verification_verdict) {
    console.log(`- **Verification**: ${task.verification_verdict}`);
  }
  if (task.completed_at) {
    console.log(`- **Completed at**: ${task.completed_at}`);
  }
}

function formatGoalListStatus(status: string): string {
  return {
    active: "In progress",
    waiting: "Waiting",
    completed: "Completed",
    cancelled: "Cancelled",
    archived: "Archived",
    abandoned: "Stopped",
  }[status] ?? "Unknown";
}

export async function cmdGoalShow(stateManager: StateManager, goalId: string): Promise<number> {
  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    getCliLogger().error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`# Goal: ${goal.title}`);
  console.log(`\nID:          ${goal.id}`);
  console.log(`Status:      ${goal.status}`);
  console.log(`Description: ${goal.description || "(none)"}`);
  if (goal.deadline) {
    console.log(`Deadline:    ${goal.deadline}`);
  }
  console.log(`Created at:  ${goal.created_at}`);

  if (goal.dimensions.length > 0) {
    console.log(`\nDimensions:`);
    for (const dim of goal.dimensions) {
      console.log(`  - ${dim.label} (${dim.name})`);
      const currentValueDisplay = dim.current_value !== undefined && dim.current_value !== null
        ? String(dim.current_value)
        : "(not yet measured)";
      console.log(`    Current value:   ${currentValueDisplay}`);
      console.log(`    Threshold type:  ${dim.threshold.type}`);
      console.log(`    Threshold value: ${JSON.stringify((dim.threshold as { value?: unknown }).value ?? dim.threshold)}`);
      console.log(`    Confidence:      ${(dim.confidence * 100).toFixed(1)}%`);
      const progress = dimensionProgress(dim.current_value, dim.threshold);
      const progressDisplay = progress !== null ? progress.toFixed(4) : "(not yet measured)";
      console.log(`    Progress:        ${progressDisplay}`);
      console.log(`    History entries: ${dim.history?.length ?? 0}`);
    }
  } else {
    console.log(`\nDimensions: (none)`);
  }

  if (goal.constraints.length > 0) {
    console.log(`\nConstraints:`);
    for (const c of goal.constraints) {
      console.log(`  - ${c}`);
    }
  }

  // Tree structure info
  if (goal.parent_id) {
    console.log(`\nParent:      ${goal.parent_id}`);
  }
  if (goal.node_type && goal.node_type !== "goal") {
    console.log(`Node type:   ${goal.node_type}`);
  }
  if (goal.children_ids && goal.children_ids.length > 0) {
    console.log(`Children:    ${goal.children_ids.length} subgoal(s)`);
    for (const childId of goal.children_ids) {
      const shortId = childId.substring(0, 8);
      let childTitle = "(error reading goal)";
      try {
        const childGoal = await stateManager.loadGoal(childId);
        if (childGoal) childTitle = childGoal.title;
        else childTitle = "(unknown)";
      } catch {
        // keep fallback title
      }
      console.log(`  - ${shortId}... — ${childTitle}`);
    }
  }

  return 0;
}

export async function cmdLog(stateManager: StateManager, goalId: string): Promise<number> {
  const observationLog = await stateManager.loadObservationLog(goalId);
  const gapHistory = await stateManager.loadGapHistory(goalId);

  if ((!observationLog || observationLog.entries.length === 0) && gapHistory.length === 0) {
    console.log(`No logs found for goal ${goalId}`);
    return 0;
  }

  if (observationLog && observationLog.entries.length > 0) {
    console.log(`# Observation Log (${observationLog.entries.length} entries, newest first)\n`);
    const sorted = [...observationLog.entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const entry of sorted) {
      console.log(`[${entry.timestamp}]`);
      console.log(`  Dimension:  ${entry.dimension_name}`);
      console.log(`  Confidence: ${(entry.confidence * 100).toFixed(1)}%`);
      console.log(`  Layer:      ${entry.layer}`);
      console.log(`  Trigger:    ${entry.trigger}`);
      console.log();
    }
  }

  if (gapHistory.length > 0) {
    console.log(`# Gap History (${gapHistory.length} entries, newest first)\n`);
    const sorted = [...gapHistory].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const entry of sorted) {
      const avgGap =
        entry.gap_vector.length > 0
          ? entry.gap_vector.reduce((sum, g) => sum + g.normalized_weighted_gap, 0) /
            entry.gap_vector.length
          : 0;
      console.log(`[${entry.timestamp}]`);
      console.log(`  Iteration: ${entry.iteration}`);
      console.log(`  Avg gap:   ${avgGap.toFixed(4)} (across ${entry.gap_vector.length} dimension(s))`);
      console.log();
    }
  }

  return 0;
}
