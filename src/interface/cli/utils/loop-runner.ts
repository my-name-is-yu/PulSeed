// ─── Shared loop utilities for CLI commands ───

import { getLogsDir } from "../../../base/utils/paths.js";
import { Logger } from "../../../runtime/logger.js";
import type { DurableLoop, LoopResult, ProgressEvent } from "../../../orchestrator/loop/durable-loop.js";
import type { Task } from "../../../base/types/task.js";

export function buildAutoApprovalFn(): (task: Task) => Promise<boolean> {
  return async (task: Task): Promise<boolean> => {
    console.log(`\n--- Auto-approved (--yes) ---`);
    console.log(`Task: ${task.work_description.split("\n")[0]}`);
    return true;
  };
}

export function buildLoopLogger(): Logger {
  return new Logger({
    dir: getLogsDir(),
    level: "debug",
    consoleOutput: false,
  });
}

export function buildProgressHandler(): (event: ProgressEvent) => void {
  let lastIterationLogged = -1;
  return (event: ProgressEvent): void => {
    const limit = event.maxIterations === null ? "resident" : String(event.maxIterations);
    const prefix = `[${event.iteration}/${limit}]`;
    if (event.phase === "Observing...") {
      if (event.iteration !== lastIterationLogged) {
        lastIterationLogged = event.iteration;
        const gapStr = event.gap !== undefined ? ` gap=${formatProgressGap(event.gap)}` : "";
        process.stdout.write(`${prefix} Observing...${gapStr}\n`);
      }
    } else if (event.phase === "Generating task...") {
      const gapStr = event.gap !== undefined ? ` gap=${formatProgressGap(event.gap)}` : "";
      const confStr = event.confidence !== undefined ? ` confidence=${Math.round(event.confidence * 100)}%` : "";
      process.stdout.write(`${prefix} Generating task...${gapStr}${confStr}\n`);
    } else if (event.phase === "Skipped") {
      const reason = event.skipReason ?? "unknown";
      process.stdout.write(`${prefix} Skipped — ${reason.replace(/_/g, " ")}\n`);
    } else if (event.phase === "Executing task...") {
      if (event.taskDescription) {
        process.stdout.write(`${prefix} Executing task: "${event.taskDescription}"\n`);
      } else {
        process.stdout.write(`${prefix} Executing task...\n`);
      }
    } else if (event.phase === "Verifying result...") {
      if (event.taskDescription) {
        process.stdout.write(`${prefix} Verifying: "${event.taskDescription}"\n`);
      } else {
        process.stdout.write(`${prefix} Verifying result...\n`);
      }
    } else if (event.phase === "Skipped (no state change)") {
      process.stdout.write(`${prefix} Skipped (no state change detected)\n`);
    }
  };
}

export function formatProgressGap(gap: number): string {
  if (!Number.isFinite(gap)) return String(gap);
  if (gap > 0 && gap < 0.01) return "<0.01";
  return gap.toFixed(2);
}

export async function runLoopWithSignals(
  durableLoop: DurableLoop,
  goalId: string
): Promise<LoopResult> {
  const controller = new AbortController();
  const shutdown = () => {
    console.log("\nStopping loop...");
    durableLoop.stop();
    controller.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    return await durableLoop.run(goalId, { abortSignal: controller.signal });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
