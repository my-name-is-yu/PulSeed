import { ConcurrencyController, ToolExecutor, ToolPermissionManager, ToolRegistry } from "../../../../tools/index.js";
import type { ToolPersonalAgentTraceContext, ToolResult } from "../../../../tools/types.js";
import { CreateScheduleTool } from "../../../../tools/schedule/CreateScheduleTool/CreateScheduleTool.js";
import { PauseScheduleTool } from "../../../../tools/schedule/PauseScheduleTool/PauseScheduleTool.js";
import { RemoveScheduleTool } from "../../../../tools/schedule/RemoveScheduleTool/RemoveScheduleTool.js";
import { ResumeScheduleTool } from "../../../../tools/schedule/ResumeScheduleTool/ResumeScheduleTool.js";
import { RunScheduleTool } from "../../../../tools/schedule/RunScheduleTool/RunScheduleTool.js";
import { UpdateScheduleTool } from "../../../../tools/schedule/UpdateScheduleTool/UpdateScheduleTool.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../../../../runtime/daemon/runtime-root.js";
import { PersonalAgentRuntimeStore, stableId } from "../../../../runtime/personal-agent/index.js";
import type { ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import type { RuntimeGraphRef } from "../../../../runtime/personal-agent/index.js";

export type ScheduleCliToolName =
  | "create_schedule"
  | "update_schedule"
  | "pause_schedule"
  | "resume_schedule"
  | "remove_schedule"
  | "run_schedule";

export interface ScheduleCliToolOptions {
  command: string;
  argv: readonly string[];
  currentRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
}

export async function executeScheduleCliTool(
  engine: ScheduleEngine,
  toolName: ScheduleCliToolName,
  input: unknown,
  options: ScheduleCliToolOptions,
): Promise<ToolResult> {
  const baseDir = engine.getBaseDir();
  const personalAgentRuntime = new PersonalAgentRuntimeStore(
    resolveConfiguredDaemonRuntimeRoot(baseDir),
    { controlBaseDir: baseDir },
  );
  const registry = new ToolRegistry();
  registry.register(new CreateScheduleTool(engine, personalAgentRuntime));
  registry.register(new UpdateScheduleTool(engine, personalAgentRuntime));
  registry.register(new PauseScheduleTool(engine, personalAgentRuntime));
  registry.register(new ResumeScheduleTool(engine, personalAgentRuntime));
  registry.register(new RemoveScheduleTool(engine, personalAgentRuntime));
  registry.register(new RunScheduleTool(engine, personalAgentRuntime));

  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    personalAgentRuntime,
    traceBaseDir: baseDir,
  });
  const replayKey = buildScheduleCliToolReplayKey(toolName, input, options);
  const callId = `cli:schedule:${toolName}:${stableId(replayKey)}`;
  const traceContext: ToolPersonalAgentTraceContext = {
    callerPath: "explicit_user_command",
    sourceKind: "explicit_command",
    sourceId: callId,
    sourceEpoch: `pulseed schedule ${options.command}`,
    highWatermark: stableId(stableJson({ argv: options.argv, input })),
    replayKey,
    summary: `pulseed schedule ${options.command} requested ${toolName}.`,
    sourceRef: { kind: "tool_call", ref: callId },
    currentRefs: options.currentRefs ?? [],
    auditRefs: [
      { kind: "tool_call", ref: callId },
      ...(options.auditRefs ?? []),
    ],
  };

  return executor.execute(toolName, input, {
    cwd: process.cwd(),
    goalId: "cli:schedule",
    trustBalance: 100,
    preApproved: true,
    hostPolicyApproved: true,
    approvalFn: async () => true,
    sessionId: "cli:schedule",
    callId,
    providerConfigBaseDir: baseDir,
    personalAgentRuntime,
    personalAgentTrace: traceContext,
  });
}

export function buildScheduleCliToolReplayKey(
  toolName: ScheduleCliToolName,
  input: unknown,
  options: Pick<ScheduleCliToolOptions, "command" | "argv">,
): string {
  return [
    "cli",
    "schedule",
    toolName,
    options.command,
    stableJson(options.argv),
    stableJson(input),
  ].join(":");
}

export function throwIfScheduleCliToolFailed(result: ToolResult): void {
  if (result.success) return;
  throw new Error(result.error ?? result.summary);
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableJson(record[key])]),
    );
  }
  return value;
}
