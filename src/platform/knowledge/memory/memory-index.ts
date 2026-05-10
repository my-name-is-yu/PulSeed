import type {
  LessonEntry,
  MemoryIndex,
  MemoryIndexEntry,
  ShortTermEntry,
} from "../../../base/types/memory-lifecycle.js";
import { MemoryLifecycleStateStore } from "./memory-lifecycle-state-store.js";

export async function initializeIndex(memoryDir: string, layer: "short-term" | "long-term"): Promise<void> {
  void layer;
  await new MemoryLifecycleStateStore(memoryDir).initialize();
}

export async function loadIndex(memoryDir: string, layer: "short-term" | "long-term"): Promise<MemoryIndex> {
  return new MemoryLifecycleStateStore(memoryDir).loadIndex(layer);
}

export async function saveIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  index: MemoryIndex
): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).saveIndex(layer, index);
}

export async function updateIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entry: MemoryIndexEntry
): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).updateIndex(layer, entry);
}

export async function removeFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entryIds: Set<string>
): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).removeFromIndex(layer, entryIds);
}

export async function removeGoalFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  goalId: string
): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).removeGoalFromIndex(layer, goalId);
}

export async function touchIndexEntry(
  memoryDir: string,
  layer: "short-term" | "long-term",
  indexId: string
): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).touchIndexEntry(layer, indexId);
}

export async function archiveOldestLongTermEntries(memoryDir: string): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).archiveOldestLongTermEntries();
}

export async function storeLessonsLongTerm(
  memoryDir: string,
  goalId: string,
  lessons: LessonEntry[],
  sourceEntries: ShortTermEntry[]
): Promise<void> {
  await new MemoryLifecycleStateStore(memoryDir).storeLessonsLongTerm(goalId, lessons, sourceEntries);
}
