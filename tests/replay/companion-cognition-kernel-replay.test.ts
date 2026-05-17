import { describe, expect, it, vi } from "vitest";
import { recordScheduleWaitResumeDecision } from "../../src/runtime/schedule/personal-agent-trace.js";
import type { PersonalAgentDecisionTrace } from "../../src/runtime/personal-agent/index.js";

describe("companion cognition kernel replay invariants", () => {
  it("keeps schedule-wake cognition refs stable for the same due instance replay", async () => {
    const traces: PersonalAgentDecisionTrace[] = [];
    const personalAgentRuntime = {
      recordTrace: vi.fn(async (trace: PersonalAgentDecisionTrace) => {
        traces.push(trace);
        return {} as never;
      }),
    };
    const input = {
      personalAgentRuntime,
      entry: {
        id: "schedule:kernel-replay",
        name: "Kernel replay wait resume",
        layer: "goal_trigger" as const,
        metadata: {
          strategy_id: "strategy:kernel-replay",
          wait_strategy_id: "strategy:kernel-replay",
        },
      },
      goalId: "goal:kernel-replay",
      firedAt: "2026-05-16T00:00:05.000Z",
      scheduledFor: "2026-05-16T00:00:00.000Z",
      signalContextId: "signal:schedule-wake:schedule:kernel-replay:2026-05-16T00:00:00.000Z",
      decision: "allow" as const,
      capabilityDecision: "available" as const,
      decisionReason: "Replay should preserve cognition identity for the same scheduled wake.",
      currentRefs: [{ kind: "runtime_event", ref: "runtime-event:schedule:kernel-replay" }],
      staleRefs: [{ kind: "run", ref: "run:previous" }],
      auditRefs: [{ kind: "schedule_audit", ref: "schedule:audit:kernel-replay" }],
    };

    await recordScheduleWaitResumeDecision(input);
    await recordScheduleWaitResumeDecision(input);

    expect(personalAgentRuntime.recordTrace).toHaveBeenCalledTimes(2);
    expect(traces).toHaveLength(2);
    expect(traces[1]?.trace_id).toBe(traces[0]?.trace_id);
    expect(traces[1]?.replay_key).toBe(traces[0]?.replay_key);
    expect(traces[1]?.situation_frame.cognition_situation).toEqual(traces[0]?.situation_frame.cognition_situation);
    expect(traces[0]?.situation_frame.cognition_situation).toMatchObject({
      caller_path: "schedule_wake",
      stale_target_refs: [{ kind: "run", ref: "run:previous" }],
      current_target_refs: expect.arrayContaining([
        { kind: "schedule_entry", ref: "schedule:kernel-replay" },
        { kind: "goal", ref: "goal:kernel-replay" },
        { kind: "runtime_event", ref: "runtime-event:schedule:kernel-replay" },
      ]),
    });
    expect(traces[0]?.situation_frame.current_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "cognition_response_plan" }),
    ]));
    expect(traces[0]?.initiative_events.flatMap((event) => event.audit_refs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "cognition_audit" }),
    ]));
  });
});
