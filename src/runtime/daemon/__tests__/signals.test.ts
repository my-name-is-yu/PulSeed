import { describe, expect, it } from "vitest";
import { generateCronEntry } from "../signals.js";

describe("generateCronEntry", () => {
  it("formats bounded daemon schedules by minute, hour, and day cadence", () => {
    expect(generateCronEntry("goal-1", 15)).toBe("*/15 * * * * /usr/bin/env pulseed run --goal goal-1");
    expect(generateCronEntry("goal_2", 120)).toBe("0 */2 * * * /usr/bin/env pulseed run --goal goal_2");
    expect(generateCronEntry("goal-3", 1440)).toBe("0 0 * * * /usr/bin/env pulseed run --goal goal-3");
    expect(generateCronEntry("goal-4", 0)).toBe("0 */1 * * * /usr/bin/env pulseed run --goal goal-4");
  });

  it("rejects unsafe goal ids instead of embedding shell metacharacters", () => {
    expect(() => generateCronEntry("goal;rm-rf", 15)).toThrow("Invalid goalId");
  });
});
