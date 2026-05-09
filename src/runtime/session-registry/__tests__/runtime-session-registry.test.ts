import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import {
  RuntimeSessionRegistry,
  RuntimeSessionRegistrySnapshotSchema,
} from "../index.js";
import type { ProcessSessionSnapshot } from "../../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { BackgroundRunLedger } from "../../store/background-run-store.js";
import { SupervisorStateStore } from "../../store/supervisor-state-store.js";
import { importLegacyChatAgentLoopSessionState } from "../../../interface/chat/chat-agentloop-state-migration.js";

describe("RuntimeSessionRegistry", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runtime-session-registry-"));
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSupervisorState(state: {
    workers: Array<Record<string, unknown>>;
    crashCounts: Record<string, number>;
    suspendedGoals: string[];
    updatedAt: number;
  }): Promise<void> {
    await new SupervisorStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir }).save(state as never);
  }

  async function importLegacyChatState(): Promise<void> {
    await importLegacyChatAgentLoopSessionState(tmpDir);
  }

  it("joins agent sessions to their owning conversation through agentLoopStatePath", async () => {
    await stateManager.writeRaw("chat/sessions/chat-a.json", {
      id: "chat-a",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      title: "Issue 742",
      messages: [],
      agentLoopStatePath: "chat/agentloop/agent-state.state.json",
      agentLoopStatus: "running",
      agentLoopResumable: true,
      agentLoopUpdatedAt: "2026-04-25T00:11:00.000Z",
    });
    await stateManager.writeRaw("chat/agentloop/agent-state.state.json", makeAgentState({
      sessionId: "native-session-b",
      updatedAt: "2026-04-25T00:12:00.000Z",
      status: "running",
    }));

    await importLegacyChatState();
    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    const conversation = snapshot.sessions.find((session) => session.id === "session:conversation:chat-a");
    const agent = snapshot.sessions.find((session) => session.id === "session:agent:native-session-b");
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:agent:native-session-b");

    expect(conversation).toMatchObject({
      kind: "conversation",
      resumable: true,
    });
    expect(agent).toMatchObject({
      kind: "agent",
      parent_session_id: "session:conversation:chat-a",
      state_ref: expect.objectContaining({
        id: "native-session-b",
        relative_path: "state/pulseed-control.sqlite",
      }),
    });
    expect(run).toMatchObject({
      kind: "agent_run",
      parent_session_id: "session:conversation:chat-a",
      child_session_id: "session:agent:native-session-b",
      goal_id: "goal-1",
      status: "running",
    });
  });

  it("projects spawned child conversations with their parent conversation runtime id", async () => {
    await stateManager.writeRaw("chat/sessions/chat-parent.json", {
      id: "chat-parent",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      title: "Parent chat",
      messages: [],
    });
    await stateManager.writeRaw("chat/sessions/chat-child.json", {
      id: "chat-child",
      cwd: "/repo",
      createdAt: "2026-04-25T00:15:00.000Z",
      updatedAt: "2026-04-25T00:20:00.000Z",
      title: "Child chat",
      parentSessionId: "chat-parent",
      spawnedBySessionId: "chat-parent",
      spawnedAt: "2026-04-25T00:15:00.000Z",
      messages: [],
    });

    await importLegacyChatState();
    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();
    const childConversation = snapshot.sessions.find((session) => session.id === "session:conversation:chat-child");

    expect(childConversation).toMatchObject({
      id: "session:conversation:chat-child",
      kind: "conversation",
      parent_session_id: "session:conversation:chat-parent",
    });
  });

  it("projects conversation lifecycle status and durable reply target from chat session metadata", async () => {
    await stateManager.writeRaw("chat/sessions/chat-notify.json", {
      id: "chat-notify",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:20:00.000Z",
      title: "Notify chat",
      sessionStatus: "completed",
      sessionSummary: "done",
      completedAt: "2026-04-25T00:30:00.000Z",
      notificationReplyTarget: {
        channel: "plugin_gateway",
        target_id: "chat-123",
        thread_id: "msg-1",
      },
      messages: [],
    });

    await importLegacyChatState();
    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();
    const conversation = snapshot.sessions.find((session) => session.id === "session:conversation:chat-notify");

    expect(conversation).toMatchObject({
      id: "session:conversation:chat-notify",
      status: "ended",
      updated_at: "2026-04-25T00:30:00.000Z",
      reply_target: expect.objectContaining({
        channel: "plugin_gateway",
        target_id: "chat-123",
      }),
      resumable: false,
    });
  });

  it("does not report a running process sidecar with a dead pid as running", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-dead.json", makeProcessSnapshot({
      session_id: "proc-dead",
      pid: 999_999,
      running: true,
    }));

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      isPidAlive: () => false,
    }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-dead",
      status: "lost",
      process_session_id: "proc-dead",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "dead_process_sidecar",
    }));
  });

  it("keeps a running process sidecar active when the default pid probe reports EPERM", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-eperm.json", makeProcessSnapshot({
      session_id: "proc-eperm",
      pid: 4242,
      running: true,
    }));
    vi.spyOn(process, "kill").mockImplementation(((pid: number | NodeJS.Signals, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      throw new Error(`unexpected process probe for ${String(pid)}`);
    }) as typeof process.kill);

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-eperm",
      status: "running",
      process_session_id: "proc-eperm",
    }));
    expect(snapshot.warnings).not.toContainEqual(expect.objectContaining({
      code: "dead_process_sidecar",
    }));
  });

  it("marks a running process sidecar lost when the default pid probe reports ESRCH", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-esrch.json", makeProcessSnapshot({
      session_id: "proc-esrch",
      pid: 4242,
      running: true,
    }));
    vi.spyOn(process, "kill").mockImplementation(((pid: number | NodeJS.Signals, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) {
        const error = new Error("no such process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      throw new Error(`unexpected process probe for ${String(pid)}`);
    }) as typeof process.kill);

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-esrch",
      status: "lost",
      process_session_id: "proc-esrch",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "dead_process_sidecar",
    }));
  });

  it("does not probe or report a running process sidecar with an unsafe pid", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-unsafe-pid.json", {
      ...makeProcessSnapshot({
        session_id: "proc-unsafe-pid",
        running: true,
        pid: undefined,
      }),
    });
    const isPidAlive = vi.fn(() => true);

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      isPidAlive,
    }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-unsafe-pid",
      status: "unknown",
      process_session_id: "proc-unsafe-pid",
    }));
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it("keeps orphan agent-loop state with a missing parent join warning", async () => {
    await stateManager.writeRaw("chat/agentloop/orphan.state.json", makeAgentState({
      sessionId: "orphan-agent",
      updatedAt: "2026-04-25T00:12:00.000Z",
      status: "running",
    }));

    await importLegacyChatState();
    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:agent:orphan-agent",
      kind: "agent",
      parent_session_id: null,
      status: "active",
    }));
    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:agent:orphan-agent",
      goal_id: "goal-1",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "missing_parent_join",
    }));
  });

  it("prefers durable terminal process state over an in-memory running snapshot", async () => {
    const runningSnapshot = makeProcessSnapshot({
      session_id: "proc-terminal",
      pid: process.pid,
      running: true,
      exitCode: null,
    });
    await stateManager.writeRaw("runtime/process-sessions/proc-terminal.json", {
      ...runningSnapshot,
      running: false,
      exitCode: 0,
      exitedAt: "2026-04-25T01:00:00.000Z",
    });

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      processSessionManager: {
        list: () => [runningSnapshot],
      },
    }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-terminal",
      status: "succeeded",
      completed_at: "2026-04-25T01:00:00.000Z",
    }));
  });

  it("projects durable pinned reply targets after restart without in-memory active routing", async () => {
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:agent:restart-safe",
      kind: "agent_run",
      notify_policy: "done_only",
      reply_target_source: "pinned_run",
      pinned_reply_target: {
        channel: "slack",
        target_id: "C123",
        thread_id: "1700000000.000200",
      },
      parent_session_id: "session:conversation:chat-a",
      title: "Restart safe",
      workspace: "/repo",
      created_at: "2026-04-25T00:00:00.000Z",
    });
    await ledger.terminal("run:agent:restart-safe", {
      status: "succeeded",
      completed_at: "2026-04-25T00:10:00.000Z",
      summary: "completed after restart",
    });
    expect(fs.existsSync(path.join(tmpDir, "runtime", "background-runs"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:agent:restart-safe",
      status: "succeeded",
      reply_target_source: "pinned_run",
      pinned_reply_target: expect.objectContaining({
        channel: "slack",
        target_id: "C123",
        thread_id: "1700000000.000200",
      }),
      summary: "completed after restart",
    }));
  });

  it("lets durable ledger records beat synthetic process projections with the same run id", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-ledger.json", makeProcessSnapshot({
      session_id: "proc-ledger",
      running: true,
      pid: process.pid,
      label: "synthetic process",
    }));

    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:process:proc-ledger",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-ledger",
      title: "durable process",
      workspace: "/repo",
      created_at: "2026-04-25T00:00:00.000Z",
      started_at: "2026-04-25T00:00:00.000Z",
      status: "running",
    });
    await ledger.terminal("run:process:proc-ledger", {
      status: "failed",
      completed_at: "2026-04-25T00:30:00.000Z",
      error: "durable failure",
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:process:proc-ledger");

    expect(run).toMatchObject({
      id: "run:process:proc-ledger",
      kind: "process_run",
      status: "failed",
      title: "durable process",
      error: "durable failure",
      reply_target_source: "none",
    });
    expect(snapshot.background_runs.filter((candidate) => candidate.id === "run:process:proc-ledger")).toHaveLength(1);
  });

  it("does not let a stale running ledger record hide a dead process sidecar", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-stale-ledger.json", makeProcessSnapshot({
      session_id: "proc-stale-ledger",
      running: true,
      pid: 999_999,
      label: "stale ledger process",
    }));

    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:process:proc-stale-ledger",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-stale-ledger",
      title: "durable running process",
      workspace: "/repo",
      created_at: "2026-04-25T00:00:00.000Z",
      started_at: "2026-04-25T00:00:00.000Z",
      status: "running",
    });

    const snapshot = await new RuntimeSessionRegistry({
      stateManager,
      isPidAlive: () => false,
    }).snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:process:proc-stale-ledger");

    expect(run).toMatchObject({
      id: "run:process:proc-stale-ledger",
      status: "lost",
      title: "durable running process",
      process_session_id: "proc-stale-ledger",
    });
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "dead_process_sidecar",
    }));
  });

  it("projects active supervisor workers from the control database", async () => {
    await writeSupervisorState({
      workers: [
        {
          workerId: "worker-1",
          goalId: "goal-a",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
          iterations: 2,
        },
      ],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:coreloop:worker-1",
      kind: "coreloop",
      status: "active",
      attachable: true,
    }));
    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:coreloop:worker-1",
      kind: "coreloop_run",
      status: "running",
    }));
  });

  it("uses the current runtime supervisor state from the control database", async () => {
    await writeSupervisorState({
      workers: [
        {
          workerId: "runtime-worker",
          goalId: "goal-runtime",
          startedAt: Date.parse("2026-04-25T00:05:00.000Z"),
          iterations: 1,
        },
      ],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:35:00.000Z"),
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions.some((session) => session.id === "session:coreloop:legacy-worker")).toBe(false);
    expect(snapshot.background_runs.some((run) => run.id === "run:coreloop:legacy-worker")).toBe(false);
    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:coreloop:runtime-worker",
      state_ref: expect.objectContaining({
        relative_path: null,
      }),
    }));
  });

  it("drops stale supervisor child sessions when the durable ledger owns the run", async () => {
    await writeSupervisorState({
      workers: [
        {
          workerId: "worker-ledger",
          goalId: "goal-ledger",
          backgroundRunId: "run:coreloop:ledger-owned",
          sessionId: "session:coreloop:stale-projection",
          parentSessionId: "session:conversation:chat-ledger",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
          iterations: 2,
        },
      ],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:coreloop:ledger-owned",
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      parent_session_id: "session:conversation:chat-ledger",
      child_session_id: "session:coreloop:ledger-current",
      goal_id: "goal-ledger",
      title: "Ledger-owned DurableLoop",
      workspace: "/repo",
      created_at: "2026-04-25T00:01:00.000Z",
      started_at: "2026-04-25T00:02:00.000Z",
      updated_at: "2026-04-25T00:03:00.000Z",
      status: "running",
      source_refs: [{
        kind: "supervisor_state",
        id: null,
        path: null,
        relative_path: "runtime/supervisor-state.json",
        updated_at: "2026-04-25T00:03:00.000Z",
      }],
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs.filter((run) => run.id === "run:coreloop:ledger-owned")).toHaveLength(1);
    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:coreloop:ledger-owned",
      child_session_id: "session:coreloop:ledger-current",
      workspace: "/repo",
      title: "Ledger-owned DurableLoop",
    }));
    expect(snapshot.sessions.some((session) => session.id === "session:coreloop:stale-projection")).toBe(false);
    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:coreloop:ledger-current",
      parent_session_id: "session:conversation:chat-ledger",
      workspace: "/repo",
    }));
  });

  it("projects a completed DurableLoop handoff graph from durable ledger records", async () => {
    await stateManager.writeRaw("chat/sessions/chat-coreloop.json", {
      id: "chat-coreloop",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:01:00.000Z",
      title: "DurableLoop handoff",
      messages: [],
    });
    await importLegacyChatState();

    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.ensureReady();
    await ledger.create({
      id: "run:coreloop:handoff",
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      parent_session_id: "session:conversation:chat-coreloop",
      child_session_id: "session:coreloop:worker-handoff",
      title: "DurableLoop handoff",
      workspace: "/repo",
      created_at: "2026-04-25T00:02:00.000Z",
      started_at: "2026-04-25T00:03:00.000Z",
      status: "running",
      source_refs: [{
        kind: "supervisor_state",
        id: null,
        path: null,
        relative_path: "runtime/supervisor-state.json",
        updated_at: "2026-04-25T00:03:00.000Z",
      }],
    });
    await ledger.terminal("run:coreloop:handoff", {
      status: "succeeded",
      completed_at: "2026-04-25T00:04:00.000Z",
      summary: "DurableLoop completed.",
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:conversation:chat-coreloop",
      kind: "conversation",
    }));
    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:coreloop:handoff",
      kind: "coreloop_run",
      parent_session_id: "session:conversation:chat-coreloop",
      child_session_id: "session:coreloop:worker-handoff",
      status: "succeeded",
    }));
    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: "session:coreloop:worker-handoff",
      kind: "coreloop",
      parent_session_id: "session:conversation:chat-coreloop",
      status: "ended",
      attachable: false,
      state_ref: expect.objectContaining({
        relative_path: "runtime/supervisor-state.json",
      }),
    }));
  });

  it("does not project idle supervisor workers as active CoreLoop runs", async () => {
    await writeSupervisorState({
      workers: [
        {
          workerId: "idle-worker",
          goalId: null,
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
          iterations: 0,
        },
      ],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.sessions.some((session) => session.id === "session:coreloop:idle-worker")).toBe(false);
    expect(snapshot.background_runs.some((run) => run.id === "run:coreloop:idle-worker")).toBe(false);
  });

  it("does not report an unconfirmed stopped process sidecar as succeeded", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-stopped.json", makeProcessSnapshot({
      session_id: "proc-stopped",
      running: false,
      exitCode: null,
      signal: null,
    }));

    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(snapshot.background_runs).toContainEqual(expect.objectContaining({
      id: "run:process:proc-stopped",
      status: "lost",
    }));
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "stale_source",
    }));
  });

  it("returns a schema-valid registry snapshot", async () => {
    await stateManager.writeRaw("chat/sessions/chat-a.json", {
      id: "chat-a",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      messages: [],
    });

    await importLegacyChatState();
    const snapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();

    expect(() => RuntimeSessionRegistrySnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

function makeAgentState(overrides: Partial<{
  sessionId: string;
  status: "running" | "completed" | "failed";
  updatedAt: string;
}> = {}) {
  return {
    sessionId: overrides.sessionId ?? "agent-session",
    traceId: "trace-1",
    turnId: "turn-1",
    goalId: "goal-1",
    cwd: "/repo",
    modelRef: "native:test",
    messages: [],
    modelTurns: 1,
    toolCalls: 0,
    compactions: 0,
    completionValidationAttempts: 0,
    calledTools: [],
    lastToolLoopSignature: null,
    repeatedToolLoopCount: 0,
    finalText: "",
    status: overrides.status ?? "running",
    updatedAt: overrides.updatedAt ?? "2026-04-25T00:01:00.000Z",
  };
}

function makeProcessSnapshot(overrides: Partial<ProcessSessionSnapshot> = {}): ProcessSessionSnapshot {
  const snapshot = {
    session_id: overrides.session_id ?? "proc-1",
    label: overrides.label ?? "training",
    command: overrides.command ?? "node",
    args: overrides.args ?? ["train.js"],
    cwd: overrides.cwd ?? "/repo",
    running: overrides.running ?? true,
    exitCode: overrides.exitCode ?? null,
    signal: overrides.signal ?? null,
    startedAt: overrides.startedAt ?? "2026-04-25T00:00:00.000Z",
    ...(overrides.exitedAt ? { exitedAt: overrides.exitedAt } : {}),
    bufferedChars: overrides.bufferedChars ?? 0,
    metadataRef: overrides.metadataRef ?? `control-db://process-sessions/${encodeURIComponent(overrides.session_id ?? "proc-1")}`,
    artifactRefs: overrides.artifactRefs ?? [],
  };
  return "pid" in overrides
    ? { ...snapshot, ...(overrides.pid ? { pid: overrides.pid } : {}) }
    : { ...snapshot, pid: 12345 };
}
