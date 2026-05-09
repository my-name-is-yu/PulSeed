import { describe, expect, it } from "vitest";
import { HookConfigSchema } from "../hook.js";

describe("HookConfigSchema", () => {
  const baseHook = {
    event: "LoopCycleStart",
    type: "shell",
    command: "echo hi",
  } as const;

  it("bounds timeout values to finite positive integer milliseconds", () => {
    expect(HookConfigSchema.parse({ ...baseHook }).timeout_ms).toBe(5000);
    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: 1 }).success).toBe(true);
    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: 60_000 }).success).toBe(true);
    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: 60 * 60 * 1000 }).success).toBe(true);

    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: 0 }).success).toBe(false);
    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: 1.5 }).success).toBe(false);
    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: Infinity }).success).toBe(false);
    expect(HookConfigSchema.safeParse({ ...baseHook, timeout_ms: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });
});
