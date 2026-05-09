import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopEventSink } from "./agent-loop-events.js";
import {
  SqliteAgentLoopSessionStateStore,
  SqliteAgentLoopTraceStore,
} from "./agent-loop-session-db-store.js";

export interface PersistentAgentLoopSessionFactoryOptions {
  traceBaseDir: string;
  kind: "task" | "chat" | "review";
}

export interface PersistentAgentLoopSessionInput {
  eventSink?: AgentLoopEventSink;
  parentSessionId?: string;
  resumeStatePath?: string;
  resumeSessionId?: string;
  sessionId?: string;
  traceId?: string;
}

export function createPersistentAgentLoopSessionFactory(
  options: PersistentAgentLoopSessionFactoryOptions,
): (input?: PersistentAgentLoopSessionInput) => AgentLoopSession {
  return (input = {}) => {
    const sessionId = input.sessionId ?? input.resumeSessionId ?? randomUUID();
    const traceId = input.traceId ?? randomUUID();
    const legacyResumeSessionId = input.resumeStatePath
      ? path.basename(input.resumeStatePath, ".state.json")
      : null;
    const stateSessionId = input.resumeSessionId ?? input.sessionId ?? legacyResumeSessionId ?? sessionId;
    const traceStore = new SqliteAgentLoopTraceStore(options.traceBaseDir);
    const stateStore = new SqliteAgentLoopSessionStateStore(options.traceBaseDir, stateSessionId, options.kind);

    return createAgentLoopSession({
      sessionId: stateSessionId,
      traceId,
      parentSessionId: input.parentSessionId,
      eventSink: input.eventSink,
      traceStore,
      stateStore,
    });
  };
}
