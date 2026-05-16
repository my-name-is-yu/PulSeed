import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { StateManager } from "../../src/base/state/state-manager.js";
import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { MemoryTruthMaintenanceStore } from "../../src/runtime/store/memory-truth-maintenance-store.js";
import { MemorySaveTool } from "../../src/tools/execution/MemorySaveTool/MemorySaveTool.js";
import { MemoryCorrectionTool } from "../../src/tools/execution/MemoryCorrectionTool/MemoryCorrectionTool.js";
import { MemoryRecallTool } from "../../src/tools/query/MemoryRecallTool/MemoryRecallTool.js";
import type { ToolCallContext } from "../../src/tools/types.js";

describe("memory truth-maintenance production contract", () => {
  it("routes save, correction, forget, recall, and projection through typed owner records", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pulseed-memory-truth-contract-"));
    try {
      const stateManager = new StateManager(root, undefined, { walEnabled: false });
      await stateManager.init();
      const knowledgeManager = new KnowledgeManager(stateManager, {} as ILLMClient);
      const context = toolContext();
      const save = new MemorySaveTool(knowledgeManager);
      const correction = new MemoryCorrectionTool(stateManager);
      const recall = new MemoryRecallTool(knowledgeManager);

      const stale = await save.call({
        key: "preferred-editor",
        value: "The user prefers Atom.",
        memory_type: "preference",
      }, context);
      const staleId = (stale.data as { id: string }).id;

      const corrected = await correction.call({
        operation: "correct",
        target_ref: `agent_memory:${staleId}`,
        replacement_value: "The user prefers VS Code.",
        replacement_key: "preferred-editor-current",
        reason: "User corrected the editor preference.",
      }, context);
      const oldRecall = await recall.call({ query: "preferred-editor", mode: "exact" }, context);
      const newRecall = await recall.call({ query: "preferred-editor-current", mode: "exact" }, context);
      const semanticUnavailable = await recall.call({ query: "editor preference" }, context);
      const store = new MemoryTruthMaintenanceStore(root);
      const claims = await store.listClaims({ includeInactive: true });
      const corrections = await store.listCorrections();
      const projections = await store.listProjectionRecords();
      const recalls = await store.listRecallRecords();

      expect(corrected.success).toBe(true);
      expect(oldRecall.data).toMatchObject({ entries: [], totalFound: 0 });
      expect(newRecall.data).toMatchObject({
        totalFound: 1,
        recall: {
          mode: "exact",
          resultClaims: [expect.objectContaining({
            correction_status: "active",
            invalidation_status: "valid",
            safe_for_normal_projection: true,
          })],
        },
      });
      expect(semanticUnavailable.data).toMatchObject({
        totalFound: 0,
        recall: {
          mode: "semantic_unavailable",
          semanticIndexStatus: "unavailable",
        },
      });
      expect(claims).toEqual(expect.arrayContaining([
        expect.objectContaining({
          claim_id: staleId,
          lifecycle: "corrected",
          visible_to_normal_surface: false,
        }),
        expect.objectContaining({
          subject: "preferred-editor-current",
          lifecycle: "active",
          visible_to_normal_surface: true,
        }),
      ]));
      expect(corrections).toHaveLength(1);
      expect(projections).toEqual(expect.arrayContaining([
        expect.objectContaining({ projection_kind: "normal_surface" }),
        expect.objectContaining({ projection_kind: "soil" }),
        expect.objectContaining({ projection_kind: "operator_debug" }),
      ]));
      expect(recalls.map((entry) => entry.mode)).toEqual(expect.arrayContaining([
        "exact",
        "semantic_unavailable",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function toolContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal:memory-truth-contract",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    sessionId: "session:memory-truth-contract",
  };
}
