import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { KnowledgeManager } from "../../knowledge/knowledge-manager.js";
import { AGENT_MEMORY_PATH } from "../../knowledge/knowledge-manager-internals.js";
import { AgentMemoryEntrySchema, type AgentMemoryEntry } from "../../knowledge/types/agent-memory.js";
import { runUserMemoryOperation } from "../user-memory-operations.js";

function memoryEntry(overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return AgentMemoryEntrySchema.parse({
    id: "memory-old",
    key: "favorite-editor",
    value: "The user prefers Atom.",
    tags: ["preference"],
    memory_type: "preference",
    status: "raw",
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  });
}

describe("user memory correction operations", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-user-memory-ops-");
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("records a user correction event and keeps stale agent memory out of default recall", async () => {
    await stateManager.writeRaw(AGENT_MEMORY_PATH, {
      entries: [memoryEntry()],
      corrections: [],
      last_consolidated_at: null,
    });

    const result = await runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      reason: "User corrected their editor preference.",
      replacementValue: "The user prefers VS Code.",
      replacementKey: "favorite-editor-current",
      now: "2026-05-02T01:00:00.000Z",
    });

    expect(result.correction).toMatchObject({
      target_ref: { kind: "agent_memory", id: "memory-old" },
      correction_kind: "corrected",
      actor: "user",
    });
    expect(result.replacement?.ref.kind).toBe("agent_memory");

    const manager = new KnowledgeManager(stateManager, {} as ILLMClient);
    expect(await manager.recallAgentMemory("favorite-editor", { exact: true })).toEqual([]);
    expect(await manager.recallAgentMemory("favorite-editor-current", { exact: true })).toEqual([
      expect.objectContaining({
        key: "favorite-editor-current",
        value: "The user prefers VS Code.",
        supersedes_memory_id: "memory-old",
      }),
    ]);

    const store = await manager.loadAgentMemoryStore();
    expect(store.entries.find((entry) => entry.id === "memory-old")).toMatchObject({
      status: "corrected",
      correction_state: { status: "corrected", active: false, retained_for_audit: true },
    });
    expect(store.corrections).toHaveLength(1);
  });

  it("preserves governance when correcting sensitive user memory", async () => {
    await stateManager.writeRaw(AGENT_MEMORY_PATH, {
      entries: [
        memoryEntry({
          governance: {
            sensitivity: "secret",
            consent: {
              scope_id: "private_chat",
              allowed_contexts: ["private_chat"],
              source_actor: "user",
              collection_context: "chat",
            },
            retention: {
              policy_id: "retain_until_retracted",
              retain_until: null,
              review_after: null,
              delete_requires_approval: true,
            },
            export_visibility: "redacted",
            owner_ref: "user",
          },
        }),
      ],
      corrections: [],
      last_consolidated_at: null,
    });

    await runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      reason: "User corrected a sensitive detail.",
      replacementValue: "Corrected sensitive detail.",
      replacementKey: "sensitive-detail-current",
      now: "2026-05-02T01:00:00.000Z",
    });

    const manager = new KnowledgeManager(stateManager, {} as ILLMClient);
    expect(await manager.recallAgentMemory("sensitive-detail-current", {
      exact: true,
      consent_scope: "local_planning",
      max_sensitivity: "local",
    })).toEqual([]);
    expect(await manager.recallAgentMemory("sensitive-detail-current", {
      exact: true,
      consent_scope: "private_chat",
      max_sensitivity: "secret",
    })).toEqual([
      expect.objectContaining({
        key: "sensitive-detail-current",
        governance: expect.objectContaining({
          sensitivity: "secret",
          export_visibility: "redacted",
        }),
      }),
    ]);
  });

  it("redacts forgotten user memory from governance exports while retaining audit metadata", async () => {
    await stateManager.writeRaw(AGENT_MEMORY_PATH, {
      entries: [memoryEntry({
        summary: "The user's old private editor preference.",
        governance: {
          sensitivity: "local",
          export_visibility: "listed",
          consent: {
            scope_id: "local",
            allowed_contexts: ["local_planning"],
            source_actor: "user",
            collection_context: "chat",
          },
          retention: {
            policy_id: "retain_until_retracted",
            retain_until: null,
            review_after: null,
            delete_requires_approval: true,
          },
          owner_ref: "user",
        },
      })],
      corrections: [],
      last_consolidated_at: null,
    });

    await runUserMemoryOperation(stateManager, {
      operation: "forget",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      reason: "User asked PulSeed to forget this preference.",
      now: "2026-05-02T02:00:00.000Z",
    });

    const manager = new KnowledgeManager(stateManager, {} as ILLMClient);
    const exported = await manager.exportAgentMemoryGovernance({
      consent_scope: "local_planning",
    });

    expect(exported).toEqual([
      expect.objectContaining({
        id: "memory-old",
        key: "[redacted]",
        summary: null,
        status: "forgotten",
        governance: expect.any(Object),
      }),
    ]);
    expect(JSON.stringify(exported)).not.toContain("Atom");
    expect(JSON.stringify(exported)).not.toContain("old private editor preference");
  });
});
