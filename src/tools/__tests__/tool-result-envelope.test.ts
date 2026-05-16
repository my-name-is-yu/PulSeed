import { describe, expect, it } from "vitest";
import { ToolResultSchema } from "../types.js";
import {
  buildDryRunToolResult,
  buildNotExecutedToolResult,
  buildToolFailureResult,
  buildToolOutcomeSummary,
} from "../tool-result-envelope.js";

describe("tool-result-envelope", () => {
  it("builds schema-valid non-executed failure results", () => {
    const result = buildNotExecutedToolResult({
      summary: "Permission denied by policy: write blocked",
      durationMs: 12,
      reason: "policy_blocked",
      message: "write blocked",
    });

    expect(ToolResultSchema.parse(result)).toMatchObject({
      success: false,
      data: null,
      summary: "Permission denied by policy: write blocked",
      error: "Permission denied by policy: write blocked",
      execution: {
        status: "not_executed",
        reason: "policy_blocked",
        message: "write blocked",
      },
      durationMs: 12,
    });
  });

  it("keeps dry-run rendering in the shared envelope", () => {
    expect(ToolResultSchema.parse(buildDryRunToolResult())).toEqual({
      success: true,
      data: null,
      summary: "dry-run: skipped",
      execution: {
        status: "not_executed",
        reason: "dry_run",
        message: "dry-run skipped tool.call()",
      },
      durationMs: 0,
    });
  });

  it("summarizes executed and non-executed outcomes consistently", () => {
    const failure = buildToolFailureResult({
      error: "Tool failed",
      durationMs: 3,
      execution: {
        status: "executed",
        reason: "tool_error",
        message: "boom",
      },
    });
    const denied = buildNotExecutedToolResult({
      summary: "User denied approval: write file",
      durationMs: 4,
      reason: "approval_denied",
      message: "write file",
    });

    expect(buildToolOutcomeSummary("write_file", failure)).toBe(
      "write_file action outcome: executed reason=tool_error. Tool failed"
    );
    expect(buildToolOutcomeSummary("write_file", denied)).toBe(
      "write_file action outcome: not_executed reason=approval_denied. User denied approval: write file"
    );
  });
});
