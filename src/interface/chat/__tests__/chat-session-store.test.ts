import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  ChatSessionCatalog,
  type ChatSessionCatalogEntry,
} from "../chat-session-store.js";
import { importLegacyChatAgentLoopSessionState } from "../chat-agentloop-state-migration.js";
import type { AgentLoopSessionState } from "../../../orchestrator/execution/agent-loop/agent-loop-session-state.js";

function makeSession(overrides: Partial<Record<string, unknown>> & {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  title?: string;
  messages?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    cwd: overrides.cwd,
    createdAt: overrides.createdAt,
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.title ? { title: overrides.title } : {}),
    messages: overrides.messages ?? [],
  };
}

function makeAgentLoopState(overrides: Partial<AgentLoopSessionState> & {
  sessionId: string;
  traceId: string;
  turnId: string;
  goalId: string;
  cwd: string;
  modelRef: string;
}): AgentLoopSessionState {
  return {
    sessionId: overrides.sessionId,
    traceId: overrides.traceId,
    turnId: overrides.turnId,
    goalId: overrides.goalId,
    cwd: overrides.cwd,
    modelRef: overrides.modelRef,
    messages: overrides.messages ?? [
      {
        role: "system",
        content: "resume me",
      },
    ],
    modelTurns: overrides.modelTurns ?? 1,
    toolCalls: overrides.toolCalls ?? 0,
    usage: overrides.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    compactions: overrides.compactions ?? 0,
    completionValidationAttempts: overrides.completionValidationAttempts ?? 0,
    calledTools: overrides.calledTools ?? [],
    lastToolLoopSignature: overrides.lastToolLoopSignature ?? null,
    repeatedToolLoopCount: overrides.repeatedToolLoopCount ?? 0,
    finalText: overrides.finalText ?? "",
    status: overrides.status ?? "running",
    ...(overrides.stopReason ? { stopReason: overrides.stopReason } : {}),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

async function writeJsonFixture(baseDir: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

describe("ChatSessionCatalog", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let catalog: ChatSessionCatalog;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
    catalog = new ChatSessionCatalog(stateManager);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  async function importLegacyFixtures(): Promise<void> {
    await importLegacyChatAgentLoopSessionState(tmpDir);
  }

  it("loads legacy session files and backfills updatedAt", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/legacy-session.json",
      makeSession({
        id: "legacy-session",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:00.000Z",
        messages: [
          { role: "user", content: "hello", timestamp: "2025-01-01T00:00:00.000Z", turnIndex: 0 },
        ],
      })
    );

    await importLegacyFixtures();
    const loaded = await catalog.loadSession("legacy-session");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("legacy-session");
    expect(loaded?.updatedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(loaded?.title).toBeNull();
    expect(loaded?.agentLoopStatus).toBe("missing");
    expect(loaded?.agentLoopResumable).toBe(false);

    await importLegacyFixtures();
    const sessions = await catalog.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "legacy-session",
      cwd: "/repo",
      title: null,
      messageCount: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      agentLoopStatus: "missing",
      agentLoopResumable: false,
    });
  });

  it("sorts by updatedAt desc and discovers resumable agentloop state", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/older.json",
      makeSession({
        id: "older",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T01:00:00.000Z",
        title: "Older",
        messages: [
          { role: "user", content: "old", timestamp: "2025-01-01T00:00:00.000Z", turnIndex: 0 },
        ],
      })
    );

    await writeJsonFixture(tmpDir,
      "chat/sessions/newer.json",
      makeSession({
        id: "newer",
        cwd: "/repo",
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-01-02T02:00:00.000Z",
        title: "Latest",
        messages: [
          { role: "user", content: "new", timestamp: "2025-01-02T00:00:00.000Z", turnIndex: 0 },
        ],
      })
    );

    await writeJsonFixture(tmpDir,
      "chat/agentloop/newer.state.json",
      makeAgentLoopState({
        sessionId: "newer",
        traceId: "trace-1",
        turnId: "turn-1",
        goalId: "goal-1",
        cwd: "/repo",
        modelRef: "model",
      })
    );

    await importLegacyFixtures();
    const sessions = await catalog.listSessions();
    expect(sessions.map((session: ChatSessionCatalogEntry) => session.id)).toEqual(["newer", "older"]);
    expect(sessions[0]).toMatchObject({
      id: "newer",
      title: "Latest",
      agentLoopStatePath: path.join("chat", "agentloop", "newer.state.json"),
      agentLoopStatus: "running",
      agentLoopResumable: true,
    });
  });

  it("resolves selectors by exact id and id prefix with clear errors", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/alpha-001.json",
      makeSession({
        id: "alpha-001",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:00.000Z",
        title: "Alpha Run",
        messages: [],
      })
    );
    await writeJsonFixture(tmpDir,
      "chat/sessions/alpha-002.json",
      makeSession({
        id: "alpha-002",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:01.000Z",
        title: "Alpha Two",
        messages: [],
      })
    );
    await writeJsonFixture(tmpDir,
      "chat/sessions/beta-003.json",
      makeSession({
        id: "beta-003",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:02.000Z",
        title: "Unique Title",
        messages: [],
      })
    );
    await writeJsonFixture(tmpDir,
      "chat/sessions/beta-004.json",
      makeSession({
        id: "beta-004",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:03.000Z",
        title: "Unique Title",
        messages: [],
      })
    );

    await importLegacyFixtures();
    const resolvedByPrefix = await catalog.resolveSelector("alpha-001");
    expect(resolvedByPrefix.id).toBe("alpha-001");

    await expect(catalog.resolveSelector("beta-00")).rejects.toMatchObject({
      kind: "ambiguous",
      selector: "beta-00",
    });

    await expect(catalog.resolveSelector("Alpha Run")).rejects.toMatchObject({
      kind: "not_found",
      selector: "Alpha Run",
    });

    await expect(catalog.resolveSelector("missing")).rejects.toMatchObject({
      kind: "not_found",
      selector: "missing",
    });
  });

  it("renames a session and bumps updatedAt", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/rename-me.json",
      {
        ...makeSession({
          id: "rename-me",
          cwd: "/repo",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T01:00:00.000Z",
          title: "Original",
          messages: [],
        }),
        turnContexts: [{
          schema_version: "chat-turn-context-v1",
          modelVisible: {
            turn: { turnId: "turn-1" },
            session: { cwd: "/repo" },
          },
        }],
      }
    );

    await importLegacyFixtures();
    const renamed = await catalog.renameSession("rename-me", "Renamed Session");
    expect(renamed.title).toBe("Renamed Session");
    expect(renamed.updatedAt).not.toBe("2025-01-01T01:00:00.000Z");

    const loaded = await catalog.loadSession("rename-me");
    expect(loaded?.title).toBe("Renamed Session");
    expect(loaded?.turnContexts).toEqual([expect.objectContaining({
      schema_version: "chat-turn-context-v1",
      modelVisible: expect.objectContaining({
        turn: expect.objectContaining({ turnId: "turn-1" }),
      }),
    })]);
  });

  it("lists by cwd and returns the latest matching session", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/repo-a-old.json",
      makeSession({
        id: "repo-a-old",
        cwd: "/repo-a",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T01:00:00.000Z",
        messages: [],
      })
    );
    await writeJsonFixture(tmpDir,
      "chat/sessions/repo-a-new.json",
      makeSession({
        id: "repo-a-new",
        cwd: "/repo-a",
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-01-02T01:00:00.000Z",
        messages: [],
      })
    );
    await writeJsonFixture(tmpDir,
      "chat/sessions/repo-b-new.json",
      makeSession({
        id: "repo-b-new",
        cwd: "/repo-b",
        createdAt: "2025-01-03T00:00:00.000Z",
        updatedAt: "2025-01-03T01:00:00.000Z",
        messages: [],
      })
    );

    await importLegacyFixtures();
    const repoASessions = await catalog.listSessions({ cwd: "/repo-a" });
    expect(repoASessions.map((session) => session.id)).toEqual(["repo-a-new", "repo-a-old"]);
    await expect(catalog.latestSession({ cwd: "/repo-a" })).resolves.toMatchObject({ id: "repo-a-new" });
  });

  it("clears a session title when renamed to null", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/clear-title.json",
      makeSession({
        id: "clear-title",
        cwd: "/repo",
        createdAt: "2025-01-01T00:00:00.000Z",
        title: "Original",
        messages: [],
      })
    );

    await importLegacyFixtures();
    const renamed = await catalog.renameSession("clear-title", null);
    expect(renamed.title).toBeNull();
    const loaded = await catalog.loadSession("clear-title");
    expect(loaded?.title).toBeNull();
  });

  it("preserves rollout journal records through load and rename", async () => {
    const rolloutRecord = {
      schema_version: "chat-rollout-journal-record-v1",
      id: "journal-session:0",
      sessionId: "journal-session",
      runId: "run-1",
      turnId: "turn-1",
      sequence: 0,
      createdAt: "2026-05-06T00:00:00.000Z",
      kind: "user_input",
      source: "chat_history",
      visibility: "model_visible",
      payload: {
        role: "user",
        content: "persist me from structured journal",
        turnIndex: 0,
      },
    };
    await writeJsonFixture(tmpDir,
      "chat/sessions/journal-session.json",
      {
        ...makeSession({
          id: "journal-session",
          cwd: "/repo",
          createdAt: "2026-05-06T00:00:00.000Z",
          messages: [
            { role: "user", content: "legacy transcript", timestamp: "2026-05-06T00:00:00.000Z", turnIndex: 0 },
          ],
        }),
        rolloutJournal: [rolloutRecord],
      }
    );

    await importLegacyFixtures();
    const loaded = await catalog.loadSession("journal-session");
    expect(loaded?.rolloutJournal).toEqual([rolloutRecord]);

    const renamed = await catalog.renameSession("journal-session", "Renamed journal session");
    expect(renamed.rolloutJournal).toEqual([rolloutRecord]);
    const reloaded = await catalog.loadSession("journal-session");
    expect(reloaded?.rolloutJournal).toEqual([rolloutRecord]);
  });

  it("uses agentloop updatedAt when deciding cleanup freshness", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/old-chat-fresh-agentloop.json",
      makeSession({
        id: "old-chat-fresh-agentloop",
        cwd: "/repo",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T01:00:00.000Z",
        messages: [],
      })
    );
    await writeJsonFixture(tmpDir,
      "chat/agentloop/old-chat-fresh-agentloop.state.json",
      makeAgentLoopState({
        sessionId: "old-chat-fresh-agentloop",
        traceId: "trace-fresh",
        turnId: "turn-fresh",
        goalId: "goal-fresh",
        cwd: "/repo",
        modelRef: "model",
        status: "failed",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
    );

    await importLegacyFixtures();
    const dryRun = await catalog.cleanupSessions({
      dryRun: true,
      olderThanMs: 60 * 60 * 1000,
      now: Date.parse("2026-01-01T00:30:00.000Z"),
    });

    expect(dryRun.removedSessionIds).not.toContain("old-chat-fresh-agentloop");
    expect(dryRun.retainedSessionIds).toContain("old-chat-fresh-agentloop");
  });

  it("prefers the top-level agentloop path and does not fall back to stale nested metadata", async () => {
    await writeJsonFixture(tmpDir,
      "chat/sessions/forked-session.json",
      {
        ...makeSession({
          id: "forked-session",
          cwd: "/repo",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:01:00.000Z",
          messages: [],
        }),
        agentLoopStatePath: "chat/agentloop/forked-session.state.json",
        agentLoop: {
          statePath: "chat/agentloop/source-session.state.json",
          status: "running",
          resumable: true,
          updatedAt: "2026-04-01T00:02:00.000Z",
        },
      }
    );
    await writeJsonFixture(tmpDir,
      "chat/agentloop/source-session.state.json",
      makeAgentLoopState({
        sessionId: "source-session",
        traceId: "trace-source",
        turnId: "turn-source",
        goalId: "goal-source",
        cwd: "/repo",
        modelRef: "model",
        status: "failed",
        updatedAt: "2026-04-01T00:02:00.000Z",
      })
    );

    await importLegacyFixtures();
    const loaded = await catalog.loadSession("forked-session");

    expect(loaded).not.toBeNull();
    expect(loaded?.agentLoopStatePath).toBe(path.join("chat", "agentloop", "forked-session.state.json"));
    expect(loaded?.agentLoopStatus).toBe("missing");
    expect(loaded?.agentLoopResumable).toBe(false);
  });

  it("cleans up old sessions in dry-run and enforce modes while protecting the active session", async () => {
    const oldSession = makeSession({
      id: "old-session",
      cwd: "/repo",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T01:00:00.000Z",
      messages: [],
    });
    const activeSession = makeSession({
      id: "active-session",
      cwd: "/repo",
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T01:00:00.000Z",
      messages: [],
    });
    const freshSession = makeSession({
      id: "fresh-session",
      cwd: "/repo",
      createdAt: "2025-12-31T23:30:00.000Z",
      updatedAt: "2025-12-31T23:50:00.000Z",
      messages: [],
    });

    await writeJsonFixture(tmpDir, "chat/sessions/old-session.json", oldSession);
    await writeJsonFixture(tmpDir, "chat/sessions/active-session.json", activeSession);
    await writeJsonFixture(tmpDir, "chat/sessions/fresh-session.json", freshSession);
    await writeJsonFixture(tmpDir,
      "chat/agentloop/old-session.state.json",
      makeAgentLoopState({
        sessionId: "old-session",
        traceId: "trace-old",
        turnId: "turn-old",
        goalId: "goal-old",
        cwd: "/repo",
        modelRef: "model",
        updatedAt: "2024-01-01T01:00:00.000Z",
      })
    );

    await importLegacyFixtures();
    const dryRun = await catalog.cleanupSessions({
      dryRun: true,
      activeSessionId: "active-session",
      olderThanMs: 60 * 60 * 1000,
      now: Date.parse("2026-01-01T00:00:00.000Z"),
    });

    expect(dryRun.removedSessionIds).toContain("old-session");
    expect(dryRun.retainedSessionIds).toContain("active-session");
    expect(fs.existsSync(path.join(tmpDir, "chat", "sessions", "old-session.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "chat", "agentloop", "old-session.state.json"))).toBe(true);

    const enforced = await catalog.cleanupSessions({
      dryRun: false,
      activeSessionId: "active-session",
      olderThanMs: 60 * 60 * 1000,
      now: Date.parse("2026-01-01T00:00:00.000Z"),
    });

    expect(enforced.removedSessionIds).toContain("old-session");
    expect(enforced.retainedSessionIds).toContain("active-session");
    await expect(catalog.loadSession("old-session")).resolves.toBeNull();
    await expect(catalog.loadSession("active-session")).resolves.toMatchObject({ id: "active-session" });
    await expect(catalog.loadSession("fresh-session")).resolves.toMatchObject({ id: "fresh-session" });
    expect(fs.existsSync(path.join(tmpDir, "chat", "sessions", "old-session.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "chat", "agentloop", "old-session.state.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "chat", "sessions", "active-session.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "chat", "sessions", "fresh-session.json"))).toBe(true);
  });
});
