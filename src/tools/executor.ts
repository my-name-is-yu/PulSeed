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
import { resolveWorkspaceCwd } from "./workspace-scope.js";
import type { PermissionWaitCanonicalPlan } from "../runtime/store/permission-wait-plan-store.js";
import {
  recordPersonalAgentToolDecision,
} from "./personal-agent-tool-trace.js";
import type {
  CapabilityRegistryDecisionKind,
  InterventionDecisionKind,
  InterventionTargetEffect,
} from "../runtime/personal-agent/index.js";
import type { PersonalAgentRuntimeStore } from "../runtime/personal-agent/index.js";

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
  private readonly traceBaseDir?: string | null;

  constructor(deps: ToolExecutorDeps) {
    this.registry = deps.registry;
    this.permissionManager = deps.permissionManager;
    this.concurrency = deps.concurrency;
    this.personalAgentRuntime = deps.personalAgentRuntime;
    this.traceBaseDir = deps.traceBaseDir ?? null;
  }

  async execute(
    toolName: string,
    rawInput: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return this.failResult(`Tool "${toolName}" not found`, 0);
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

    const hostPreflightResult = await this.checkHostPolicyPreflight(tool, input, context, startTime);
    if (hostPreflightResult) return hostPreflightResult;

    let precheckedPermissionResult: Awaited<ReturnType<ToolPermissionManager["check"]>> | null = null;

    // --- Gate 2: Semantic Validation (tool-specific) ---
    const semanticResult = await tool.checkPermissions(input, context);
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
        if (approvalResult) return approvalResult;
        precheckedPermissionResult = { status: "allowed" };
      }
    }

    // --- Gate 3: Permission Manager (3-layer) ---
    const permResult = precheckedPermissionResult ?? await this.permissionManager.check(tool, input, context);
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
        context,
        startTime,
        reason: permResult.reason,
        reversibility: "reversible",
        policyDecision: permResult.policyDecision,
        permissionGrantDecision: permResult.permissionGrantDecision,
      });
      if (approvalResult) return approvalResult;
    }

    // --- Gate 4: Input Sanitization ---
    const sanitizeError = this.sanitizeInput(tool, input, context);
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

    await this.recordToolPolicyDecision(tool, input, context, {
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
          if (context.dryRun) {
            return {
              success: true,
              data: null,
              summary: "dry-run: skipped",
              execution: { status: "not_executed", reason: "dry_run", message: "dry-run skipped tool.call()" },
              durationMs: 0,
            };
          }
          const callFn = () => tool.call(input, context);
          const isSafe = tool.isConcurrencySafe(input);
          if (context.timeoutMs) {
            return this.withTimeout(
              () => this.callWithRetry(callFn, tool.metadata.name, isSafe, context),
              context.timeoutMs,
            );
          }
          return this.callWithRetry(callFn, tool.metadata.name, isSafe, context);
        },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger?.warn("tool.call.failure", { tool: toolName, callId, error });
      const failure = this.failResult(
        `Tool ${toolName} failed: ${error}`,
        Date.now() - startTime,
        this.executionForFailure(err, context) ?? { status: "executed", reason: "tool_error", message: error },
      );
      await this.recordToolPolicyDecision(tool, input, context, {
        decision: "allow",
        capabilityDecision: "available",
        decisionReason: `${tool.metadata.name} was admitted by Capability Registry and InterventionPolicy before tool.call().`,
        targetEffect: "execute_tool",
        targetSummary: `${tool.metadata.name} tool execution was admitted before side effects.`,
        outcomeSummary: toolOutcomeSummary(tool.metadata.name, failure),
      });
      try {
        await persistCapabilityExecutionRecords({ tool, rawInput: input, result: failure, context });
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

    await this.recordToolPolicyDecision(tool, input, context, {
      decision: "allow",
      capabilityDecision: "available",
      decisionReason: `${tool.metadata.name} was admitted by Capability Registry and InterventionPolicy before tool.call().`,
      targetEffect: "execute_tool",
      targetSummary: `${tool.metadata.name} tool execution was admitted before side effects.`,
      outcomeSummary: toolOutcomeSummary(tool.metadata.name, result),
    });

    try {
      await persistCapabilityExecutionRecords({ tool, rawInput: input, result, context });
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
      safe.map((c) => this.execute(c.toolName, c.input, context)),
    );
    for (let i = 0; i < safe.length; i++) {
      results[safe[i].index] = safeResults[i];
    }

    // Run unsafe calls sequentially
    for (const c of unsafe) {
      results[c.index] = await this.execute(c.toolName, c.input, context);
    }

    return results;
  }

  // --- Private Helpers ---

  private async requestPermissionApproval(input: {
    tool: ITool;
    input: unknown;
    context: ToolCallContext;
    startTime: number;
    reason: string;
    reversibility: "reversible" | "irreversible" | "unknown";
    policyDecision?: HostToolExecutionDecision;
    permissionGrantDecision?: unknown;
  }): Promise<ToolResult | null> {
    const approvalId = `permission-wait:${randomUUID()}`;
    const canonicalPlan = this.buildCanonicalPermissionWaitPlan(input);
    const auditRef = `tool:${input.tool.metadata.name}:${input.context.callId ?? approvalId}`;
    if (input.context.permissionWaitPlanStore) {
      await input.context.permissionWaitPlanStore.createWaiting({
        wait_plan_id: approvalId,
        approval_id: approvalId,
        goal_id: input.context.goalId,
        canonical_plan: canonicalPlan,
        audit_refs: [auditRef],
      });
    }
    const approvalRequest = {
      toolName: input.tool.metadata.name,
      input: input.input,
      reason: input.reason,
      permissionLevel: input.tool.metadata.permissionLevel,
      isDestructive: input.tool.metadata.isDestructive,
      reversibility: input.reversibility,
      approvalId,
      permissionWaitPlanId: approvalId,
      canonicalPermissionPlan: canonicalPlan,
      ...(input.context.callId ? { callId: input.context.callId } : {}),
      ...(input.context.sessionId ? { sessionId: input.context.sessionId } : {}),
      ...(input.context.runId ? { runId: input.context.runId } : {}),
      ...(input.context.turnId ? { turnId: input.context.turnId } : {}),
      ...(input.permissionGrantDecision ? { permissionGrantDecision: input.permissionGrantDecision } : {}),
    } as const;

    await input.context.onApprovalRequested?.(approvalRequest);
    const approved = await input.context.approvalFn(approvalRequest);
    if (!approved) {
      await input.context.permissionWaitPlanStore?.markDenied(approvalId, {
        reason: "approval_denied",
        audit_refs: [auditRef],
      });
      const denied = this.failResult(
        `User denied approval: ${input.reason}`,
        Date.now() - input.startTime,
        { status: "not_executed", reason: "approval_denied", message: input.reason },
      );
      await this.recordToolPolicyDecision(input.tool, input.input, input.context, {
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: `Operator denied confirmation for ${input.tool.metadata.name}: ${input.reason}`,
        targetEffect: "execute_tool",
        targetSummary: `${input.tool.metadata.name} tool execution was blocked after confirmation was denied.`,
        outcomeSummary: toolOutcomeSummary(input.tool.metadata.name, denied),
      });
      return denied;
    }

    input.context.preApproved = true;
    input.context.hostPolicyApproved = true;

    if (!input.context.permissionWaitPlanStore) return null;

    await input.context.permissionWaitPlanStore.markApproved(approvalId, {
      audit_refs: [`approval:${approvalId}`, auditRef],
    });
    const resumePlan = this.buildCanonicalPermissionWaitPlan({
      ...input,
      policyDecision: input.policyDecision ?? decideHostToolExecution({
        tool: input.tool,
        input: input.input,
        context: input.context,
      }),
    });
    const resumeResult = await input.context.permissionWaitPlanStore.resumeApproved(approvalId, {
      canonical_plan: resumePlan,
      audit_refs: [auditRef],
    });
    if (resumeResult.status === "resumed") return null;

    const message = resumeResult.status === "mismatch_rejected"
      ? `Approval mismatch: ${resumeResult.mismatch_reasons.join(", ")}`
      : `Approval could not resume stored plan: ${resumeResult.status}`;
    const blocked = this.failResult(
      message,
      Date.now() - input.startTime,
      {
        status: "not_executed",
        reason: resumeResult.status === "mismatch_rejected" ? "stale_state" : "approval_denied",
        message,
      },
    );
    await this.recordToolPolicyDecision(input.tool, input.input, input.context, {
      decision: "block",
      capabilityDecision: "blocked",
      decisionReason: `Approval resume blocked ${input.tool.metadata.name}: ${message}`,
      targetEffect: "execute_tool",
      targetSummary: `${input.tool.metadata.name} tool execution was blocked because approval could not resume safely.`,
      outcomeSummary: toolOutcomeSummary(input.tool.metadata.name, blocked),
    });
    return blocked;
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
          { kind: "tool", ref: tool.metadata.name },
          { kind: "tool_permission", ref: tool.metadata.permissionLevel },
          ...(tool.metadata.activityCategory ? [{ kind: "tool_activity", ref: tool.metadata.activityCategory }] : []),
        ],
        ...(options.outcomeSummary ? { outcomeSummary: options.outcomeSummary } : {}),
      },
    );
  }

  private buildCanonicalPermissionWaitPlan(input: {
    tool: ITool;
    input: unknown;
    context: ToolCallContext;
    reason: string;
    reversibility: "reversible" | "irreversible" | "unknown";
    policyDecision?: HostToolExecutionDecision;
    permissionGrantDecision?: unknown;
  }): PermissionWaitCanonicalPlan {
    const inputRecord = input.input && typeof input.input === "object"
      ? input.input as Record<string, unknown>
      : {};
    const cwdInput = typeof inputRecord["cwd"] === "string" ? inputRecord["cwd"] as string : undefined;
    const cwdResolution = resolveWorkspaceCwd(cwdInput, input.context);
    const hostDecision = input.policyDecision ?? decideHostToolExecution({
      tool: input.tool,
      input: input.input,
      context: input.context,
    });
    const permissionGrantSummary = summarizePermissionGrantDecision(input.permissionGrantDecision);
    return {
      schema_version: "permission-wait-canonical-plan-v1",
      tool_name: input.tool.metadata.name,
      input: input.input,
      cwd: cwdResolution.valid ? cwdResolution.resolved : input.context.cwd,
      ...(typeof inputRecord["command"] === "string" && inputRecord["command"].trim()
        ? { command: inputRecord["command"] as string }
        : {}),
      target: {
        goal_id: input.context.goalId,
        ...(input.context.runId ? { run_id: input.context.runId } : {}),
        ...(input.context.sessionId ? { session_id: input.context.sessionId } : {}),
        ...(input.context.turnId ? { turn_id: input.context.turnId } : {}),
        ...(input.context.callId ? { tool_call_id: input.context.callId } : {}),
      },
      permission: {
        permission_level: input.tool.metadata.permissionLevel,
        is_destructive: input.tool.metadata.isDestructive,
        reversibility: input.reversibility,
      },
      ...(input.context.hostToolState?.currentEpoch ?? input.context.hostToolState?.observedEpoch
        ? { state_epoch: input.context.hostToolState?.currentEpoch ?? input.context.hostToolState?.observedEpoch }
        : {}),
      capability_facts: {
        tool_permission_level: input.tool.metadata.permissionLevel,
        tool_is_read_only: input.tool.metadata.isReadOnly,
        tool_is_destructive: input.tool.metadata.isDestructive,
        ...(input.tool.metadata.requiresNetwork !== undefined ? { tool_requires_network: input.tool.metadata.requiresNetwork } : {}),
        ...(input.tool.metadata.activityCategory ? { tool_activity_category: input.tool.metadata.activityCategory } : {}),
        tool_tags: [...input.tool.metadata.tags].sort(),
        host_decision_status: hostDecision.status,
        host_decision_reason: hostDecision.reason,
        ...(permissionGrantSummary.status ? { permission_grant_status: permissionGrantSummary.status } : {}),
        ...(permissionGrantSummary.reason ? { permission_grant_reason: permissionGrantSummary.reason } : {}),
      },
    };
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
    return {
      success: false,
      data: null,
      summary: error,
      error,
      ...(execution ? { execution } : {}),
      durationMs,
    };
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

export class ToolExecutionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool call timed out after ${timeoutMs}ms`);
    this.name = "ToolExecutionTimeoutError";
  }
}

function summarizePermissionGrantDecision(value: unknown): { status?: string; reason?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const status = typeof record["status"] === "string" ? record["status"] : undefined;
  const reason = typeof record["reason"] === "string"
    ? record["reason"]
    : typeof record["evidence"] === "string"
      ? record["evidence"]
      : undefined;
  return {
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
  };
}

function toolOutcomeSummary(toolName: string, result: ToolResult): string {
  const status = result.execution?.status ?? (result.success ? "executed" : "failed");
  const reason = result.execution?.reason ? ` reason=${result.execution.reason}` : "";
  const summary = result.summary ? ` ${result.summary}` : "";
  return `${toolName} action outcome: ${status}${reason}.${summary}`.trim();
}

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  permissionManager: ToolPermissionManager;
  concurrency: ConcurrencyController;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  traceBaseDir?: string | null;
}
