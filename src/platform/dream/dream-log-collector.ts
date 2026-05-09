import { randomUUID } from "node:crypto";
import type { Logger } from "../../runtime/logger.js";
import { StrategyDreamStateStore } from "../../runtime/store/strategy-dream-state-store.js";
import type { LoopIterationResult, LoopResult } from "../../orchestrator/loop/loop-result-types.js";
import type { DriveScore } from "../../base/types/drive.js";
import {
  EventLogSchema,
  ImportanceEntrySchema,
  IterationLogSchema,
  SessionLogSchema,
  WatermarkStateSchema,
  type DreamLogCollectionConfig,
  type DreamRotationMode,
  type EventLog,
  type ImportanceEntry,
  type IterationLog,
  type SessionLog,
  type WatermarkState,
} from "./dream-types.js";

export interface DreamCollectorConfig {
  enabled?: boolean;
  iterationLoggingEnabled?: boolean;
  sessionSummariesEnabled?: boolean;
  eventPersistenceEnabled?: boolean;
  maxFileSizeBytes?: number;
  pruneTargetRatio?: number;
  rotationMode?: DreamRotationMode;
  watermarkBehavior?: DreamLogCollectionConfig["watermarkBehavior"];
  importanceThreshold?: number;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PRUNE_TARGET_RATIO = 0.8;
const DEFAULT_IMPORTANCE_THRESHOLD = 0.5;

type QueueTask<T> = () => Promise<T>;

/**
 * Best-effort append-only collector for Dream Mode Phase 1.
 *
 * Dream runtime state is owned by the control database. Rotation knobs are kept
 * in the public config contract for legacy callers, but append/prune file
 * behavior now belongs only to explicit migration/import paths.
 */
export class DreamLogCollector {
  private readonly logger?: Logger;
  private readonly config: Required<DreamCollectorConfig>;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly stateStore: StrategyDreamStateStore;

  constructor(baseDir: string, logger?: Logger, config: DreamCollectorConfig = {}) {
    this.logger = logger;
    this.config = {
      enabled: config.enabled ?? true,
      iterationLoggingEnabled: config.iterationLoggingEnabled ?? true,
      sessionSummariesEnabled: config.sessionSummariesEnabled ?? true,
      eventPersistenceEnabled: config.eventPersistenceEnabled ?? true,
      maxFileSizeBytes: config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
      pruneTargetRatio: config.pruneTargetRatio ?? DEFAULT_PRUNE_TARGET_RATIO,
      rotationMode: config.rotationMode ?? "size",
      watermarkBehavior: config.watermarkBehavior ?? "readwrite",
      importanceThreshold: config.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD,
    };
    this.stateStore = new StrategyDreamStateStore(baseDir);
  }

  async appendIterationLog(entry: IterationLog): Promise<void> {
    if (!this.config.enabled || !this.config.iterationLoggingEnabled) return;
    const parsed = IterationLogSchema.parse(entry);
    await this.stateStore.appendIterationLog(parsed);
  }

  async appendSessionLog(entry: SessionLog): Promise<void> {
    if (!this.config.enabled || !this.config.sessionSummariesEnabled) return;
    const parsed = SessionLogSchema.parse(entry);
    await this.stateStore.appendSessionLog(parsed);
  }

  async appendEventLog(entry: EventLog): Promise<void> {
    if (!this.config.enabled || !this.config.eventPersistenceEnabled) return;
    const parsed = EventLogSchema.parse(entry);
    await this.stateStore.appendEventLog(parsed);
  }

  async appendImportanceEntry(entry: ImportanceEntry, options?: { force?: boolean }): Promise<boolean> {
    const parsed = ImportanceEntrySchema.parse(entry);
    if (!options?.force && parsed.importance < this.config.importanceThreshold) {
      return false;
    }
    await this.stateStore.appendImportanceEntry(parsed);
    return true;
  }

  async loadWatermarks(): Promise<WatermarkState> {
    return this.stateStore.loadWatermarks();
  }

  async saveWatermarks(state: WatermarkState): Promise<void> {
    if (this.config.watermarkBehavior === "readonly") {
      return;
    }
    const parsed = WatermarkStateSchema.parse(state);
    await this.withQueue("watermarks", async () => {
      await this.stateStore.saveWatermarks(parsed);
    });
  }

  async markGoalProcessed(goalId: string, lastProcessedLine: number, lastProcessedTimestamp?: string): Promise<void> {
    const state = await this.loadWatermarks();
    state.goals[goalId] = {
      lastProcessedLine,
      ...(lastProcessedTimestamp ? { lastProcessedTimestamp } : {}),
    };
    await this.saveWatermarks(state);
  }

  async markImportanceProcessed(lastProcessedLine: number, lastProcessedTimestamp?: string): Promise<void> {
    const state = await this.loadWatermarks();
    state.importanceBuffer = {
      lastProcessedLine,
      ...(lastProcessedTimestamp ? { lastProcessedTimestamp } : {}),
    };
    await this.saveWatermarks(state);
  }

  async updateImportanceWatermark(lastProcessedLine: number, lastProcessedTimestamp?: string): Promise<void> {
    await this.markImportanceProcessed(lastProcessedLine, lastProcessedTimestamp);
  }

  async markImportanceCursorProcessed(cursor: {
    lastProcessedLine: number;
    lastProcessedTimestamp?: string;
    lastProcessedId?: string;
  }): Promise<void> {
    const state = await this.loadWatermarks();
    state.importanceBuffer = {
      lastProcessedLine: cursor.lastProcessedLine,
      ...(cursor.lastProcessedTimestamp ? { lastProcessedTimestamp: cursor.lastProcessedTimestamp } : {}),
      ...(cursor.lastProcessedId ? { lastProcessedId: cursor.lastProcessedId } : {}),
    };
    await this.saveWatermarks(state);
  }

  buildSessionId(goalId: string, startedAt: string): string {
    return `${goalId}:${startedAt}`;
  }

  async appendIterationResult(params: {
    goalId: string;
    sessionId: string;
    iterationResult: LoopIterationResult;
    timestamp?: string;
  }): Promise<void> {
    const { goalId, sessionId, iterationResult, timestamp } = params;
    await this.appendIterationLog({
      entryId: randomUUID(),
      timestamp: timestamp ?? new Date().toISOString(),
      goalId,
      iteration: iterationResult.loopIndex,
      sessionId,
      gapAggregate: iterationResult.gapAggregate,
      driveScores: this.toDriveScores(iterationResult.driveScores),
      taskId: iterationResult.taskResult?.task.id ?? null,
      taskAction: iterationResult.taskResult?.action ?? null,
      strategyId: iterationResult.taskResult?.task.strategy_id ?? null,
      verificationResult: iterationResult.taskResult
        ? {
            verdict: iterationResult.taskResult.verificationResult.verdict,
            confidence: iterationResult.taskResult.verificationResult.confidence,
            timestamp: iterationResult.taskResult.verificationResult.timestamp,
          }
        : null,
      stallDetected: iterationResult.stallDetected,
      stallSeverity: iterationResult.stallReport?.escalation_level ?? null,
      tokensUsed: iterationResult.tokensUsed ?? iterationResult.taskResult?.tokensUsed ?? null,
      elapsedMs: iterationResult.elapsedMs,
      skipped: iterationResult.skipped ?? false,
      skipReason: iterationResult.skipReason ?? null,
      completionJudgment: iterationResult.completionJudgment,
      waitSuppressed: iterationResult.waitSuppressed ?? false,
    });
  }

  async appendSessionSummary(params: {
    goalId: string;
    sessionId: string;
    completedAt: string;
    finalStatus: LoopResult["finalStatus"];
    iterations: LoopIterationResult[];
    totalTokensUsed: number;
  }): Promise<void> {
    const { goalId, sessionId, completedAt, finalStatus, iterations, totalTokensUsed } = params;
    const strategiesUsed = Array.from(
      new Set(
        iterations
          .map((iteration) => iteration.taskResult?.task.strategy_id)
          .filter((strategyId): strategyId is string => typeof strategyId === "string" && strategyId.length > 0)
      )
    );
    await this.appendSessionLog({
      timestamp: completedAt,
      goalId,
      sessionId,
      iterationCount: iterations.length,
      initialGapAggregate: iterations[0]?.gapAggregate ?? 0,
      finalGapAggregate: iterations[iterations.length - 1]?.gapAggregate ?? 0,
      totalTokensUsed,
      totalElapsedMs: iterations.reduce((sum, iteration) => sum + iteration.elapsedMs, 0),
      stallCount: iterations.filter((iteration) => iteration.stallDetected).length,
      outcome: finalStatus,
      strategiesUsed,
    });
  }

  private toDriveScores(driveScores: DriveScore[]): IterationLog["driveScores"] {
    if (driveScores.length === 0) return undefined;
    return driveScores.map((score) => ({
      dimensionName: score.dimension_name,
      score: score.final_score,
    }));
  }

  private async withQueue<T>(key: string, task: QueueTask<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task, task);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}
