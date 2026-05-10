import type { Logger } from "../../runtime/logger.js";
import { GoalSchema } from "../types/goal.js";
import { GapHistoryEntrySchema } from "../types/gap.js";
import { ObservationLogEntrySchema, ObservationLogSchema } from "../types/state.js";
import { GoalTaskStateStore } from "../../runtime/store/goal-task-state-store.js";
import { replayWAL } from "./legacy-state-wal.js";
import type { WALIntent } from "./legacy-state-wal.js";

export interface StateManagerLegacyWALRecoveryOptions {
  baseDir: string;
  logger?: Logger;
  listGoalIds: () => Promise<string[]>;
  goalTaskStateStore?: GoalTaskStateStore;
}

export async function recoverStateManagerLegacyWAL(
  options: StateManagerLegacyWALRecoveryOptions,
): Promise<void> {
  const { baseDir, logger, listGoalIds } = options;
  let goalIds: string[];
  try {
    goalIds = await listGoalIds();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const store = options.goalTaskStateStore ?? new GoalTaskStateStore(baseDir);
  await store.ensureReady();

  for (const goalId of goalIds) {
    const replayed = await replayWAL(goalId, baseDir, async (intent) => {
      await replayStateManagerLegacyWALIntent(store, intent, logger);
    });
    if (replayed > 0) {
      logger?.info(`[StateManager] Imported ${replayed} legacy WAL entries for goal ${goalId}`);
    }
  }
}

/** Map a legacy WAL intent into the typed goal/task store. */
export async function replayStateManagerLegacyWALIntent(
  store: GoalTaskStateStore,
  intent: WALIntent,
  logger?: Logger,
): Promise<void> {
  const data = asRecord(intent.data);
  switch (intent.op) {
    case "save_goal": {
      if (data) await store.saveGoal(GoalSchema.parse(data));
      break;
    }
    case "save_observation": {
      if (data) await store.saveObservationLog(ObservationLogSchema.parse(data));
      break;
    }
    case "append_observation": {
      if (!data) break;
      if (Array.isArray(data["entries"])) {
        await store.saveObservationLog(ObservationLogSchema.parse(data));
        break;
      }
      const entry = ObservationLogEntrySchema.parse(data);
      await store.appendObservation(entry.goal_id, entry, 500);
      break;
    }
    case "append_observation_and_save_goal": {
      if (!data) break;
      const goal = asRecord(data["goal"]);
      const observationLog = data["observationLog"];
      if (goal && observationLog) {
        await store.saveObservationLog(ObservationLogSchema.parse(observationLog));
        await store.saveGoal(GoalSchema.parse(goal));
      }
      break;
    }
    case "save_gap_history":
    case "append_gap_entry": {
      if (!data) break;
      const goalId = typeof data["goalId"] === "string" ? data["goalId"] : null;
      const entries = Array.isArray(data["entries"]) ? data["entries"] : null;
      if (goalId && entries) {
        await store.saveGapHistory(goalId, entries.map((entry) => GapHistoryEntrySchema.parse(entry)));
      }
      break;
    }
    case "save_pace_snapshot": {
      if (data) await store.saveGoal(GoalSchema.parse(data));
      break;
    }
    case "write_raw": {
      if (!data) break;
      const relativePath = typeof data["path"] === "string" ? data["path"] : null;
      const payload = data["payload"];
      if (relativePath && payload !== undefined) {
        const handled = await store.writeRawPath(relativePath, payload);
        if (!handled) {
          logger?.warn(`[StateManager] Legacy WAL write_raw ignored unsupported path: ${relativePath}`);
        }
      }
      break;
    }
    default:
      logger?.warn(`[StateManager] Unknown legacy WAL intent op: ${intent.op}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
