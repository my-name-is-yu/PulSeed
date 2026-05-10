import type { LessonEntry } from "../../../base/types/memory-lifecycle.js";
import { MemoryLifecycleStateStore } from "./memory-lifecycle-state-store.js";

export async function queryLessons(
  memoryDir: string,
  tags: string[],
  dimensions: string[],
  maxCount: number
): Promise<LessonEntry[]> {
  return new MemoryLifecycleStateStore(memoryDir).queryLessons(tags, dimensions, maxCount);
}

export async function queryCrossGoalLessons(
  memoryDir: string,
  tags: string[],
  dimensions: string[],
  excludeGoalId: string,
  maxCount: number
): Promise<LessonEntry[]> {
  return new MemoryLifecycleStateStore(memoryDir).queryCrossGoalLessons(tags, dimensions, excludeGoalId, maxCount);
}
