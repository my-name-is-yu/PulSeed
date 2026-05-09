import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { openControlDatabase } from "../../../runtime/store/control-db/index.js";
import { AgentLoopSessionStateCatalog, SqliteAgentLoopTraceStore } from "../../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import { ChatSessionDataStore, CrossPlatformChatSessionInfoStore } from "../chat-session-data-store.js";
import { importLegacyChatAgentLoopSessionState } from "../chat-agentloop-state-migration.js";

describe("importLegacyChatAgentLoopSessionState", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("imports legacy chat, cross-platform, AgentLoop state, and trace files into typed Control DB rows", async () => {
    await stateManager.writeRaw("chat/sessions/legacy-chat.json", {
      id: "legacy-chat",
      cwd: "/repo",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:01:00.000Z",
      title: "Legacy Chat",
      messages: [],
    });
    await stateManager.writeRaw("chat/agentloop/legacy-chat.state.json", {
      sessionId: "agent-native",
      traceId: "trace-native",
      turnId: "turn-native",
      goalId: "goal-native",
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
      status: "running",
      updatedAt: "2026-05-09T00:02:00.000Z",
    });
    await stateManager.writeRaw("chat/cross-platform-sessions/session-info.json", {
      session_key: "identity:one",
      identity_key: "identity:one",
      platform: "slack",
      conversation_id: "C123",
      user_id: "U123",
      cwd: "/repo",
      created_at: "2026-05-09T00:00:00.000Z",
      last_used_at: "2026-05-09T00:03:00.000Z",
      chat_session_id: "legacy-chat",
      metadata: { channel: "plugin_gateway" },
    });
    fs.mkdirSync(path.join(tmpDir, "traces", "agentloop", "chat"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "traces", "agentloop", "chat", "trace-native.jsonl"),
      `${JSON.stringify({
        eventId: "event-1",
        traceId: "trace-native",
        sessionId: "agent-native",
        turnId: "turn-native",
        goalId: "goal-native",
        type: "final",
        createdAt: "2026-05-09T00:03:00.000Z",
      })}\n`,
      "utf-8",
    );

    const report = await importLegacyChatAgentLoopSessionState(tmpDir);

    expect(report).toMatchObject({
      importedChatSessions: 1,
      importedCrossPlatformSessions: 1,
      importedAgentLoopStates: 1,
      importedTraceEvents: 1,
      blockedSources: [],
    });
    await expect(new ChatSessionDataStore(tmpDir).load("legacy-chat")).resolves.toMatchObject({
      id: "legacy-chat",
      agentLoopSessionId: "agent-native",
      agentLoopTraceId: "trace-native",
      agentLoopStatus: "running",
      agentLoopStatePath: path.join("chat", "agentloop", "legacy-chat.state.json"),
    });
    await expect(new AgentLoopSessionStateCatalog(tmpDir).load("agent-native")).resolves.toMatchObject({
      sessionId: "agent-native",
      traceId: "trace-native",
      status: "running",
    });
    await expect(new CrossPlatformChatSessionInfoStore(tmpDir).load("identity:one")).resolves.toMatchObject({
      session_key: "identity:one",
      chat_session_id: "legacy-chat",
    });
    await expect(new SqliteAgentLoopTraceStore(tmpDir).list("trace-native")).resolves.toHaveLength(1);

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      const imports = controlDb.listLegacyImports();
      expect(imports).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_kind: "chat_session", source_id: "legacy-chat", status: "imported" }),
        expect.objectContaining({ source_kind: "agentloop_state", source_id: "agent-native", status: "imported" }),
        expect.objectContaining({ source_kind: "cross_platform_chat_session", source_id: "identity:one", status: "imported" }),
        expect.objectContaining({ source_kind: "agentloop_trace", status: "imported" }),
      ]));
    } finally {
      controlDb.close();
    }
  });
});
