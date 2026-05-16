import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { StateManager } from "../../src/base/state/state-manager.js";
import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { inspectUserMemory } from "../../src/platform/corrections/user-memory-operations.js";
import { MemoryTruthMaintenanceStore } from "../../src/runtime/store/memory-truth-maintenance-store.js";
import { RuntimeEventLogStore } from "../../src/runtime/store/runtime-event-log.js";
import {
  compileSoilContextFromRepository,
  SqliteSoilRepository,
} from "../../src/platform/soil/index.js";
import { MemorySaveTool } from "../../src/tools/execution/MemorySaveTool/MemorySaveTool.js";
import { MemoryCorrectionTool } from "../../src/tools/execution/MemoryCorrectionTool/MemoryCorrectionTool.js";
import { MemoryRecallTool } from "../../src/tools/query/MemoryRecallTool/MemoryRecallTool.js";
import type { ToolCallContext } from "../../src/tools/types.js";
import { runProductGauntletScenario } from "../harness/product-gauntlet-runner.js";

describe("memory truth-maintenance product gauntlet", () => {
  it("filters corrected and forgotten memory through save, correction, recall, inspect, Soil, and replay paths", async () => {
    await runProductGauntletScenario("memory_truth_maintenance_projection_replay", async (context) => {
      const stateManager = new StateManager(context.pulseedHome, undefined, { walEnabled: false });
      await stateManager.init();
      const knowledgeManager = new KnowledgeManager(stateManager, {} as ILLMClient);
      const saveTool = new MemorySaveTool(knowledgeManager);
      const correctionTool = new MemoryCorrectionTool(stateManager);
      const recallTool = new MemoryRecallTool(knowledgeManager);
      const toolContext = toolCallContext(context.scenarioId);

      const staleSave = await saveTool.call({
        key: "favorite-editor",
        value: "The user prefers Atom.",
        memory_type: "preference",
        tags: ["editor"],
      }, toolContext);
      const forgottenSave = await saveTool.call({
        key: "old-location",
        value: "The user lives in the old city.",
        memory_type: "fact",
        tags: ["location"],
      }, toolContext);
      const staleId = (staleSave.data as { id: string }).id;
      const forgottenId = (forgottenSave.data as { id: string }).id;

      const correction = await correctionTool.call({
        operation: "correct",
        target_ref: `agent_memory:${staleId}`,
        reason: "User corrected editor preference.",
        replacement_value: "The user prefers VS Code.",
        replacement_key: "favorite-editor-current",
      }, toolContext);
      const forget = await correctionTool.call({
        operation: "forget",
        target_ref: `agent_memory:${forgottenId}`,
        reason: "User asked PulSeed to forget the old location.",
      }, toolContext);
      const recall = await recallTool.call({
        query: "favorite-editor-current",
        mode: "exact",
      }, toolContext);
      const forgottenRecall = await recallTool.call({
        query: "old-location",
        mode: "exact",
      }, toolContext);
      const inspect = await inspectUserMemory(stateManager, {
        targetRef: { kind: "agent_memory", id: staleId },
      });

      const truthStore = new MemoryTruthMaintenanceStore(context.pulseedHome);
      const claims = await truthStore.listClaims({ includeInactive: true });
      const evidenceRefs = await truthStore.listEvidenceRefs();
      const corrections = await truthStore.listCorrections();
      const tombstones = await truthStore.listTombstones();
      const conflictSets = await truthStore.listConflictSets();
      const recallRecords = await truthStore.listRecallRecords();
      const projectionRecords = await truthStore.listProjectionRecords();
      const soilProjection = await fsp.readFile(path.join(context.pulseedHome, "soil", "memory", "index.md"), "utf8");
      const soilRepo = await SqliteSoilRepository.openExisting({ rootDir: path.join(context.pulseedHome, "soil") });
      expect(soilRepo).not.toBeNull();
      const staleSoilLexical = await soilRepo!.searchLexical({ query: "Atom old city", limit: 10 });
      const activeSoilLexical = await soilRepo!.searchLexical({ query: "VS Code", limit: 10 });
      const compiledStaleSoilContext = await compileSoilContextFromRepository({
        retrievalId: "memory-truth-product-gauntlet-stale-soil",
        fallbackQuery: "Atom old city",
        fallbackCandidates: staleSoilLexical,
        now: () => new Date("2026-05-16T00:00:00.000Z"),
      }, soilRepo!);
      soilRepo!.close();
      const eventLog = new RuntimeEventLogStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir });
      const events = await eventLog.listEvents({ limit: 50 });
      const rebuild = await eventLog.rebuildProjections();

      const restartedState = new StateManager(context.pulseedHome, undefined, { walEnabled: false });
      await restartedState.init();
      const restartedRecall = await new MemoryRecallTool(new KnowledgeManager(restartedState, {} as ILLMClient))
        .call({ query: "favorite-editor-current", mode: "exact" }, toolContext);
      const restartedForgottenRecall = await new MemoryRecallTool(new KnowledgeManager(restartedState, {} as ILLMClient))
        .call({ query: "old-location", mode: "exact" }, toolContext);

      const evidence = {
        ownershipBoundary: {
          mutation_owner: "MemoryTruthMaintenanceStore",
          projection_owner: "MemoryTruthMaintenanceStore + Soil projection",
          transaction_boundary: "MemoryTruthMaintenanceStore.applyCorrectionTransaction",
          state_manager_boundary: "bootstrap/config/debug/import/export compatibility",
        },
        memoryClaims: claims,
        evidenceRefs,
        corrections,
        tombstones,
        conflictSets,
        recallRecords,
        soilProjection: {
          path: path.join(context.pulseedHome, "soil", "memory", "index.md"),
          text: soilProjection,
          stale_lexical_candidates: staleSoilLexical,
          active_lexical_candidates: activeSoilLexical,
          compiled_stale_context: compiledStaleSoilContext,
        },
        normalProjection: {
          entries: (recall.data as { entries: unknown[] }).entries,
          totalFound: (recall.data as { totalFound: number }).totalFound,
        },
        operatorDebugEvidence: {
          inspect,
          projectionRecords,
          correction,
          forget,
        },
        eventLog: events,
        runtimeGraph: rebuild.memory_truth_maintenance_summary,
        replaySummary: {
          restarted_recall: restartedRecall.data,
          restarted_forgotten_recall: restartedForgottenRecall.data,
        },
        safetyInvariants: {
          corrected_old_claim_hidden: true,
          forgotten_claim_hidden: true,
          normal_surface_has_no_internal_refs: true,
          soil_projection_uses_active_replacement: true,
          runtime_event_log_linked: true,
        },
        nextFiles: [
          "src/runtime/store/memory-truth-maintenance-store.ts",
          "src/platform/knowledge/memory-truth-adapter.ts",
          "src/platform/corrections/user-memory-operations.ts",
          "src/tools/query/MemoryRecallTool/MemoryRecallTool.ts",
        ],
      };
      context.recordEvidence(evidence);

      expect(staleSave.success).toBe(true);
      expect(forgottenSave.success).toBe(true);
      expect(correction.success).toBe(true);
      expect(forget.success).toBe(true);
      expect(recall.success).toBe(true);
      expect(forgottenRecall.success).toBe(true);
      expect((recall.data as { entries: unknown[] }).entries).toHaveLength(1);
      expect((forgottenRecall.data as { entries: unknown[] }).entries).toHaveLength(0);
      const normalPayload = JSON.stringify((recall.data as { entries: unknown[] }).entries);
      expect(normalPayload).not.toContain("Atom");
      expect(normalPayload).not.toContain("evidence:");
      expect(normalPayload).not.toContain("tombstone");
      expect(JSON.stringify(forgottenRecall.data)).not.toContain("old city");
      expect(inspect).toMatchObject({
        current_state: "corrected",
        active_for_future_use: false,
        replacement_recorded: true,
        raw_content_visible: false,
      });
      expect(corrections).toHaveLength(2);
      expect(tombstones).toHaveLength(1);
      expect(soilProjection).toContain("favorite-editor-current");
      expect(soilProjection).toContain("VS Code");
      expect(soilProjection).not.toContain("Atom");
      expect(soilProjection).not.toContain("old-location");
      expect(staleSoilLexical).toEqual([]);
      expect(activeSoilLexical.map((candidate) => candidate.snippet).join("\n")).toContain("VS Code");
      expect(compiledStaleSoilContext.items).toEqual([]);
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        "memory.truth_maintenance.recorded",
      ]));
      expect(rebuild.memory_truth_maintenance_summary).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "correction" }),
      ]));
      expect(restartedRecall.data).toMatchObject({ totalFound: 1 });
      expect(restartedForgottenRecall.data).toMatchObject({ totalFound: 0 });
      return evidence;
    });
  });
});

function toolCallContext(scenarioId: string): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: `goal:${scenarioId}`,
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    sessionId: `session:${scenarioId}`,
  };
}
