import { describe, expect, it } from "vitest";
import {
  AttentionInputSchema,
  buildSchedulerWakeAttentionInputs,
  buildSignalContextFromAttentionInputs,
  createAttentionInput,
  createExperienceLearningDiagnosticAttentionInput,
  createAttentionInputIntakePort,
  dedupeAttentionInputs,
  ref,
} from "../index.js";

const NOW = "2026-05-12T00:00:00.000Z";

describe("AttentionInput intake", () => {
  it("normalizes all non-GUI signal sources before SignalContext assembly", () => {
    const inputs = [
      createAttentionInput({
        source_kind: "schedule",
        source_id: "schedule:goal-trigger",
        source_epoch: "schedule-engine:1",
        high_watermark: "tick:10",
        emitted_at: NOW,
        payload_class: "schedule.goal_trigger",
        summary: "User-created schedule became due.",
        current_goal_refs: [ref("goal", "goal:scheduled")],
      }),
      createAttentionInput({
        source_kind: "daemon_tick",
        source_id: "daemon:proactive:10",
        source_epoch: "daemon-loop:1",
        high_watermark: "tick:10",
        emitted_at: NOW,
        payload_class: "daemon.proactive_tick",
        summary: "Daemon proactive tick produced an internal signal.",
      }),
      createAttentionInput({
        source_kind: "resident_curiosity",
        source_id: "curiosity:compare:1",
        emitted_at: NOW,
        payload_class: "resident.curiosity",
        summary: "Resident curiosity noticed a comparison worth tracking.",
      }),
      createAttentionInput({
        source_kind: "resident_proactive_maintenance",
        source_id: "maintenance:dream:1",
        emitted_at: NOW,
        payload_class: "resident.proactive_maintenance",
        summary: "Resident maintenance found a quiet preparation candidate.",
      }),
      createAttentionInput({
        source_kind: "runtime_event",
        source_id: "runtime:event:1",
        emitted_at: NOW,
        payload_class: "runtime.event",
        summary: "Runtime emitted a state transition.",
      }),
      createAttentionInput({
        source_kind: "gateway_user_activity",
        source_id: "telegram:user:1:message:1",
        emitted_at: NOW,
        payload_class: "gateway.user_activity",
        summary: "Gateway user activity arrived.",
        current_session_refs: [ref("session", "session:gateway")],
      }),
      createAttentionInput({
        source_kind: "surface_memory",
        source_id: "memory:surface:1",
        emitted_at: NOW,
        payload_class: "surface.memory_ref",
        summary: "Surface memory can affect attention priority.",
        active_surface_ref: ref("surface", "surface:current"),
      }),
      createAttentionInput({
        source_kind: "feedback",
        source_id: "feedback:dismissal:1",
        emitted_at: NOW,
        payload_class: "feedback.dismissal",
        summary: "Recent feedback should lower future interruption pressure.",
      }),
    ];

    const context = buildSignalContextFromAttentionInputs({
      signal_context_id: "signal:attention-input:all",
      assembled_at: NOW,
      inputs,
    });

    expect(context.signal_sources).toEqual([
      "schedule_tick",
      "daemon",
      "curiosity",
      "resident",
      "runtime_event",
      "user_activity",
      "memory",
      "surface",
      "feedback",
    ]);
    expect(context.signal_refs.map((source) => source.ref.kind)).toEqual([
      "schedule_tick",
      "runtime_event",
      "curiosity",
      "runtime_event",
      "runtime_event",
      "user_activity",
      "memory",
      "surface",
      "feedback",
    ]);
    expect(context.active_surface_ref).toEqual(ref("surface", "surface:current"));
    expect(context.current_goal_refs).toEqual([ref("goal", "goal:scheduled")]);
    expect(context.current_session_refs).toEqual([ref("session", "session:gateway")]);
    expect(context.runtime_state_refs).toEqual([
      ref("runtime_event", "daemon:daemon:proactive:10"),
      ref("runtime_event", "resident-proactive:maintenance:dream:1"),
      ref("runtime_event", "runtime:event:1"),
    ]);
    expect(context.user_activity_refs).toEqual([ref("user_activity", "telegram:user:1:message:1")]);
  });

  it("keeps wake separate from notify, speech, and action", () => {
    const input = createAttentionInput({
      source_kind: "schedule",
      source_id: "wait:1",
      emitted_at: NOW,
      payload_class: "schedule.wait_resume",
      summary: "Wait resume should only wake internal attention.",
    });

    expect(input.effect_policy).toEqual({
      wake: true,
      notify: false,
      speak: false,
      act: false,
    });
    expect(() =>
      AttentionInputSchema.parse({
        ...input,
        effect_policy: {
          wake: true,
          notify: true,
          speak: false,
          act: false,
        },
      })
    ).toThrow();
    expect(() =>
      AttentionInputSchema.parse({
        ...input,
        effect_policy: {
          wake: true,
          notify: false,
          speak: true,
          act: false,
        },
      })
    ).toThrow();
    expect(() =>
      AttentionInputSchema.parse({
        ...input,
        effect_policy: {
          wake: true,
          notify: false,
          speak: false,
          act: true,
        },
      })
    ).toThrow();
  });

  it("keeps experience-learning runtime-event attention diagnostic-only", () => {
    const input = createExperienceLearningDiagnosticAttentionInput({
      runtime_event_id: "runtime-event:experience-learning:1",
      emitted_at: NOW,
      summary: "Experience learning produced diagnostic salience.",
      learning_ref: ref("runtime_event", "experience-learning:prior-1"),
      current_goal_refs: [ref("goal", "goal-1")],
    });

    expect(input).toEqual(expect.objectContaining({
      admission_eligibility: "diagnostic_only",
      may_mature: false,
      active_surface_ref: null,
      relationship_permission_refs: [],
      effect_policy: {
        wake: false,
        notify: false,
        speak: false,
        act: false,
      },
    }));

    const normalRuntime = createAttentionInput({
      source_kind: "runtime_event",
      source_id: "runtime-event:normal:1",
      emitted_at: NOW,
      payload_class: "runtime.event",
      summary: "Normal runtime event can contribute an active signal.",
    });
    const context = buildSignalContextFromAttentionInputs({
      signal_context_id: "signal:learning-diagnostic",
      assembled_at: NOW,
      inputs: [normalRuntime, input],
    });
    expect(context.signal_sources).toEqual(["runtime_event"]);
    expect(context.active_surface_ref).toBeNull();
    expect(context.current_goal_refs).toEqual([]);
    expect(context.runtime_state_refs).toEqual([
      ref("runtime_event", "runtime-event:normal:1"),
      ref("runtime_event", "runtime-event:experience-learning:1"),
      ref("runtime_event", "experience-learning:prior-1"),
    ]);

    const artifactDiagnostic = createExperienceLearningDiagnosticAttentionInput({
      runtime_event_id: "runtime-event:experience-learning:2",
      emitted_at: NOW,
      summary: "Experience learning artifact produced diagnostic salience.",
      learning_ref: ref("runtime_item", "learning-artifact:1"),
    });
    expect(artifactDiagnostic.runtime_state_refs).toEqual([
      ref("runtime_event", "runtime-event:experience-learning:2"),
      ref("runtime_item", "learning-artifact:1"),
    ]);

    expect(() =>
      AttentionInputSchema.parse({
        ...input,
        effect_policy: { wake: true, notify: false, speak: false, act: false },
      })
    ).toThrow(/cannot wake/);
    expect(() =>
      AttentionInputSchema.parse({
        ...input,
        may_mature: true,
      })
    ).toThrow(/may not mature/);
    expect(() =>
      AttentionInputSchema.parse({
        ...input,
        active_surface_ref: ref("surface", "surface:normal"),
      })
    ).toThrow(/active surface/);
  });

  it("rejects signal source overrides that do not match the source kind", () => {
    expect(() =>
      createAttentionInput({
        source_kind: "gateway_user_activity",
        source_id: "telegram:user:1:message:mismatch",
        emitted_at: NOW,
        payload_class: "gateway.message",
        summary: "Gateway user activity cannot masquerade as a runtime event.",
        signal_source: "runtime_event",
      })
    ).toThrow('signal_source "runtime_event" is not allowed for attention input source_kind "gateway_user_activity"');

    expect(() =>
      createAttentionInput({
        source_kind: "schedule",
        source_id: "wait:strategy-1",
        emitted_at: NOW,
        payload_class: "schedule.wait_resume",
        summary: "Wait expiry must carry a wait ref, not the schedule-tick default.",
        signal_source: "wait_expiry",
      })
    ).toThrow('signal_ref is required for attention input signal_source "wait_expiry"');

    expect(() =>
      createAttentionInput({
        source_kind: "schedule",
        source_id: "wait:strategy-1",
        emitted_at: NOW,
        payload_class: "schedule.wait_resume",
        summary: "Wait expiry is an allowed schedule signal source.",
        signal_ref: ref("wait", "strategy-1"),
        signal_source: "wait_expiry",
      })
    ).not.toThrow();
  });

  it("rejects raw AttentionInput records with inconsistent source and ref contracts", () => {
    const gateway = createAttentionInput({
      source_kind: "gateway_user_activity",
      source_id: "telegram:user:1:message:raw",
      emitted_at: NOW,
      payload_class: "gateway.message",
      summary: "Gateway user activity arrived.",
    });

    expect(AttentionInputSchema.safeParse({
      ...gateway,
      signal_ref: {
        ...gateway.signal_ref,
        ref: ref("runtime_event", "runtime:event:wrong-ref"),
      },
    }).success).toBe(false);

    expect(AttentionInputSchema.safeParse({
      ...gateway,
      signal_source: "runtime_event",
    }).success).toBe(false);

    const scheduleTick = createAttentionInput({
      source_kind: "schedule",
      source_id: "schedule:entry:raw",
      emitted_at: NOW,
      payload_class: "schedule.wait_resume",
      summary: "Schedule wake arrived.",
    });

    expect(AttentionInputSchema.safeParse({
      ...scheduleTick,
      signal_source: "wait_expiry",
    }).success).toBe(false);
  });

  it("uses stable default replay keys for schedule, proactive, and gateway sources", () => {
    const cases = [
      {
        source_kind: "schedule" as const,
        source_id: "schedule:entry:stable",
        payload_class: "schedule.wait_resume",
        summary: "Schedule wake replayed with a different emitted timestamp.",
      },
      {
        source_kind: "resident_proactive_maintenance" as const,
        source_id: "resident:maintenance:stable",
        payload_class: "resident.proactive_maintenance",
        summary: "Resident maintenance replayed with a different emitted timestamp.",
      },
      {
        source_kind: "gateway_user_activity" as const,
        source_id: "telegram:chat:1:update:stable",
        payload_class: "gateway.message",
        summary: "Gateway update replayed with a different emitted timestamp.",
      },
    ];

    for (const candidate of cases) {
      const first = createAttentionInput({
        ...candidate,
        emitted_at: NOW,
      });
      const replay = createAttentionInput({
        ...candidate,
        emitted_at: "2026-05-12T00:03:00.000Z",
      });

      const result = dedupeAttentionInputs([first, replay]);

      expect(result.accepted).toEqual([first]);
      expect(result.duplicates).toMatchObject([
        {
          input: replay,
          disposition: "duplicate_replay_key",
          duplicate_of: first.attention_input_id,
        },
      ]);
    }
  });

  it("builds wait-resume scheduler wake inputs with typed metadata and no output authority", () => {
    const inputs = buildSchedulerWakeAttentionInputs({
      entry_id: "entry-1",
      fired_at: NOW,
      goal_ref: ref("goal", "goal-1"),
      wait_ref: ref("wait", "wait-1"),
      runtime_state_ref: ref("runtime_event", "runtime-event:schedule-wake:entry-1"),
    });

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.source)).toEqual([
      {
        source_kind: "schedule",
        source_id: "schedule_tick:entry-1",
        source_epoch: "schedule:entry-1",
        high_watermark: NOW,
        replay_key: `schedule:schedule_tick:entry-1:schedule:entry-1:${NOW}`,
        emitted_at: NOW,
      },
      {
        source_kind: "schedule",
        source_id: "wait_expiry:wait-1",
        source_epoch: "schedule:entry-1",
        high_watermark: NOW,
        replay_key: `schedule:wait_expiry:wait-1:schedule:entry-1:${NOW}`,
        emitted_at: NOW,
      },
    ]);
    expect(inputs.map((input) => input.effect_policy)).toEqual([
      { wake: true, notify: false, speak: false, act: false },
      { wake: true, notify: false, speak: false, act: false },
    ]);

    const context = buildSignalContextFromAttentionInputs({
      signal_context_id: "signal:schedule-wake:entry-1",
      assembled_at: NOW,
      inputs,
    });

    expect(context.signal_sources).toEqual(["schedule_tick", "wait_expiry"]);
    expect(context.signal_refs.map((source) => source.ref)).toEqual([
      ref("schedule_tick", "entry-1"),
      ref("wait", "wait-1"),
    ]);
    expect(context.current_goal_refs).toEqual([ref("goal", "goal-1")]);
    expect(context.runtime_state_refs).toEqual([ref("runtime_event", "runtime-event:schedule-wake:entry-1")]);
  });

  it("uses scheduled-for as the stable scheduler replay high-watermark", () => {
    const first = buildSchedulerWakeAttentionInputs({
      entry_id: "entry-1",
      fired_at: "2026-05-12T00:01:00.000Z",
      scheduled_for: NOW,
      wait_ref: ref("wait", "wait-1"),
    });
    const replay = buildSchedulerWakeAttentionInputs({
      entry_id: "entry-1",
      fired_at: "2026-05-12T00:02:00.000Z",
      scheduled_for: NOW,
      wait_ref: ref("wait", "wait-1"),
    });

    expect(first.map((input) => input.source.emitted_at)).toEqual([
      "2026-05-12T00:01:00.000Z",
      "2026-05-12T00:01:00.000Z",
    ]);
    expect(replay.map((input) => input.source.emitted_at)).toEqual([
      "2026-05-12T00:02:00.000Z",
      "2026-05-12T00:02:00.000Z",
    ]);
    expect(first.map((input) => input.source.high_watermark)).toEqual([NOW, NOW]);
    expect(replay.map((input) => input.source.high_watermark)).toEqual([NOW, NOW]);
    expect(replay.map((input) => input.source.replay_key)).toEqual(first.map((input) => input.source.replay_key));
  });

  it("deduplicates schedule events by source epoch and high-watermark replay key", () => {
    const first = createAttentionInput({
      source_kind: "schedule",
      source_id: "schedule:entry:1",
      source_epoch: "schedule-engine:1",
      high_watermark: "tick:100",
      emitted_at: NOW,
      payload_class: "schedule.wait_resume",
      summary: "Schedule wake fired.",
    });
    const duplicate = createAttentionInput({
      source_kind: "schedule",
      source_id: "schedule:entry:1",
      source_epoch: "schedule-engine:1",
      high_watermark: "tick:100",
      emitted_at: NOW,
      payload_class: "schedule.wait_resume",
      summary: "Same schedule wake replayed.",
    });
    const later = createAttentionInput({
      source_kind: "schedule",
      source_id: "schedule:entry:1",
      source_epoch: "schedule-engine:1",
      high_watermark: "tick:101",
      emitted_at: "2026-05-12T00:01:00.000Z",
      payload_class: "schedule.wait_resume",
      summary: "A later schedule wake fired.",
    });

    const result = dedupeAttentionInputs([first, duplicate, later]);

    expect(result.accepted.map((input) => input.attention_input_id)).toEqual([
      first.attention_input_id,
      later.attention_input_id,
    ]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]).toMatchObject({
      input: duplicate,
      disposition: "duplicate_replay_key",
      duplicate_of: first.attention_input_id,
    });
  });

  it("deduplicates resident proactive maintenance source refs through the intake port", async () => {
    const port = createAttentionInputIntakePort();
    const first = createAttentionInput({
      source_kind: "resident_proactive_maintenance",
      source_id: "resident:maintenance:1",
      source_epoch: "resident-loop:boot-1",
      high_watermark: "candidate:42",
      emitted_at: NOW,
      payload_class: "resident.proactive_maintenance",
      summary: "Maintenance produced a quiet candidate.",
    });
    const duplicate = createAttentionInput({
      source_kind: "resident_proactive_maintenance",
      source_id: "resident:maintenance:1",
      source_epoch: "resident-loop:boot-1",
      high_watermark: "candidate:42",
      emitted_at: NOW,
      payload_class: "resident.proactive_maintenance",
      summary: "Maintenance candidate replayed.",
    });

    await expect(port.ingest([first])).resolves.toMatchObject({
      accepted: [first],
      duplicates: [],
    });
    await expect(port.ingest([duplicate])).resolves.toMatchObject({
      accepted: [],
      duplicates: [
        {
          input: duplicate,
          disposition: "duplicate_replay_key",
          duplicate_of: first.attention_input_id,
        },
      ],
    });
  });

  it("deduplicates gateway user activity without turning it into a reply", () => {
    const first = createAttentionInput({
      source_kind: "gateway_user_activity",
      source_id: "telegram:user:1:message:abc",
      source_epoch: "telegram:chat:1",
      high_watermark: "update:100",
      emitted_at: NOW,
      payload_class: "gateway.message",
      summary: "User sent a Telegram message.",
      current_session_refs: [ref("session", "telegram:chat:1")],
    });
    const duplicate = createAttentionInput({
      source_kind: "gateway_user_activity",
      source_id: "telegram:user:1:message:abc",
      source_epoch: "telegram:chat:1",
      high_watermark: "update:100",
      emitted_at: NOW,
      payload_class: "gateway.message",
      summary: "Gateway replayed the same update.",
      current_session_refs: [ref("session", "telegram:chat:1")],
    });

    const result = dedupeAttentionInputs([first, duplicate]);

    expect(result.accepted).toEqual([first]);
    expect(result.duplicates).toHaveLength(1);
    expect(first.effect_policy).toEqual({
      wake: true,
      notify: false,
      speak: false,
      act: false,
    });
  });

  it("carries surface, memory, feedback, stale, and invalidation refs into SignalContext", () => {
    const input = createAttentionInput({
      source_kind: "feedback",
      source_id: "feedback:correction:1",
      emitted_at: NOW,
      payload_class: "feedback.correction",
      summary: "Correction should change future attention.",
      active_surface_ref: ref("surface", "surface:active"),
      memory_refs: [ref("memory", "memory:preference")],
      feedback_refs: [ref("feedback", "feedback:correction:1")],
      stale_refs: [ref("goal", "goal:stale")],
      invalidation_refs: [ref("surface", "surface:stale")],
      audit_refs: [ref("audit_trace", "audit:feedback:1")],
    });

    const context = buildSignalContextFromAttentionInputs({
      signal_context_id: "signal:feedback:1",
      assembled_at: NOW,
      inputs: [input],
    });

    expect(context.active_surface_ref).toEqual(ref("surface", "surface:active"));
    expect(context.signal_refs.map((signal) => signal.ref)).toEqual([
      ref("feedback", "feedback:correction:1"),
      ref("surface", "surface:active"),
      ref("memory", "memory:preference"),
    ]);
    expect(context.stale_target_context.stale_refs).toEqual([ref("goal", "goal:stale")]);
    expect(context.stale_target_context.needs_regrounding_refs).toEqual([ref("surface", "surface:stale")]);
    expect(context.audit_refs).toEqual([ref("audit_trace", "audit:feedback:1")]);
  });
});
