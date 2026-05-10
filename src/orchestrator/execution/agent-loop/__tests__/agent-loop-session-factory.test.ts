import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { createPersistentAgentLoopSessionFactory } from "../agent-loop-session-factory.js";
import { normalizeAgentLoopSessionState } from "../agent-loop-session-state.js";

describe("createPersistentAgentLoopSessionFactory", () => {
  it("persists trace events to Control DB under the configured base directory", async () => {
    const baseDir = makeTempDir();
    const createSession = createPersistentAgentLoopSessionFactory({
      traceBaseDir: baseDir,
      kind: "chat",
    });
    const session = createSession();

    await session.traceStore.append({
      type: "started",
      eventId: "event-1",
      sessionId: session.sessionId,
      traceId: session.traceId,
      turnId: "turn-1",
      goalId: "goal-1",
      createdAt: new Date().toISOString(),
    });

    await expect(session.traceStore.list(session.traceId)).resolves.toMatchObject([
      { type: "started", traceId: session.traceId, sessionId: session.sessionId },
    ]);
  });

  it("resumes by typed DB session id", async () => {
    const baseDir = makeTempDir();
    const createSession = createPersistentAgentLoopSessionFactory({
      traceBaseDir: baseDir,
      kind: "chat",
    });
    const session = createSession({ resumeSessionId: "session-1" });

    await session.stateStore.save({
      sessionId: session.sessionId,
      traceId: session.traceId,
      turnId: "turn-1",
      goalId: "chat",
      cwd: baseDir,
      modelRef: "openai/gpt-test",
      messages: [{ role: "user", content: "continue" }],
      modelTurns: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      compactions: 0,
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    await expect(session.stateStore.load()).resolves.toMatchObject({
      sessionId: "session-1",
      traceId: session.traceId,
      status: "running",
    });
  });
});

describe("normalizeAgentLoopSessionState", () => {
  it("normalizes legacy state payloads that predate newer counters", () => {
    const baseDir = makeTempDir();
    const state = normalizeAgentLoopSessionState({
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: baseDir,
      modelRef: "openai/gpt-test",
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: "Calling verify",
          toolCalls: [{ id: "call-1", name: "verify", input: { command: "npm test" } }],
        },
      ],
      modelTurns: 2,
      toolCalls: 1,
      compactions: 1,
      status: "running",
    });

    expect(state).toMatchObject({
      sessionId: "session-1",
      traceId: "trace-1",
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "running",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(state?.messages[1]?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "verify",
      input: { command: "npm test" },
    });
  });

  it("returns null for incompatible state payloads", () => {
    expect(normalizeAgentLoopSessionState({
      sessionId: "session-1",
      traceId: "trace-1",
      goalId: "goal-1",
      messages: [{ role: "user", content: "missing turnId/cwd/modelRef" }],
    })).toBeNull();
  });
});
