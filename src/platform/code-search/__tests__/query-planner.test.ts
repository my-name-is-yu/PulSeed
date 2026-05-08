import { describe, expect, it } from "vitest";
import { planCodeSearchTask } from "../query-planner.js";

describe("code-search query planner", () => {
  it("does not derive query terms from non-ASCII freeform text", () => {
    const planned = planCodeSearchTask({
      task: "☃ ☂",
      cwd: "/repo",
    });

    expect(planned.intent).toBe("unknown");
    expect(planned.queryTerms).toEqual([]);
    expect(planned.likelySymbols).toEqual([]);
  });

  it("preserves explicit query terms for non-ASCII task text", () => {
    const planned = planCodeSearchTask({
      task: "☃ ☂",
      queryTerms: ["AuthConfig"],
      cwd: "/repo",
    });

    expect(planned.queryTerms).toEqual(["AuthConfig"]);
    expect(planned.likelySymbols).toEqual(["AuthConfig"]);
  });
});
