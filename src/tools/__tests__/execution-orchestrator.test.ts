import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { decideHostToolExecution } from "../execution-orchestrator.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../types.js";

function makePolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    executionProfile: "consumer",
    sandboxMode: "workspace_write",
    approvalPolicy: "on_request",
    networkAccess: true,
    workspaceRoot: "/repo",
    protectedPaths: [],
    trustProjectInstructions: true,
    ...overrides,
  };
}

function makeTool(overrides: Partial<ToolMetadata> = {}): ITool {
  const metadata: ToolMetadata = {
    name: "tool",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: [],
    ...overrides,
  };
  return {
    metadata,
    inputSchema: z.unknown(),
    description: () => metadata.name,
    call: vi.fn(async (): Promise<ToolResult> => ({
      success: true,
      data: null,
      summary: "ok",
      durationMs: 1,
    })),
    checkPermissions: vi.fn(async (): Promise<PermissionCheckResult> => ({ status: "allowed" })),
    isConcurrencySafe: () => true,
  };
}

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/repo",
    goalId: "goal-1",
    trustBalance: 0,
    preApproved: false,
    approvalFn: async () => false,
    executionPolicy: makePolicy(),
    ...overrides,
  };
}

describe("decideHostToolExecution", () => {
  it("allows read-only typed requests under the current host policy", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ permissionLevel: "read_only", isReadOnly: true }),
      input: {},
      context: makeContext(),
    });

    expect(decision.status).toBe("allowed");
  });

  it("denies unsafe shell protocol requests without consulting model wording", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ name: "shell", permissionLevel: "read_metrics", isReadOnly: false }),
      input: { command: "echo ok && sudo reboot" },
      context: makeContext(),
    });

    expect(decision.status).toBe("denied");
    expect(decision.executionReason).toBe("policy_blocked");
  });

  it("allows safe read-only shell protocol requests through typed command metadata", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ name: "shell", permissionLevel: "read_metrics", isReadOnly: false }),
      input: { command: "git status --short" },
      context: makeContext(),
    });

    expect(decision.status).toBe("allowed");
  });

  it("requires approval for shell protocol local writes", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ name: "shell", permissionLevel: "read_metrics", isReadOnly: false }),
      input: { command: "echo ok > output.txt" },
      context: makeContext({ executionPolicy: makePolicy({ approvalPolicy: "on_request" }) }),
    });

    expect(decision.status).toBe("needs_permission");
    expect(decision.requiredApprovalPolicy).toBe("on_request");
  });

  it("requires a sandbox change for shell protocol network commands when network is disabled", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ name: "shell", permissionLevel: "read_metrics", isReadOnly: false }),
      input: { command: "git fetch origin" },
      context: makeContext({ executionPolicy: makePolicy({ networkAccess: false }) }),
    });

    expect(decision.status).toBe("needs_sandbox");
    expect(decision.executionReason).toBe("sandbox_required");
    expect(decision.requiredSandboxMode).toBe("danger_full_access");
  });

  it("denies destructive shell protocol commands before approval", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ name: "shell", permissionLevel: "read_metrics", isReadOnly: false }),
      input: { command: "git reset --hard HEAD" },
      context: makeContext(),
    });

    expect(decision.status).toBe("denied");
    expect(decision.executionReason).toBe("policy_blocked");
  });

  it("denies shell writes to protected paths before approval", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ name: "shell", permissionLevel: "read_metrics", isReadOnly: false }),
      input: { command: "touch .env" },
      context: makeContext({ executionPolicy: makePolicy({ protectedPaths: ["/repo/.env"] }) }),
    });

    expect(decision.status).toBe("denied");
    expect(decision.executionReason).toBe("policy_blocked");
  });

  it("requires permission for local writes when approval is on-request", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ permissionLevel: "write_local", isReadOnly: false }),
      input: { path: "notes.md" },
      context: makeContext({ executionPolicy: makePolicy({ approvalPolicy: "on_request" }) }),
    });

    expect(decision.status).toBe("needs_permission");
    expect(decision.requiredApprovalPolicy).toBe("on_request");
  });

  it("requires sandbox changes for mutating tools in read-only sandbox", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ permissionLevel: "write_local", isReadOnly: false }),
      input: { path: "notes.md" },
      context: makeContext({ executionPolicy: makePolicy({ sandboxMode: "read_only" }) }),
    });

    expect(decision.status).toBe("needs_sandbox");
    expect(decision.executionReason).toBe("sandbox_required");
  });

  it("requires escalation for high-risk tools under untrusted policy", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ permissionLevel: "execute", isReadOnly: false, isDestructive: true }),
      input: { command: "deploy" },
      context: makeContext({ executionPolicy: makePolicy({ approvalPolicy: "untrusted" }) }),
    });

    expect(decision.status).toBe("needs_escalation");
    expect(decision.executionReason).toBe("escalation_required");
  });

  it("fails closed when the typed host state epoch is stale", () => {
    const decision = decideHostToolExecution({
      tool: makeTool({ permissionLevel: "read_only", isReadOnly: true }),
      input: {},
      context: makeContext({
        hostToolState: {
          observedEpoch: "epoch-before",
          currentEpoch: "epoch-after",
        },
      }),
    });

    expect(decision.status).toBe("fail_closed");
    expect(decision.executionReason).toBe("stale_state");
  });
});
