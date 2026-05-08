import { describe, expect, it } from "vitest";
import { coerceDataSourceObservationValue } from "../observation-value.js";

describe("coerceDataSourceObservationValue", () => {
  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite numeric input %s",
    (value) => {
      expect(coerceDataSourceObservationValue(value)).toBeNull();
    }
  );

  it("preserves finite numeric inputs", () => {
    expect(coerceDataSourceObservationValue(42)).toBe(42);
  });

  it("keeps non-finite numeric text as text", () => {
    expect(coerceDataSourceObservationValue("Infinity")).toBe("Infinity");
  });
});
