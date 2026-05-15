import * as path from "node:path";
import { z } from "zod/v3";
import type { ApprovalRequiredEvent } from "../approval-broker.js";
import {
  createRuntimeStorePaths,
  DaemonStateStore,
  GoalTaskStateStore,
  RuntimeOperationStore,
  resolveRuntimeControlDbBaseDir,
  type OutboxStore,
  type RuntimeAutomationSnapshot,
} from "../store/index.js";
import { BrowserSessionStore, RuntimeAuthHandoffStore } from "../interactive-automation/index.js";
import { GuardrailStore } from "../guardrails/index.js";
import type { StateManager } from "../../base/state/state-manager.js";
import { createRuntimeSessionRegistry } from "../session-registry/index.js";
import type { RuntimeSessionRegistrySnapshot } from "../session-registry/types.js";
import {
  buildResidentRuntimeInterfaceSnapshot,
  type ResidentRuntimeInterfaceSnapshot,
} from "../resident-runtime-interface.js";
import {
  RuntimeOperatorHandoffStore,
  type RuntimeOperatorHandoffRecord,
} from "../store/operator-handoff-store.js";

const JsonObjectSchema = z.object({}).catchall(z.unknown());

type ActiveWorkersProvider = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;

export interface EventServerSnapshotData {
  daemon: Record<string, unknown> | null;
  goals: Array<{ id: string; title: string; status: string; loop_status: string }>;
  approvals: ApprovalRequiredEvent[];
  active_workers: Array<Record<string, unknown>>;
  last_outbox_seq: number;
  auth_sessions: Array<Record<string, unknown>>;
  guardrails: Record<string, unknown> | null;
  runtime_automation: RuntimeAutomationSnapshot;
  runtime_sessions: RuntimeSessionRegistrySnapshot | null;
  operator_handoffs: RuntimeOperatorHandoffRecord[];
  resident_runtime_interface: ResidentRuntimeInterfaceSnapshot;
}

export class EventServerSnapshotReader {
  constructor(
    private readonly eventsDir: string,
    private readonly configuredRuntimeRoot?: string,
    private readonly stateManager?: StateManager,
    private readonly configuredControlBaseDir?: string,
  ) {}

  async buildSnapshot(
    approvalEvents: ApprovalRequiredEvent[],
    outboxStore?: OutboxStore,
    activeWorkersProvider?: ActiveWorkersProvider
  ): Promise<EventServerSnapshotData> {
    const [daemon, goals, latestOutbox, activeWorkers, authSessions, guardrails, runtimeAutomation, runtimeSessions, operatorHandoffs] = await Promise.all([
      this.readDaemonState(),
      this.readGoalSummaries(),
      outboxStore?.loadLatest() ?? Promise.resolve(null),
      activeWorkersProvider?.() ?? Promise.resolve([]),
      this.readPendingAuthSessions(),
      this.readGuardrailSnapshot(),
      this.readRuntimeAutomationSnapshot(),
      this.readRuntimeSessionSnapshot(),
      this.readOpenOperatorHandoffs(),
    ]);

    const residentRuntimeInterface = await this.readResidentRuntimeInterface({
      runtimeSessions,
      approvals: approvalEvents,
      activeWorkers,
      latestOutboxSeq: latestOutbox?.seq ?? 0,
      operatorHandoffs,
    });

    return {
      daemon,
      goals,
      approvals: approvalEvents,
      active_workers: activeWorkers,
      last_outbox_seq: latestOutbox?.seq ?? 0,
      auth_sessions: authSessions,
      guardrails,
      runtime_automation: runtimeAutomation,
      runtime_sessions: runtimeSessions,
      operator_handoffs: operatorHandoffs,
      resident_runtime_interface: residentRuntimeInterface,
    };
  }

  private runtimeRoot(): string {
    return this.configuredRuntimeRoot ?? path.join(path.dirname(this.eventsDir), "runtime");
  }

  private controlDbOptions(): { controlBaseDir: string } | undefined {
    if (this.configuredControlBaseDir) return { controlBaseDir: this.configuredControlBaseDir };
    if (this.stateManager) return { controlBaseDir: this.stateManager.getBaseDir() };
    return undefined;
  }

  private controlBaseDir(): string {
    return this.configuredControlBaseDir ?? this.stateManager?.getBaseDir() ?? path.dirname(this.eventsDir);
  }

  private runtimeControlBaseDir(): string {
    if (this.configuredControlBaseDir) return this.configuredControlBaseDir;
    if (this.stateManager) return this.stateManager.getBaseDir();
    return resolveRuntimeControlDbBaseDir(createRuntimeStorePaths(this.runtimeRoot()));
  }

  private async readPendingAuthSessions(): Promise<Array<Record<string, unknown>>> {
    const store = new BrowserSessionStore(this.runtimeRoot(), this.controlDbOptions());
    const sessions = await store.listPendingAuth();
    return sessions.map((session) => ({
      session_id: session.session_id,
      provider_id: session.provider_id,
      service_key: session.service_key,
      workspace: session.workspace,
      actor_key: session.actor_key,
      state: session.state,
      updated_at: session.updated_at,
    }));
  }

  private async readGuardrailSnapshot(): Promise<Record<string, unknown> | null> {
    const store = new GuardrailStore(this.runtimeRoot(), this.controlDbOptions());
    const [breakers, backpressure] = await Promise.all([
      store.listBreakers(),
      store.loadBackpressureSnapshot(),
    ]);
    const openBreakers = breakers
      .filter((breaker) => breaker.state === "open" || breaker.state === "paused" || breaker.state === "half_open")
      .map((breaker) => ({
        key: breaker.key,
        provider_id: breaker.provider_id,
        service_key: breaker.service_key,
        state: breaker.state,
        failure_count: breaker.failure_count,
        cooldown_until: breaker.cooldown_until ?? null,
        updated_at: breaker.updated_at,
      }));
    return {
      open_breakers: openBreakers,
      backpressure_active: backpressure?.active ?? [],
      backpressure_throttled: backpressure?.throttled ?? [],
    };
  }

  private async readRuntimeAutomationSnapshot(): Promise<RuntimeAutomationSnapshot> {
    const runtimeRoot = this.runtimeRoot();
    const controlDbOptions = this.controlDbOptions();
    const [authHandoffs, browserSessions, breakers, backpressure] = await Promise.all([
      new RuntimeAuthHandoffStore(runtimeRoot, controlDbOptions).list(),
      new BrowserSessionStore(runtimeRoot, controlDbOptions).list(),
      new GuardrailStore(runtimeRoot, controlDbOptions).listBreakers(),
      new GuardrailStore(runtimeRoot, controlDbOptions).loadBackpressureSnapshot(),
    ]);
    const openBreakers = breakers.filter((breaker) => breaker.state === "open");
    const pausedBreakers = breakers.filter((breaker) => breaker.state === "paused");
    const halfOpenBreakers = breakers.filter((breaker) => breaker.state === "half_open");
    const pendingAuth = authHandoffs.filter((handoff) =>
      handoff.state === "requested" || handoff.state === "pending_operator" || handoff.state === "in_progress" || handoff.state === "blocked"
    );
    const recentTerminalAuth = authHandoffs.filter((handoff) =>
      handoff.state === "completed" || handoff.state === "cancelled" || handoff.state === "expired" || handoff.state === "superseded"
    );
    const staleBrowserSessions = browserSessions.filter((session) => session.state !== "authenticated");
    return {
      schema_version: "runtime-automation-snapshot-v1",
      generated_at: new Date().toISOString(),
      auth_handoffs: {
        pending: pendingAuth,
        stale: [],
        recent_terminal: recentTerminalAuth,
      },
      browser_sessions: {
        authenticated: browserSessions.filter((session) => session.state === "authenticated"),
        stale: staleBrowserSessions,
      },
      guardrails: {
        open_breakers: openBreakers,
        paused_breakers: pausedBreakers,
        half_open_breakers: halfOpenBreakers,
      },
      backpressure: {
        active: backpressure?.active ?? [],
        throttled: backpressure?.throttled ?? [],
      },
      blocked_work: [
        ...pendingAuth.map((handoff) => ({
          kind: "auth_wait" as const,
          provider_id: handoff.provider_id,
          service_key: handoff.service_key,
          handoff_id: handoff.handoff_id,
          reason: handoff.failure_message ?? "auth handoff pending",
          since: handoff.updated_at,
          retry_after: handoff.expires_at ?? null,
        })),
        ...openBreakers.map((breaker) => ({
          kind: "guardrail_open" as const,
          provider_id: breaker.provider_id,
          service_key: breaker.service_key,
          reason: `guardrail:${breaker.state}`,
          since: breaker.updated_at,
          retry_after: breaker.cooldown_until ?? null,
        })),
        ...(backpressure?.throttled ?? []).map((entry) => ({
          kind: "backpressure" as const,
          provider_id: entry.provider_id,
          service_key: entry.service_key,
          reason: entry.reason,
          since: entry.at,
          retry_after: null,
        })),
      ],
    };
  }

  private async readRuntimeSessionSnapshot(): Promise<RuntimeSessionRegistrySnapshot | null> {
    if (!this.stateManager) return null;
    const registry = createRuntimeSessionRegistry({ stateManager: this.stateManager });
    return registry.snapshot();
  }

  private async readOpenOperatorHandoffs(): Promise<RuntimeOperatorHandoffRecord[]> {
    return new RuntimeOperatorHandoffStore(this.runtimeRoot(), this.controlDbOptions()).listOpen();
  }

  private async readResidentRuntimeInterface(input: {
    runtimeSessions: RuntimeSessionRegistrySnapshot | null;
    approvals: ApprovalRequiredEvent[];
    activeWorkers: Array<Record<string, unknown>>;
    latestOutboxSeq: number;
    operatorHandoffs: RuntimeOperatorHandoffRecord[];
  }): Promise<ResidentRuntimeInterfaceSnapshot> {
    const operationStore = new RuntimeOperationStore(this.runtimeRoot(), this.controlDbOptions());
    const [pendingOperations, recentOperations, runtimeEvents, daemonState] = await Promise.all([
      operationStore.listPending(),
      operationStore.listRecentOperations(50),
      operationStore.listRecentRuntimeEvents(50),
      this.readRuntimeControlDaemonState(),
    ]);

    return buildResidentRuntimeInterfaceSnapshot({
      runtimeRoot: this.runtimeRoot(),
      controlBaseDir: this.runtimeControlBaseDir(),
      daemonState,
      runtimeSessions: input.runtimeSessions,
      runtimeEvents,
      pendingOperations,
      recentOperations,
      pendingApprovals: input.approvals,
      lastOutboxSeq: input.latestOutboxSeq,
      activeWorkers: input.activeWorkers,
      operatorHandoffRefs: input.operatorHandoffs.map((handoff) => handoff.handoff_id),
    });
  }

  private async readRuntimeControlDaemonState(): Promise<Record<string, unknown> | null> {
    const state = await new DaemonStateStore(this.runtimeControlBaseDir()).load();
    return state ? parseJsonObject(JSON.stringify(state)) : null;
  }

  async readDaemonStateRaw(): Promise<string | null> {
    const state = await new DaemonStateStore(this.controlBaseDir()).load();
    return state ? JSON.stringify(state) : null;
  }

  async readDaemonState(): Promise<Record<string, unknown> | null> {
    const raw = await this.readDaemonStateRaw();
    if (raw === null) return null;
    return parseJsonObject(raw);
  }

  async readGoalSummaries(): Promise<Array<{ id: string; title: string; status: string; loop_status: string }>> {
    const store = new GoalTaskStateStore(this.controlBaseDir());
    const goalIds = await store.listGoalIds({ archived: false });
    const goals: Array<{ id: string; title: string; status: string; loop_status: string }> = [];
    for (const goalId of goalIds) {
      const goal = await store.loadGoal(goalId, { includeArchived: false });
      if (goal === null) continue;
      goals.push({
        id: goal.id,
        title: goal.title,
        status: goal.status,
        loop_status: goal.loop_status,
      });
    }
    return goals;
  }

  async readGoalDetail(goalId: string): Promise<Record<string, unknown> | null> {
    const store = new GoalTaskStateStore(this.controlBaseDir());
    const goal = await store.loadGoal(goalId, { includeArchived: false });
    if (goal === null) return null;
    const gapHistory = await store.loadGapHistory(goalId);
    return { ...goal, current_gap: gapHistory.at(-1) ?? null };
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
