import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { Session } from "../../../base/types/session.js";
import { openControlDatabase } from "../control-db/index.js";
import { ExecutionSessionStateStore } from "../execution-session-state-store.js";
import { importLegacyExecutionSessionState } from "../execution-session-state-migration.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    session_type: "task_execution",
    goal_id: "goal-1",
    task_id: "task-1",
    context_slots: [{ priority: 1, label: "task", content: "content", token_estimate: 0 }],
    context_budget: 50_000,
    started_at: "2026-05-10T00:00:00.000Z",
    ended_at: null,
    result_summary: null,
    ...overrides,
  };
}

describe("ExecutionSessionStateStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  it("stores execution sessions in the control DB without legacy session JSON files", async () => {
    const baseDir = tempHome("pulseed-execution-session-store-");
    const store = new ExecutionSessionStateStore(baseDir);

    await store.save(makeSession({ id: "session-a", started_at: "2026-05-10T00:00:00.000Z" }));
    await store.save(makeSession({
      id: "session-b",
      goal_id: "goal-1",
      session_type: "observation",
      task_id: null,
      started_at: "2026-05-10T00:01:00.000Z",
    }));
    await store.save(makeSession({
      id: "session-c",
      goal_id: "goal-2",
      ended_at: "2026-05-10T00:02:00.000Z",
      result_summary: "done",
      started_at: "2026-05-10T00:02:00.000Z",
    }));

    await expect(store.load("session-a")).resolves.toMatchObject({ id: "session-a", goal_id: "goal-1" });
    await expect(store.list({ goalId: "goal-1", activeOnly: true })).resolves.toMatchObject([
      { id: "session-b" },
      { id: "session-a" },
    ]);
    await expect(store.list({ limit: 2 })).resolves.toMatchObject([
      { id: "session-c" },
      { id: "session-b" },
    ]);

    expect(fs.existsSync(path.join(baseDir, "sessions", "session-a.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "sessions", "index.json"))).toBe(false);
  });

  it("imports legacy sessions as explicit repair input and ignores stale index authority", async () => {
    const baseDir = tempHome("pulseed-execution-session-import-");
    const sessionsDir = path.join(baseDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "legacy-a.json"), JSON.stringify(makeSession({
      id: "legacy-a",
      goal_id: "goal-import",
      started_at: "2026-05-10T00:00:00.000Z",
    })));
    fs.writeFileSync(path.join(sessionsDir, "legacy-b.json"), JSON.stringify(makeSession({
      id: "legacy-b",
      goal_id: "goal-import",
      started_at: "2026-05-10T00:01:00.000Z",
      ended_at: "2026-05-10T00:02:00.000Z",
      result_summary: "complete",
    })));
    fs.writeFileSync(path.join(sessionsDir, "index.json"), JSON.stringify(["legacy-a", "missing-stale"]));

    const report = await importLegacyExecutionSessionState(baseDir);
    expect(report).toMatchObject({
      legacySessionFiles: 2,
      importedSessions: 2,
      legacyIndexFiles: 1,
      staleIndexEntries: 1,
      blockedSources: [],
    });

    const store = new ExecutionSessionStateStore(baseDir);
    await expect(store.list({ goalId: "goal-import" })).resolves.toMatchObject([
      { id: "legacy-b", result_summary: "complete" },
      { id: "legacy-a" },
    ]);
    await expect(store.list({ goalId: "goal-import", activeOnly: true })).resolves.toMatchObject([
      { id: "legacy-a" },
    ]);

    const database = await openControlDatabase({ baseDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "execution_session",
          source_id: "legacy-a",
          migration_name: "execution-session-state",
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "execution_session_index",
          source_id: "index",
          migration_name: "execution-session-state",
          status: "validated",
          details: expect.objectContaining({ stale_entries: 1 }),
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("blocks invalid legacy session files without using them as runtime fallback", async () => {
    const baseDir = tempHome("pulseed-execution-session-blocked-");
    const sessionsDir = path.join(baseDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "bad-nonfinite.json"), `{
      "id": "bad-nonfinite",
      "session_type": "task_execution",
      "goal_id": "goal-1",
      "task_id": null,
      "context_slots": [{ "priority": 1, "label": "task", "content": "content", "token_estimate": 0 }],
      "context_budget": 1e309,
      "started_at": "2026-05-10T00:00:00.000Z",
      "ended_at": null,
      "result_summary": null
    }`);
    fs.writeFileSync(path.join(sessionsDir, "index.json"), JSON.stringify({ corrupt: true }));

    const report = await importLegacyExecutionSessionState(baseDir);
    expect(report.importedSessions).toBe(0);
    expect(report.blockedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "execution_session", sourcePath: "sessions/bad-nonfinite.json" }),
      expect.objectContaining({ sourceKind: "execution_session_index", sourcePath: "sessions/index.json" }),
    ]));

    await expect(new ExecutionSessionStateStore(baseDir).load("bad-nonfinite")).resolves.toBeNull();
  });
});
