import type { MemoryDataType } from "../../../base/types/memory-lifecycle.js";
import { MemoryLifecycleStateStore } from "./memory-lifecycle-state-store.js";
import type { MemoryCompressionDeps } from "./memory-compression.js";
import { compressAllRemainingToLongTerm as _compressAllRemainingToLongTerm } from "./memory-compression.js";

const DATA_TYPES: MemoryDataType[] = [
  "experience_log",
  "observation",
  "strategy",
  "task",
  "knowledge",
];

export async function initializeMemoryDirectories(memoryDir: string): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).initialize();
}

export async function archiveGoalMemory(
  memoryDir: string,
  compressionDeps: MemoryCompressionDeps,
  goalId: string,
  reason: "completed" | "cancelled"
): Promise<void> {
  const store = new MemoryLifecycleStateStore(memoryDir);
  for (const dataType of DATA_TYPES) {
    const entries = await store.loadShortTermEntries(goalId, dataType);
    if (entries.length === 0) continue;
    try {
      await _compressAllRemainingToLongTerm(compressionDeps, goalId, dataType, entries);
    } catch {
      // Best-effort on close.
    }
  }
  await store.archiveGoal(goalId, reason);
}
