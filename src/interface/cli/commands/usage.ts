import { parseArgs } from "node:util";
import type { StateManager } from "../../../base/state/state-manager.js";
import {
  addUsageTokenCounts,
  normalizeUsageCounter,
  type UsageCounter,
} from "../../usage-counter.js";
import { parseUsagePeriodMs } from "../../usage-period.js";
import { ScheduleHistoryStore } from "../../../runtime/schedule/history.js";
import { GoalTaskStateStore } from "../../../runtime/store/goal-task-state-store.js";
import { ChatSessionDataStore } from "../../chat/chat-session-data-store.js";

async function collectGoalUsage(stateManager: StateManager, goalId: string): Promise<{
  goalId: string;
  totalTokens: number;
  taskCount: number;
  terminalTaskCount: number;
}> {
  let totalTokens = 0;
  let taskCount = 0;
  let terminalTaskCount = 0;
  const ledgers = (await new GoalTaskStateStore(stateManager.getBaseDir()).listTaskOutcomeLedgers())
    .filter((ledger) => ledger.goal_id === goalId);
  for (const ledger of ledgers) {
    taskCount += 1;
    totalTokens = addUsageTokenCounts(totalTokens, ledger.summary?.["tokens_used"]);
    if (
      ledger.summary?.["latest_event_type"] === "succeeded"
      || ledger.summary?.["latest_event_type"] === "failed"
      || ledger.summary?.["latest_event_type"] === "abandoned"
    ) {
      terminalTaskCount += 1;
    }
  }

  return { goalId, totalTokens, taskCount, terminalTaskCount };
}

async function collectScheduleUsage(stateManager: StateManager, period: string): Promise<{
  period: string;
  runs: number;
  totalTokens: number;
}> {
  const periodMs = parseUsagePeriodMs(period);
  const since = Date.now() - periodMs;
  const raw = await new ScheduleHistoryStore(stateManager.getBaseDir()).load();

  let runs = 0;
  let totalTokens = 0;
  for (const record of raw) {
    if (!record || typeof record !== "object") continue;
    const finishedAt = (record as Record<string, unknown>)["finished_at"];
    const firedAt = typeof finishedAt === "string" ? Date.parse(finishedAt) : Number.NaN;
    if (!Number.isFinite(firedAt) || firedAt < since) continue;
    runs += 1;
    totalTokens = addUsageTokenCounts(totalTokens, (record as Record<string, unknown>)["tokens_used"]);
  }

  return { period, runs, totalTokens };
}

async function readSessionUsage(stateManager: StateManager, sessionId: string): Promise<{
  sessionId: string;
  totals: UsageCounter;
  byPhase: Record<string, UsageCounter>;
}> {
  const session = await new ChatSessionDataStore(stateManager.getBaseDir()).load(sessionId);
  if (!session) {
    throw new Error(`chat session not found: ${sessionId}`);
  }
  const byPhase = Object.fromEntries(
    Object.entries(session.usage?.byPhase ?? {}).map(([phase, usage]) => [phase, normalizeUsageCounter(usage)])
  );
  return {
    sessionId,
    totals: normalizeUsageCounter(session.usage?.totals),
    byPhase,
  };
}

function printSessionSummary(summary: {
  sessionId: string;
  totals: UsageCounter;
  byPhase: Record<string, UsageCounter>;
}): void {
  console.log(`Usage summary (session ${summary.sessionId})`);
  console.log(`Session total tokens:  ${summary.totals.totalTokens}`);
  console.log(`Session input tokens:  ${summary.totals.inputTokens}`);
  console.log(`Session output tokens: ${summary.totals.outputTokens}`);
  const phaseEntries = Object.entries(summary.byPhase)
    .filter(([, usage]) => usage.totalTokens > 0)
    .sort((left, right) => right[1].totalTokens - left[1].totalTokens);
  if (phaseEntries.length === 0) return;
  console.log("");
  console.log("By phase:");
  for (const [phase, usage] of phaseEntries) {
    console.log(`- ${phase}: ${usage.totalTokens} (in=${usage.inputTokens}, out=${usage.outputTokens})`);
  }
}

function printUsageHelp(): void {
  console.log("Usage: pulseed usage <session|goal|daemon|schedule> [args]");
  console.log("  session <id>                     Show usage for one chat session");
  console.log("  goal <goal-id>                   Show usage from task ledgers for a goal");
  console.log("  daemon <goal-id>                 Alias of goal scope for daemon-triggered runs");
  console.log("  schedule [--period <7d|24h|2w>]  Show schedule token usage for a period");
}

export async function cmdUsage(stateManager: StateManager, argv: string[]): Promise<number> {
  const scope = argv[0]?.toLowerCase();

  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    printUsageHelp();
    return 0;
  }

  if (scope === "session") {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          session: { type: "string" },
        },
        strict: false,
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return 1;
    }
    const sessionId = String(parsed.values.session ?? parsed.positionals[0] ?? "");
    if (!sessionId) {
      console.error("Usage: pulseed usage session <session-id>");
      return 1;
    }
    try {
      const summary = await readSessionUsage(stateManager, sessionId);
      printSessionSummary(summary);
      return 0;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return 1;
    }
  }

  if (scope === "goal" || scope === "daemon") {
    const goalId = argv[1];
    if (!goalId) {
      console.error(`Usage: pulseed usage ${scope} <goal-id>`);
      return 1;
    }
    try {
      const summary = await collectGoalUsage(stateManager, goalId);
      console.log(`Usage summary (${scope} scope)`);
      console.log(`Goal: ${summary.goalId}`);
      console.log(`Tasks observed: ${summary.taskCount}`);
      console.log(`Terminal tasks: ${summary.terminalTaskCount}`);
      console.log(`Total tokens: ${summary.totalTokens}`);
      return 0;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return 1;
    }
  }

  if (scope === "schedule") {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          period: { type: "string", default: "7d" },
        },
        strict: false,
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return 1;
    }
    const period = String(parsed.values.period ?? parsed.positionals[0] ?? "7d");
    try {
      const summary = await collectScheduleUsage(stateManager, period);
      console.log(`Usage summary (schedule, ${summary.period})`);
      console.log(`Runs: ${summary.runs}`);
      console.log(`Total tokens: ${summary.totalTokens}`);
      return 0;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return 1;
    }
  }

  console.error("Unknown usage scope.");
  printUsageHelp();
  return 1;
}
