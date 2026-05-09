import { describe, expect, it } from "vitest";
import { NotificationConfigSchema } from "../notification.js";

describe("NotificationConfigSchema", () => {
  it("bounds batching windows to finite positive integer minutes", () => {
    const parseWindow = (windowMinutes: number) => NotificationConfigSchema.safeParse({
      batching: {
        enabled: true,
        window_minutes: windowMinutes,
        digest_format: "compact",
      },
    });

    expect(NotificationConfigSchema.parse({ batching: { enabled: true } }).batching.window_minutes).toBe(30);
    expect(parseWindow(1).success).toBe(true);
    expect(parseWindow(60).success).toBe(true);
    expect(parseWindow(24 * 60).success).toBe(true);

    expect(parseWindow(0).success).toBe(false);
    expect(parseWindow(1.5).success).toBe(false);
    expect(parseWindow(Infinity).success).toBe(false);
    expect(parseWindow(Number.MAX_SAFE_INTEGER).success).toBe(false);
  });
});
