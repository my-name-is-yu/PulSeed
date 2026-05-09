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

  it("bounds global notification cooldowns to finite safe minutes", () => {
    const parseCooldown = (value: number) => NotificationConfigSchema.safeParse({
      cooldown: {
        stall_escalation: value,
        custom_report: value,
      },
    });

    expect(NotificationConfigSchema.parse({}).cooldown.stall_escalation).toBe(60);
    expect(parseCooldown(0).success).toBe(true);
    expect(parseCooldown(60).success).toBe(true);
    expect(parseCooldown(30 * 24 * 60).success).toBe(true);

    expect(parseCooldown(-1).success).toBe(false);
    expect(parseCooldown(30 * 24 * 60 + 1).success).toBe(false);
    expect(parseCooldown(Infinity).success).toBe(false);
    expect(parseCooldown(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it("bounds per-goal notification cooldown overrides", () => {
    const parseOverride = (value: number) => NotificationConfigSchema.safeParse({
      goal_overrides: [{
        goal_id: "goal-1",
        notification_cooldown: {
          stall_escalation: value,
        },
      }],
    });

    expect(parseOverride(15).success).toBe(true);
    expect(parseOverride(-1).success).toBe(false);
    expect(parseOverride(30 * 24 * 60 + 1).success).toBe(false);
    expect(parseOverride(Infinity).success).toBe(false);
    expect(parseOverride(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
});
