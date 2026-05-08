import type { RecognizedIntent } from "./intent-recognizer.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { ReportingEngine } from "../../reporting/reporting-engine.js";
import type { Report } from "../../base/types/report.js";

// ─── Types ───

export interface ActionDeps {
  stateManager: StateManager;
  goalNegotiator: GoalNegotiator;
  reportingEngine: ReportingEngine;
}

export interface ActionResult {
  messages: string[]; // lines to display in chat
  messageType?: "info" | "error" | "warning" | "success"; // type for all messages in this result
  startLoop?: { goalId: string }; // signal to start the loop
  stopLoop?: boolean; // signal to stop the loop
  showHelp?: boolean; // signal to open the help overlay
  showReport?: Report; // signal to open the report overlay
  toggleDashboard?: "toggle"; // signal to toggle the dashboard overlay
}

export interface RunnableGoalOption {
  id: string;
  title: string;
}

const START_INDEX_TOKEN = /^[1-9][0-9]*$/;

function parseStartGoalIndex(value: string): number | null {
  const normalized = value.trim();
  if (!START_INDEX_TOKEN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function listRunnableStartGoals(stateManager: StateManager): Promise<RunnableGoalOption[]> {
  const ids = await stateManager.listGoalIds();
  const runnableGoals: RunnableGoalOption[] = [];
  for (const id of ids) {
    const goal = await stateManager.loadGoal(id);
    if (goal && (goal.status === "active" || goal.status === "waiting")) {
      runnableGoals.push({ id, title: goal.title ?? id });
    }
  }
  return runnableGoals;
}

export function selectRunnableStartGoal(
  runnableGoals: RunnableGoalOption[],
  goalArg: string
): RunnableGoalOption | undefined {
  const num = parseStartGoalIndex(goalArg);
  if (num !== null && num <= runnableGoals.length) {
    return runnableGoals[num - 1];
  }
  return runnableGoals.find((g) => g.id === goalArg);
}

// ─── ActionHandler ───

/**
 * Executes recognized intents against PulSeed modules.
 * Each handler maps an IntentType to a concrete operation.
 */
export class ActionHandler {
  constructor(private deps: ActionDeps) {}

  async handle(intent: RecognizedIntent): Promise<ActionResult> {
    switch (intent.intent) {
      case "loop_start":
        return this.handleStart(intent);
      case "loop_stop":
        return this.handleStop();
      case "status":
        return this.handleStatus();
      case "report":
        return this.handleReport();
      case "goal_list":
        return this.handleGoalList();
      case "goal_create":
        return this.handleGoalCreate(intent);
      case "help":
        return this.handleHelp();
      case "dashboard":
        return { messages: ["Dashboard toggled."], toggleDashboard: "toggle" };
      case "chat":
        return this.handleChat(intent);
      case "unknown":
        return {
          messages: [
            "I didn't understand that. Type 'help' to see available commands.",
          ],
        };
    }
  }

  // ─── Handlers ───

  private async handleStart(intent: RecognizedIntent): Promise<ActionResult> {
    // Use explicit goalId from params if provided
    const explicitGoalId = intent.params?.["goalId"] ?? null;
    const goalArg = intent.params?.["goalArg"] ?? null;

    if (explicitGoalId) {
      const goal = await this.deps.stateManager.loadGoal(explicitGoalId);
      if (!goal || (goal.status !== "active" && goal.status !== "waiting")) {
        return {
          messages: [`No runnable goal found for ID "${explicitGoalId}".`],
          messageType: "warning",
        };
      }
      const label = goal?.title ?? explicitGoalId;
      return { messages: [`Starting loop: ${label}`], startLoop: { goalId: explicitGoalId } };
    }

    const runnableGoals = await listRunnableStartGoals(this.deps.stateManager);

    if (runnableGoals.length === 0) {
      return {
        messages: [
          "No runnable goal found. Create a goal first.",
          'Example: "write a README" or "goal create write README"',
        ],
      };
    }

    // If a goal argument was provided, match by number (1-indexed) or exact ID.
    if (goalArg) {
      const matched = selectRunnableStartGoal(runnableGoals, goalArg);

      if (!matched) {
        const list = runnableGoals.map((g, i) => `  ${i + 1}. ${g.title} (ID: ${g.id})`).join("\n");
        return {
          messages: [
            `No goal matching "${goalArg}". Available goals:`,
            list,
            "Use /start <number> or /start <goal-id>.",
          ],
          messageType: "warning",
        };
      }

      return { messages: [`Starting loop: ${matched.title}`], startLoop: { goalId: matched.id } };
    }

    // No argument: if exactly one goal, start it; otherwise list and ask
    if (runnableGoals.length === 1) {
      const { id, title } = runnableGoals[0];
      return { messages: [`Starting loop: ${title}`], startLoop: { goalId: id } };
    }

    const list = runnableGoals.map((g, i) => `  ${i + 1}. ${g.title}`).join("\n");
    return {
      messages: [
        "Multiple goals available. Specify which one to start:",
        list,
        "Use /start <number> or /start <goal-id>.",
      ],
    };
  }

  private handleStop(): ActionResult {
    return {
      messages: ["Loop stopped."],
      stopLoop: true,
    };
  }

  private async handleStatus(): Promise<ActionResult> {
    const ids = await this.deps.stateManager.listGoalIds();

    if (ids.length === 0) {
      return { messages: ["No active goals."] };
    }

    const messages: string[] = [];

    for (const id of ids) {
      const goal = await this.deps.stateManager.loadGoal(id);
      if (!goal) continue;

      messages.push(`\n--- Goal: ${goal.title ?? id} ---`);
      messages.push(`Status: ${goal.status}`);

      if (goal.dimensions.length === 0) {
        messages.push("(no dimensions)");
        continue;
      }

      messages.push("Dimensions:");
      for (const dim of goal.dimensions) {
        const current =
          dim.current_value !== null && dim.current_value !== undefined
            ? String(dim.current_value)
            : "not measured";
        const isCountType =
          dim.threshold.type === "min" || dim.threshold.type === "max";
        const pct =
          typeof dim.current_value === "number" && !isCountType
            ? ` (${(dim.current_value * 100).toFixed(1)}%)`
            : "";
        const conf = `confidence: ${(dim.confidence * 100).toFixed(0)}%`;
        messages.push(`  - ${dim.label ?? dim.name}: ${current}${pct} [${conf}]`);
      }
    }

    return { messages };
  }

  private async handleReport(): Promise<ActionResult> {
    const ids = await this.deps.stateManager.listGoalIds();

    if (ids.length === 0) {
      return { messages: ["No goals to generate a report for."] };
    }

    // Generate report for the first available goal and show it in the report overlay
    const id = ids[0];
    try {
      const report = await this.deps.reportingEngine.generateDailySummary(id);
      await this.deps.reportingEngine.saveReport(report);
      return { messages: [], showReport: report };
    } catch (err) {
      return {
        messages: [
          `Failed to generate report for goal ${id}: ${err instanceof Error ? err.message : String(err)}`,
        ],
        messageType: "error",
      };
    }
  }

  private async handleGoalList(): Promise<ActionResult> {
    const ids = await this.deps.stateManager.listGoalIds();

    if (ids.length === 0) {
      return {
        messages: [
          "No goals yet.",
          'To create a new goal, type something like: "write a README".',
        ],
      };
    }

    const messages: string[] = ["Registered goals:"];

    for (const id of ids) {
      const goal = await this.deps.stateManager.loadGoal(id);
      if (!goal) continue;
      const deadline = goal.deadline ? ` (deadline: ${goal.deadline})` : "";
      messages.push(`  [${goal.status}] ${goal.title ?? id}${deadline}`);
      messages.push(`    ID: ${id}`);
    }

    return { messages };
  }

  private async handleGoalCreate(
    intent: RecognizedIntent
  ): Promise<ActionResult> {
    const description = intent.params?.["description"] ?? intent.raw;

    if (!description.trim()) {
      return {
        messages: [
          'A goal description is required. Example: "write a README"',
        ],
      };
    }

    try {
      const result = await this.deps.goalNegotiator.negotiate(description);
      const { goal, response } = result;

      const messages: string[] = [
        `Goal created: ${goal.title}`,
        `ID: ${goal.id}`,
        `Dimensions: ${goal.dimensions.length}`,
        `Evaluation: ${response.type}`,
      ];

      if (response.type === "counter_propose" && response.counter_proposal) {
        messages.push(
          `Counter-proposal: ${response.counter_proposal.reasoning}`
        );
      }

      if (response.message) {
        messages.push(`Message: ${response.message}`);
      }

      return { messages };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : String(err);
      return {
        messages: [`Failed to create goal: ${errorMsg}`],
        messageType: "error",
      };
    }
  }

  private handleHelp(): ActionResult {
    return {
      messages: [],
      showHelp: true,
    };
  }

  private handleChat(intent: RecognizedIntent): ActionResult {
    return {
      messages: [
        intent.params?.["response"] ?? intent.response ?? "I'm not sure how to help with that.",
      ],
    };
  }
}
