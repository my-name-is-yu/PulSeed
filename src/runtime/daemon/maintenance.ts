import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v3";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import type { DaemonConfig, DaemonState } from "../../base/types/daemon.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import {
  buildRelationshipProfileSurfaceProjection,
  formatRelationshipProfileSurfaceContext,
  loadRelationshipProfileSurfaceContext,
} from "../../grounding/profile-surface.js";
import {
  createSurfaceInspectionAdapterPayload,
  type SurfaceInspectionAdapterPayload,
} from "../../grounding/surface-contracts.js";
import type { DriveSystem, GoalActivationSnapshot } from "../../platform/drive/drive-system.js";
import { createEnvelope } from "../types/envelope.js";
import type { Envelope } from "../types/envelope.js";
import type { ScheduleEngine } from "../schedule/engine.js";
import type { Logger } from "../logger.js";
import { ApprovalStore, OutboxStore, RuntimeHealthStore, ProactiveInterventionStore, createRuntimeStorePaths } from "../store/index.js";
import type {
  GoalRunAdmissionTriggerKind,
  PersonalAgentRuntimeStore,
  RuntimeGraphRef,
} from "../personal-agent/index.js";
import { recordGoalRunAdmissionDecision } from "../personal-agent/index.js";

export interface RuntimeMaintenanceLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RuntimeStoreMaintenanceOptions {
  approvalRetentionMs?: number;
  outboxRetentionMs?: number;
  outboxMaxRecords?: number;
  claimRetentionMs?: number;
}

export interface RuntimeStoreMaintenanceReport {
  approvals: {
    removedPending: number;
    expiredPending: number;
    prunedResolved: number;
  };
  outbox: {
    pruned: number;
    retained: number;
  };
  health: {
    repaired: boolean;
    status: string | null;
  };
  claims: {
    pruned: number;
  };
}

const ProactiveResponseSchema = z.object({
  action: z.enum(["suggest_goal", "investigate", "preemptive_check", "sleep"]),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProactiveDecision = z.infer<typeof ProactiveResponseSchema>;

export interface ProactiveMaintenanceSurfaceSummary {
  surface_id: string;
  surface_included_count: number;
  surface_excluded_count: number;
  surface_inspection: SurfaceInspectionAdapterPayload;
}

export interface ProactiveMaintenanceResult {
  lastProactiveTickAt: number;
  decision: ProactiveDecision | null;
  surface?: ProactiveMaintenanceSurfaceSummary;
}

export type GoalCycleScheduleSnapshotEntry = GoalActivationSnapshot;

async function getGoalActivationSnapshotCompat(
  driveSystem: DriveSystem,
  goalId: string,
): Promise<GoalActivationSnapshot> {
  const candidate = driveSystem as DriveSystem & {
    getGoalActivationSnapshot?: (goalId: string) => Promise<GoalActivationSnapshot>;
  };

  if (typeof candidate.getGoalActivationSnapshot === "function") {
    return candidate.getGoalActivationSnapshot(goalId);
  }

  const [shouldActivate, schedule] = await Promise.all([
    driveSystem.shouldActivate(goalId),
    driveSystem.getSchedule(goalId),
  ]);
  return { goalId, shouldActivate, schedule };
}

export async function collectGoalCycleScheduleSnapshot(
  driveSystem: DriveSystem,
  goalIds: string[],
): Promise<GoalCycleScheduleSnapshotEntry[]> {
  const snapshot: GoalCycleScheduleSnapshotEntry[] = [];

  for (const goalId of goalIds) {
    snapshot.push(await getGoalActivationSnapshotCompat(driveSystem, goalId));
  }

  return snapshot;
}

export async function determineActiveGoalsForCycle(
  driveSystem: DriveSystem,
  goalIds: string[],
  snapshot: GoalCycleScheduleSnapshotEntry[] = [],
): Promise<string[]> {
  const eligibleIds: string[] = [];
  const scores = new Map<string, number>();
  const snapshotByGoalId = new Map(snapshot.map((entry) => [entry.goalId, entry]));

  for (const goalId of goalIds) {
    const entry =
      snapshotByGoalId.get(goalId)
      ?? await getGoalActivationSnapshotCompat(driveSystem, goalId);

    if (entry.shouldActivate) {
      eligibleIds.push(goalId);
      const nextCheckAt = entry.schedule ? new Date(entry.schedule.next_check_at).getTime() : 0;
      scores.set(goalId, -nextCheckAt);
    }
  }

  return driveSystem.prioritizeGoals(eligibleIds, scores);
}

export function getNextIntervalForGoals(config: DaemonConfig, goalIds: string[]): number {
  const goalIntervals = config.goal_intervals;
  if (!goalIntervals || goalIds.length === 0) {
    return config.check_interval_ms;
  }

  let minInterval = config.check_interval_ms;
  for (const goalId of goalIds) {
    const override = goalIntervals[goalId];
    if (override !== undefined && override < minInterval) {
      minInterval = override;
    }
  }
  return minInterval;
}

export async function processScheduleEntriesForDaemon(params: {
  scheduleEngine?: ScheduleEngine;
  logger: Logger;
  acceptRuntimeEnvelope: (envelope: Envelope) => boolean;
}): Promise<void> {
  const { scheduleEngine, logger, acceptRuntimeEnvelope } = params;
  if (!scheduleEngine) {
    return;
  }

  try {
    const results = await scheduleEngine.tick();
    for (const result of results) {
      if (result.status === "error") {
        logger.warn(`Schedule entry ${result.entry_id} failed: ${result.error_message}`);
        continue;
      }

      const goalId = (result as Record<string, unknown>)["goal_id"] as string | undefined;
      if (!goalId) {
        logger.warn("schedule_activated envelope missing goal_id", {
          entry_id: (result as Record<string, unknown>)["entry_id"],
          layer: (result as Record<string, unknown>)["layer"],
        });
        continue;
      }

      const entry = scheduleEngine.getEntries().find((candidate) => candidate.id === result.entry_id);
      if (entry?.metadata?.activation_kind === "wait_resume") {
        logger.info("Wait-resume schedule wake completed attention re-evaluation without runtime activation", {
          entry_id: result.entry_id,
          goal_id: goalId,
          strategy_id: entry.metadata.wait_strategy_id ?? entry.metadata.strategy_id ?? entry.id,
        });
        continue;
      }

      const envelope = createEnvelope({
        type: "event",
        name: "schedule_activated",
        source: "schedule-engine",
        goal_id: goalId,
        priority: "normal",
        payload: result,
        dedupe_key: result.entry_id,
      });
      acceptRuntimeEnvelope(envelope);
    }
  } catch (err) {
    logger.error("Failed to process schedule entries", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function pruneStaleFiles(
  dirPath: string,
  olderThanMs: number,
  now: number,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }

  const threshold = now - olderThanMs;
  let pruned = 0;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }
    if (stat.mtimeMs >= threshold) {
      continue;
    }

    try {
      await fsp.unlink(fullPath);
      pruned += 1;
    } catch {
      // Best-effort cleanup.
    }
  }

  return pruned;
}

export async function runRuntimeStoreMaintenanceCycle(params: {
  runtimeRoot: string;
  controlBaseDir?: string;
  approvalStore?: ApprovalStore;
  outboxStore?: OutboxStore;
  runtimeHealthStore?: RuntimeHealthStore;
  logger: RuntimeMaintenanceLogger;
  now?: number;
  options?: RuntimeStoreMaintenanceOptions;
}): Promise<RuntimeStoreMaintenanceReport> {
  const now = params.now ?? Date.now();
  const options = params.options ?? {};
  const runtimePaths = createRuntimeStorePaths(params.runtimeRoot);
  const controlOptions = { controlBaseDir: params.controlBaseDir };
  const approvalStore = params.approvalStore ?? new ApprovalStore(runtimePaths, controlOptions);
  const outboxStore = params.outboxStore ?? new OutboxStore(runtimePaths, controlOptions);
  const runtimeHealthStore =
    params.runtimeHealthStore ?? new RuntimeHealthStore(runtimePaths, { controlBaseDir: params.controlBaseDir });

  const approvals = await approvalStore.reconcile(now);
  const prunedResolved = await approvalStore.pruneResolved(
    options.approvalRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
    now,
  );
  const outbox = await outboxStore.prune({
    olderThanMs: options.outboxRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
    maxRecords: options.outboxMaxRecords ?? 5_000,
    now,
  });
  const health = await runtimeHealthStore.reconcile(now);
  const proactiveInterventions = await new ProactiveInterventionStore(runtimePaths, controlOptions).summarize();
  health.details = {
    ...health.details,
    proactive_interventions: proactiveInterventions,
  };
  try {
    await runtimeHealthStore.saveSnapshot(health);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    params.logger.warn("Skipped proactive intervention health detail update because runtime health storage disappeared", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const claims = await pruneStaleFiles(
    runtimePaths.claimsDir,
    options.claimRetentionMs ?? 7 * 24 * 60 * 60 * 1000,
    now,
  );

  params.logger.info("Runtime store maintenance cycle completed", {
    approvals_removed_pending: approvals.removedPending,
    approvals_expired_pending: approvals.expiredPending,
    approvals_pruned_resolved: prunedResolved,
    outbox_pruned: outbox.pruned,
    outbox_retained: outbox.retained,
    claims_pruned: claims,
    health_status: health.status,
  });

  return {
    approvals: {
      ...approvals,
      prunedResolved,
    },
    outbox,
    health: {
      repaired: health.details?.["repaired"] === true,
      status: health.status,
    },
    claims: {
      pruned: claims,
    },
  };
}

export async function runProactiveMaintenance(params: {
  baseDir?: string;
  config: DaemonConfig;
  llmClient?: ILLMClient;
  state: DaemonState;
  lastProactiveTickAt: number;
  logger: Logger;
}): Promise<ProactiveMaintenanceResult> {
  const { config, llmClient, state, lastProactiveTickAt, logger } = params;
  if (!config.proactive_mode || !llmClient) {
    return { lastProactiveTickAt, decision: null };
  }
  if (Date.now() - lastProactiveTickAt < config.proactive_interval_ms) {
    return { lastProactiveTickAt, decision: null };
  }

  let relationshipProfileSurface: ProactiveMaintenanceSurfaceSummary | undefined;
  try {
    const goalSummaries = state.active_goals.length > 0
      ? state.active_goals.map((id) => `- ${id}`).join("\n")
      : "(no active goals)";
    const baseDir = params.baseDir ?? config.runtime_root ?? getPulseedDirPath();
    const relationshipProfileSurfaceContext = await buildProactiveMaintenanceRelationshipProfileSurfaceContext(baseDir);
    relationshipProfileSurface = relationshipProfileSurfaceContext.surface;

    const prompt = [
      getInternalIdentityPrefix("proactive engine", { baseDir }),
      relationshipProfileSurfaceContext.promptContext,
      `Given the current state of all goals:\n${goalSummaries}\n\nDecide what action to take:\n- "suggest_goal": A new goal should be created (provide title + description)\n- "investigate": Something needs investigation (provide what and why)\n- "preemptive_check": Run a pre-emptive observation (provide goal_id)\n- "sleep": Nothing needs attention right now\n\nRespond with JSON: { "action": "...", "details": { ... } }`,
    ].filter((part) => part.trim().length > 0).join("\n\n");

    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { model_tier: "light" },
    );
    const parsed = ProactiveResponseSchema.safeParse(
      llmClient.parseJSON(response.content, ProactiveResponseSchema),
    );

    if (!parsed.success) {
      logger.warn("Proactive tick: failed to parse LLM response", {
        raw: response.content,
        error: parsed.error.message,
      });
      return {
        lastProactiveTickAt: Date.now(),
        decision: null,
        ...(relationshipProfileSurface ? { surface: relationshipProfileSurface } : {}),
      };
    }

    const { action, details } = parsed.data;
    if (action === "sleep") {
      logger.debug("Proactive tick: LLM decided to sleep");
    } else {
      logger.info(`Proactive tick: action=${action}`, { details });
    }
    return {
      lastProactiveTickAt: Date.now(),
      decision: parsed.data,
      ...(relationshipProfileSurface ? { surface: relationshipProfileSurface } : {}),
    };
  } catch (err) {
    logger.warn("Proactive tick: LLM error (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      lastProactiveTickAt: Date.now(),
      decision: null,
      ...(relationshipProfileSurface ? { surface: relationshipProfileSurface } : {}),
    };
  }
}

async function buildProactiveMaintenanceRelationshipProfileSurfaceContext(baseDir: string): Promise<{
  promptContext: string;
  surface?: ProactiveMaintenanceSurfaceSummary;
}> {
  const relationshipProfileContext = await loadRelationshipProfileSurfaceContext({
    baseDir,
    scope: "resident_behavior",
    includeSensitive: true,
  });
  const relationshipProfileSurface = buildRelationshipProfileSurfaceProjection({
    context: relationshipProfileContext,
    target: "daemon",
    scopeRef: "proactive-maintenance",
    purpose: "proactive_maintenance",
    requestedUse: "proactive_action_candidate",
    now: new Date().toISOString(),
  });
  return {
    promptContext: formatRelationshipProfileSurfaceContext(
      relationshipProfileSurface,
      { title: "Proactive maintenance relationship profile Surface" },
    ),
    ...(relationshipProfileSurface ? {
      surface: {
        surface_id: relationshipProfileSurface.id,
        surface_included_count: relationshipProfileSurface.included_context.length,
        surface_excluded_count: relationshipProfileSurface.excluded_context.length,
        surface_inspection: createSurfaceInspectionAdapterPayload(relationshipProfileSurface, "daemon"),
      },
    } : {}),
  };
}

export async function getMaxGapScoreForGoals(
  driveSystem: DriveSystem,
  goalIds: string[],
  snapshot: GoalCycleScheduleSnapshotEntry[] = [],
): Promise<number> {
  const snapshotByGoalId = new Map(snapshot.map((entry) => [entry.goalId, entry]));
  let max = 0;

  for (const goalId of goalIds) {
    const entry = snapshotByGoalId.get(goalId);

    if (entry) {
      const score = (entry.schedule as Record<string, unknown> | null)?.["last_gap_score"];
      if (typeof score === "number" && score > max) {
        max = score;
      }
      continue;
    }

    try {
      const fallbackEntry = await getGoalActivationSnapshotCompat(driveSystem, goalId);
      const schedule = fallbackEntry.schedule;
      const score = (schedule as Record<string, unknown>)["last_gap_score"];
      if (typeof score === "number" && score > max) {
        max = score;
      }
    } catch {
      // Non-fatal — just use 0 for this goal
    }
  }
  return max;
}

function getPersistedDaemonStateSnapshot(state: DaemonState): string {
  return JSON.stringify({
    status: state.status,
    active_goals: [...state.active_goals],
    loop_count: state.loop_count,
    last_loop_at: state.last_loop_at,
    interrupted_goals: state.interrupted_goals ? [...state.interrupted_goals] : undefined,
    last_resident_at: state.last_resident_at,
    resident_activity: state.resident_activity,
  });
}

export async function runSupervisorMaintenanceCycleForDaemon(params: {
  currentGoalIds: string[];
  driveSystem: DriveSystem;
  supervisor: { activateGoal(goalId: string): void } | null;
  baseDir?: string;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  processScheduleEntries: () => Promise<void>;
  proactiveTick: () => Promise<void>;
  runRuntimeStoreMaintenance?: () => Promise<void>;
  saveDaemonState: () => Promise<void>;
  eventServer?: { broadcast?(event: string, payload: Record<string, unknown>): void | Promise<void> };
  state: DaemonState;
}): Promise<void> {
  const snapshot = await collectGoalCycleScheduleSnapshot(
    params.driveSystem,
    [...params.currentGoalIds],
  );
  const activeGoals = await determineActiveGoalsForCycle(
    params.driveSystem,
    [...params.currentGoalIds],
    snapshot,
  );
  const stateBeforeMaintenance = getPersistedDaemonStateSnapshot(params.state);
  for (const goalId of activeGoals) {
    const snapshotEntry = snapshot.find((entry) => entry.goalId === goalId) ?? null;
    const triggerKind = inferSupervisorMaintenanceTrigger(snapshotEntry);
    const sourceEpoch = snapshotEntry?.schedule?.next_check_at
      ?? `supervisor-maintenance:${params.state.loop_count}`;
    const sourceId = [
      "supervisor-maintenance",
      goalId,
      triggerKind,
      sourceEpoch,
    ].join(":");
    const refs = supervisorMaintenanceAdmissionRefs(goalId, triggerKind, snapshotEntry, params.state.loop_count);
    await recordGoalRunAdmissionDecision({
      personalAgentRuntime: params.personalAgentRuntime,
      baseDir: params.baseDir,
      source: "supervisor_maintenance",
      triggerKind,
      goalId,
      sourceId,
      sourceEpoch,
      highWatermark: sourceEpoch,
      runPolicy: "resident",
      maxIterations: null,
      decisionReason: `Supervisor maintenance admitted goal ${goalId} for durable queued execution from ${triggerKind}.`,
      currentRefs: refs,
      auditRefs: refs,
    });
    params.supervisor?.activateGoal(goalId);
  }

  await params.processScheduleEntries();
  await params.proactiveTick();
  await params.runRuntimeStoreMaintenance?.();
  if (getPersistedDaemonStateSnapshot(params.state) !== stateBeforeMaintenance) {
    await params.saveDaemonState();
  }

  if (params.eventServer) {
    void params.eventServer.broadcast?.("daemon_status", {
      status: params.state.status,
      activeGoals: params.state.active_goals,
      loopCount: params.state.loop_count,
      lastLoopAt: params.state.last_loop_at,
    });
  }
}

function inferSupervisorMaintenanceTrigger(
  snapshotEntry: GoalCycleScheduleSnapshotEntry | null,
): GoalRunAdmissionTriggerKind {
  const schedule = snapshotEntry?.schedule ?? null;
  if (schedule) {
    const nextCheckAt = Date.parse(schedule.next_check_at);
    if (Number.isFinite(nextCheckAt) && nextCheckAt <= Date.now()) {
      return "schedule_due";
    }
    if (snapshotEntry?.shouldActivate === true) {
      return "external_signal";
    }
  }
  return "resident_cycle";
}

function supervisorMaintenanceAdmissionRefs(
  goalId: string,
  triggerKind: GoalRunAdmissionTriggerKind,
  snapshotEntry: GoalCycleScheduleSnapshotEntry | null,
  loopCount: number,
): RuntimeGraphRef[] {
  const refs: RuntimeGraphRef[] = [
    { kind: "daemon_state", ref: `loop:${loopCount}` },
  ];
  const schedule = snapshotEntry?.schedule ?? null;
  if (schedule) {
    refs.push(
      { kind: "goal_schedule", ref: schedule.goal_id },
      { kind: "schedule_wake", ref: `${goalId}:${schedule.next_check_at}` },
    );
  }
  if (triggerKind === "external_signal") {
    refs.push({ kind: "drive_event_queue", ref: goalId });
  }
  return refs;
}

export async function writeChatMessageEvent(
  driveSystem: DriveSystem,
  goalId: string,
  message: string,
): Promise<void> {
  await driveSystem.writeEvent(
    PulSeedEventSchema.parse({
      type: "internal",
      source: "command-dispatcher",
      timestamp: new Date().toISOString(),
      data: {
        goal_id: goalId,
        kind: "chat_message",
        message,
      },
    }),
  );
}
