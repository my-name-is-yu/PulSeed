import type { ToolCallContext } from "../../src/tools/types.js";

export function makeToolCallContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    ...overrides,
  };
}

export function makeApprovedToolCallContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return makeToolCallContext({
    preApproved: true,
    approvalFn: async () => true,
    ...overrides,
  });
}
