import type { ToolResult } from "./types.js";

export type ToolExecutionStatus = NonNullable<ToolResult["execution"]>;
export type ToolNotExecutedReason = NonNullable<ToolExecutionStatus["reason"]>;

export interface ToolFailureResultInput {
  error: string;
  durationMs: number;
  execution?: ToolResult["execution"];
}

export interface ToolNotExecutedResultInput {
  summary: string;
  durationMs: number;
  reason: ToolNotExecutedReason;
  message?: string;
  error?: string;
}

export function buildToolFailureResult(input: ToolFailureResultInput): ToolResult {
  return {
    success: false,
    data: null,
    summary: input.error,
    error: input.error,
    ...(input.execution ? { execution: input.execution } : {}),
    durationMs: input.durationMs,
  };
}

export function buildNotExecutedToolResult(input: ToolNotExecutedResultInput): ToolResult {
  return buildToolFailureResult({
    error: input.error ?? input.summary,
    durationMs: input.durationMs,
    execution: {
      status: "not_executed",
      reason: input.reason,
      message: input.message ?? input.summary,
    },
  });
}

export function buildDryRunToolResult(): ToolResult {
  return {
    success: true,
    data: null,
    summary: "dry-run: skipped",
    execution: {
      status: "not_executed",
      reason: "dry_run",
      message: "dry-run skipped tool.call()",
    },
    durationMs: 0,
  };
}

export function buildToolOutcomeSummary(toolName: string, result: ToolResult): string {
  const status = result.execution?.status ?? (result.success ? "executed" : "failed");
  const reason = result.execution?.reason ? ` reason=${result.execution.reason}` : "";
  const summary = result.summary ? ` ${result.summary}` : "";
  return `${toolName} action outcome: ${status}${reason}.${summary}`.trim();
}
