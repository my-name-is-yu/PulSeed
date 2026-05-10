import { describe, expect, it } from "vitest";
import { computeActualElapsedMs } from "../task/task-history-metrics.js";

describe("computeActualElapsedMs", () => {
  it("returns elapsed milliseconds for valid task timestamps", () => {
    expect(computeActualElapsedMs(
      "2026-05-10T00:00:00.000Z",
      "2026-05-10T00:05:00.000Z",
    )).toBe(300_000);
  });

  it("returns null for missing, invalid, negative, or unsafe durations", () => {
    expect(computeActualElapsedMs(null, "2026-05-10T00:05:00.000Z")).toBeNull();
    expect(computeActualElapsedMs("not-a-date", "2026-05-10T00:05:00.000Z")).toBeNull();
    expect(computeActualElapsedMs("2026-05-10T00:05:00.000Z", "2026-05-10T00:00:00.000Z")).toBeNull();
    expect(computeActualElapsedMs("-271821-04-20T00:00:00.000Z", "+275760-09-13T00:00:00.000Z")).toBeNull();
  });
});
