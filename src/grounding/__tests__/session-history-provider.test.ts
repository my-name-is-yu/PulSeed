import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../base/state/state-manager.js";
import type { GroundingProviderContext } from "../contracts.js";
import { sessionHistoryProvider } from "../providers/session-history-provider.js";
import { ExecutionSessionStateStore } from "../../runtime/store/execution-session-state-store.js";

function makeContext(baseDir: string): GroundingProviderContext {
  return {
    deps: {
      stateManager: {
        getBaseDir: vi.fn().mockReturnValue(baseDir),
      } as unknown as StateManager,
    },
    profile: {
      id: "chat/handoff",
      surface: "chat",
      purpose: "handoff",
      include: {} as never,
      budgets: {
        maxTokens: 10_000,
        maxGoalCount: 5,
        maxTaskCount: 5,
        maxHistoryMessages: 5,
        maxProgressEntries: 5,
        maxKnowledgeHits: 5,
        maxRepoInstructionChars: 1_000,
      },
    },
    request: {
      surface: "chat",
      purpose: "handoff",
    },
    warnings: [],
    runtime: new Map(),
  };
}

describe("sessionHistoryProvider", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-session-history-provider-"));
    tempDirs.push(dir);
    return dir;
  }

  it("reads stored session history from the typed execution session store", async () => {
    const baseDir = tempHome();
    await new ExecutionSessionStateStore(baseDir).save({
      id: "session-db",
      session_type: "task_execution",
      goal_id: "goal-db",
      task_id: "task-db",
      context_slots: [{ priority: 1, label: "task", content: "content", token_estimate: 0 }],
      context_budget: 50_000,
      started_at: "2026-05-10T00:00:00.000Z",
      ended_at: "2026-05-10T00:01:00.000Z",
      result_summary: "Finished from DB",
    });
    fs.mkdirSync(path.join(baseDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "sessions", "legacy-only.json"), "{ not json");

    const section = await sessionHistoryProvider.build(makeContext(baseDir));
    expect(section?.content).toContain("session-db (goal-db): Finished from DB");
    expect(section?.content).not.toContain("legacy-only");
    expect(section?.sources[0]).toMatchObject({
      type: "state",
      label: "execution session store",
      retrievalId: "session:stored",
    });
  });
});
