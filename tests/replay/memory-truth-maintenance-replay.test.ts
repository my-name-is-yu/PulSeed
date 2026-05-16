import * as fsp from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { StateManager } from "../../src/base/state/state-manager.js";
import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { loadAgentMemoryStoreFromTruth } from "../../src/platform/knowledge/memory-truth-adapter.js";
import { MemoryTruthMaintenanceStore } from "../../src/runtime/store/memory-truth-maintenance-store.js";

describe("memory truth-maintenance restart/replay invariants", () => {
  it("recreates runtime stores without duplicate corrections or stale resurrection", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pulseed-memory-truth-replay-"));
    try {
      const state = new StateManager(root, undefined, { walEnabled: false });
      await state.init();
      const manager = new KnowledgeManager(state, {} as ILLMClient);

      const stale = await manager.saveAgentMemory({
        key: "favorite-editor",
        value: "The user prefers Atom.",
        tags: ["editor"],
        memory_type: "preference",
      });
      const disposable = await manager.saveAgentMemory({
        key: "temporary-location",
        value: "The user lives in the old city.",
        tags: ["location"],
        memory_type: "fact",
      });

      const correctionInput = {
        operation: "correct" as const,
        targetRef: { kind: "agent_memory" as const, id: stale.id },
        reason: "User corrected their editor preference.",
        replacementValue: "The user prefers VS Code.",
        replacementKey: "favorite-editor-current",
        now: "2026-05-16T00:10:00.000Z",
      };
      const firstCorrection = await runUserMemoryOperation(state, correctionInput);
      const duplicateCorrection = await runUserMemoryOperation(state, correctionInput);
      const forgetResult = await runUserMemoryOperation(state, {
        operation: "forget",
        targetRef: { kind: "agent_memory", id: disposable.id },
        reason: "User asked to forget the old city.",
        now: "2026-05-16T00:11:00.000Z",
      });

      const conflictStore = new MemoryTruthMaintenanceStore(root, { appendRuntimeEvents: false });
      await conflictStore.saveOwnerSnapshot({
        ownerKind: "agent_memory_conflict_replay",
        ownerScope: "default",
        claims: [
          conflictClaim("conflict:one", "timezone", "UTC"),
          conflictClaim("conflict:two", "timezone", "Asia/Tokyo"),
        ],
        conflictSets: [{
          conflict_set_id: "conflict:set:timezone",
          claim_ids: ["conflict:one", "conflict:two"],
          status: "held",
          resolution_claim_id: null,
          reason: "Two timezone claims conflict and must stay held after restart.",
          created_at: "2026-05-16T00:12:00.000Z",
          updated_at: "2026-05-16T00:12:00.000Z",
          operator_explanation_refs: ["operator:memory-conflict"],
        }],
        emitRuntimeEvent: false,
      });

      const restartedState = new StateManager(root, undefined, { walEnabled: false });
      await restartedState.init();
      const restartedManager = new KnowledgeManager(restartedState, {} as ILLMClient);
      const replayCorrection = await runUserMemoryOperation(restartedState, correctionInput);
      const exactReplacement = await restartedManager.recallAgentMemoryWithProvenance("favorite-editor-current", { mode: "exact" });
      const staleRecall = await restartedManager.recallAgentMemory("favorite-editor", { mode: "exact" });
      const forgottenRecall = await restartedManager.recallAgentMemory("temporary-location", { mode: "exact" });
      const truthStore = await loadAgentMemoryStoreFromTruth(root);
      const replayedTruth = new MemoryTruthMaintenanceStore(root);
      const recallRecords = await replayedTruth.listRecallRecords();
      const conflictSets = await replayedTruth.listConflictSets();
      const soilPage = await fsp.readFile(path.join(root, "soil", "memory", "index.md"), "utf8");

      expect(duplicateCorrection.correction?.correction_id).toBe(firstCorrection.correction?.correction_id);
      expect(replayCorrection.correction?.correction_id).toBe(firstCorrection.correction?.correction_id);
      expect(truthStore.corrections.filter((entry) => entry.correction_id === firstCorrection.correction?.correction_id)).toHaveLength(1);
      expect(truthStore.corrections.filter((entry) => entry.correction_id === forgetResult.correction?.correction_id)).toHaveLength(1);
      expect(exactReplacement.entries).toEqual([
        expect.objectContaining({
          key: "favorite-editor-current",
          value: "The user prefers VS Code.",
          supersedes_memory_id: stale.id,
        }),
      ]);
      expect(staleRecall).toEqual([]);
      expect(forgottenRecall).toEqual([]);
      expect(conflictSets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          conflict_set_id: "conflict:set:timezone",
          status: "held",
          claim_ids: ["conflict:one", "conflict:two"],
        }),
      ]));
      expect(recallRecords).toEqual(expect.arrayContaining([
        expect.objectContaining({
        mode: "exact",
        result_claims: [expect.objectContaining({ claim_id: firstCorrection.replacement?.ref.id })],
        }),
      ]));
      expect(soilPage).toContain("favorite-editor-current");
      expect(soilPage).toContain("VS Code");
      expect(soilPage).not.toContain("Atom");
      expect(soilPage).not.toContain("temporary-location");

      const distinctCorrection = await runUserMemoryOperation(restartedState, {
        operation: "retract",
        targetRef: { kind: "agent_memory", id: firstCorrection.replacement!.ref.id },
        reason: "User retracted the replacement after replay validation.",
        now: "2026-05-16T00:13:00.000Z",
      });
      const afterDistinct = await loadAgentMemoryStoreFromTruth(root);
      expect(distinctCorrection.correction?.correction_id).not.toBe(firstCorrection.correction?.correction_id);
      expect(afterDistinct.corrections.map((entry) => entry.correction_id)).toEqual(expect.arrayContaining([
        firstCorrection.correction!.correction_id,
        forgetResult.correction!.correction_id,
        distinctCorrection.correction!.correction_id,
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function conflictClaim(claimId: string, subject: string, value: string) {
  return {
    claim_id: claimId,
    owner_kind: "agent_memory_conflict_replay",
    owner_scope: "default",
    claim_type: "fact" as const,
    subject,
    predicate: "has_value",
    object: { value },
    source_evidence_refs: [`evidence:${claimId}`],
    confidence: 0.5,
    trust_state: "unverified" as const,
    sensitivity: "local" as const,
    consent_scope: "local_planning",
    lifecycle: "active" as const,
    created_at: "2026-05-16T00:12:00.000Z",
    updated_at: "2026-05-16T00:12:00.000Z",
    visible_to_normal_surface: true,
  };
}
