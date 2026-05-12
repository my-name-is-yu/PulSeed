import { describe, it, expect, vi } from "vitest";
import { AskHumanTool, AskHumanInputSchema } from "../AskHumanTool.js";
import type { ToolCallContext } from "../../../types.js";
import { toToolDefinition } from "../../../tool-definition-adapter.js";

function makeContext(approved: boolean): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(approved),
  };
}

describe("AskHumanTool", () => {
  const tool = new AskHumanTool();

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("ask-human");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.maxConcurrency).toBe(1);
    expect(tool.metadata.tags).toContain("interaction");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toBeTruthy();
  });

  it("checkPermissions returns allowed", async () => {
    const ctx = makeContext(true);
    const result = await tool.checkPermissions({ question: "ok?" }, ctx);
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns false", () => {
    expect(tool.isConcurrencySafe({ question: "ok?" })).toBe(false);
  });

  it("returns approved when approvalFn returns true", async () => {
    const ctx = makeContext(true);
    const result = await tool.call({ question: "Continue?" }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { answer: string; question: string };
    expect(data.answer).toBe("approved");
    expect(data.question).toBe("Continue?");
    expect(result.summary).toContain("approved");
  });

  it("returns denied when approvalFn returns false", async () => {
    const ctx = makeContext(false);
    const result = await tool.call({ question: "Delete everything?" }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { answer: string; question: string };
    expect(data.answer).toBe("denied");
    expect(data.question).toBe("Delete everything?");
  });

  it("returns a terminal denial result for scoped permission requests", async () => {
    const ctx = makeContext(false);
    const result = await tool.call({ question: "Write config?", approval_scope: "write" }, ctx);
    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "approval_denied",
    });
    expect(ctx.approvalFn).toHaveBeenCalledWith(expect.objectContaining({
      permissionLevel: "write_local",
      isDestructive: true,
    }));
  });

  it("passes options to approvalFn", async () => {
    const ctx = makeContext(true);
    await tool.call({ question: "Which one?", options: ["A", "B"] }, ctx);
    expect(ctx.approvalFn).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ options: ["A", "B"] }) })
    );
  });

  it("passes structured approval target to approvalFn and returns it", async () => {
    const ctx = makeContext(true);
    const approvalTarget = {
      tool_name: "confirm_gateway_config_write",
      arguments: { channel: "telegram" },
    };
    const result = await tool.call({
      question: "Write config?",
      approval_scope: "write",
      approval_target: approvalTarget,
    }, ctx);
    expect(ctx.approvalFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ approval_target: approvalTarget }),
      })
    );
    expect(result.data).toMatchObject({ approval_target: approvalTarget });
  });

  it("returns failure when approvalFn throws", async () => {
    const ctx: ToolCallContext = {
      ...makeContext(true),
      approvalFn: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const result = await tool.call({ question: "ok?" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });

  it("Zod rejects empty question", () => {
    const parsed = AskHumanInputSchema.safeParse({ question: "" });
    expect(parsed.success).toBe(false);
  });

  it("Zod accepts question with optional options and approval scope", () => {
    const parsed = AskHumanInputSchema.safeParse({
      question: "ok?",
      options: ["yes", "no"],
      approval_scope: "execute",
      approval_target: {
        tool_name: "confirm_gateway_config_write",
        arguments: { channel: "telegram" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown fields and exports a closed model-facing schema", () => {
    expect(AskHumanInputSchema.safeParse({
      question: "Continue?",
      unexpected: true,
    }).success).toBe(false);

    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
