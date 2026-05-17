/**
 * Capability acquisition helpers used from the CoreLoop task cycle.
 */

import type { Logger } from "../../../runtime/logger.js";
import type { AgentResult, IAdapter } from "../../execution/adapter-layer.js";
import { AdapterRegistry } from "../../execution/adapter-layer.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../../../base/types/capability.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ToolPermissionManager } from "../../../tools/permission.js";
import { ConcurrencyController } from "../../../tools/concurrency.js";
import type { ToolCallContext } from "../../../tools/types.js";
import { RunAdapterTool } from "../../../tools/execution/RunAdapterTool/RunAdapterTool.js";
import {
  PersonalAgentRuntimeStore,
  stableId,
} from "../../../runtime/personal-agent/index.js";

export interface CapabilityAcquisitionOutcome {
  capabilityName: string;
  replanRequired: boolean;
  recommendationSource?: string;
  recommendedPlugin?: string;
}

export interface CapabilityAcquisitionExecutionOptions {
  toolExecutor?: ToolExecutor;
  baseDir?: string;
}

/** Handle the "capability_acquiring" action from TaskLifecycle.
 * Delegates acquisition to an adapter, verifies the result, and registers
 * the capability on success. Retries up to 3 times before escalating. */
export async function handleCapabilityAcquisition(
  acquisitionTask: CapabilityAcquisitionTask,
  goalId: string,
  adapter: IAdapter,
  capabilityDetector: CapabilityDetector | undefined,
  capabilityAcquisitionFailures: Map<string, number>,
  logger: Logger | undefined,
  options: CapabilityAcquisitionExecutionOptions = {},
): Promise<CapabilityAcquisitionOutcome> {
  const capName = acquisitionTask.gap.missing_capability.name;
  const capType = acquisitionTask.gap.missing_capability.type;

  if (!capabilityDetector) {
    logger?.warn("CoreLoop: capability_acquiring action received but no capabilityDetector configured — skipping");
    return { capabilityName: capName, replanRequired: false };
  }

  const recommendation = capabilityDetector.recommendAcquisition(acquisitionTask.gap)[0];

  try {
    await capabilityDetector.setCapabilityStatus(capName, capType, "requested");
  } catch {
    // Non-fatal.
  }

  logger?.info("CoreLoop: handling capability acquisition", { capName, capType, method: acquisitionTask.method });

  const recommendationBlock = recommendation
    ? `\nRecommended acquisition path:\n` +
      `- Plugin: ${recommendation.pluginName}\n` +
      `- Install source: ${recommendation.installSource}\n` +
      `- Verification hint: ${recommendation.verificationHint}\n`
    : "";

  const prompt =
    `Capability Acquisition Task\n` +
    `Method: ${acquisitionTask.method}\n` +
    `Description: ${acquisitionTask.task_description}\n` +
    `Success criteria: ${acquisitionTask.success_criteria.join("; ")}\n\n` +
    recommendationBlock +
    `Instructions: Please acquire or set up the capability "${capName}" (${capType}). ` +
    `Follow the method "${acquisitionTask.method}" and ensure the success criteria are met.`;

  let agentResult;
  try {
    await capabilityDetector.setCapabilityStatus(capName, capType, "acquiring");
    agentResult = await executeCapabilityAcquisitionAdapter({
      acquisitionTask,
      goalId,
      adapter,
      prompt,
      options,
    });
  } catch (err) {
    logger?.error("CoreLoop: adapter execution failed during capability acquisition", {
      capName,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId, capabilityAcquisitionFailures, logger);
    return {
      capabilityName: capName,
      replanRequired: false,
      recommendationSource: recommendation?.installSource,
      recommendedPlugin: recommendation?.pluginName,
    };
  }

  const capability = {
    id: capName.toLowerCase().replace(/\s+/g, "_"),
    name: capName,
    description: acquisitionTask.task_description,
    type: capType,
    status: "acquiring" as const,
  };

  let verificationResult;
  try {
    verificationResult = await capabilityDetector.verifyAcquiredCapability(
      capability,
      acquisitionTask,
      agentResult
    );
  } catch (err) {
    logger?.error("CoreLoop: capability verification threw an error", {
      capName,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId, capabilityAcquisitionFailures, logger);
    return {
      capabilityName: capName,
      replanRequired: false,
      recommendationSource: recommendation?.installSource,
      recommendedPlugin: recommendation?.pluginName,
    };
  }

  if (verificationResult === "pass") {
    capabilityAcquisitionFailures.delete(capName);
    try {
      await capabilityDetector.registerCapability(capability, {
        goal_id: goalId,
        originating_task_id: acquisitionTask.gap.related_task_id,
        acquired_at: new Date().toISOString(),
      });
      await capabilityDetector.setCapabilityStatus(capName, capType, "available");
      logger?.info("CoreLoop: capability acquired and registered successfully", {
        capName,
        replanRequired: true,
        recommendedPlugin: recommendation?.pluginName,
      });
      return {
        capabilityName: capName,
        replanRequired: true,
        recommendationSource: recommendation?.installSource,
        recommendedPlugin: recommendation?.pluginName,
      };
    } catch (err) {
      logger?.error("CoreLoop: failed to register capability after verification pass", {
        capName,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        capabilityName: capName,
        replanRequired: false,
        recommendationSource: recommendation?.installSource,
        recommendedPlugin: recommendation?.pluginName,
      };
    }
  } else if (verificationResult === "escalate") {
    capabilityAcquisitionFailures.delete(capName);
    await escalateCapability(capabilityDetector, acquisitionTask, goalId, logger);
  } else {
    await recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId, capabilityAcquisitionFailures, logger);
  }

  return {
    capabilityName: capName,
    replanRequired: false,
    recommendationSource: recommendation?.installSource,
    recommendedPlugin: recommendation?.pluginName,
  };
}

async function executeCapabilityAcquisitionAdapter(input: {
  acquisitionTask: CapabilityAcquisitionTask;
  goalId: string;
  adapter: IAdapter;
  prompt: string;
  options: CapabilityAcquisitionExecutionOptions;
}): Promise<AgentResult> {
  const baseDir = input.options.baseDir;
  if (!baseDir) {
    throw new Error("capability acquisition requires an explicit baseDir");
  }
  const toolExecutor = input.options.toolExecutor ?? createRunAdapterToolExecutor(input.adapter, baseDir);
  const replayKey = [
    "capability_acquisition:run_adapter",
    input.goalId,
    input.acquisitionTask.gap.related_task_id ?? "task:none",
    input.acquisitionTask.gap.missing_capability.name,
    input.acquisitionTask.method,
    stableId(input.prompt),
  ].join(":");
  const toolContext: ToolCallContext = {
    cwd: baseDir,
    goalId: input.goalId,
    taskId: input.acquisitionTask.gap.related_task_id,
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => false,
    providerConfigBaseDir: baseDir,
    personalAgentRuntime: new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir }),
    callId: `capability-acquisition-run-adapter:${stableId(replayKey)}`,
    sessionId: `goal:${input.goalId}`,
    turnId: `capability-acquisition:${stableId([
      input.goalId,
      input.acquisitionTask.gap.missing_capability.name,
      input.acquisitionTask.method,
    ].join(":"))}`,
    personalAgentTrace: {
      callerPath: "task_execution",
      sourceKind: "task_execution",
      sourceId: input.acquisitionTask.gap.related_task_id ?? input.acquisitionTask.gap.missing_capability.name,
      sourceEpoch: input.acquisitionTask.method,
      highWatermark: `${input.goalId}:${input.acquisitionTask.gap.missing_capability.name}:${input.acquisitionTask.verification_attempts}`,
      replayKey,
      summary: `Acquire capability ${input.acquisitionTask.gap.missing_capability.name} through run-adapter.`,
      sourceRef: {
        kind: input.acquisitionTask.gap.related_task_id ? "task" : "capability_gap",
        ref: input.acquisitionTask.gap.related_task_id ?? input.acquisitionTask.gap.missing_capability.name,
      },
      currentRefs: [
        { kind: "goal", ref: input.goalId },
        { kind: "capability", ref: input.acquisitionTask.gap.missing_capability.name },
      ],
      auditRefs: [
        { kind: "capability_acquisition_method", ref: input.acquisitionTask.method },
        { kind: "adapter", ref: input.adapter.adapterType },
      ],
    },
  };
  const result = await toolExecutor.execute(
    "run-adapter",
    {
      adapter_id: input.adapter.adapterType,
      task_description: input.prompt,
      goal_id: input.goalId,
      timeout_ms: 120_000,
    },
    toolContext,
  );
  if (result.data != null && isAgentResult(result.data)) return result.data;
  throw new Error(result.error ?? result.execution?.reason ?? "run_adapter_not_executed");
}

function createRunAdapterToolExecutor(adapter: IAdapter, baseDir: string): ToolExecutor {
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(adapter);
  const registry = new ToolRegistry();
  registry.register(new RunAdapterTool(adapterRegistry));
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    personalAgentRuntime: new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir }),
    traceBaseDir: baseDir,
  });
}

function isAgentResult(value: unknown): value is AgentResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<AgentResult>;
  return typeof record.success === "boolean"
    && typeof record.output === "string"
    && typeof record.elapsed_ms === "number"
    && (record.stopped_reason === "completed"
      || record.stopped_reason === "timeout"
      || record.stopped_reason === "error"
      || record.stopped_reason === "cancelled"
      || record.stopped_reason === "blocked"
      || record.stopped_reason === "policy_blocked");
}

/** Records a capability acquisition failure and escalates after 3 consecutive failures. */
export async function recordCapabilityFailure(
  capabilityDetector: CapabilityDetector,
  acquisitionTask: CapabilityAcquisitionTask,
  goalId: string,
  capabilityAcquisitionFailures: Map<string, number>,
  logger: Logger | undefined
): Promise<void> {
  const capName = acquisitionTask.gap.missing_capability.name;
  const currentCount = (capabilityAcquisitionFailures.get(capName) ?? 0) + 1;
  capabilityAcquisitionFailures.set(capName, currentCount);

  logger?.warn("CoreLoop: capability acquisition failed", { capName, failureCount: currentCount });

  if (currentCount >= 3) {
    await escalateCapability(capabilityDetector, acquisitionTask, goalId, logger);
  }
}

/** Escalates a capability acquisition failure to the user and marks status as verification_failed. */
export async function escalateCapability(
  capabilityDetector: CapabilityDetector,
  acquisitionTask: CapabilityAcquisitionTask,
  goalId: string,
  logger: Logger | undefined
): Promise<void> {
  const capName = acquisitionTask.gap.missing_capability.name;
  const capType = acquisitionTask.gap.missing_capability.type;

  logger?.warn("CoreLoop: escalating capability acquisition to user", { capName });
  try {
    await capabilityDetector.escalateToUser(acquisitionTask.gap, goalId);
    await capabilityDetector.setCapabilityStatus(capName, capType, "verification_failed");
  } catch (err) {
    logger?.error("CoreLoop: escalation failed", {
      capName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
