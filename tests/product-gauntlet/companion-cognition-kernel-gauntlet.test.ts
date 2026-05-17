import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../src/base/state/state-manager.js";
import { RuntimeControlService } from "../../src/runtime/control/runtime-control-service.js";
import {
  PersonalAgentRuntimeStore,
  type PersonalAgentDecisionTrace,
} from "../../src/runtime/personal-agent/index.js";
import { recordScheduleJobDecision } from "../../src/runtime/schedule/personal-agent-trace.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { runProductGauntletScenario } from "../harness/product-gauntlet-runner.js";

describe("companion cognition kernel product gauntlet", () => {
  it("routes schedule, runtime-control, and memory-truth decisions through advisory kernel outputs", async () => {
    await runProductGauntletScenario("companion_cognition_kernel_boundaries", async (context) => {
      const traces: PersonalAgentDecisionTrace[] = [];
      const traceSink = {
        recordTrace: vi.fn(async (trace: PersonalAgentDecisionTrace) => {
          traces.push(trace);
          return {} as never;
        }),
      };

      await recordScheduleJobDecision({
        personalAgentRuntime: traceSink,
        entry: {
          id: "schedule:kernel-gauntlet",
          name: "Kernel gauntlet probe",
          layer: "probe",
        },
        firedAt: context.fakeClock.now,
        scheduledFor: context.fakeClock.now,
        jobKind: "probe",
        actionKind: "health_probe",
        decision: "allow",
        capabilityDecision: "available",
        decisionReason: "Schedule probe must pass through the companion cognition kernel before trace materialization.",
        currentRefs: [{ kind: "runtime_event", ref: "runtime-event:schedule:kernel-gauntlet" }],
      });

      const runtimeService = new RuntimeControlService({
        runtimeRoot: context.runtimeRoot,
        personalAgentRuntime: traceSink,
        now: () => new Date(context.fakeClock.now),
        executor: vi.fn().mockResolvedValue({ ok: true, state: "verified", message: "config reloaded" }),
      });
      const runtimeResult = await runtimeService.request({
        intent: { kind: "reload_config", reason: "product gauntlet reload" },
        cwd: context.rootDir,
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      const memorySpy = vi
        .spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace")
        .mockImplementation(async (_trace) => {
          traces.push(_trace);
          return {} as never;
        });
      try {
        const stateManager = new StateManager(context.controlBaseDir);
        await stateManager.init();
        await runUserMemoryOperation(stateManager, {
          operation: "forget",
          targetRef: { kind: "runtime_evidence", id: "evidence-kernel-gauntlet" },
          reason: "User invalidated stale runtime evidence before future behavior can use it.",
          goalId: "goal:kernel-gauntlet",
          now: context.fakeClock.now,
        });
      } finally {
        memorySpy.mockRestore();
      }

      const callerPaths = traces.map((trace) => trace.situation_frame.cognition_situation?.caller_path);
      expect(runtimeResult).toMatchObject({ success: true, state: "verified" });
      expect(callerPaths).toEqual(expect.arrayContaining([
        "schedule_wake",
        "runtime_control_response",
        "memory_truth_operation",
      ]));
      for (const trace of traces) {
        expect(trace.situation_frame.normal_surface_trace_visible).toBe(false);
        expect(trace.situation_frame.policy_refs).toEqual([
          expect.objectContaining({ kind: "response_plan" }),
        ]);
        expect(trace.situation_frame.current_refs).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "cognition_response_plan" }),
        ]));
        expect(trace.intervention_decisions[0]?.policy_ref).toEqual(expect.objectContaining({
          kind: "response_plan",
        }));
        expect(trace.initiative_events.flatMap((event) => event.audit_refs)).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "cognition_audit" }),
        ]));
      }

      context.recordEvidence({
        replaySummary: {
          trace_ids: traces.map((trace) => trace.trace_id),
          caller_paths: callerPaths,
          response_plan_refs: traces.flatMap((trace) =>
            trace.situation_frame.current_refs.filter((ref) => ref.kind === "cognition_response_plan")),
        },
        safetyInvariants: {
          kernel_outputs_are_advisory: true,
          normal_surface_trace_visible: false,
          schedule_runtime_control_memory_truth_share_kernel: true,
        },
      });
    });
  });
});
