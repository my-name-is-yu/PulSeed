import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import { ChatSessionCatalog } from "../../interface/chat/chat-session-store.js";
import {
  AgentLoopSessionStateCatalog,
} from "../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import type { ProcessSessionManager, ProcessSessionSnapshot } from "../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { BackgroundRunLedger } from "../store/background-run-store.js";
import { ProcessSessionStateStore } from "../store/process-session-state-store.js";
import { SupervisorStateStore } from "../store/supervisor-state-store.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../daemon/runtime-root.js";
import {
  BackgroundRunSchema,
  RuntimeSessionRegistrySnapshotSchema,
  type BackgroundRun,
  type BackgroundRunFilter,
  type BackgroundRunStatus,
  type RuntimeSession,
  type RuntimeSessionFilter,
  type RuntimeSessionRef,
  type RuntimeSessionRegistrySnapshot,
  type RuntimeSessionRegistryWarning,
} from "./types.js";
import {
  agentRunId,
  agentSessionId,
  agentStatusToRunStatus,
  agentStatusToSessionStatus,
  chooseProcessSnapshot,
  compareByUpdatedAtThenId,
  conversationSessionId,
  coreLoopRunId,
  coreLoopSessionFromLedgerRun,
  coreLoopSessionId,
  defaultIsPidAlive,
  filterRuns,
  filterSessions,
  isProcessPidValue,
  isObject,
  mergeLedgerRunWithProjection,
  messageFromError,
  numberToIso,
  processArtifacts,
  processRunId,
  relativeToBase,
  sourceRef,
  stringField,
} from "./registry-helpers.js";

interface RuntimeSessionRegistryDeps {
  stateManager: StateManager;
  stateBaseDir?: string;
  processSessionManager?: Pick<ProcessSessionManager, "list">;
  backgroundRunLedger?: Pick<BackgroundRunLedger, "list">;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean | "unknown";
}

interface SupervisorStateLike {
  workers?: unknown;
  updatedAt?: unknown;
}

function chatLifecycleToRuntimeStatus(status: string | null | undefined): RuntimeSession["status"] {
  if (status === "queued" || status === "running" || status === "waiting") return "active";
  if (status === "completed" || status === "failed") return "ended";
  return "idle";
}

function createDefaultBackgroundRunLedger(stateBaseDir: string): Pick<BackgroundRunLedger, "list"> {
  const configuredRuntimeRoot = resolveConfiguredDaemonRuntimeRoot(stateBaseDir);
  return new BackgroundRunLedger(configuredRuntimeRoot, { controlBaseDir: stateBaseDir });
}

export class RuntimeSessionRegistry {
  private readonly stateManager: StateManager;
  private readonly stateBaseDir: string;
  private readonly chatCatalog: ChatSessionCatalog;
  private readonly agentLoopCatalog: AgentLoopSessionStateCatalog;
  private readonly processSessionManager?: Pick<ProcessSessionManager, "list">;
  private readonly processSessionStore: ProcessSessionStateStore;
  private readonly backgroundRunLedger: Pick<BackgroundRunLedger, "list">;
  private readonly now: () => Date;
  private readonly isPidAlive: (pid: number) => boolean | "unknown";

  constructor(deps: RuntimeSessionRegistryDeps) {
    this.stateManager = deps.stateManager;
    this.stateBaseDir = deps.stateBaseDir ?? deps.stateManager.getBaseDir();
    this.chatCatalog = new ChatSessionCatalog(this.stateManager);
    this.agentLoopCatalog = new AgentLoopSessionStateCatalog(this.stateBaseDir);
    this.processSessionManager = deps.processSessionManager;
    this.processSessionStore = new ProcessSessionStateStore(this.stateBaseDir);
    this.backgroundRunLedger = deps.backgroundRunLedger ?? createDefaultBackgroundRunLedger(this.stateBaseDir);
    this.now = deps.now ?? (() => new Date());
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  }

  async snapshot(): Promise<RuntimeSessionRegistrySnapshot> {
    const generatedAt = this.now().toISOString();
    const sessions: RuntimeSession[] = [];
    const backgroundRuns: BackgroundRun[] = [];
    const warnings: RuntimeSessionRegistryWarning[] = [];

    await this.projectChatAndAgentSessions(sessions, backgroundRuns, warnings);
    await this.projectSupervisorState(sessions, backgroundRuns, warnings);
    await this.projectProcessSessions(backgroundRuns, warnings);
    await this.projectLedgerRuns(sessions, backgroundRuns, warnings);

    sessions.sort(compareByUpdatedAtThenId);
    backgroundRuns.sort(compareByUpdatedAtThenId);

    return RuntimeSessionRegistrySnapshotSchema.parse({
      schema_version: "runtime-session-registry-v1",
      generated_at: generatedAt,
      sessions,
      background_runs: backgroundRuns,
      warnings,
    });
  }

  async listSessions(filter: RuntimeSessionFilter = {}): Promise<RuntimeSession[]> {
    return filterSessions((await this.snapshot()).sessions, filter);
  }

  async listRuns(filter: BackgroundRunFilter = {}): Promise<BackgroundRun[]> {
    return filterRuns((await this.snapshot()).background_runs, filter);
  }

  async getSession(id: string): Promise<RuntimeSession | null> {
    return (await this.snapshot()).sessions.find((session) => session.id === id) ?? null;
  }

  async getRun(id: string): Promise<BackgroundRun | null> {
    return (await this.snapshot()).background_runs.find((run) => run.id === id) ?? null;
  }

  private async projectChatAndAgentSessions(
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    let chatSessions;
    try {
      chatSessions = await this.chatCatalog.listSessions();
    } catch (error) {
      warnings.push({
        code: "source_unavailable",
        source: sourceRef("chat_session", null, null, null, null),
        message: `Failed to list chat sessions: ${messageFromError(error)}`,
      });
      return;
    }

    const linkedAgentSessionIds = new Set<string>();
    for (const chat of chatSessions) {
      const conversationId = conversationSessionId(chat.id);
      const chatSource = sourceRef(
        "chat_session",
        chat.id,
        null,
        path.join("state", "pulseed-control.sqlite"),
        chat.updatedAt,
      );

      sessions.push({
        schema_version: "runtime-session-v1",
        id: conversationId,
        kind: "conversation",
        parent_session_id: chat.parentSessionId ? conversationSessionId(chat.parentSessionId) : null,
        title: chat.title,
        workspace: chat.cwd,
        status: chatLifecycleToRuntimeStatus(chat.sessionStatus),
        created_at: chat.createdAt,
        updated_at: chat.completedAt ?? chat.updatedAt,
        last_event_at: chat.completedAt ?? chat.updatedAt,
        transcript_ref: chatSource,
        state_ref: null,
        reply_target: chat.notificationReplyTarget ?? null,
        resumable: chat.sessionStatus !== "completed",
        attachable: false,
        source_refs: [chatSource],
      });

      if ((chat.agentLoopSessionId || chat.agentLoopStatePath) && chat.agentLoopStatus !== "missing") {
        linkedAgentSessionIds.add(chat.agentLoopSessionId ?? chat.id);
        const agentProjection = await this.projectAgentSession(chat, conversationId, chatSource, warnings);
        sessions.push(agentProjection.session);
        backgroundRuns.push(agentProjection.run);
      }
    }

    await this.projectOrphanAgentSessions(linkedAgentSessionIds, sessions, backgroundRuns, warnings);
  }

  private async projectAgentSession(
    chat: Awaited<ReturnType<ChatSessionCatalog["listSessions"]>>[number],
    conversationId: string,
    chatSource: RuntimeSessionRef,
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<{ session: RuntimeSession; run: BackgroundRun }> {
    const requestedSessionId = chat.agentLoopSessionId ?? chat.id;
    const state = await this.agentLoopCatalog.load(requestedSessionId);
    const stateRef = sourceRef(
      "agentloop_state",
      state?.sessionId ?? requestedSessionId,
      null,
      path.join("state", "pulseed-control.sqlite"),
      state?.updatedAt ?? chat.agentLoopUpdatedAt ?? null,
    );
    const agentLoopSessionId = state?.sessionId ?? requestedSessionId;
    const traceId = state?.traceId ?? chat.agentLoopTraceId ?? null;
    const stateUpdatedAt = state?.updatedAt ?? chat.agentLoopUpdatedAt ?? null;
    const stateGoalId = state?.goalId ?? chat.goalId ?? null;
    const normalizedStatus = state?.status ?? chat.agentLoopStatus;
    if (!state) {
      warnings.push({
        code: "source_parse_failed",
        source: stateRef,
        message: `AgentLoop state is missing from Control DB for session ${requestedSessionId}.`,
      });
    }

    const stableAgentId = agentLoopSessionId;
    const sessionId = agentSessionId(stableAgentId);
    const updatedAt = stateUpdatedAt ?? chat.updatedAt;
    const agentStateRef = { ...stateRef, id: agentLoopSessionId, updated_at: stateUpdatedAt };
    const traceRef = traceId
      ? sourceRef("agentloop_trace", traceId, null, null, stateUpdatedAt)
      : null;
    const sourceRefs = [chatSource, agentStateRef, ...(traceRef ? [traceRef] : [])];

    return {
      session: {
        schema_version: "runtime-session-v1",
        id: sessionId,
        kind: "agent",
        parent_session_id: conversationId,
        title: chat.title ?? stableAgentId,
        workspace: chat.cwd,
        status: agentStatusToSessionStatus(normalizedStatus),
        created_at: chat.createdAt,
        updated_at: updatedAt,
        last_event_at: updatedAt,
        transcript_ref: null,
        state_ref: agentStateRef,
        reply_target: null,
        resumable: chat.agentLoopResumable,
        attachable: false,
        source_refs: sourceRefs,
      },
      run: BackgroundRunSchema.parse({
        schema_version: "background-run-v1",
        id: agentRunId(stableAgentId),
        kind: "agent_run",
        parent_session_id: conversationId,
        child_session_id: sessionId,
        process_session_id: null,
        goal_id: stateGoalId,
        status: agentStatusToRunStatus(normalizedStatus),
        notify_policy: "done_only",
        reply_target_source: "none",
        pinned_reply_target: null,
        title: chat.title ?? stableAgentId,
        workspace: chat.cwd,
        created_at: chat.createdAt,
        started_at: chat.createdAt,
        updated_at: updatedAt,
        completed_at: normalizedStatus === "completed" || normalizedStatus === "failed" ? updatedAt : null,
        summary: null,
        error: normalizedStatus === "failed" ? "AgentLoop session failed." : null,
        artifacts: [],
        source_refs: sourceRefs,
      }),
    };
  }

  private async projectOrphanAgentSessions(
    linkedAgentSessionIds: Set<string>,
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    const agentStates = await this.agentLoopCatalog.list({ kind: "chat" });

    for (const state of agentStates) {
      if (linkedAgentSessionIds.has(state.sessionId)) continue;
      const stateRef = sourceRef(
        "agentloop_state",
        state.sessionId,
        null,
        path.join("state", "pulseed-control.sqlite"),
        state.updatedAt,
      );
      const sessionId = agentSessionId(state.sessionId);
      const agentStateRef = { ...stateRef, id: state.sessionId, updated_at: state.updatedAt };
      warnings.push({
        code: "missing_parent_join",
        source: agentStateRef,
        message: `AgentLoop state ${state.sessionId} has no owning chat session join.`,
      });
      sessions.push({
          schema_version: "runtime-session-v1",
          id: sessionId,
          kind: "agent",
          parent_session_id: null,
          title: state.taskId ?? state.goalId,
          workspace: state.cwd,
          status: agentStatusToSessionStatus(state.status),
          created_at: null,
          updated_at: state.updatedAt,
          last_event_at: state.updatedAt,
          transcript_ref: null,
          state_ref: agentStateRef,
          reply_target: null,
          resumable: state.status !== "completed",
          attachable: false,
          source_refs: [
            agentStateRef,
            sourceRef("agentloop_trace", state.traceId, null, null, state.updatedAt),
          ],
      });
      backgroundRuns.push(BackgroundRunSchema.parse({
          schema_version: "background-run-v1",
          id: agentRunId(state.sessionId),
          kind: "agent_run",
          parent_session_id: null,
          child_session_id: sessionId,
          process_session_id: null,
          goal_id: state.goalId,
          status: agentStatusToRunStatus(state.status),
          notify_policy: "done_only",
          reply_target_source: "none",
          pinned_reply_target: null,
          title: state.taskId ?? state.goalId,
          workspace: state.cwd,
          created_at: null,
          started_at: null,
          updated_at: state.updatedAt,
          completed_at: state.status === "completed" || state.status === "failed" ? state.updatedAt : null,
          summary: null,
          error: state.status === "failed" ? "AgentLoop session failed." : null,
          artifacts: [],
          source_refs: [agentStateRef],
      }));
    }
  }

  private async projectSupervisorState(
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    const runtimeRoot = resolveConfiguredDaemonRuntimeRoot(this.stateBaseDir);
    const source = sourceRef("supervisor_state", "current", null, null, null);
    let raw: SupervisorStateLike | null;
    try {
      raw = await new SupervisorStateStore(runtimeRoot, { controlBaseDir: this.stateBaseDir }).load();
    } catch (error) {
      warnings.push({
        code: "source_parse_failed",
        source,
        message: `Failed to read supervisor state: ${messageFromError(error)}`,
      });
      return;
    }
    if (!raw) return;

    const state = raw;
    const workers = Array.isArray(state.workers) ? state.workers : [];
    const updatedAt = numberToIso(state.updatedAt) ?? null;
    const supervisorSource = { ...source, updated_at: updatedAt };
    for (const worker of workers) {
      if (!isObject(worker)) continue;
      const workerId = stringField(worker, "workerId");
      if (!workerId) continue;
      const goalId = stringField(worker, "goalId");
      if (!goalId) continue;
      const startedAt = numberToIso(worker["startedAt"]) ?? updatedAt;
      const sessionId = stringField(worker, "sessionId") ?? coreLoopSessionId(workerId);
      const runId = stringField(worker, "backgroundRunId") ?? coreLoopRunId(workerId);
      const parentSessionId = stringField(worker, "parentSessionId");
      const title = goalId ? `DurableLoop goal ${goalId}` : `DurableLoop worker ${workerId}`;
      sessions.push({
        schema_version: "runtime-session-v1",
        id: sessionId,
        kind: "coreloop",
        parent_session_id: parentSessionId,
        title,
        workspace: null,
        status: "active",
        created_at: startedAt,
        updated_at: updatedAt,
        last_event_at: updatedAt,
        transcript_ref: null,
        state_ref: supervisorSource,
        reply_target: null,
        resumable: false,
        attachable: true,
        source_refs: [supervisorSource],
      });
      backgroundRuns.push(BackgroundRunSchema.parse({
        schema_version: "background-run-v1",
        id: runId,
        kind: "coreloop_run",
        parent_session_id: parentSessionId,
        child_session_id: sessionId,
        process_session_id: null,
        goal_id: goalId,
        status: "running",
        notify_policy: "state_changes",
        reply_target_source: "none",
        pinned_reply_target: null,
        title,
        workspace: null,
        created_at: startedAt,
        started_at: startedAt,
        updated_at: updatedAt,
        completed_at: null,
        summary: null,
        error: null,
        artifacts: [],
        source_refs: [supervisorSource],
      }));
    }
  }

  private async projectProcessSessions(
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    const liveSnapshots = new Map<string, ProcessSessionSnapshot>();
    for (const snapshot of this.processSessionManager?.list(true) ?? []) {
      liveSnapshots.set(snapshot.session_id, snapshot);
    }

    const persistedSnapshots = await this.readPersistedProcessSnapshots(warnings);
    const ids = new Set([...liveSnapshots.keys(), ...persistedSnapshots.map((snapshot) => snapshot.session_id)]);
    for (const id of ids) {
      const live = liveSnapshots.get(id);
      const persisted = persistedSnapshots.find((snapshot) => snapshot.session_id === id);
      const snapshot = chooseProcessSnapshot(live, persisted);
      if (!snapshot) continue;
      const status = this.processRunStatus(snapshot, Boolean(live), warnings);
      const processSource = sourceRef(
        "process_session",
        snapshot.session_id,
        null,
        snapshot.metadataRef ?? path.join("state", "pulseed-control.sqlite"),
        snapshot.exitedAt ?? snapshot.startedAt,
      );
      const artifacts = processArtifacts(snapshot);
      backgroundRuns.push(BackgroundRunSchema.parse({
        schema_version: "background-run-v1",
        id: processRunId(snapshot.session_id),
        kind: "process_run",
        parent_session_id: null,
        child_session_id: null,
        process_session_id: snapshot.session_id,
        goal_id: null,
        status,
        notify_policy: "done_only",
        reply_target_source: "none",
        pinned_reply_target: null,
        title: snapshot.label ?? `${snapshot.command} ${snapshot.args.join(" ")}`.trim(),
        workspace: snapshot.cwd,
        created_at: snapshot.startedAt,
        started_at: snapshot.startedAt,
        updated_at: snapshot.exitedAt ?? snapshot.startedAt,
        completed_at: status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
          ? snapshot.exitedAt ?? null
          : null,
        summary: null,
        error: status === "failed" ? `Process exited with code ${snapshot.exitCode}` : null,
        artifacts,
        source_refs: [
          processSource,
          ...artifacts.map((artifact) => sourceRef("artifact", artifact.label, artifact.path, relativeToBase(this.stateBaseDir, artifact.path), null)),
        ],
      }));
    }
  }

  private async projectLedgerRuns(
    sessions: RuntimeSession[],
    backgroundRuns: BackgroundRun[],
    warnings: RuntimeSessionRegistryWarning[],
  ): Promise<void> {
    let ledgerRuns: BackgroundRun[];
    try {
      ledgerRuns = await this.backgroundRunLedger.list();
    } catch (error) {
      warnings.push({
        code: "source_unavailable",
        source: sourceRef("task_ledger", "background_runs", null, path.join("state", "pulseed-control.sqlite"), null),
        message: `Failed to list background run ledger records: ${messageFromError(error)}`,
      });
      return;
    }

    const byId = new Map(backgroundRuns.map((run) => [run.id, run]));
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const run of ledgerRuns) {
      const projected = byId.get(run.id);
      const merged = mergeLedgerRunWithProjection(run, projected);
      byId.set(run.id, merged);
      pruneSupersededProjectedSession(sessions, sessionIds, byId, projected, merged);
      if (merged.kind === "coreloop_run" && merged.child_session_id && !sessionIds.has(merged.child_session_id)) {
        sessions.push(coreLoopSessionFromLedgerRun(merged));
        sessionIds.add(merged.child_session_id);
      }
    }
    backgroundRuns.splice(0, backgroundRuns.length, ...byId.values());
  }

  private async readPersistedProcessSnapshots(warnings: RuntimeSessionRegistryWarning[]): Promise<ProcessSessionSnapshot[]> {
    try {
      return await this.processSessionStore.listSnapshots();
    } catch (error) {
      warnings.push({
        code: "source_unavailable",
        source: sourceRef("process_session", null, null, path.join("state", "pulseed-control.sqlite"), null),
        message: `Failed to list process session snapshots: ${messageFromError(error)}`,
      });
      return [];
    }
  }

  private processRunStatus(
    snapshot: ProcessSessionSnapshot,
    hasLiveSession: boolean,
    warnings: RuntimeSessionRegistryWarning[],
  ): BackgroundRunStatus {
    if (snapshot.exitedAt || snapshot.running === false || snapshot.exitCode !== null || snapshot.signal) {
      if (snapshot.exitCode === 0) return "succeeded";
      if (snapshot.exitCode !== null) return "failed";
      if (snapshot.signal) return "cancelled";
      if (snapshot.exitedAt) return "unknown";
      warnings.push({
        code: "stale_source",
        source: sourceRef("process_session", snapshot.session_id, null, snapshot.metadataRef ?? path.join("state", "pulseed-control.sqlite"), snapshot.startedAt),
        message: `Process session ${snapshot.session_id} is not running but has no terminal exit metadata.`,
      });
      return "lost";
    }
    if (!snapshot.running) return "unknown";
    if (hasLiveSession) return "running";
    if (!isProcessPidValue(snapshot.pid)) return "unknown";

    const alive = this.isPidAlive(snapshot.pid);
    if (alive === true) return "running";
    if (alive === false) {
      warnings.push({
        code: "dead_process_sidecar",
        source: sourceRef("process_session", snapshot.session_id, null, snapshot.metadataRef ?? path.join("state", "pulseed-control.sqlite"), snapshot.startedAt),
        message: `Process session ${snapshot.session_id} is marked running but PID ${snapshot.pid} is not alive.`,
      });
      return "lost";
    }
    return "unknown";
  }
}

function pruneSupersededProjectedSession(
  sessions: RuntimeSession[],
  sessionIds: Set<string>,
  backgroundRunsById: Map<string, BackgroundRun>,
  projected: BackgroundRun | undefined,
  merged: BackgroundRun,
): void {
  if (!projected || projected.kind !== "coreloop_run" || merged.kind !== "coreloop_run") return;
  const staleSessionId = projected.child_session_id;
  const replacementSessionId = merged.child_session_id;
  if (!staleSessionId || !replacementSessionId || staleSessionId === replacementSessionId) return;
  const stillReferenced = [...backgroundRunsById.values()].some((run) =>
    run.id !== merged.id && run.child_session_id === staleSessionId
  );
  if (stillReferenced) return;
  const index = sessions.findIndex((session) =>
    session.id === staleSessionId
    && session.kind === "coreloop"
    && session.source_refs.some((ref) => ref.kind === "supervisor_state")
  );
  if (index < 0) return;
  sessions.splice(index, 1);
  sessionIds.delete(staleSessionId);
}

export function createRuntimeSessionRegistry(deps: RuntimeSessionRegistryDeps): RuntimeSessionRegistry {
  return new RuntimeSessionRegistry(deps);
}
