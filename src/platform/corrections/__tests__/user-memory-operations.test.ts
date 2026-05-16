import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { KnowledgeManager } from "../../knowledge/knowledge-manager.js";
import { KnowledgeMemoryStateStore } from "../../knowledge/knowledge-memory-state-store.js";
import { loadAgentMemoryStoreFromTruth } from "../../knowledge/memory-truth-adapter.js";
import { AgentMemoryEntrySchema, type AgentMemoryEntry } from "../../knowledge/types/agent-memory.js";
import { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import { RuntimeEvidenceLedger } from "../../../runtime/store/evidence-ledger.js";
import { MemoryTruthMaintenanceStore } from "../../../runtime/store/memory-truth-maintenance-store.js";
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
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("records a user correction event and keeps stale agent memory out of default recall", async () => {
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
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

  it("records durable admission after committing agent memory correction effects", async () => {
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
      entries: [memoryEntry()],
      corrections: [],
      last_consolidated_at: null,
    });
    const order: string[] = [];
    const originalRecordTrace = PersonalAgentRuntimeStore.prototype.recordTrace;
    vi.spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace")
      .mockImplementation(async function (this: PersonalAgentRuntimeStore, trace) {
        order.push("trace");
        return originalRecordTrace.call(this, trace);
      });
    const originalApply = MemoryTruthMaintenanceStore.prototype.applyCorrectionTransaction;
    vi.spyOn(MemoryTruthMaintenanceStore.prototype, "applyCorrectionTransaction")
      .mockImplementation(async function (this: MemoryTruthMaintenanceStore, input) {
        order.push("truth-transaction");
        return originalApply.call(this, input);
      });

    await runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      reason: "User corrected their editor preference.",
      replacementValue: "The user prefers VS Code.",
      replacementKey: "favorite-editor-current",
      now: "2026-05-02T01:00:00.000Z",
    });

    expect(order.indexOf("trace")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("truth-transaction")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("truth-transaction")).toBeLessThan(order.indexOf("trace"));
  });

  it("does not record durable admission when the truth transaction fails", async () => {
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
      entries: [memoryEntry()],
      corrections: [],
      last_consolidated_at: null,
    });
    const traceSpy = vi.spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace");
    vi.spyOn(MemoryTruthMaintenanceStore.prototype, "applyCorrectionTransaction")
      .mockRejectedValueOnce(new Error("truth unavailable"));

    await expect(runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      reason: "User corrected their editor preference.",
      replacementValue: "The user prefers VS Code.",
      replacementKey: "favorite-editor-current",
      now: "2026-05-02T01:00:00.000Z",
    })).rejects.toThrow("truth unavailable");

    const store = await new KnowledgeMemoryStateStore(tmpDir).loadAgentMemoryStore();
    expect(store.entries).toEqual([memoryEntry()]);
    expect(store.corrections).toEqual([]);
    expect(traceSpy).not.toHaveBeenCalled();
  });

  it("replays the same agent memory correction input without duplicate correction effects", async () => {
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
      entries: [memoryEntry()],
      corrections: [],
      last_consolidated_at: null,
    });
    const input = {
      operation: "correct" as const,
      targetRef: { kind: "agent_memory" as const, id: "memory-old" },
      reason: "User corrected their editor preference.",
      replacementValue: "The user prefers VS Code.",
      replacementKey: "favorite-editor-current",
      now: "2026-05-02T01:00:00.000Z",
    };

    const first = await runUserMemoryOperation(stateManager, input);
    const second = await runUserMemoryOperation(stateManager, input);

    expect(second.correction?.correction_id).toBe(first.correction?.correction_id);
    expect(second.replacement?.ref.id).toBe(first.replacement?.ref.id);
    const store = await loadAgentMemoryStoreFromTruth(tmpDir);
    expect(store.corrections).toHaveLength(1);
    expect(store.entries.filter((entry) => entry.supersedes_memory_id === "memory-old")).toHaveLength(1);
  });

  it("records durable admission before runtime memory correction ledger effects", async () => {
    const order: string[] = [];
    vi.spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace").mockImplementation(async function () {
      order.push("trace");
      return {} as never;
    });
    const originalAppend = RuntimeEvidenceLedger.prototype.appendCorrection;
    vi.spyOn(RuntimeEvidenceLedger.prototype, "appendCorrection")
      .mockImplementation(async function (this: RuntimeEvidenceLedger, correction) {
        order.push("append");
        return originalAppend.call(this, correction);
      });

    await runUserMemoryOperation(stateManager, {
      operation: "forget",
      targetRef: { kind: "runtime_evidence", id: "evidence-1" },
      reason: "User invalidated stale evidence.",
      goalId: "goal-1",
      now: "2026-05-02T03:00:00.000Z",
    });

    expect(order).toEqual(["trace", "append"]);
  });

  it("replays the same runtime memory correction input without duplicate ledger effects", async () => {
    const input = {
      operation: "forget" as const,
      targetRef: { kind: "runtime_evidence" as const, id: "evidence-1" },
      reason: "User invalidated stale evidence.",
      goalId: "goal-1",
      now: "2026-05-02T03:00:00.000Z",
    };

    const first = await runUserMemoryOperation(stateManager, input);
    const second = await runUserMemoryOperation(stateManager, input);

    expect(second.correction?.correction_id).toBe(first.correction?.correction_id);
    const history = await runUserMemoryOperation(stateManager, {
      operation: "history",
      targetRef: { kind: "runtime_evidence", id: "evidence-1" },
      goalId: "goal-1",
    });
    expect(history.history.map((entry) => entry.correction_id)).toEqual([
      first.correction?.correction_id,
    ]);
  });

  it("preserves governance when correcting sensitive user memory", async () => {
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
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
    await new KnowledgeMemoryStateStore(tmpDir).saveAgentMemoryStore({
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
