import { describe, expect, it } from "vitest";
import {
  createCompanionCharacterPolicyDecisionInputRef,
  createCompanionCharacterPolicyDecisionPolicyRef,
  createCompanionCharacterPolicyProjection,
} from "../index.js";

const NOW = "2026-05-13T04:00:00.000Z";

describe("CompanionCharacterPolicyProjection", () => {
  it("turns stored character config into typed dialogue, decision, and surface policy", () => {
    const projection = createCompanionCharacterPolicyProjection({
      projectionId: "character-policy:direct",
      evaluatedAt: NOW,
      characterConfig: {
        caution_level: 5,
        stall_flexibility: 4,
        communication_directness: 5,
        proactivity_level: 4,
      },
    });

    expect(projection.dialogue_strategy).toMatchObject({
      directness: "direct",
      default_response_shape: "lead_with_facts",
      initiative_posture: "high",
      clarification_bias: "act_when_bound",
    });
    expect(projection.decision_policy).toMatchObject({
      caution_stance: "very_ambitious",
      stall_response: "persistent",
      character_can_relax_safety_boundary: false,
      character_can_relax_approval_boundary: false,
      character_can_grant_autonomy: false,
    });
    expect(projection.surface_policy).toMatchObject({
      execution_summary_verbosity: "detailed",
      escalation_suggestion_policy: "suppress_default_suggestions",
      normal_companion_raw_policy_state_visible: false,
      normal_companion_capability_catalog_visible: false,
      normal_companion_debug_state_visible: false,
      ordinary_surface_discloses_character_knobs: false,
    });
    expect(projection.metadata).toMatchObject({
      prompt_dump: false,
      model_text_is_authority: false,
      policy_hint_only: true,
    });
  });

  it("keeps low-proactivity character policy quiet without exposing raw control state", () => {
    const projection = createCompanionCharacterPolicyProjection({
      projectionId: "character-policy:quiet",
      evaluatedAt: NOW,
      characterConfig: {
        caution_level: 1,
        stall_flexibility: 1,
        communication_directness: 1,
        proactivity_level: 1,
      },
    });

    expect(projection.dialogue_strategy.initiative_posture).toBe("events_only");
    expect(projection.surface_policy.normal_companion_user_visible_reason).toBe("none");
    expect(projection.surface_policy.execution_summary_verbosity).toBe("brief");
    expect(projection.surface_policy.escalation_suggestion_policy).toBe("include_for_all_escalations");
    expect(projection.decision_policy.feasibility_threshold_hint).toBe(2);
    expect(projection.decision_policy.stall_threshold_multiplier_hint).toBe(1);
  });

  it("emits typed policy refs without requiring a companion cognition frame", () => {
    const projection = createCompanionCharacterPolicyProjection({
      projectionId: "character-policy:frame",
      evaluatedAt: NOW,
      characterConfig: {
        caution_level: 2,
        stall_flexibility: 2,
        communication_directness: 3,
        proactivity_level: 2,
      },
    });
    const characterInputRef = createCompanionCharacterPolicyDecisionInputRef(projection);
    const characterPolicyRef = createCompanionCharacterPolicyDecisionPolicyRef(projection);

    expect(characterInputRef).toEqual(expect.objectContaining({
      kind: "character_config_policy",
      ref: "character-policy:frame",
      role: "policy",
      freshness: "current",
    }));
    expect(characterPolicyRef).toEqual({
      kind: "character_config_policy",
      ref: "character-policy:frame",
      result: "policy_hint_only",
      epoch: NOW,
    });
  });
});
