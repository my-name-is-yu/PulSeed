import { describe, expect, it } from "vitest";
import {
  PendingPermissionTaskSchema,
  createPendingPermissionTask,
  withPermissionExpiry,
} from "../permission-dialogue.js";

function makePermissionTask(expiresAt?: number) {
  return createPendingPermissionTask({
    id: "approval-1",
    description: "Write a local file",
    action: "write-tool",
    target: { session_id: "session-1", tool_id: "write-tool", tool_call_id: "call-1" },
    stateEpoch: "epoch-1",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

describe("permission dialogue contracts", () => {
  it("bounds permission task expiry metadata to safe nonnegative integers", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const task = makePermissionTask(0);

    expect(task.expires_at).toBe(0);
    expect(PendingPermissionTaskSchema.safeParse({
      ...task,
      expires_at: unsafeInteger,
    }).success).toBe(false);
    expect(() => makePermissionTask(unsafeInteger)).toThrow();
    expect(() => withPermissionExpiry(task, unsafeInteger)).toThrow();
    expect(withPermissionExpiry(task, Number.MAX_SAFE_INTEGER).expires_at).toBe(Number.MAX_SAFE_INTEGER);
  });
});
