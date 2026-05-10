import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import { KnowledgeMemoryStateStore } from "../../../../platform/knowledge/knowledge-memory-state-store.js";
import { AgentMemoryStoreSchema } from "../../../../platform/knowledge/types/agent-memory.js";
import { cmdMemory } from "../memory.js";

describe("cmdMemory", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let logs: string[];

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-cli-memory-");
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
      entries: [{
        id: "memory-forget",
        key: "temporary-fact",
        value: "This should no longer be used.",
        tags: [],
        memory_type: "fact",
        status: "raw",
        governance: {
          sensitivity: "local",
          consent: {
            scope_id: "local_planning",
            allowed_contexts: ["local_planning"],
            source_actor: "user",
            collection_context: "test",
          },
          retention: {
            policy_id: "retain_until_retracted",
            retain_until: null,
            review_after: null,
            delete_requires_approval: true,
          },
          export_visibility: "listed",
          owner_ref: "user",
        },
        created_at: "2026-05-02T00:00:00.000Z",
        updated_at: "2026-05-02T00:00:00.000Z",
      }],
      corrections: [],
      last_consolidated_at: null,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("forgets agent memory by tombstoning it and preserving correction history", async () => {
    const forgetExit = await cmdMemory(stateManager, [
      "forget",
      "agent_memory:memory-forget",
      "--reason",
      "User asked PulSeed to forget this fact.",
    ]);

    expect(forgetExit).toBe(0);
    const rawStore = await new KnowledgeMemoryStateStore(tmpDir).loadAgentMemoryStore();
    const store = AgentMemoryStoreSchema.parse(rawStore);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      id: "memory-forget",
      status: "forgotten",
      correction_state: { status: "forgotten", active: false, retained_for_audit: true },
    });
    expect(store.corrections).toHaveLength(1);
    expect(store.corrections[0]).toMatchObject({
      correction_kind: "forgotten",
      actor: "user",
    });

    const historyExit = await cmdMemory(stateManager, ["history", "agent_memory:memory-forget"]);

    expect(historyExit).toBe(0);
    expect(logs.join("\n")).toContain(store.corrections[0]!.correction_id);
  });

  it("rejects destructive deletion from the default memory command", async () => {
    const exitCode = await cmdMemory(stateManager, [
      "forget",
      "agent_memory:memory-forget",
      "--destructive-delete",
    ]);

    expect(exitCode).toBe(1);
    const store = AgentMemoryStoreSchema.parse(await new KnowledgeMemoryStateStore(tmpDir).loadAgentMemoryStore());
    expect(store.entries[0]!.status).toBe("raw");
    expect(store.corrections).toEqual([]);
  });

  it("exports governance metadata for remembered user data", async () => {
    const exitCode = await cmdMemory(stateManager, ["export", "--consent-scope", "local_planning"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.at(-1) ?? "{}") as {
      entries: Array<{ key: string; governance: { sensitivity: string } }>;
    };
    expect(output.entries).toEqual([
      expect.objectContaining({
        key: "temporary-fact",
        governance: expect.objectContaining({ sensitivity: "local" }),
      }),
    ]);
  });
});
