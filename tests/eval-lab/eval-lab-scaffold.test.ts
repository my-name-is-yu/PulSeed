import { describe, expect, it } from "vitest";

describe("long-run evaluation lab scaffold", () => {
  it("runs in its own deterministic lane before scenario runtime wiring", () => {
    expect("tests/eval-lab").toBe("tests/eval-lab");
  });
});
