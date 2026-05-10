import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAbsoluteRelativeTimestamp,
  formatDurationMs,
  formatPercent,
  formatRelativeTime,
  formatRelativeTimestamp,
  formatUptime,
} from "../display-format.js";

describe("CLI display format helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps stable output for normal timestamps and durations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:10:00.000Z"));

    expect(formatUptime("2026-05-09T22:05:00.000Z")).toBe("2h 5m");
    expect(formatRelativeTime("2026-05-10T00:09:30.000Z")).toBe("30s ago");
    expect(formatRelativeTimestamp(Date.parse("2026-05-10T00:20:00.000Z"))).toBe("10m from now");
    expect(formatAbsoluteRelativeTimestamp(Date.parse("2026-05-09T00:10:00.000Z"))).toBe(
      "2026-05-09T00:10:00.000Z (1d ago)"
    );
    expect(formatDurationMs(90_000)).toBe("1.5m");
    expect(formatPercent(0.955)).toBe("95.5%");
  });

  it("does not render non-finite or invalid persisted values", () => {
    expect(formatUptime("not-a-date")).toBe("unknown");
    expect(formatRelativeTime("not-a-date")).toBe("unknown");
    expect(formatRelativeTimestamp(Number.NaN)).toBe("unknown");
    expect(formatRelativeTimestamp(Number.POSITIVE_INFINITY)).toBe("unknown");
    expect(formatAbsoluteRelativeTimestamp(9_000_000_000_000_000)).toBe("n/a");
    expect(formatDurationMs(Number.NaN)).toBe("n/a");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("n/a");
    expect(formatDurationMs(-1)).toBe("n/a");
    expect(formatPercent(Number.NaN)).toBe("n/a");
    expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe("n/a");
  });
});
