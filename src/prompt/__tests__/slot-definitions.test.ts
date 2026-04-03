import { describe, it, expect } from "vitest";
import {
  getSlotConfig,
  getSlotDefinition,
  type ContextPurpose,
  type ContextSlot,
} from "../slot-definitions.js";

describe("getSlotConfig", () => {
  it("every purpose returns a config with activeSlots", () => {
    const purposes: ContextPurpose[] = [
      "observation",
      "task_generation",
      "verification",
      "strategy_generation",
      "goal_decomposition",
    ];
    for (const purpose of purposes) {
      const config = getSlotConfig(purpose);
      expect(config.purpose).toBe(purpose);
      expect(Array.isArray(config.activeSlots)).toBe(true);
      expect(config.activeSlots.length).toBeGreaterThan(0);
    }
  });

  it("every purpose includes goal_definition as an active slot", () => {
    const purposes: ContextPurpose[] = [
      "observation",
      "task_generation",
      "verification",
      "strategy_generation",
      "goal_decomposition",
    ];
    for (const purpose of purposes) {
      const config = getSlotConfig(purpose);
      expect(config.activeSlots).toContain("goal_definition");
    }
  });

  it("observation has dimension_history but not lessons", () => {
    const config = getSlotConfig("observation");
    expect(config.activeSlots).toContain("dimension_history");
    expect(config.activeSlots).not.toContain("lessons");
  });

  it("observation has workspace_state", () => {
    const config = getSlotConfig("observation");
    expect(config.activeSlots).toContain("workspace_state");
  });

  it("task_generation includes reflections, lessons, failure_context, knowledge", () => {
    const config = getSlotConfig("task_generation");
    expect(config.activeSlots).toContain("reflections");
    expect(config.activeSlots).toContain("lessons");
    expect(config.activeSlots).toContain("failure_context");
    expect(config.activeSlots).toContain("knowledge");
  });

  it("task_generation includes recent_task_results", () => {
    const config = getSlotConfig("task_generation");
    expect(config.activeSlots).toContain("recent_task_results");
  });

  it("verification includes recent_task_results and knowledge", () => {
    const config = getSlotConfig("verification");
    expect(config.activeSlots).toContain("recent_task_results");
    expect(config.activeSlots).toContain("knowledge");
  });

  it("verification does not include reflections or lessons", () => {
    const config = getSlotConfig("verification");
    expect(config.activeSlots).not.toContain("reflections");
    expect(config.activeSlots).not.toContain("lessons");
  });

  it("strategy_generation includes lessons, knowledge, strategy_templates", () => {
    const config = getSlotConfig("strategy_generation");
    expect(config.activeSlots).toContain("lessons");
    expect(config.activeSlots).toContain("knowledge");
    expect(config.activeSlots).toContain("strategy_templates");
  });

  it("strategy_generation does not include recent_task_results", () => {
    const config = getSlotConfig("strategy_generation");
    expect(config.activeSlots).not.toContain("recent_task_results");
  });

  it("goal_decomposition only has goal_definition and knowledge", () => {
    const config = getSlotConfig("goal_decomposition");
    expect(config.activeSlots).toEqual(["goal_definition", "knowledge"]);
  });

  it("strategy_generation has budgetOverrides", () => {
    const config = getSlotConfig("strategy_generation");
    expect(config.budgetOverrides).toBeDefined();
    expect(config.budgetOverrides).toHaveProperty("knowledge", 40);
    expect(config.budgetOverrides).toHaveProperty("transferKnowledge", 20);
    expect(config.budgetOverrides).toHaveProperty("observations", 15);
    expect(config.budgetOverrides).toHaveProperty("goalDefinition", 20);
    expect(config.budgetOverrides).toHaveProperty("meta", 5);
  });

  it("strategy_generation budgetOverrides sum to 100", () => {
    const config = getSlotConfig("strategy_generation");
    const overrides = config.budgetOverrides || {};
    const sum = Object.values(overrides).reduce((acc, val) => acc + val, 0);
    expect(sum).toBe(100);
  });

  it("goal_decomposition has budgetOverrides", () => {
    const config = getSlotConfig("goal_decomposition");
    expect(config.budgetOverrides).toBeDefined();
    expect(config.budgetOverrides).toHaveProperty("goalDefinition", 30);
    expect(config.budgetOverrides).toHaveProperty("knowledge", 35);
    expect(config.budgetOverrides).toHaveProperty("observations", 15);
    expect(config.budgetOverrides).toHaveProperty("transferKnowledge", 15);
    expect(config.budgetOverrides).toHaveProperty("meta", 5);
  });

  it("goal_decomposition budgetOverrides sum to 100", () => {
    const config = getSlotConfig("goal_decomposition");
    const overrides = config.budgetOverrides || {};
    const sum = Object.values(overrides).reduce((acc, val) => acc + val, 0);
    expect(sum).toBe(100);
  });

  it("throws for unknown purpose", () => {
    expect(() => getSlotConfig("unknown" as ContextPurpose)).toThrow();
  });
});

describe("getSlotDefinition", () => {
  const allSlots: ContextSlot[] = [
    "goal_definition",
    "current_state",
    "dimension_history",
    "recent_task_results",
    "reflections",
    "lessons",
    "knowledge",
    "strategy_templates",
    "workspace_state",
    "failure_context",
  ];

  it("returns a definition for every known slot", () => {
    for (const slot of allSlots) {
      const def = getSlotDefinition(slot);
      expect(def.slot).toBe(slot);
      expect(def.xmlTag).toBeTruthy();
      expect(def.layer).toBeTruthy();
      expect(typeof def.priority).toBe("number");
    }
  });

  it("goal_definition is in hot layer with priority 1", () => {
    const def = getSlotDefinition("goal_definition");
    expect(def.layer).toBe("hot");
    expect(def.priority).toBe(1);
  });

  it("current_state is in hot layer with priority 2", () => {
    const def = getSlotDefinition("current_state");
    expect(def.layer).toBe("hot");
    expect(def.priority).toBe(2);
  });

  it("lessons is in cold layer", () => {
    const def = getSlotDefinition("lessons");
    expect(def.layer).toBe("cold");
  });

  it("knowledge is in archival layer", () => {
    const def = getSlotDefinition("knowledge");
    expect(def.layer).toBe("archival");
  });

  it("strategy_templates is in archival layer", () => {
    const def = getSlotDefinition("strategy_templates");
    expect(def.layer).toBe("archival");
  });

  it("failure_context has the lowest priority (highest number)", () => {
    const failureDef = getSlotDefinition("failure_context");
    for (const slot of allSlots) {
      const def = getSlotDefinition(slot);
      expect(failureDef.priority).toBeGreaterThanOrEqual(def.priority);
    }
  });

  it("xmlTag matches slot name", () => {
    for (const slot of allSlots) {
      const def = getSlotDefinition(slot);
      expect(def.xmlTag).toBe(slot);
    }
  });

  it("throws for unknown slot", () => {
    expect(() => getSlotDefinition("nonexistent" as ContextSlot)).toThrow();
  });
});
