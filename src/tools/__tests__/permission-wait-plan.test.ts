import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import {
  buildApprovedToolCallContext,
  buildPermissionApprovalWaitPlan,
  buildPermissionWaitCanonicalPlan,
} from "../permission-wait-plan.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolResult,
} from "../types.js";

function makeTool(): ITool<{ value: string; cwd?: string }> {
  return {
    metadata: {
      name: "write-file",
      aliases: [],
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      requiresNetwork: false,
      activityCategory: "file_modify",
      tags: ["zeta", "alpha"],
    },
    inputSchema: z.object({
      value: z.string(),
      cwd: z.string().optional(),
    }),
    description: () => "write-file",
    call: vi.fn().mockResolvedValue({
      success: true,
      data: null,
      summary: "ok",
      durationMs: 1,
    } as ToolResult),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
    isConcurrencySafe: vi.fn().mockReturnValue(false),
  };
}

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp/workspace",
    goalId: "goal-1",
    trustBalance: 0,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    callId: "call-1",
    hostToolState: {
      currentEpoch: "epoch-1",
    },
    ...overrides,
  };
}

describe("permission-wait-plan", () => {
  it("builds canonical permission wait plans with sorted capability facts", () => {
    const plan = buildPermissionWaitCanonicalPlan({
      tool: makeTool(),
      input: { value: "x", cwd: "." },
      context: makeContext(),
      reason: "write requires approval",
      reversibility: "reversible",
      permissionGrantDecision: {
        status: "expired_grant",
        reason: "Grant was consumed",
      },
    });

    expect(plan).toMatchObject({
      schema_version: "permission-wait-canonical-plan-v1",
      tool_name: "write-file",
      input: { value: "x", cwd: "." },
      cwd: expect.stringMatching(/\/tmp\/workspace$/),
      target: {
        goal_id: "goal-1",
        session_id: "session-1",
        run_id: "run-1",
        turn_id: "turn-1",
        tool_call_id: "call-1",
      },
      permission: {
        permission_level: "write_local",
        is_destructive: false,
        reversibility: "reversible",
      },
      state_epoch: "epoch-1",
      capability_facts: {
        tool_permission_level: "write_local",
        tool_activity_category: "file_modify",
        tool_tags: ["alpha", "zeta"],
        permission_grant_status: "expired_grant",
        permission_grant_reason: "Grant was consumed",
      },
    });
  });

  it("builds approval requests around the canonical plan", () => {
    const waitPlan = buildPermissionApprovalWaitPlan({
      tool: makeTool(),
      input: { value: "x" },
      context: makeContext(),
      reason: "write requires approval",
      reversibility: "unknown",
    });

    expect(waitPlan.approvalId).toMatch(/^permission-wait:/);
    expect(waitPlan.auditRef).toBe("tool:write-file:call-1");
    expect(waitPlan.approvalRequest).toMatchObject({
      toolName: "write-file",
      reason: "write requires approval",
      permissionLevel: "write_local",
      isDestructive: false,
      reversibility: "unknown",
      approvalId: waitPlan.approvalId,
      permissionWaitPlanId: waitPlan.approvalId,
      canonicalPermissionPlan: waitPlan.canonicalPlan,
      callId: "call-1",
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
    });
  });

  it("returns an approved context clone without mutating the shared context", () => {
    const context = makeContext();
    const approved = buildApprovedToolCallContext(context);

    expect(approved).not.toBe(context);
    expect(approved).toMatchObject({
      preApproved: true,
      hostPolicyApproved: true,
    });
    expect(context.preApproved).toBe(false);
    expect(context.hostPolicyApproved).toBeUndefined();
  });
});
