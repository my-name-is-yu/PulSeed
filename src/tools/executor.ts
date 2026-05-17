// src/tools/executor.ts

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getPulseedDirPath } from "../base/utils/paths.js";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
} from "./types.js";
import type { PermissionGrantEvaluation } from "./permission-grant-evaluation.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolPermissionManager } from "./permission.js";
import type { ConcurrencyController } from "./concurrency.js";
import {
  decideHostToolExecution,
  permissionResultFromHostDecision,
  type HostToolExecutionDecision,
} from "./execution-orchestrator.js";
import { persistCapabilityExecutionRecords } from "./capability-execution-records.js";
import { assessShellCommand } from "./system/ShellTool/command-policy.js";
import {
  recordPersonalAgentToolDecision,
} from "./personal-agent-tool-trace.js";
import {
  buildApprovedToolCallContext,
  buildPermissionApprovalWaitPlan,
  buildPermissionWaitCanonicalPlan,
} from "./permission-wait-plan.js";
import {
  buildDryRunToolResult,
  buildNotExecutedToolResult,
  buildToolFailureResult,
  buildToolOutcomeSummary,
} from "./tool-result-envelope.js";
import {
  CapabilityPlane,
  admitCapabilityDescriptor,
  type CapabilityAdmissionDecision,
  type CapabilityDescriptor,
} from "../runtime/capability-plane.js";
import type {
  CapabilityRegistryDecisionKind,
  InterventionDecisionKind,
  InterventionTargetEffect,
} from "../runtime/personal-agent/index.js";
import type { PersonalAgentRuntimeStore } from "../runtime/personal-agent/index.js";
import { InteractionAuthorityStore } from "../runtime/control/interaction-authority-store.js";
import { projectApprovalResumeAuthority } from "../runtime/control/execution-authority-decision.js";
import { RuntimeEventLogStore } from "../runtime/store/runtime-event-log.js";
import type {
  PermissionWaitCanonicalPlan,
  PermissionWaitPlanRecord,
  PermissionWaitPlanResumeResult,
} from "../runtime/store/permission-wait-plan-store.js";

type PermissionApprovalResult =
  | { status: "approved"; context: ToolCallContext }
  | { status: "blocked"; result: ToolResult };

/**
 * 5-gate execution pipeline for tool invocations.
 *
 * Gate 1: Input validation (Zod schema)
 * Gate 2: Semantic validation (tool-specific checkPermissions)
 * Gate 3: Permission check (3-layer permission manager)
 * Gate 4: Input sanitization (path traversal, injection prevention)
 * Gate 5: Concurrency control (input-dependent batching)
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly permissionManager: ToolPermissionManager;
  private readonly concurrency: ConcurrencyController;
  private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  private readonly interactionAuthorityStore?: Pick<InteractionAuthorityStore, "recordDecision">;
  private readonly traceBaseDir?: string | null;
  private readonly staticCapabilityPlane?: CapabilityPlane;

  constructor(deps: ToolExecutorDeps) {
    this.registry = deps.registry;
    this.permissionManager = deps.permissionManager;
    this.concurrency = deps.concurrency;
    this.personalAgentRuntime = deps.personalAgentRuntime;
    this.interactionAuthorityStore = deps.interactionAuthorityStore;
    this.traceBaseDir = deps.traceBaseDir ?? null;
    this.staticCapabilityPlane = deps.capabilityPlane;
  }

  async execute(
    toolName: string,
    rawInput: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      const missing = buildNotExecutedToolResult({
        summary: `Tool "${toolName}" not found`,
        durationMs: 0,
        reason: "policy_blocked",
        message: `Tool "${toolName}" is missing and cannot fall back to a direct adapter execution path.`,
      });
      await recordPersonalAgentToolDecision(
        {
          personalAgentRuntime: context.personalAgentRuntime ?? this.personalAgentRuntime,
          baseDir: context.providerConfigBaseDir ?? this.traceBaseDir ?? null,
        },
        toolName,
        rawInput,
        context,
        {
          decision: "block",
          capabilityDecision: "missing",
          decisionReason: `ToolExecutor denied missing tool ${toolName} before any adapter fallback.`,
          targetEffect: "execute_tool",
          targetSummary: `${toolName} tool execution was blocked before side effects because no registered tool exists.`,
          capabilityRefs: [{ kind: "tool", ref: toolName }],
          outcomeSummary: buildToolOutcomeSummary(toolName, missing),
        },
      );
      return missing;
    }

    const startTime = Date.now();
    const logger = context.logger;
    const callId = context.callId;
    const sessionId = context.sessionId;

    logger?.debug("tool.call.start", { tool: toolName, callId, sessionId });

    // --- Gate 1: Input Validation (Zod) ---
    const parseResult = tool.inputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      const errors = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return this.failResult(
        `Input validation failed: ${errors}`,
        Date.now() - startTime,
      );
    }
    const input = parseResult.data;

    const capabilityPreflightResult = await this.checkCapabilityPlanePreflight(tool, input, context, startTime);
    if (capabilityPreflightResult.result) return capabilityPreflightResult.result;
    const capabilityContext = capabilityPreflightResult.context;

    const hostPreflightResult = await this.checkHostPolicyPreflight(tool, input, capabilityContext, startTime);
    if (hostPreflightResult) return hostPreflightResult;

    let precheckedPermissionResult: Awaited<ReturnType<ToolPermissionManager["check"]>> | null = null;
    let executionContext = capabilityContext;

    // --- Gate 2: Semantic Validation (tool-specific) ---
    const semanticResult = await tool.checkPermissions(input, executionContext);
    if (semanticResult.status === "denied") {
      await this.recordToolPolicyDecision(tool, input, context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: `Tool-specific permission check blocked ${tool.metadata.name}: ${semanticResult.reason}`,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was blocked before side effects.`,
      });
      return this.failResult(
        `Permission denied: ${semanticResult.reason}`,
        Date.now() - startTime,
        { status: "not_executed", reason: semanticResult.executionReason ?? "permission_denied", message: semanticResult.reason },
      );
    }
    if (semanticResult.status === "needs_approval") {
      const grantBackedPermissionResult = await this.permissionManager.check(tool, input, context);
      if (this.isAllowedByPermissionGrant(grantBackedPermissionResult)) {
        precheckedPermissionResult = grantBackedPermissionResult;
      } else {
        if (grantBackedPermissionResult.status === "denied") {
          await this.recordToolPolicyDecision(tool, input, context, {
            decision: "block",
            capabilityDecision: "blocked",
            decisionReason: `Permission policy blocked ${tool.metadata.name}: ${grantBackedPermissionResult.reason}`,
            targetEffect: "execute_tool",
            targetSummary: `${tool.metadata.name} tool execution was blocked before side effects.`,
          });
          return this.failResult(
            `Permission denied by policy: ${grantBackedPermissionResult.reason}`,
            Date.now() - startTime,
            {
              status: "not_executed",
              reason: grantBackedPermissionResult.executionReason ?? "policy_blocked",
              message: grantBackedPermissionResult.reason,
            },
          );
        }
        const approvalReason = tool.metadata.tags.includes("automation")
          ? semanticResult.reason
          : grantBackedPermissionResult.status === "needs_approval"
            ? grantBackedPermissionResult.reason
            : semanticResult.reason;
        await this.recordToolPolicyDecision(tool, input, context, {
          decision: "confirm_required",
          capabilityDecision: "permission_required",
          decisionReason: `Tool-specific permission check requires confirmation for ${tool.metadata.name}: ${approvalReason}`,
          targetEffect: "execute_tool",
          targetSummary: `${tool.metadata.name} tool execution requires confirmation before side effects.`,
        });
        const approvalResult = await this.requestPermissionApproval({
          tool,
          input,
          context,
          startTime,
          reason: approvalReason,
          reversibility: "unknown",
          permissionGrantDecision: grantBackedPermissionResult.permissionGrantDecision,
        });
        if (approvalResult.status === "blocked") return approvalResult.result;
        executionContext = approvalResult.context;
        precheckedPermissionResult = { status: "allowed" };
      }
    }

    // --- Gate 3: Permission Manager (3-layer) ---
    const permResult = precheckedPermissionResult ?? await this.permissionManager.check(tool, input, executionContext);
    if (permResult.status === "denied") {
      await this.recordToolPolicyDecision(tool, input, context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: `Permission policy blocked ${tool.metadata.name}: ${permResult.reason}`,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was blocked before side effects.`,
      });
      return this.failResult(
        `Permission denied by policy: ${permResult.reason}`,
        Date.now() - startTime,
        { status: "not_executed", reason: permResult.executionReason ?? "policy_blocked", message: permResult.reason },
      );
    }
    if (permResult.status === "needs_approval") {
      await this.recordToolPolicyDecision(tool, input, context, {
        decision: "confirm_required",
        capabilityDecision: "permission_required",
        decisionReason: `Permission policy requires confirmation for ${tool.metadata.name}: ${permResult.reason}`,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution requires confirmation before side effects.`,
      });
      const approvalResult = await this.requestPermissionApproval({
        tool,
        input,
        context: executionContext,
        startTime,
        reason: permResult.reason,
        reversibility: "reversible",
        policyDecision: permResult.policyDecision,
        permissionGrantDecision: permResult.permissionGrantDecision,
      });
      if (approvalResult.status === "blocked") return approvalResult.result;
      executionContext = approvalResult.context;
    }

    const capabilityApprovalResult = await this.finalizeCapabilityPlaneAdmission(
      tool,
      input,
      executionContext,
      startTime,
      permResult,
    );
    if (capabilityApprovalResult.status === "blocked") return capabilityApprovalResult.result;
    executionContext = capabilityApprovalResult.context;

    // --- Gate 4: Input Sanitization ---
    const sanitizeError = this.sanitizeInput(tool, input, executionContext);
    if (sanitizeError) {
      await this.recordToolPolicyDecision(tool, input, context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: `Input sanitizer blocked ${tool.metadata.name}: ${sanitizeError}`,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was blocked before side effects.`,
      });
      return this.failResult(
        `Input sanitization failed: ${sanitizeError}`,
        Date.now() - startTime,
        { status: "not_executed", reason: "policy_blocked", message: sanitizeError },
      );
    }

    await this.recordToolPolicyDecision(tool, input, executionContext, {
      decision: "allow",
      capabilityDecision: "available",
      decisionReason: `${tool.metadata.name} was admitted by Capability Registry and InterventionPolicy before tool.call().`,
      targetEffect: "execute_tool",
      targetSummary: `${tool.metadata.name} tool execution was admitted before side effects.`,
    });

    // --- Gate 5: Concurrency Control ---
    let result: ToolResult;
    try {
      result = await this.concurrency.run(
        tool,
        input,
        async () => {
          if (executionContext.dryRun) {
            return buildDryRunToolResult();
          }
          const callFn = () => tool.call(input, executionContext);
          const isSafe = tool.isConcurrencySafe(input);
          if (executionContext.timeoutMs) {
            return this.withTimeout(
              () => this.callWithRetry(callFn, tool.metadata.name, isSafe, executionContext),
              executionContext.timeoutMs,
            );
          }
          return this.callWithRetry(callFn, tool.metadata.name, isSafe, executionContext);
        },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger?.warn("tool.call.failure", { tool: toolName, callId, error });
      const failure = this.failResult(
        `Tool ${toolName} failed: ${error}`,
        Date.now() - startTime,
        this.executionForFailure(err, executionContext) ?? { status: "executed", reason: "tool_error", message: error },
      );
      await this.recordToolPolicyDecision(tool, input, executionContext, {
        decision: "allow",
        capabilityDecision: "available",
        decisionReason: `${tool.metadata.name} was admitted by Capability Registry and InterventionPolicy before tool.call().`,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was admitted before side effects.`,
        outcomeSummary: buildToolOutcomeSummary(tool.metadata.name, failure),
      });
      try {
        await persistCapabilityExecutionRecords({ tool, rawInput: input, result: failure, context: executionContext });
      } catch (persistErr) {
        const persistError = persistErr instanceof Error ? persistErr.message : String(persistErr);
        logger?.warn("tool.capability_records.failure", { tool: toolName, callId, error: persistError });
      }
      throw err;
    }

    // --- Output Truncation ---
    if (result.data) {
      const serialized = JSON.stringify(result.data);
      if (serialized.length > tool.metadata.maxOutputChars) {
        const originalLength = serialized.length;
        const truncatedStr = serialized.slice(0, tool.metadata.maxOutputChars);
        const overflowDir = join(getPulseedDirPath(), "tmp");
        mkdirSync(overflowDir, { recursive: true });
        const overflowPath = join(overflowDir, `overflow-${randomUUID()}.json`);
        writeFileSync(overflowPath, serialized, "utf-8");
        result.data = truncatedStr;
        result.summary = `${result.summary} [truncated: ${originalLength - tool.metadata.maxOutputChars} chars omitted]`;
        result.truncated = { originalChars: originalLength, overflowPath };
      }
    }

    await this.recordToolPolicyDecision(tool, input, executionContext, {
      decision: "allow",
      capabilityDecision: "available",
      decisionReason: `${tool.metadata.name} was admitted by Capability Registry and InterventionPolicy before tool.call().`,
      targetEffect: "execute_tool",
      targetSummary: `${tool.metadata.name} tool execution was admitted before side effects.`,
      outcomeSummary: buildToolOutcomeSummary(tool.metadata.name, result),
    });

    try {
      await persistCapabilityExecutionRecords({ tool, rawInput: input, result, context: executionContext });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger?.warn("tool.capability_records.failure", { tool: toolName, callId, error });
    }

    logger?.debug("tool.call.success", { tool: toolName, callId, durationMs: Date.now() - startTime });
    return result;
  }

  async executeBatch(
    calls: Array<{ toolName: string; input: unknown }>,
    context: ToolCallContext,
  ): Promise<ToolResult[]> {
    const safe: Array<{ toolName: string; input: unknown; index: number }> = [];
    const unsafe: Array<{ toolName: string; input: unknown; index: number }> = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = this.registry.get(call.toolName);
      if (tool && tool.isConcurrencySafe(call.input)) {
        safe.push({ ...call, index: i });
      } else {
        unsafe.push({ ...call, index: i });
      }
    }

    const results: ToolResult[] = new Array(calls.length);

    // Run safe calls in parallel
    const safeResults = await Promise.all(
      safe.map((c) => this.execute(c.toolName, c.input, this.cloneToolCallContext(context))),
    );
    for (let i = 0; i < safe.length; i++) {
      results[safe[i].index] = safeResults[i];
    }

    // Run unsafe calls sequentially
    for (const c of unsafe) {
      results[c.index] = await this.execute(c.toolName, c.input, this.cloneToolCallContext(context));
    }

    return results;
  }

  // --- Private Helpers ---

  private async checkCapabilityPlanePreflight(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
    startTime: number,
  ): Promise<{ context: ToolCallContext; result?: ToolResult }> {
    const admission = this.resolveCapabilityPlane().admitToolExecution({ tool, rawInput: input, context });
    const descriptorContext = this.withCapabilityDescriptorContext(context, tool, admission);

    if (admission.status === "blocked") {
      const blocked = buildNotExecutedToolResult({
        summary: `Capability Plane blocked ${tool.metadata.name}: ${admission.reason}`,
        durationMs: Date.now() - startTime,
        reason: "policy_blocked",
        message: admission.reason,
      });
      await this.recordToolPolicyDecision(tool, input, descriptorContext, {
        decision: "block",
        capabilityDecision: admission.descriptor ? "blocked" : "missing",
        decisionReason: admission.reason,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was blocked by Capability Plane before side effects.`,
        outcomeSummary: buildToolOutcomeSummary(tool.metadata.name, blocked),
      });
      return { context: descriptorContext, result: blocked };
    }

    if (admission.status === "requires_approval") {
      return { context: descriptorContext };
    }

    return { context: descriptorContext };
  }

  private resolveCapabilityPlane(): CapabilityPlane {
    return this.staticCapabilityPlane ?? CapabilityPlane.fromToolRegistry(this.registry);
  }

  private withCapabilityDescriptorContext(
    context: ToolCallContext,
    tool: ITool,
    admission: CapabilityAdmissionDecision,
  ): ToolCallContext {
    const descriptor = admission.descriptor;
    if (!descriptor) {
      context.capabilityAdmissionDecision = admission;
      return context;
    }
    context.capabilityDescriptor = descriptor;
    context.capabilityAdmissionDecision = admission;
    return context;
  }

  private cloneToolCallContext(context: ToolCallContext): ToolCallContext {
    const clone: ToolCallContext = {
      ...context,
      capabilityDescriptor: undefined,
      capabilityAdmissionDecision: undefined,
      capabilityExecution: undefined,
    };
    Object.defineProperty(clone, "hostToolState", {
      get: () => context.hostToolState,
      set: (value: ToolCallContext["hostToolState"]) => {
        context.hostToolState = value;
      },
      enumerable: true,
      configurable: true,
    });
    return clone;
  }

  private async finalizeCapabilityPlaneAdmission(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
    startTime: number,
    permissionResult: PermissionCheckResult | null,
  ): Promise<PermissionApprovalResult> {
    const descriptor = context.capabilityDescriptor;
    if (!descriptor) return { status: "approved", context };

    const authorityApproved = context.preApproved === true
      || (permissionResult !== null && this.isAllowedByPermissionGrant(permissionResult))
      || (permissionResult !== null && this.isAllowedByHostPolicy(tool, input, context, permissionResult));
    let finalAdmission = admitCapabilityDescriptor({
      descriptor,
      rawInput: input,
      context: {
        preApproved: authorityApproved,
        approvalFingerprint: context.capabilityAdmissionDecision?.capability_fingerprint ?? null,
        authorityRefs: this.capabilityAuthorityRefs(tool, descriptor, context, permissionResult, authorityApproved),
        cwd: context.cwd,
        goalId: context.goalId,
        runId: context.runId ?? null,
        sessionId: context.sessionId ?? null,
        turnId: context.turnId ?? null,
        callId: context.callId ?? null,
        stateEpoch: context.hostToolState?.currentEpoch ?? context.hostToolState?.observedEpoch ?? null,
      },
    });
    context.capabilityAdmissionDecision = finalAdmission;

    if (finalAdmission.status === "blocked") {
      const blocked = buildNotExecutedToolResult({
        summary: `Capability Plane blocked ${tool.metadata.name}: ${finalAdmission.reason}`,
        durationMs: Date.now() - startTime,
        reason: "policy_blocked",
        message: finalAdmission.reason,
      });
      await this.recordToolPolicyDecision(tool, input, context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: finalAdmission.reason,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was blocked by final Capability Plane admission before side effects.`,
        outcomeSummary: buildToolOutcomeSummary(tool.metadata.name, blocked),
      });
      return { status: "blocked", result: blocked };
    }

    if (finalAdmission.status === "allowed") {
      return { status: "approved", context };
    }

    await this.recordToolPolicyDecision(tool, input, context, {
      decision: "confirm_required",
      capabilityDecision: "permission_required",
      decisionReason: finalAdmission.reason,
      targetEffect: "execute_tool",
      targetSummary: `${tool.metadata.name} tool execution requires descriptor-backed confirmation before side effects.`,
    });
    const approvalResult = await this.requestPermissionApproval({
      tool,
      input,
      context,
      startTime,
      reason: finalAdmission.reason,
      reversibility: reversibilityForDescriptor(descriptor),
    });
    if (approvalResult.status === "blocked") return approvalResult;

    finalAdmission = admitCapabilityDescriptor({
      descriptor,
      rawInput: input,
      context: {
        preApproved: true,
        approvalFingerprint: finalAdmission.capability_fingerprint,
        authorityRefs: this.capabilityAuthorityRefs(tool, descriptor, approvalResult.context, permissionResult, true),
        cwd: approvalResult.context.cwd,
        goalId: approvalResult.context.goalId,
        runId: approvalResult.context.runId ?? null,
        sessionId: approvalResult.context.sessionId ?? null,
        turnId: approvalResult.context.turnId ?? null,
        callId: approvalResult.context.callId ?? null,
        stateEpoch: approvalResult.context.hostToolState?.currentEpoch ?? approvalResult.context.hostToolState?.observedEpoch ?? null,
      },
    });
    approvalResult.context.capabilityAdmissionDecision = finalAdmission;
    if (finalAdmission.status !== "allowed") {
      const blocked = buildNotExecutedToolResult({
        summary: `Capability Plane blocked ${tool.metadata.name}: ${finalAdmission.reason}`,
        durationMs: Date.now() - startTime,
        reason: "policy_blocked",
        message: finalAdmission.reason,
      });
      await this.recordToolPolicyDecision(tool, input, approvalResult.context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: finalAdmission.reason,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was blocked by final Capability Plane admission before side effects.`,
        outcomeSummary: buildToolOutcomeSummary(tool.metadata.name, blocked),
      });
      return { status: "blocked", result: blocked };
    }
    return approvalResult;
  }

  private capabilityAuthorityRefs(
    tool: ITool,
    descriptor: CapabilityDescriptor,
    _context: ToolCallContext,
    permissionResult: PermissionCheckResult | null,
    authorityApproved: boolean,
  ): string[] {
    const refs = [
      `descriptor:${descriptor.provider_kind}:${tool.metadata.name}`,
      `permission:${tool.metadata.permissionLevel}`,
    ];
    if (tool.metadata.requiresNetwork) refs.push("permission:network");
    if (tool.metadata.isDestructive && authorityApproved) refs.push("approval:destructive-action");
    if (permissionResult !== null && this.isAllowedByPermissionGrant(permissionResult)) {
      refs.push("permission_grant:matched");
    }
    return refs;
  }

  private isAllowedByHostPolicy(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
    permissionResult: PermissionCheckResult,
  ): boolean {
    if (permissionResult.status !== "allowed" || !context.executionPolicy) return false;
    return decideHostToolExecution({ tool, input, context }).status === "allowed";
  }

  private async requestPermissionApproval(input: {
    tool: ITool;
    input: unknown;
    context: ToolCallContext;
    startTime: number;
    reason: string;
    reversibility: "reversible" | "irreversible" | "unknown";
    policyDecision?: HostToolExecutionDecision;
    permissionGrantDecision?: PermissionGrantEvaluation;
  }): Promise<PermissionApprovalResult> {
    const waitPlan = buildPermissionApprovalWaitPlan(input);
    let waitingRecord: PermissionWaitPlanRecord | null = null;
    if (input.context.permissionWaitPlanStore) {
      waitingRecord = await input.context.permissionWaitPlanStore.createWaiting({
        wait_plan_id: waitPlan.approvalId,
        approval_id: waitPlan.approvalId,
        goal_id: input.context.goalId,
        canonical_plan: waitPlan.canonicalPlan,
        audit_refs: [waitPlan.auditRef],
      });
    }

    await input.context.onApprovalRequested?.(waitPlan.approvalRequest);
    const approved = await input.context.approvalFn(waitPlan.approvalRequest);
    if (!approved) {
      await input.context.permissionWaitPlanStore?.markDenied(waitPlan.approvalId, {
        reason: "approval_denied",
        audit_refs: [waitPlan.auditRef],
      });
      const denied = buildNotExecutedToolResult({
        summary: `User denied approval: ${input.reason}`,
        durationMs: Date.now() - input.startTime,
        reason: "approval_denied",
        message: input.reason,
      });
      await this.recordToolPolicyDecision(input.tool, input.input, input.context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: `Operator denied confirmation for ${input.tool.metadata.name}: ${input.reason}`,
        targetEffect: "execute_tool",
        targetSummary: `${input.tool.metadata.name} tool execution was blocked after confirmation was denied.`,
        outcomeSummary: buildToolOutcomeSummary(input.tool.metadata.name, denied),
      });
      return { status: "blocked", result: denied };
    }

    if (!input.context.permissionWaitPlanStore) {
      return { status: "approved", context: buildApprovedToolCallContext(input.context) };
    }
    if (!waitingRecord) {
      throw new Error("Permission wait plan store did not return a waiting approval record.");
    }

    const resumePlan = buildPermissionWaitCanonicalPlan({
      tool: input.tool,
      input: input.input,
      context: input.context,
      reason: input.reason,
      reversibility: input.reversibility,
      permissionGrantDecision: input.permissionGrantDecision,
    });
    await this.recordApprovalResumeRequestBeforeMutation(input.context, {
      waitPlanId: waitPlan.approvalId,
      expectedCanonicalPlan: waitPlan.canonicalPlan,
      actualCanonicalPlan: resumePlan,
      waitingRecord,
    });
    await input.context.permissionWaitPlanStore.markApproved(waitPlan.approvalId, {
      audit_refs: [`approval:${waitPlan.approvalId}`, waitPlan.auditRef],
    });
    const resumeResult = await input.context.permissionWaitPlanStore.resumeApproved(waitPlan.approvalId, {
      canonical_plan: resumePlan,
      audit_refs: [waitPlan.auditRef],
    });
    await this.recordApprovalResumeAuthority(input.context, {
      waitPlanId: waitPlan.approvalId,
      expectedCanonicalPlan: waitPlan.canonicalPlan,
      actualCanonicalPlan: resumePlan,
      resumeResult,
    });
    if (resumeResult.status === "resumed") {
      return { status: "approved", context: buildApprovedToolCallContext(input.context) };
    }

    const message = resumeResult.status === "mismatch_rejected"
      ? `Approval mismatch: ${resumeResult.mismatch_reasons.join(", ")}`
      : `Approval could not resume stored plan: ${resumeResult.status}`;
    const blocked = buildNotExecutedToolResult({
      summary: message,
      durationMs: Date.now() - input.startTime,
      reason: resumeResult.status === "mismatch_rejected" ? "stale_state" : "approval_denied",
      message,
    });
    await this.recordToolPolicyDecision(input.tool, input.input, input.context, {
      decision: "block",
      capabilityDecision: "blocked",
      decisionReason: `Approval resume blocked ${input.tool.metadata.name}: ${message}`,
      targetEffect: "execute_tool",
      targetSummary: `${input.tool.metadata.name} tool execution was blocked because approval could not resume safely.`,
      outcomeSummary: buildToolOutcomeSummary(input.tool.metadata.name, blocked),
    });
    return { status: "blocked", result: blocked };
  }

  private isAllowedByPermissionGrant(result: PermissionCheckResult): boolean {
    if (result.status !== "allowed") return false;
    const grantDecision = result.permissionGrantDecision;
    return Boolean(
      grantDecision
      && typeof grantDecision === "object"
      && "allowed" in grantDecision
      && grantDecision.allowed === true
    );
  }

  private async recordToolPolicyDecision(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
    options: {
      decision: InterventionDecisionKind;
      capabilityDecision: CapabilityRegistryDecisionKind;
      decisionReason: string;
      targetEffect: InterventionTargetEffect;
      targetSummary: string;
      outcomeSummary?: string;
    },
  ): Promise<void> {
    await recordPersonalAgentToolDecision(
      {
        personalAgentRuntime: context.personalAgentRuntime ?? this.personalAgentRuntime,
        baseDir: context.providerConfigBaseDir ?? this.traceBaseDir ?? null,
      },
      tool.metadata.name,
      input,
      context,
      {
        decision: options.decision,
        capabilityDecision: options.capabilityDecision,
        decisionReason: options.decisionReason,
        targetEffect: options.targetEffect,
        targetSummary: options.targetSummary,
        capabilityRefs: [
          ...this.capabilityPlaneRefs(tool, context),
          { kind: "tool", ref: tool.metadata.name },
          { kind: "tool_permission", ref: tool.metadata.permissionLevel },
          ...(tool.metadata.activityCategory ? [{ kind: "tool_activity", ref: tool.metadata.activityCategory }] : []),
        ],
        ...(options.outcomeSummary ? { outcomeSummary: options.outcomeSummary } : {}),
      },
    );
  }

  private async recordApprovalResumeAuthority(
    context: ToolCallContext,
    input: Parameters<typeof projectApprovalResumeAuthority>[0],
  ): Promise<void> {
    const store = this.resolveInteractionAuthorityStore(context);
    await store.recordDecision(projectApprovalResumeAuthority(input));
  }

  private async recordApprovalResumeRequestBeforeMutation(
    context: ToolCallContext,
    input: {
      waitPlanId: string;
      expectedCanonicalPlan: PermissionWaitCanonicalPlan;
      actualCanonicalPlan: PermissionWaitCanonicalPlan;
      waitingRecord: PermissionWaitPlanRecord;
    },
  ): Promise<void> {
    const resumeResult: PermissionWaitPlanResumeResult = {
      status: "not_approved",
      record: input.waitingRecord,
    };
    const store = this.resolveRuntimeEventLogStore(context);
    await store.appendAuthorityDecision(projectApprovalResumeAuthority({
      waitPlanId: input.waitPlanId,
      expectedCanonicalPlan: input.expectedCanonicalPlan,
      actualCanonicalPlan: input.actualCanonicalPlan,
      resumeResult,
      resumePhase: "before_mutation",
      reason: "Approval resume request was durably appended before mutating the wait-plan approval state.",
      decisionId: `execution-authority:approval:${input.waitPlanId}:resume:before-mutation`,
    }));
  }

  private resolveInteractionAuthorityStore(
    context: ToolCallContext,
  ): Pick<InteractionAuthorityStore, "recordDecision"> {
    if (context.interactionAuthorityStore) return context.interactionAuthorityStore;
    if (this.interactionAuthorityStore) return this.interactionAuthorityStore;
    const baseDir = context.providerConfigBaseDir ?? this.traceBaseDir ?? getPulseedDirPath();
    return new InteractionAuthorityStore(baseDir, { controlBaseDir: baseDir });
  }

  private resolveRuntimeEventLogStore(
    context: ToolCallContext,
  ): Pick<RuntimeEventLogStore, "appendAuthorityDecision"> {
    const baseDir = context.providerConfigBaseDir ?? this.traceBaseDir ?? getPulseedDirPath();
    return new RuntimeEventLogStore(baseDir, { controlBaseDir: baseDir });
  }

  private capabilityPlaneRefs(tool: ITool, context: ToolCallContext): Array<{ kind: string; ref: string }> {
    const descriptor = context.capabilityDescriptor;
    const admission = context.capabilityAdmissionDecision;
    return [
      ...(descriptor ? [
        { kind: "capability", ref: descriptor.capability_id },
        { kind: "capability_provider", ref: descriptor.provider_ref },
        { kind: "capability_operation", ref: descriptor.runtime_graph_refs.operation_ref },
        { kind: "capability_readiness", ref: descriptor.readiness_state },
      ] : [{ kind: "capability", ref: `tool:${tool.metadata.name}` }]),
      ...(admission?.admission_id ? [
        { kind: "capability_admission", ref: admission.admission_id },
      ] : []),
      ...(admission?.capability_fingerprint ? [
        { kind: "capability_fingerprint", ref: admission.capability_fingerprint },
      ] : []),
    ];
  }

  private async checkHostPolicyPreflight(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
    startTime: number,
  ): Promise<ToolResult | null> {
    const decision = decideHostToolExecution({ tool, input, context });
    if (decision.status === "allowed" || decision.status === "needs_permission") {
      return null;
    }

    const policyResult = permissionResultFromHostDecision(decision);
    if (policyResult.status !== "denied") {
      return null;
    }

    await this.recordToolPolicyDecision(tool, input, context, {
      decision: "block",
      capabilityDecision: "blocked",
      decisionReason: `Host execution policy blocked ${tool.metadata.name}: ${policyResult.reason}`,
      targetEffect: "execute_tool",
      targetSummary: `${tool.metadata.name} tool execution was blocked by host policy before side effects.`,
    });

    return this.failResult(
      `Permission denied by host policy: ${policyResult.reason}`,
      Date.now() - startTime,
      {
        status: "not_executed",
        reason: policyResult.executionReason ?? "policy_blocked",
        message: policyResult.reason,
      },
    );
  }

  private sanitizeInput(tool: ITool, input: unknown, context: ToolCallContext): string | null {
    if (tool.metadata.name === "shell" && typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      const cmd = obj["command"];
      if (typeof cmd === "string") {
        const assessment = assessShellCommand(cmd, context.executionPolicy, context.trusted === true, context.cwd);
        if (assessment.status === "denied") return assessment.reason ?? "Shell command denied by policy";
      }
    }

    return null;
  }

  private async withTimeout(
    fn: () => Promise<ToolResult>,
    timeoutMs: number,
  ): Promise<ToolResult> {
    return Promise.race([
      fn(),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(
          () => reject(new ToolExecutionTimeoutError(timeoutMs)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Retry a tool call for transient network/IO errors.
   * Only retries if the tool is concurrency-safe (idempotent).
   * Backoff: 500ms, 1000ms.
   */
  private async callWithRetry(
    fn: () => Promise<ToolResult>,
    toolName: string,
    isSafe: boolean,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const TRANSIENT_PATTERNS = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "fetch failed",
      "socket hang up",
    ];
    const BACKOFFS = [500, 1000];

    const isTransient = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
    };

    const attempts = isSafe ? BACKOFFS.length + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isSafe || !isTransient(err) || attempt >= BACKOFFS.length) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const execution = this.executionForFailure(err, context);
          context.logger?.warn("tool.call.failure", { tool: toolName, callId: context.callId, error: errMsg });
          return {
            success: false,
            data: null,
            summary: `Tool ${toolName} failed: ${errMsg}`,
            error: errMsg,
            ...(execution ? { execution } : {}),
            durationMs: 0,
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, BACKOFFS[attempt]));
      }
    }

    const exhaustedMsg = `Tool ${toolName} failed after retries`;
    context.logger?.warn("tool.call.failure", { tool: toolName, callId: context.callId, error: exhaustedMsg });
    return {
      success: false,
      data: null,
      summary: exhaustedMsg,
      error: exhaustedMsg,
      durationMs: 0,
    };
  }

  private failResult(error: string, durationMs: number, execution?: ToolResult["execution"]): ToolResult {
    return buildToolFailureResult({ error, durationMs, execution });
  }

  private executionForFailure(error: unknown, context: ToolCallContext): ToolResult["execution"] | undefined {
    const message = error instanceof Error ? error.message : String(error);
    if (context.abortSignal?.aborted) {
      return { status: "executed", reason: "interrupted", message };
    }
    if (error instanceof ToolExecutionTimeoutError) {
      return { status: "executed", reason: "timed_out", message };
    }
    return undefined;
  }
}

function reversibilityForDescriptor(descriptor: CapabilityDescriptor | null): "reversible" | "irreversible" | "unknown" {
  if (!descriptor) return "unknown";
  if (descriptor.rollback_plan.kind === "none" || descriptor.rollback_plan.kind === "reversible" || descriptor.rollback_plan.kind === "append_only") {
    return "reversible";
  }
  if (descriptor.rollback_plan.kind === "irreversible") return "irreversible";
  return "unknown";
}

export class ToolExecutionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool call timed out after ${timeoutMs}ms`);
    this.name = "ToolExecutionTimeoutError";
  }
}

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  permissionManager: ToolPermissionManager;
  concurrency: ConcurrencyController;
  capabilityPlane?: CapabilityPlane;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  interactionAuthorityStore?: Pick<InteractionAuthorityStore, "recordDecision">;
  traceBaseDir?: string | null;
}
