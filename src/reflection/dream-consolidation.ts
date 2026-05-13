import type { StateManager } from "../base/state/state-manager.js";
import type { MemoryLifecycleManager } from "../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../platform/knowledge/knowledge-manager.js";
import type { ConsolidationReport } from "./types.js";
import { ConsolidationReportSchema } from "./types.js";
import { saveReflectionReport } from "./reflection-utils.js";
import {
  createReflectionInputFromCognitionReplay,
  type CognitionReplayRecord,
} from "../runtime/cognition/index.js";
import { evaluateCognitionWritebackReflectionInput } from "./cognition-writeback-evaluator.js";
import {
  FileCognitionWritebackQueueStore,
  type CognitionWritebackQueueStore,
} from "./cognition-writeback-queue.js";

// ─── Helpers ───

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Main ───

export async function runDreamConsolidation(deps: {
  stateManager: StateManager;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  cognitionReplayRecords?: CognitionReplayRecord[];
  cognitionWritebackQueue?: CognitionWritebackQueueStore;
  baseDir: string;
}): Promise<ConsolidationReport> {
  const {
    stateManager,
    memoryLifecycle,
    knowledgeManager,
    cognitionReplayRecords = [],
    cognitionWritebackQueue = new FileCognitionWritebackQueueStore(deps.baseDir),
    baseDir,
  } = deps;
  const date = todayISO();
  const now = new Date().toISOString();

  const goalIds = await stateManager.listGoalIds();
  let entriesCompressed = 0;
  let staleEntriesFound = 0;
  let revalidationTasksCreated = 0;

  // Compress short-term memory to long-term for each goal
  const dataTypes = ["experience_log", "observation", "strategy", "task", "knowledge"] as const;
  if (memoryLifecycle) {
    for (const goalId of goalIds) {
      for (const dataType of dataTypes) {
        try {
          const result = await memoryLifecycle.compressToLongTerm(goalId, dataType);
          entriesCompressed += result.entries_compressed ?? 0;
        } catch {
          // Continue with other goals/types if one fails
        }
      }
    }
  }

  // Check for stale knowledge entries and generate revalidation tasks
  if (knowledgeManager) {
    try {
      const staleEntries = await knowledgeManager.getStaleEntries();
      staleEntriesFound = staleEntries.length;

      if (staleEntries.length > 0) {
        const tasks = await knowledgeManager.generateRevalidationTasks(staleEntries);
        revalidationTasksCreated = tasks.length;
      }
    } catch {
      // Non-fatal — continue
    }
  }
  const cognitionReflectionInputs = cognitionReplayRecords.flatMap((record) => {
    try {
      return [createReflectionInputFromCognitionReplay({
        inputId: `reflection-input:${record.cognition_id}`,
        record,
      })];
    } catch {
      return [];
    }
  });
  const cognitionWritebackQueueEntries = cognitionReflectionInputs.flatMap((reflectionInput) =>
    evaluateCognitionWritebackReflectionInput({
      reflectionInput,
      evaluatedAt: now,
    })
  );
  for (const entry of cognitionWritebackQueueEntries) {
    await cognitionWritebackQueue.enqueue(entry);
  }

  const report = ConsolidationReportSchema.parse({
    date,
    created_at: now,
    goals_consolidated: goalIds.length,
    entries_compressed: entriesCompressed,
    stale_entries_found: staleEntriesFound,
    revalidation_tasks_created: revalidationTasksCreated,
    cognition_writeback_inputs_read: cognitionReflectionInputs.length,
    cognition_writeback_queue_entries_evaluated: cognitionWritebackQueueEntries.length,
    cognition_runtime_authority_granted: false,
    cognition_writeback_owner_writes_performed: false,
  });

  await saveReflectionReport(baseDir, "dream", date, report);

  return report;
}
