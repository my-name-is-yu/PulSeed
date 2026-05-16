import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import { KnowledgeMemoryStateStore } from "../../../../platform/knowledge/knowledge-memory-state-store.js";
import { AgentMemoryStoreSchema } from "../../../../platform/knowledge/types/agent-memory.js";
import { cmdMemory } from "../memory.js";

describe("cmdMemory", () => {
  const RAW_MEMORY_VALUE = "Sensitive raw memory value must not render.";
  const RAW_REASON = "Sensitive correction reason must not render.";
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
        value: RAW_MEMORY_VALUE,
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

  it("inspects correction history through a read-only user-facing projection without raw refs or sensitive content", async () => {
    const forgetExit = await cmdMemory(stateManager, [
      "forget",
      "agent_memory:memory-forget",
      "--reason",
      RAW_REASON,
    ]);
    expect(forgetExit).toBe(0);
    const beforeInspect = AgentMemoryStoreSchema.parse(await new KnowledgeMemoryStateStore(tmpDir).loadAgentMemoryStore());
    logs = [];

    const inspectExit = await cmdMemory(stateManager, ["inspect", "agent_memory:memory-forget", "--json"]);

    expect(inspectExit).toBe(0);
    const afterInspect = AgentMemoryStoreSchema.parse(await new KnowledgeMemoryStateStore(tmpDir).loadAgentMemoryStore());
    expect(afterInspect).toEqual(beforeInspect);
    const output = logs.join("\n");
    expect(output).not.toContain("memory-forget");
    expect(output).not.toContain(beforeInspect.corrections[0]!.correction_id);
    expect(output).not.toContain(RAW_MEMORY_VALUE);
    expect(output).not.toContain(RAW_REASON);
    const projection = JSON.parse(output) as {
      target_kind: string;
      current_state: string;
      active_for_future_use: boolean;
      raw_content_visible: boolean;
      raw_refs_visible: boolean;
      physical_delete_performed: boolean;
      mutation_performed: boolean;
      history: Array<{ action: string; reason_recorded: boolean }>;
    };
    expect(projection).toMatchObject({
      schema_version: "user-facing-memory-inspect/v1",
      target_kind: "agent_memory",
      current_state: "forgotten",
      active_for_future_use: false,
      raw_content_visible: false,
      raw_refs_visible: false,
      physical_delete_performed: false,
      mutation_performed: false,
      history: [{
        action: "forgotten",
        reason_recorded: true,
      }],
    });
  });

  it("shows corrected memories as inactive without exposing replacement refs or replacement text", async () => {
    const replacementValue = "Replacement value must not render.";
    const correctExit = await cmdMemory(stateManager, [
      "correct",
      "agent_memory:memory-forget",
      "--reason",
      RAW_REASON,
      "--value",
      replacementValue,
      "--replacement-key",
      "replacement-key-must-not-render",
    ]);
    expect(correctExit).toBe(0);
    const store = AgentMemoryStoreSchema.parse(await new KnowledgeMemoryStateStore(tmpDir).loadAgentMemoryStore());
    const replacement = store.entries.find((entry) => entry.supersedes_memory_id === "memory-forget");
    expect(replacement).toBeDefined();
    logs = [];

    const inspectExit = await cmdMemory(stateManager, ["inspect", "agent_memory:memory-forget", "--json"]);

    expect(inspectExit).toBe(0);
    const output = logs.join("\n");
    expect(output).not.toContain("memory-forget");
    expect(output).not.toContain(replacement!.id);
    expect(output).not.toContain("replacement-key-must-not-render");
    expect(output).not.toContain(replacementValue);
    expect(output).not.toContain(RAW_REASON);
    const projection = JSON.parse(output) as {
      current_state: string;
      active_for_future_use: boolean;
      replacement_recorded: boolean;
      history: Array<{ action: string; replacement_recorded: boolean }>;
    };
    expect(projection).toMatchObject({
      current_state: "corrected",
      active_for_future_use: false,
      replacement_recorded: true,
      history: [{
        action: "corrected",
        replacement_recorded: true,
      }],
    });
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

  it("redacts corrected inactive memory from governance export", async () => {
    const correctExit = await cmdMemory(stateManager, [
      "correct",
      "agent_memory:memory-forget",
      "--reason",
      RAW_REASON,
      "--value",
      "Replacement value that may remain active.",
      "--replacement-key",
      "replacement-active",
    ]);
    expect(correctExit).toBe(0);
    logs = [];

    const exitCode = await cmdMemory(stateManager, ["export", "--consent-scope", "local_planning"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.at(-1) ?? "{}") as {
      entries: Array<{ key: string; summary: string | null; status: string }>;
    };
    expect(output.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "[redacted]",
        summary: null,
        status: "corrected",
      }),
      expect.objectContaining({
        key: "replacement-active",
        status: "raw",
      }),
    ]));
    expect(JSON.stringify(output)).not.toContain(RAW_MEMORY_VALUE);
    expect(JSON.stringify(output)).not.toContain("temporary-fact");
  });
});
