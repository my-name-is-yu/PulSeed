import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { StrategyDreamStateStore } from "../../../runtime/store/strategy-dream-state-store.js";

export async function countGoalDirs(baseDir: string, tier: "light" | "deep"): Promise<number> {
  const goalsDir = path.join(baseDir, "goals");
  const entries = await fsp.readdir(goalsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).length * (tier === "deep" ? 1 : 1);
}

export async function countGoalPairs(baseDir: string): Promise<number> {
  const count = await countGoalDirs(baseDir, "deep");
  return count < 2 ? 0 : (count * (count - 1)) / 2;
}

export async function countLearnedPatterns(baseDir: string): Promise<number> {
  const learningDir = path.join(baseDir, "learning");
  const files = await fsp.readdir(learningDir).catch(() => [] as string[]);
  let total = 0;
  for (const fileName of files.filter((file) => file.endsWith("_patterns.json"))) {
    const raw = await readJsonFileOrNull(path.join(learningDir, fileName));
    if (Array.isArray(raw)) {
      total += raw.length;
    }
  }
  return total;
}

export async function collectBacklogMetrics(baseDir: string): Promise<{
  iteration_lines_pending: number;
  event_lines_pending: number;
  importance_entries_pending: number;
}> {
  const store = new StrategyDreamStateStore(baseDir);
  const watermarks = await store.loadWatermarks();
  let iterationLinesPending = 0;
  for (const goalId of await store.listDreamGoalIds()) {
    const total = await store.countIterationLogs(goalId);
    const lastProcessed = watermarks.goals[goalId]?.lastProcessedLine ?? 0;
    iterationLinesPending += Math.max(0, total - Math.min(lastProcessed, total));
  }

  let eventLinesPending = 0;
  const eventCounts = new Map<string, number>();
  for (const row of await store.listEventLogs()) {
    eventCounts.set(row.fileName, (eventCounts.get(row.fileName) ?? 0) + 1);
  }
  for (const [fileName, total] of eventCounts) {
    const lastProcessed = watermarks.goals[`event:${fileName}`]?.lastProcessedLine ?? 0;
    eventLinesPending += Math.max(0, total - Math.min(lastProcessed, total));
  }

  const importanceLines = (await store.listImportanceEntries()).length;
  const importanceProcessed = watermarks.importanceBuffer.lastProcessedLine ?? 0;
  const importanceEntriesPending = Math.max(0, importanceLines - Math.min(importanceProcessed, importanceLines));

  return {
    iteration_lines_pending: iterationLinesPending,
    event_lines_pending: eventLinesPending,
    importance_entries_pending: importanceEntriesPending,
  };
}

export async function countFileLines(filePath: string): Promise<number> {
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export async function countFilesNamed(root: string, fileName: string): Promise<number> {
  if (fileName === "iteration-logs.jsonl") {
    return (await new StrategyDreamStateStore(root).listDreamGoalIds()).length;
  }
  if (fileName === "strategy-history.json") {
    return new StrategyDreamStateStore(root).countStrategyHistoryGoals();
  }
  let count = 0;
  for await (const filePath of walk(root)) {
    if (path.basename(filePath) === fileName) {
      count += 1;
    }
  }
  return count;
}

export async function countJsonFiles(root: string): Promise<number> {
  let count = 0;
  for await (const filePath of walk(root)) {
    if (filePath.endsWith(".json")) {
      count += 1;
    }
  }
  return count;
}

export async function countJsonlLines(baseDir: string, relativePath: string): Promise<number> {
  if (relativePath.replace(/\\/g, "/") === "dream/session-logs.jsonl") {
    return (await new StrategyDreamStateStore(baseDir).listSessionLogs()).length;
  }
  return countFileLines(path.join(baseDir, relativePath));
}

export async function countAgentMemoryEntries(baseDir: string): Promise<number> {
  const filePath = path.join(baseDir, "memory", "agent-memory", "entries.json");
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { entries?: unknown[] };
  return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
}

export async function countEventLines(baseDir: string, eventType: string): Promise<number> {
  const rows = await new StrategyDreamStateStore(baseDir).listEventLogs();
  return rows.filter((row) => row.event.eventType === eventType).length;
}

export async function countTrustDomains(baseDir: string): Promise<number> {
  const filePath = path.join(baseDir, "trust", "trust-store.json");
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { balances?: Record<string, unknown> };
  return parsed.balances ? Object.keys(parsed.balances).length : 0;
}

export async function countVerificationArtifacts(baseDir: string): Promise<number> {
  const verificationDir = path.join(baseDir, "verification");
  let count = 0;
  for await (const _ of walk(verificationDir)) {
    count += 1;
  }
  return count;
}

export async function *walk(root: string): AsyncGenerator<string> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}
