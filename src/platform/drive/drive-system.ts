import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { PulSeedEventSchema, GoalScheduleSchema } from "./types/drive.js";
import type { PulSeedEvent, GoalSchedule } from "./types/drive.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { Logger } from "../../runtime/logger.js";
import {
  assertEventSpoolJsonFileName,
  listEventSpoolJsonFiles,
  moveEventSpoolFile,
  pruneEventSpoolDirectory,
  readEventSpoolText,
  writeEventSpoolJson,
} from "../../base/utils/event-spool.js";
import {
  DriveGoalScheduleStateStore,
  type DriveGoalScheduleStateStoreOptions,
} from "./drive-schedule-state-store.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type RuntimeGraphRef,
} from "../../runtime/personal-agent/index.js";

export interface GoalActivationSnapshot {
  goalId: string;
  shouldActivate: boolean;
  schedule: GoalSchedule | null;
}

/**
 * DriveSystem handles lightweight activation checks (no LLM calls), event queue
 * processing, and goal schedule management.
 *
 * File layout:
 *   <baseDir>/events/*.json          — bounded IPC spool for unprocessed events
 *   <baseDir>/events/archive/*.json  — processed event spool retention
 *   state/pulseed-control.sqlite      — goal activation schedules
 *
 * Inactive goal statuses: "completed", "cancelled", "archived"
 * All writes are atomic: write to .tmp file, then rename.
 */
export class DriveSystem {
  private readonly baseDir: string;
  private readonly stateManager: StateManager;
  private readonly logger?: Logger;
  private watcher: FSWatcher | null = null;
  private inMemoryQueue: PulSeedEvent[] = [];
  private onEventCallback: ((event: PulSeedEvent) => void) | null = null;
  private readonly initPromise: Promise<void>;
  private readonly scheduleStore: DriveGoalScheduleStateStore;
  private readonly personalAgentRuntime: Pick<PersonalAgentRuntimeStore, "recordTrace">;

  constructor(
    stateManager: StateManager,
    options?: {
      baseDir?: string;
      logger?: Logger;
      personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
    } & DriveGoalScheduleStateStoreOptions,
  ) {
    this.stateManager = stateManager;
    this.baseDir = options?.baseDir ?? stateManager.getBaseDir();
    this.logger = options?.logger;
    this.scheduleStore = new DriveGoalScheduleStateStore(this.baseDir, options);
    this.personalAgentRuntime = options?.personalAgentRuntime
      ?? new PersonalAgentRuntimeStore(this.baseDir, { controlBaseDir: this.baseDir });
    this.watcher = null;
    this.inMemoryQueue = [];
    this.onEventCallback = null;
    this.initPromise = this.ensureDirectories().catch((err) => {
      this.logger?.warn?.(`DriveSystem: failed to create directories: ${err}`);
    });
  }

  // ─── Directory Management ───

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      path.join(this.baseDir, "events"),
      path.join(this.baseDir, "events", "archive"),
    ];
    for (const dir of dirs) {
      await fsp.mkdir(dir, { recursive: true });
    }
  }

  // ─── Activation Check ───

  private isTerminalGoalStatus(status: string | null | undefined): boolean {
    return status === "completed"
      || status === "cancelled"
      || status === "archived"
      || status === "abandoned";
  }

  private isScheduleDueForSnapshot(schedule: GoalSchedule | null): boolean {
    if (schedule === null) {
      return true;
    }
    return new Date(schedule.next_check_at).getTime() <= Date.now();
  }

  async getGoalActivationSnapshot(goalId: string): Promise<GoalActivationSnapshot> {
    const goal = await this.stateManager.loadGoal(goalId);
    const schedule = await this.getSchedule(goalId);

    if (this.isTerminalGoalStatus(goal?.status)) {
      return {
        goalId,
        shouldActivate: false,
        schedule,
      };
    }

    const events = await this.readEventQueue();
    if (events.length > 0) {
      const hasGoalEvent = events.some(
        (e) => e.data["goal_id"] === goalId || e.data["target_goal_id"] === goalId
      );
      if (hasGoalEvent) {
        return {
          goalId,
          shouldActivate: true,
          schedule,
        };
      }
    }

    return {
      goalId,
      shouldActivate: this.isScheduleDueForSnapshot(schedule),
      schedule,
    };
  }

  /**
   * Lightweight check (no LLM). Returns true if any condition is met:
   * 1. Event queue has unprocessed events for this goal
   * 2. Schedule is due (next_check_at <= now)
   * 3. Goal is not in a terminal status ("completed", "cancelled", "archived")
   */
  async shouldActivate(goalId: string): Promise<boolean> {
    return (await this.getGoalActivationSnapshot(goalId)).shouldActivate;
  }

  // ─── Event Queue ───

  /**
   * Read all JSON files from {baseDir}/events/ directory.
   * Parse each as PulSeedEvent. Return sorted by timestamp (oldest first).
   * Skips files that fail to parse (logs a warning).
   */
  async readEventQueue(): Promise<PulSeedEvent[]> {
    await this.initPromise;
    const eventsDir = path.join(this.baseDir, "events");

    let fileNames: string[];
    try {
      fileNames = await listEventSpoolJsonFiles(eventsDir);
    } catch {
      return [];
    }

    const events: PulSeedEvent[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(eventsDir, fileName);

      // Skip directories (e.g., the archive subdirectory)
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = await readEventSpoolText(eventsDir, fileName);
        const raw = JSON.parse(content) as unknown;
        const event = PulSeedEventSchema.parse(raw);
        events.push(event);
      } catch (err) {
        this.logger?.warn(`DriveSystem: skipping invalid event file "${fileName}": ${err}`);
      }
    }

    // Sort oldest first by timestamp
    events.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    return events;
  }

  /**
   * Move an event file from {baseDir}/events/{fileName} to
   * {baseDir}/events/archive/{fileName}. Creates the archive dir if needed.
   */
  async archiveEvent(eventFileName: string): Promise<void> {
    assertEventSpoolJsonFileName(eventFileName);
    const eventsDir = path.join(this.baseDir, "events");
    const archiveDir = path.join(this.baseDir, "events", "archive");
    await moveEventSpoolFile(eventsDir, eventFileName, archiveDir);
    await pruneEventSpoolDirectory(archiveDir);
  }

  /**
   * Read queue, archive each processed event, return the events.
   */
  async processEvents(): Promise<PulSeedEvent[]> {
    await this.initPromise;
    const eventsDir = path.join(this.baseDir, "events");

    let fileNames: string[];
    try {
      fileNames = await listEventSpoolJsonFiles(eventsDir);
    } catch {
      return [];
    }

    const events: PulSeedEvent[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(eventsDir, fileName);

      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = await readEventSpoolText(eventsDir, fileName);
        const raw = JSON.parse(content) as unknown;
        const event = PulSeedEventSchema.parse(raw);
        await this.archiveEvent(fileName);
        events.push(event);
      } catch (err) {
        this.logger?.warn(`DriveSystem: skipping invalid event file "${fileName}" during processEvents: ${err}`);
      }
    }

    // Sort oldest first by timestamp
    events.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    return events;
  }

  // ─── Schedule Management ───

  /**
   * Load the typed schedule from the control DB.
   * Returns null if no schedule exists.
   */
  async getSchedule(goalId: string): Promise<GoalSchedule | null> {
    await this.initPromise;
    return this.scheduleStore.load(goalId);
  }

  /**
   * Save the goal activation schedule to the typed control DB store.
   */
  async updateSchedule(goalId: string, schedule: GoalSchedule): Promise<void> {
    await this.initPromise;
    const validated = GoalScheduleSchema.parse(schedule);
    await this.scheduleStore.save(goalId, validated);
  }

  /**
   * Check if the schedule for a goal is due (next_check_at <= now).
   * If no schedule exists, returns true (needs initial check).
   */
  async isScheduleDue(goalId: string): Promise<boolean> {
    const schedule = await this.getSchedule(goalId);
    if (schedule === null) {
      return true;
    }
    const nextCheckAt = new Date(schedule.next_check_at).getTime();
    return nextCheckAt <= Date.now();
  }

  /**
   * Create a new schedule with next_check_at = now + intervalHours.
   */
  createDefaultSchedule(goalId: string, intervalHours: number): GoalSchedule {
    const interval = GoalScheduleSchema.shape.check_interval_hours.parse(intervalHours);
    const now = new Date();
    const nextCheckAt = new Date(now.getTime() + interval * 60 * 60 * 1000);
    return GoalScheduleSchema.parse({
      goal_id: goalId,
      next_check_at: nextCheckAt.toISOString(),
      check_interval_hours: interval,
      last_triggered_at: null,
      consecutive_actions: 0,
      cooldown_until: null,
      current_interval_hours: interval,
    });
  }

  // ─── Multi-Goal Prioritization ───

  /**
   * Sort goals by drive score (highest first).
   * Goals without scores go last (in their original relative order).
   */
  prioritizeGoals(goalIds: string[], scores: Map<string, number>): string[] {
    const withScore: Array<{ id: string; score: number }> = [];
    const withoutScore: string[] = [];

    for (const id of goalIds) {
      const score = scores.get(id);
      if (score !== undefined) {
        withScore.push({ id, score });
      } else {
        withoutScore.push(id);
      }
    }

    // Sort descending by score (stable sort preserves original order for ties)
    withScore.sort((a, b) => b.score - a.score);

    return [...withScore.map((g) => g.id), ...withoutScore];
  }

  // ─── Event Writing & Real-Time Watching ───

  /**
   * Write an event file to the events directory.
   * Public method used by EventServer to enqueue events via HTTP.
   */
  async writeEvent(event: PulSeedEvent): Promise<void> {
    await this.initPromise;
    await this.recordExternalEventDecision(event);
    const eventsDir = path.join(this.baseDir, "events");
    await writeEventSpoolJson(eventsDir, event, { prefix: "event" });
  }

  private async recordExternalEventDecision(event: PulSeedEvent): Promise<void> {
    const eventRef = externalEventRef(event);
    const eventTypeRef: RuntimeGraphRef = { kind: "external_event_type", ref: event.type };
    const sourceRef: RuntimeGraphRef = { kind: "external_event_source", ref: event.source };
    const goalRefs = extractEventGoalRefs(event);
    const replayKey = [
      "drive_event_ingress",
      event.type,
      event.source,
      event.timestamp,
      stableId(stableJson(event.data)),
    ].join(":");

    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "external_signal",
      source: {
        sourceKind: "external_signal",
        sourceId: eventRef.ref,
        emittedAt: event.timestamp,
        sourceEpoch: event.timestamp,
        highWatermark: event.timestamp,
        replayKey,
        summary: `External ${event.type} event from ${event.source} entered PulSeed runtime ingress.`,
        sourceRef: eventRef,
      },
      target: {
        kind: "attention_only",
        ref: { kind: "event_spool", ref: `event:${stableId(replayKey)}` },
        effect: "continue_route",
        summary: `Queue external ${event.type} event for runtime processing.`,
      },
      decision: "allow",
      decisionReason: "External event ingress was allowed by InterventionPolicy after Capability Registry evaluation.",
      capabilityDecision: "available",
      capabilityRefs: [{ kind: "capability", ref: "event_spool_ingress" }],
      policyRef: { kind: "intervention_policy", ref: "policy:external-event-ingress-v1" },
      currentRefs: [eventRef, eventTypeRef, sourceRef, ...goalRefs],
      auditRefs: [eventRef, sourceRef, ...goalRefs],
    }));
  }

  /**
   * Start watching the events directory for new event files.
   * When a new .json file appears, parse it and push it to the in-memory queue.
   * Optionally calls onEvent callback immediately on each new event.
   */
  startWatcher(onEvent?: (event: PulSeedEvent) => void): void {
    this.onEventCallback = onEvent ?? null;
    const eventsDir = path.join(this.baseDir, "events");

    // initPromise ensures the directory exists; if not yet resolved,
    // the watcher will be started after it completes.
    void this.initPromise.then(() => {
      // Guard: if stopWatcher was called before initPromise resolved
      if (this.onEventCallback === null && onEvent !== undefined) return;

      this.watcher = watch(eventsDir, (eventType, filename) => {
        const fileName = filename ? String(filename) : "";
        if (eventType !== "rename" || !fileName) return;
        if (!listenableEventFile(fileName)) return;

        void this.handleWatchEvent(eventsDir, fileName).catch((err) => {
          this.logger?.warn(`[DriveSystem] watcher async error: ${String(err)}`);
        });
      });
    });
  }

  /**
   * Handle a file event from the watcher asynchronously.
   */
  private async handleWatchEvent(eventsDir: string, fileName: string): Promise<void> {
    let content: string;
    try {
      content = await readEventSpoolText(eventsDir, fileName);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // file deleted — expected
      this.logger?.warn(`[DriveSystem] watcher read error: ${String(err)}`);
      return;
    }
    try {
      const event = PulSeedEventSchema.parse(JSON.parse(content) as unknown);
      this.inMemoryQueue.push(event);
      if (this.onEventCallback) {
        this.onEventCallback(event);
      }
    } catch (err) {
      this.logger?.warn(`[DriveSystem] watcher parse error in ${fileName}: ${String(err)}`);
    }
  }

  /**
   * Stop watching the events directory and clear the callback.
   */
  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.onEventCallback = null;
  }

  /**
   * Return all events accumulated in the in-memory queue since the last drain,
   * and clear the queue.
   */
  drainInMemoryQueue(): PulSeedEvent[] {
    const events = [...this.inMemoryQueue];
    this.inMemoryQueue = [];
    return events;
  }
}

function listenableEventFile(fileName: string): boolean {
  try {
    assertEventSpoolJsonFileName(fileName);
    return true;
  } catch {
    return false;
  }
}

function externalEventRef(event: PulSeedEvent): RuntimeGraphRef {
  return {
    kind: "external_event",
    ref: `${event.source}:${event.type}:${event.timestamp}:${stableId(stableJson(event.data))}`,
  };
}

function extractEventGoalRefs(event: PulSeedEvent): RuntimeGraphRef[] {
  const refs: RuntimeGraphRef[] = [];
  const goalId = event.data["goal_id"];
  if (typeof goalId === "string" && goalId.length > 0) {
    refs.push({ kind: "goal", ref: goalId });
  }
  const targetGoalId = event.data["target_goal_id"];
  if (typeof targetGoalId === "string" && targetGoalId.length > 0 && targetGoalId !== goalId) {
    refs.push({ kind: "goal", ref: targetGoalId });
  }
  return refs;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableJson(record[key])]),
    );
  }
  return value;
}
