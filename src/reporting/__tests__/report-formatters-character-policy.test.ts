import { describe, expect, it } from "vitest";
import type { CharacterConfig } from "../../platform/traits/types/character.js";
import {
  buildNotificationContent,
  getVerbosityLevel,
} from "../report-formatters.js";

function characterConfig(overrides: Partial<CharacterConfig>): CharacterConfig {
  return {
    caution_level: 2,
    stall_flexibility: 1,
    communication_directness: 3,
    proactivity_level: 2,
    ...overrides,
  };
}

describe("report-formatters character policy projection", () => {
  it("uses the typed character surface policy for execution summary verbosity", () => {
    expect(getVerbosityLevel(characterConfig({ proactivity_level: 1 }))).toBe("brief");
    expect(getVerbosityLevel(characterConfig({ proactivity_level: 3 }))).toBe("normal");
    expect(getVerbosityLevel(characterConfig({ proactivity_level: 5 }))).toBe("detailed");
  });

  it("uses the typed character surface policy for escalation suggestions", () => {
    const context = {
      goalId: "goal:1",
      message: "capacity is insufficient",
      details: "The configured capability cannot complete the task.",
    };

    const considerate = buildNotificationContent(
      "stall_escalation",
      context,
      characterConfig({ communication_directness: 1 })
    );
    const balancedStall = buildNotificationContent(
      "stall_escalation",
      context,
      characterConfig({ communication_directness: 3 })
    );
    const balancedCapability = buildNotificationContent(
      "capability_insufficient",
      context,
      characterConfig({ communication_directness: 3 })
    );
    const direct = buildNotificationContent(
      "capability_insufficient",
      context,
      characterConfig({ communication_directness: 5 })
    );

    expect(considerate.content).toContain("### Suggested next actions:");
    expect(balancedStall.content).not.toContain("### Suggested next actions:");
    expect(balancedCapability.content).toContain("### Suggested next actions:");
    expect(direct.content).not.toContain("### Suggested next actions:");
  });
});
