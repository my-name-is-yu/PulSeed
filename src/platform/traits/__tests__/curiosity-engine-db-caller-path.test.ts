import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPostLoopHooks } from "../../../orchestrator/loop/post-loop-hooks.js";
import { CuriosityStateStore } from "../../../runtime/store/curiosity-state-store.js";
import { CuriosityEngine } from "../curiosity-engine.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

describe("CuriosityEngine database caller path", () => {
  it("persists post-loop curiosity proposals through the typed store without legacy state JSON", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "curiosity-post-loop-"));
    try {
      const stateManager = {
        getBaseDir: vi.fn().mockReturnValue(tmpDir),
        loadGoal: vi.fn().mockResolvedValue(makeGoal({
          id: "goal-1",
          status: "completed",
          origin: null,
        })),
        saveGoal: vi.fn().mockResolvedValue(undefined),
      } as any;
      const curiosityStateStore = new CuriosityStateStore(tmpDir);
      const curiosityEngine = new CuriosityEngine({
        stateManager,
        curiosityStateStore,
        llmClient: {
          sendMessage: vi.fn().mockResolvedValue({ content: "[]" }),
          parseJSON: vi.fn().mockReturnValue([
            {
              description: "Inspect post-loop database-first curiosity state",
              rationale: "The post-loop caller path should persist through control DB ownership.",
              suggested_dimensions: [],
              scope_domain: "runtime",
              detection_method: "periodic_review",
            },
          ]),
        } as any,
        ethicsGate: {
          check: vi.fn().mockResolvedValue({ verdict: "pass" }),
        } as any,
        stallDetector: {
          getStallState: vi.fn().mockResolvedValue({
            goal_id: "goal-1",
            dimension_escalation: {},
            global_escalation: 0,
            decay_factors: {},
            recovery_loops: {},
          }),
        } as any,
        driveSystem: {
          schedule: vi.fn(),
        } as any,
      });

      await runPostLoopHooks({
        goalId: "goal-1",
        sessionId: "session-1",
        completedAt: "2026-05-10T00:00:00.000Z",
        totalTokensUsed: 0,
        finalStatus: "max_iterations",
        iterations: [],
        deps: {
          stateManager,
          curiosityEngine,
        } as any,
        config: {
          dryRun: true,
          autoConsolidateOnComplete: false,
        } as any,
        logger: undefined,
        tryGenerateReport: vi.fn(),
      });

      const persisted = await curiosityStateStore.load();
      expect(persisted?.proposals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          proposed_goal: expect.objectContaining({
            description: "Inspect post-loop database-first curiosity state",
          }),
        }),
      ]));
      expect(fs.existsSync(path.join(tmpDir, "curiosity", "state.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
