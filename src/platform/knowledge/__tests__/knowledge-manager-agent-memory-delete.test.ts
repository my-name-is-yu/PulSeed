import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { KnowledgeManager } from "../knowledge-manager.js";
import { AgentMemoryEntrySchema } from "../types/agent-memory.js";

describe("KnowledgeManager physical agent memory delete gate", () => {
  let tmpDir: string;
  let manager: KnowledgeManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-agent-memory-delete-");
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    manager = new KnowledgeManager(stateManager, {} as ILLMClient);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("rejects physical deletion without an explicit repair manifest", async () => {
    await manager.saveAgentMemory({
      key: "user.preference.editor",
      value: "The user prefers Vim.",
      tags: ["preference"],
    });

    await expect(manager.deleteAgentMemory("user.preference.editor")).rejects.toThrow(
      "physical agent memory deletion requires an explicit memory_repair manifest"
    );

    expect(await manager.recallAgentMemory("user.preference.editor", { exact: true })).toEqual([
      expect.objectContaining({
        key: "user.preference.editor",
        value: "The user prefers Vim.",
      }),
    ]);
  });

  it("retains a repair manifest ledger entry when physical deletion is explicitly approved", async () => {
    const saved = await manager.saveAgentMemory({
      key: "repair.orphaned-import",
      value: "Imported duplicate memory that should be removed by repair.",
      tags: ["repair"],
    });

    const removed = await manager.deleteAgentMemory("repair.orphaned-import", {
      caller: "memory_repair",
      targetKey: "repair.orphaned-import",
      reason: "Repair manifest approved removal of an orphaned duplicate import.",
      manifestRef: "memory-repair-manifest:test",
      approvedAt: "2026-05-14T00:00:00.000Z",
    });

    expect(removed).toBe(true);
    const store = await manager.loadAgentMemoryStore();
    expect(store.entries).toHaveLength(0);
    expect(store.corrections).toEqual([
      expect.objectContaining({
        target_ref: { kind: "agent_memory", id: saved.id },
        correction_kind: "forgotten",
        actor: "manual_tool",
        reason: "Repair manifest approved removal of an orphaned duplicate import.",
        audit: expect.objectContaining({
          status: "destructive_delete_requested",
          retained_for_audit: true,
          destructive_delete_approved_at: "2026-05-14T00:00:00.000Z",
        }),
        provenance: expect.objectContaining({
          source: "manual_tool",
          source_ref: "memory-repair-manifest:test",
        }),
      }),
    ]);
  });

  it("prefers deleting the active replacement when duplicate repaired keys exist", async () => {
    const original = await manager.saveAgentMemory({
      key: "repair.reverified-key",
      value: "Original stale value.",
      tags: ["repair"],
    });
    const store = await manager.loadAgentMemoryStore();
    store.entries[0] = AgentMemoryEntrySchema.parse({
      ...store.entries[0]!,
      status: "corrected",
    });
    const activeReplacement = AgentMemoryEntrySchema.parse({
      ...original,
      id: "memory-active-replacement",
      value: "Active replacement value.",
      status: "raw",
      supersedes_memory_id: original.id,
      created_at: "2026-05-14T00:01:00.000Z",
      updated_at: "2026-05-14T00:01:00.000Z",
    });
    store.entries.push(activeReplacement);
    await manager.saveAgentMemoryStore(store);

    const removed = await manager.deleteAgentMemory("repair.reverified-key", {
      caller: "memory_repair",
      targetKey: "repair.reverified-key",
      reason: "Repair manifest approved removal of the active replacement.",
      manifestRef: "memory-repair-manifest:active-replacement",
      approvedAt: "2026-05-14T00:02:00.000Z",
    });

    expect(removed).toBe(true);
    const updated = await manager.loadAgentMemoryStore();
    expect(updated.entries).toEqual([
      expect.objectContaining({
        id: original.id,
        key: "repair.reverified-key",
        status: "corrected",
      }),
    ]);
    expect(updated.corrections.at(-1)).toMatchObject({
      target_ref: { kind: "agent_memory", id: "memory-active-replacement" },
      audit: expect.objectContaining({
        status: "destructive_delete_requested",
      }),
    });
  });
});
