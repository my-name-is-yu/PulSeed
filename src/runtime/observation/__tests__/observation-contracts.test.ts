import { describe, expect, it } from "vitest";
import {
  buildSignalContextFromAttentionInputs,
  createAttentionInput,
  dedupeAttentionInputs,
  ref,
} from "../../attention/index.js";
import {
  ObservationEventSchema,
  ObservationMemoryPolicySchema,
  ObservationSessionSchema,
  createObservationEvent,
  createObservationSession,
  observationEventToAttentionInput,
} from "../index.js";
import type { ObservationMemoryPolicy } from "../index.js";

const NOW = "2026-05-12T00:00:00.000Z";
const STARTED_AT = "2026-05-12T00:00:05.000Z";
const EXPIRES_AT = "2026-05-12T00:05:05.000Z";

function memoryPolicy(overrides: Partial<ObservationMemoryPolicy> = {}): ObservationMemoryPolicy {
  return ObservationMemoryPolicySchema.parse({
    raw_media_persistence: "not_persisted",
    raw_media_retention: "none",
    derived_metadata_retention: "attention_signal",
    memory_promotion: {
      status: "not_requested",
      requires_approval: true,
      reason: "Observation may only promote derived summaries after explicit approval.",
    },
    ...overrides,
  });
}

function activeSession(overrides: Partial<Parameters<typeof createObservationSession>[0]> = {}) {
  return createObservationSession({
    session_id: "observation-session-1",
    source: {
      source_kind: "device",
      source_id: "camera:desk",
      source_epoch: "camera:desk:boot-1",
      modality: "camera",
    },
    purpose: "user_requested_context",
    requested_at: NOW,
    started_at: STARTED_AT,
    expires_at: EXPIRES_AT,
    max_duration_ms: 300_000,
    state: "active",
    visible_indicator: {
      required: true,
      state: "shown",
      shown_at: STARTED_AT,
      surface_ref: ref("surface", "tui:status"),
      reason: "Live observation requires an operator-visible indicator.",
    },
    memory_policy: memoryPolicy(),
    no_continuous_sensing: true,
    gui_capture_ui_included: false,
    raw_media_persistence_enabled: false,
    ...overrides,
  });
}

function sampleEvent(overrides: Partial<Parameters<typeof createObservationEvent>[0]> = {}) {
  return createObservationEvent({
    event_id: "observation-event-1",
    session_ref: ref("observation_session", "observation-session-1"),
    observed_at: "2026-05-12T00:01:00.000Z",
    modality: "camera",
    event_kind: "sample_observed",
    summary: "A bounded camera observation produced derived movement metadata.",
    attention_signal: {
      enters_attention: true,
      direct_action: false,
      effect_policy: { wake: true, notify: false, speak: false, act: false },
    },
    derived_metadata: { movement: true, confidence: 0.73 },
    memory_policy: memoryPolicy(),
    ...overrides,
  });
}

describe("Observation sensory contracts", () => {
  it("defines bounded sessions for all future sensory modalities without raw media persistence or GUI capture UI", () => {
    for (const modality of ["camera", "microphone", "screen", "image", "audio", "video", "multimodal"] as const) {
      const session = activeSession({
        session_id: `observation-session-${modality}`,
        source: {
          source_kind: modality === "screen" ? "screen_capture" : "future_sensor",
          source_id: `source:${modality}`,
          source_epoch: `source:${modality}:epoch-1`,
          modality,
        },
      });

      expect(session.source.modality).toBe(modality);
      expect(session.no_continuous_sensing).toBe(true);
      expect(session.gui_capture_ui_included).toBe(false);
      expect(session.raw_media_persistence_enabled).toBe(false);
      expect(session.memory_policy).toMatchObject({
        raw_media_persistence: "not_persisted",
        raw_media_retention: "none",
      });
      expect(Date.parse(session.expires_at)).toBeGreaterThan(Date.parse(session.started_at ?? session.requested_at));
    }
  });

  it("rejects active observation sessions without a visible indicator or bounded duration", () => {
    expect(() =>
      activeSession({
        visible_indicator: {
          required: true,
          state: "pending",
          shown_at: null,
          surface_ref: ref("surface", "tui:status"),
          reason: "Indicator was not shown yet.",
        },
      })
    ).toThrow("started observation sessions require a shown visible indicator");

    expect(() =>
      activeSession({
        started_at: null,
      })
    ).toThrow("active observation sessions require started_at");

    expect(() =>
      activeSession({
        expires_at: "2026-05-12T02:00:05.000Z",
      })
    ).toThrow("observation session duration cannot exceed max_duration_ms");

    expect(() =>
      activeSession({
        visible_indicator: {
          required: true,
          state: "shown",
          shown_at: "2026-05-12T00:00:06.000Z",
          surface_ref: ref("surface", "tui:status"),
          reason: "Indicator appeared after the observation session started.",
        },
      })
    ).toThrow("visible indicator must be shown before observation session starts");
  });

  it("keeps memory promotion approval-gated and disallows raw media payloads", () => {
    expect(() =>
      ObservationMemoryPolicySchema.parse({
        raw_media_persistence: "not_persisted",
        raw_media_retention: "none",
        derived_metadata_retention: "runtime_audit",
        memory_promotion: {
          status: "approved_for_derived_summary",
          requires_approval: true,
          promoted_ref: ref("memory", "memory:observation-summary"),
          reason: "Missing approval ref should fail closed.",
        },
      })
    ).toThrow("approved observation memory promotion requires an approval_ref");

    expect(() =>
      ObservationEventSchema.parse({
        ...sampleEvent(),
        raw_media_ref: "file:///tmp/raw-camera-frame.jpg",
      })
    ).toThrow();
  });

  it("converts observation events into attention signals without notify, speech, action, or execution authority", () => {
    const session = activeSession();
    const event = sampleEvent();
    const input = observationEventToAttentionInput({
      session,
      event,
      active_surface_ref: ref("surface", "tui:status"),
      current_session_refs: [ref("session", "gateway:telegram:chat-1")],
    });

    expect(input.source.source_kind).toBe("observation_event");
    expect(input.source.source_epoch).toBe("camera:desk:boot-1");
    expect(input.source.high_watermark).toBe("2026-05-12T00:01:00.000Z");
    expect(input.signal_source).toBe("observation");
    expect(input.signal_ref.ref).toEqual(ref("observation_event", "observation-event-1"));
    expect(input.effect_policy).toEqual({ wake: true, notify: false, speak: false, act: false });

    const context = buildSignalContextFromAttentionInputs({
      signal_context_id: "signal:observation:event",
      assembled_at: "2026-05-12T00:01:01.000Z",
      inputs: [input],
    });
    expect(context.signal_sources).toEqual(["observation", "surface"]);
    expect(context.signal_refs.map((source) => source.ref.kind)).toEqual(["observation_event", "surface"]);
    expect(context.current_session_refs).toEqual([ref("session", "gateway:telegram:chat-1")]);
  });

  it("deduplicates repeated observation events by replay key instead of flushing a backlog", () => {
    const session = activeSession();
    const event = sampleEvent();
    const first = observationEventToAttentionInput({ session, event });
    const replay = observationEventToAttentionInput({ session, event });
    const divergentReplay = observationEventToAttentionInput({
      session,
      event: sampleEvent({
        observed_at: "2026-05-12T00:02:00.000Z",
      }),
    });

    const result = dedupeAttentionInputs([first, replay, divergentReplay]);

    expect(result.accepted).toHaveLength(1);
    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates).toEqual([
      expect.objectContaining({ disposition: "duplicate_replay_key" }),
      expect.objectContaining({ disposition: "duplicate_replay_key" }),
    ]);
    expect(result.duplicates[0]?.duplicate_of).toBe(first.attention_input_id);
    expect(result.duplicates[1]?.duplicate_of).toBe(first.attention_input_id);
  });

  it("fails closed when an observation event falls outside the session bounded window", () => {
    const session = activeSession();

    expect(() =>
      observationEventToAttentionInput({
        session,
        event: sampleEvent({
          observed_at: "2026-05-11T23:59:59.999Z",
        }),
      })
    ).toThrow('observation event "observation-event-1" occurred outside session "observation-session-1" bounded window');

    expect(() =>
      observationEventToAttentionInput({
        session,
        event: sampleEvent({
          observed_at: "2026-05-12T00:05:05.001Z",
        }),
      })
    ).toThrow('observation event "observation-event-1" occurred outside session "observation-session-1" bounded window');
  });

  it("fails closed when sensory events try to enter attention before the session indicator is shown", () => {
    const pendingSession = activeSession({
      state: "requested",
      started_at: null,
      expires_at: "2026-05-12T00:05:00.000Z",
      visible_indicator: {
        required: true,
        state: "pending",
        shown_at: null,
        surface_ref: ref("surface", "tui:status"),
        reason: "The observation has not started yet.",
      },
    });

    expect(() =>
      observationEventToAttentionInput({
        session: pendingSession,
        event: sampleEvent(),
      })
    ).toThrow('observation event "observation-event-1" requires a started observation session with a shown visible indicator');
  });

  it("rejects observation event direct-action and source masquerading attempts", () => {
    expect(() =>
      ObservationEventSchema.parse({
        ...sampleEvent(),
        attention_signal: {
          enters_attention: true,
          direct_action: true,
          effect_policy: { wake: true, notify: false, speak: false, act: false },
        },
      })
    ).toThrow();

    expect(() =>
      createAttentionInput({
        source_kind: "observation_event",
        source_id: "observation:event:wrong",
        emitted_at: NOW,
        payload_class: "observation.sample_observed",
        summary: "Observation events cannot bypass the observation session contract.",
      })
    ).toThrow("observation_event attention inputs require ObservationSession and ObservationEvent validation");
  });

  it("rejects events that are not linked to the declared observation session or modality", () => {
    const session = activeSession();
    expect(() =>
      observationEventToAttentionInput({
        session,
        event: sampleEvent({
          session_ref: ref("observation_session", "other-session"),
        }),
      })
    ).toThrow('observation event "observation-event-1" does not belong to session "observation-session-1"');

    expect(() =>
      observationEventToAttentionInput({
        session,
        event: sampleEvent({
          modality: "microphone",
        }),
      })
    ).toThrow('observation event modality "microphone" does not match session modality "camera"');
  });

  it("keeps schema failures closed for invalid visible indicator and session refs", () => {
    expect(ObservationSessionSchema.safeParse({
      ...activeSession(),
      visible_indicator: {
        required: true,
        state: "shown",
        shown_at: null,
        surface_ref: ref("surface", "tui:status"),
        reason: "Invalid shown indicator should fail.",
      },
    }).success).toBe(false);

    expect(ObservationEventSchema.safeParse({
      ...sampleEvent(),
      session_ref: ref("runtime_event", "runtime:event:not-session"),
    }).success).toBe(false);
  });
});
