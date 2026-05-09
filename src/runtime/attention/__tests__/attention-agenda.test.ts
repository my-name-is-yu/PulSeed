import { describe, expect, it } from "vitest";
import {
  mergeUrgesIntoAgenda,
  runtimeItemsForAgenda,
} from "../attention-agenda.js";
import {
  assembleSignalContext,
  createUrgeCandidate,
  ref,
} from "../index.js";
import type {
  SignalContext,
  UrgeCandidate,
} from "../../types/companion-autonomy.js";

const NOW = "2026-05-10T00:00:00.000Z";
const LATER = "2026-05-10T00:05:00.000Z";

type AgendaUrgeInput = Partial<UrgeCandidate> & {
  urge_id: string;
  signal_context?: SignalContext;
};

function signalContext(): SignalContext {
  return assembleSignalContext({
    signal_context_id: "signal:agenda:1",
    assembled_at: NOW,
    signals: [
      { source: "goal", ref: ref("goal", "goal:agenda") },
      { source: "runtime_event", ref: ref("runtime_event", "runtime:event:agenda") },
    ],
    active_surface_ref: ref("surface", "surface:agenda"),
    current_goal_refs: [ref("goal", "goal:agenda")],
    runtime_state_refs: [ref("runtime_event", "runtime:event:agenda")],
  });
}

function agendaUrge(input: AgendaUrgeInput): UrgeCandidate {
  return createUrgeCandidate({
    urge_id: input.urge_id,
    signal_context: input.signal_context ?? signalContext(),
    origin: input.origin ?? "goal",
    target: input.target ?? ref("goal", "goal:agenda"),
    feeling: input.feeling ?? "care",
    subject: input.subject ?? "Keep attention on the active goal.",
    strength: input.strength ?? 0.8,
    confidence: input.confidence ?? 0.72,
    expected_user_benefit: input.expected_user_benefit ?? "PulSeed can keep the agenda current.",
    surface_ref: input.surface_ref ?? ref("surface", "surface:agenda"),
    allowed_moves: input.allowed_moves,
    forbidden_moves: input.forbidden_moves,
    maturation_state: input.maturation?.state,
  });
}

describe("attention agenda extraction", () => {
  it("merges duplicate urges by structured agenda identity", () => {
    const initial = mergeUrgesIntoAgenda({
      now: NOW,
      urges: [agendaUrge({ urge_id: "urge:agenda:1", confidence: 0.7 })],
    });

    const merged = mergeUrgesIntoAgenda({
      now: LATER,
      existing_agenda_items: initial,
      urges: [agendaUrge({ urge_id: "urge:agenda:2", confidence: 0.91 })],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.91);
    expect(merged[0]?.source_urge_refs.map((urgeRef) => urgeRef.id)).toEqual([
      "urge:agenda:1",
      "urge:agenda:2",
    ]);
    expect(merged[0]?.current_posture).toBe("held");
    expect(merged[0]?.updated_at).toBe(LATER);
  });

  it("projects ready agenda items as inspect-only runtime items", () => {
    const [agendaItem] = mergeUrgesIntoAgenda({
      now: NOW,
      urges: [agendaUrge({
        urge_id: "urge:agenda:ready",
        maturation: {
          state: "mature",
          first_seen_at: NOW,
          reinforcement_refs: [],
          blocker_refs: [],
        },
      })],
    });

    const [runtimeItem] = runtimeItemsForAgenda([agendaItem!], LATER);

    expect(runtimeItem?.status).toBe("mature");
    expect(runtimeItem?.posture).toBe("proposed");
    expect(runtimeItem?.authority.actionable).toBe(false);
    expect(runtimeItem?.authority.requires_confirmation).toBe(true);
    expect(runtimeItem?.related_goal_refs).toEqual(["goal:agenda"]);
    expect(runtimeItem?.visibility_policy.display).toBe("hidden");
  });
});
