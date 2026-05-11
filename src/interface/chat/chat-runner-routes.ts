import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, ToolCallResult } from "../../base/llm/llm-client.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import type { ApprovalRequest, ITool, ToolCallContext, ToolResult } from "../../tools/types.js";
import { extractPromptedToolCalls } from "../../orchestrator/execution/agent-loop/prompted-tool-protocol.js";
import {
  collectGitDiffArtifact,
  formatToolActivity,
} from "./chat-runner-support.js";
import type { ChatUsageCounter } from "./chat-history.js";
import type { ChatRunResult, ChatRunnerRouteHost, RuntimeControlChatContext } from "./chat-runner-contracts.js";
import type { SelectedChatRoute } from "./ingress-router.js";
import type { ChatEventContext } from "./chat-events.js";
import {
  type AgentLoopSessionState,
} from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import { AgentLoopSessionStateCatalog } from "../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import { resolveExecutionPolicy, type ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { AssistantBuffer } from "./chat-runner-event-bridge.js";
import type { SetupSecretIntakeResult } from "./setup-secret-intake.js";
import { createGatewaySetupStatusProvider } from "./gateway-setup-status.js";
import {
  renderSystemPromptWithTurnContext,
  type ChatTurnContext,
} from "./turn-context.js";
import { buildChatModelRequest } from "./model-request-builder.js";
import {
  createDiscordAdapterPlanDialogue,
  createTelegramConfirmWriteDialogue,
  type SetupDialogueRuntimeState,
} from "./setup-dialogue.js";
import type { TurnLanguageHint } from "./turn-language.js";
import { createOperationProgressItem } from "./operation-progress.js";
import type { RunSpecConfirmationState } from "./chat-history.js";
import {
  addUsageCounter,
  hasUsage,
  normalizeUsageCounter,
  usageFromLLMResponse,
  zeroUsageCounter,
} from "./chat-usage.js";
import {
  formatTelegramConfigProgressDetail,
  formatTelegramConfigureGuidance,
} from "./telegram-setup-guidance.js";
export {
  buildTelegramSetupGuidanceData,
  formatTelegramConfigureGuidance,
  type TelegramSetupGuidanceData,
} from "./telegram-setup-guidance.js";

const MAX_TOOL_LOOPS = 24;
const TOOL_LOOP_STUCK_REPEAT_LIMIT = 1;

export type GatewayToolScope =
  | "read_workspace"
  | "read_runtime_status"
  | "request_approval"
  | "approved_write"
  | "approved_execute"
  | "approved_durable_run"
  | "authorized_runtime_control";

export interface GatewayToolScopeContext {
  runtimeControlAllowed?: boolean;
  runtimeControlApprovalMode?: "interactive" | "preapproved" | "disallowed";
  approvedWrite?: boolean;
  approvedExecute?: boolean;
  approvedDurableRun?: boolean;
}

class ToolLoopTerminalError extends Error {
  constructor(
    readonly code:
      | "tool_loop_exhausted"
      | "stalled_tool_loop"
      | "model_request_timeout"
      | "model_request_aborted"
      | "tool_call_timeout"
      | "tool_call_aborted"
      | "approval_denied"
      | "policy_blocked",
    message: string,
  ) {
    super(message);
    this.name = "ToolLoopTerminalError";
  }
}

export async function executeRuntimeControlRoute(
  host: ChatRunnerRouteHost,
  route: Extract<SelectedChatRoute, { kind: "runtime_control" }>,
  runtimeControlContext: RuntimeControlChatContext | null,
  cwd: string,
  start: number
): Promise<ChatRunResult> {
  if (!host.deps.runtimeControlService) {
    return {
      success: false,
      output: "Runtime control is not available in this chat surface yet.",
      elapsed_ms: Date.now() - start,
    };
  }

  const replyTarget = runtimeControlContext?.replyTarget ?? host.deps.runtimeReplyTarget;
  const actor = runtimeControlContext?.actor ?? host.deps.runtimeControlActor;
  const result = await host.deps.runtimeControlService.request({
    intent: route.intent,
    cwd,
    requestedBy: actor ?? {
      surface: replyTarget?.surface ?? "chat",
      platform: replyTarget?.platform,
      conversation_id: replyTarget?.conversation_id,
      identity_key: replyTarget?.identity_key,
      user_id: replyTarget?.user_id,
    },
    replyTarget: replyTarget ?? { surface: "chat" },
    approvalFn: runtimeControlContext?.approvalFn
      ?? host.deps.runtimeControlApprovalFn
      ?? host.deps.approvalFn,
  });

  return {
    success: result.success,
    output: result.message,
    elapsed_ms: Date.now() - start,
  };
}

export function formatBlockedRuntimeControlRoute(
  route: Extract<SelectedChatRoute, { kind: "runtime_control_blocked" }>,
  options: { mode?: "user" | "diagnostic" } = {},
): string {
  if (options.mode === "diagnostic") {
    if (route.reason === "runtime_control_unclassified") {
      return [
        "Runtime control was explicitly requested, but PulSeed could not derive a typed runtime-control operation from this turn.",
        "The operation was not executed, and PulSeed will not fall back to shell tools for daemon or gateway lifecycle control.",
      ].join("\n");
    }
    if (route.reason === "runtime_control_disallowed") {
      return [
        `Runtime control ${route.intent?.kind ?? "operation"} was recognized, but this chat surface is not authorized for runtime-control lifecycle actions.`,
        "The operation was not executed, and PulSeed will not fall back to shell tools for daemon or gateway lifecycle control.",
      ].join("\n");
    }
    return [
      `Runtime control ${route.intent?.kind ?? "operation"} was recognized, but the runtime-control service is not available in this chat surface.`,
      "The operation was not executed, and PulSeed will not fall back to shell tools for daemon or gateway lifecycle control.",
    ].join("\n");
  }

  if (route.reason === "runtime_control_unclassified") {
    return [
      "I recognized this as a request to inspect or control PulSeed, but I could not identify a supported safe action from this turn.",
      "Nothing was executed, and PulSeed will not use shell commands as a workaround.",
      "Use an authorized management channel if you need a live status check or runtime action.",
    ].join("\n");
  }
  if (route.reason === "runtime_control_disallowed") {
    return [
      "This chat is not authorized to inspect or control PulSeed's running state.",
      "Nothing was executed, and PulSeed will not use shell commands as a workaround.",
      "Use an authorized management channel if you need a live status check or runtime action.",
    ].join("\n");
  }
  return [
    "This chat cannot reach PulSeed's authorized management service right now.",
    "Nothing was executed, and PulSeed will not use shell commands as a workaround.",
    "Use an authorized management channel if you need a live status check or runtime action.",
  ].join("\n");
}

export async function executeConfigureRoute(
  host: ChatRunnerRouteHost,
  route: SelectedChatRoute,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  if (route.kind !== "configure") {
    throw new Error(`executeConfigureRoute received route kind ${route.kind}`);
  }
  const output = await formatConfigureGuidance(host, route.configureTarget, host.getSetupSecretIntake(), host.getTurnLanguageHint(), eventContext);
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
}

export async function executeAgentLoopRoute(
  host: ChatRunnerRouteHost,
  params: {
    turnContext: ChatTurnContext;
    resumeOnly: boolean;
    assistantBuffer: AssistantBuffer;
    eventContext: ChatEventContext;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
      recordUsage(phase: string, usage: ChatUsageCounter): void;
    };
    gitRoot: string;
    activeAbortSignal: AbortSignal;
    start: number;
  }
): Promise<ChatRunResult> {
  const {
    resumeOnly,
    assistantBuffer,
    eventContext,
    history,
    gitRoot,
    activeAbortSignal,
    start,
  } = params;
  const turnContext = params.turnContext;
  const runtimeContext = turnContext.hostOnly.runtime.runtimeControlContext;
  try {
    const resumeStateResult = resumeOnly ? await loadResumableAgentLoopState(host) : null;
    const resumeState = resumeStateResult?.kind === "loaded" ? resumeStateResult.state : null;
    if (resumeOnly && resumeStateResult?.kind !== "loaded") {
      const elapsed_ms = Date.now() - start;
      const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
        resumeStateResult?.message ?? "I could not find a chat that can safely continue.",
        assistantBuffer.text,
        eventContext,
        {
          code: resumeStateResult?.code ?? "resume_state_missing",
          stoppedReason: resumeStateResult?.code ?? "resume_state_missing",
        },
        host.deps.llmClient
      );
      host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return {
        success: false,
        output,
        elapsed_ms,
      };
    }
    host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
    const result = await host.deps.chatAgentLoopRunner!.execute({
      message: turnContext.modelVisible.prompts.basePrompt,
      cwd: turnContext.hostOnly.execution.executionCwd,
      goalId: turnContext.hostOnly.execution.goalId,
      history: turnContext.modelVisible.conversation.priorTurns,
      eventSink: host.eventBridge.createAgentLoopEventSink(eventContext, assistantBuffer, {
        streamFinalCandidate: () => true,
      }),
      approvalFn: agentLoopApprovalFn(host, runtimeContext),
      toolCallContext: {
        executionPolicy: turnContext.hostOnly.execution.executionPolicy,
        ...(host.deps.permissionGrantContext?.sessionId
          ? { sessionId: host.deps.permissionGrantContext.sessionId }
          : host.getConversationSessionId()
            ? { sessionId: host.getConversationSessionId()! }
            : {}),
        runId: turnContext.modelVisible.turn.runId,
        turnId: turnContext.modelVisible.turn.turnId,
        ...(host.deps.permissionGrantContext?.projectId ? { projectId: host.deps.permissionGrantContext.projectId } : {}),
        ...(host.deps.permissionGrantStore ? { permissionGrantStore: host.deps.permissionGrantStore } : {}),
        ...(host.deps.permissionWaitPlanStore ? { permissionWaitPlanStore: host.deps.permissionWaitPlanStore } : {}),
        ...(host.deps.capabilityVerificationStore ? { capabilityVerificationStore: host.deps.capabilityVerificationStore } : {}),
        ...(host.deps.capabilityExecutionResolver ? { capabilityExecutionResolver: host.deps.capabilityExecutionResolver } : {}),
        ...(host.getConversationSessionId() ? { conversationSessionId: host.getConversationSessionId()! } : {}),
        providerConfigBaseDir: host.getProviderConfigBaseDir(),
        setupSecretIntake: host.getSetupSecretIntake(),
        setupDialogue: {
          get: () => host.getPendingSetupDialogue(),
          set: (dialogue) => host.setPendingSetupDialogue(dialogue as SetupDialogueRuntimeState | null),
        },
        runSpecConfirmation: {
          get: () => host.getPendingRunSpecConfirmation(),
          set: (confirmation) => host.setPendingRunSpecConfirmation(confirmation as RunSpecConfirmationState | null),
          currentTurnStartedAt: new Date(start).toISOString(),
        },
        runtimeReplyTarget: (runtimeContext?.replyTarget ?? turnContext.hostOnly.runtime.fallbackReplyTarget ?? null) as Record<string, unknown> | null,
        runtimeControlActor: (runtimeContext?.actor ?? turnContext.hostOnly.runtime.fallbackActor ?? null) as Record<string, unknown> | null,
        runtimeControlAllowed: turnContext.modelVisible.runtime.runtimeControlAllowed,
        runtimeControlApprovalMode: turnContext.modelVisible.runtime.approvalMode,
      },
      ...(host.getNativeAgentLoopSessionId() ? { resumeSessionId: host.getNativeAgentLoopSessionId()! } : {}),
      ...(resumeState ? { resumeState } : {}),
      ...(resumeOnly ? { resumeOnly: true } : {}),
      systemPrompt: renderSystemPromptWithTurnContext(
        turnContext.modelVisible.instructions.agentLoopSystemPrompt,
        turnContext.modelVisible,
      ),
      abortSignal: activeAbortSignal,
    });
    const elapsed_ms = Date.now() - start;
    const agentLoopUsage = result.agentLoop?.usage
      ? normalizeUsageCounter(result.agentLoop.usage)
      : zeroUsageCounter();
    if (result.agentLoop) {
      (history as unknown as {
        setAgentLoopSessionIdentity(input: { sessionId: string | null; traceId?: string | null }): void;
      }).setAgentLoopSessionIdentity({
        sessionId: result.agentLoop.sessionId,
        traceId: result.agentLoop.traceId,
      });
    }
    if (hasUsage(agentLoopUsage)) {
      history.recordUsage("agentloop", agentLoopUsage);
    }
    if (result.output) {
      host.eventBridge.pushAssistantSnapshot(result.output, assistantBuffer, eventContext);
    }
    if (result.success) {
      const diffArtifact = await collectGitDiffArtifact(gitRoot);
      if (diffArtifact) {
        host.eventBridge.emitDiffArtifact(diffArtifact, eventContext);
      }
      await history.appendAssistantMessage(result.output);
      host.eventBridge.emitEvent({
        type: "assistant_final",
        text: result.output,
        persisted: true,
        ...host.eventBridge.eventBase(eventContext),
      });
      host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
    } else {
      result.output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
        result.output || result.error || "Unknown error",
        assistantBuffer.text,
        eventContext,
        {
          stoppedReason: result.stopped_reason,
          agentLoopStopReason: result.agentLoop?.stopReason,
          code: result.agentLoop?.failureReason,
        },
        host.deps.llmClient
      );
      host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
    }
    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      assistantBuffer.text,
      eventContext,
      {},
      host.deps.llmClient
    );
    host.eventBridge.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: Date.now() - start,
    };
  }
}

interface GatewayModelLoopRouteParams {
  turnContext: ChatTurnContext;
  eventContext: ChatEventContext;
  assistantBuffer: AssistantBuffer;
  systemPrompt?: string;
  executionGoalId?: string;
  history: {
    appendAssistantMessage(message: string): Promise<void>;
    recordUsage(phase: string, usage: ChatUsageCounter): void;
  };
  gitRoot: string;
  runtimeControlContext: RuntimeControlChatContext | null;
  activeAbortSignal?: AbortSignal;
  timeoutMs?: number;
  start: number;
}

export async function executeGatewayModelLoopRoute(
  host: ChatRunnerRouteHost,
  params: GatewayModelLoopRouteParams,
): Promise<ChatRunResult> {
  try {
    const approvalCapable = Boolean(host.deps.approvalRequestFn || host.deps.approvalFn);
    const registryTools = host.deps.registry?.listAll() ?? [];
    const toolResult = await executeWithTools(
      host,
      params.turnContext,
      params.eventContext,
      params.assistantBuffer,
      params.systemPrompt,
      params.executionGoalId,
      params.runtimeControlContext,
      params.start,
      {
        tools: selectDirectModelLoopTools(registryTools, params.turnContext, params.runtimeControlContext, approvalCapable),
        streamFinalText: true,
        abortSignal: params.activeAbortSignal,
        timeoutMs: params.timeoutMs,
      },
    );
    const elapsed_ms = Date.now() - params.start;
    if (hasUsage(toolResult.usage)) {
      params.history.recordUsage("execution", toolResult.usage);
    }
    const diffArtifact = await collectGitDiffArtifact(params.gitRoot);
    if (diffArtifact) {
      host.eventBridge.emitDiffArtifact(diffArtifact, params.eventContext);
    }
    const output = toolResult.output;
    if (!params.assistantBuffer.text) {
      host.eventBridge.pushAssistantDelta(output, params.assistantBuffer, params.eventContext);
    } else {
      host.eventBridge.pushAssistantSnapshot(output, params.assistantBuffer, params.eventContext);
    }
    await params.history.appendAssistantMessage(output);
    host.eventBridge.emitEvent({
      type: "assistant_final",
      text: output,
      persisted: true,
      ...host.eventBridge.eventBase(params.eventContext),
    });
    host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, params.eventContext, true);
    return { success: true, output, elapsed_ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const evidence = err instanceof ToolLoopTerminalError
      ? toolLoopTerminalEvidence(err)
      : {};
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      params.assistantBuffer.text,
      params.eventContext,
      evidence,
      host.deps.llmClient
    );
    host.eventBridge.emitLifecycleEndEvent("error", Date.now() - params.start, params.eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: Date.now() - params.start,
    };
  }
}

const GATEWAY_READ_WORKSPACE_TOOL_NAMES = new Set([
  "tool_search",
  "list_dir",
  "read",
  "grep",
  "glob",
  "code_search",
  "code_read_context",
  "json_query",
]);

const GATEWAY_RUNTIME_STATUS_TOOL_NAMES = new Set([
  "get_gateway_setup_status",
  "prepare_gateway_setup_guidance",
  "get_runtime_status",
  "list_schedules",
  "get_schedule",
  "runs_list",
  "runs_observe",
  "sessions_list",
  "sessions_observe",
]);

const GATEWAY_REQUEST_APPROVAL_TOOL_NAMES = new Set([
  "ask-human",
]);

const GATEWAY_APPROVED_WRITE_TOOL_NAMES = new Set([
  "prepare_gateway_config_write",
  "confirm_gateway_config_write",
  "cancel_gateway_config_write",
  "draft_run_spec",
  "update_run_spec_draft",
  "cancel_run_spec_draft",
  "runspec_propose",
  "create_schedule",
  "update_schedule",
  "remove_schedule",
  "pause_schedule",
  "resume_schedule",
]);

const GATEWAY_APPROVED_DURABLE_RUN_TOOL_NAMES = new Set([
  "runspec_confirm",
  "start_durable_run",
  "run_start",
  "run_schedule",
]);

const GATEWAY_AUTHORIZED_RUNTIME_CONTROL_TOOL_NAMES = new Set([
  "request_runtime_control",
  "run_pause",
  "run_resume",
  "run_cancel",
]);

const GATEWAY_APPROVED_EXECUTE_TOOL_NAMES = new Set([
  "shell",
  "shell_command",
  "process_session_start",
  "process_session_write",
  "process_session_stop",
]);

export function resolveGatewayToolScopes(context: GatewayToolScopeContext = {}): Set<GatewayToolScope> {
  const scopes = new Set<GatewayToolScope>([
    "read_workspace",
    "read_runtime_status",
    "request_approval",
  ]);
  if (context.approvedWrite) scopes.add("approved_write");
  if (context.approvedExecute) scopes.add("approved_execute");
  if (context.approvedDurableRun) scopes.add("approved_durable_run");
  if (context.runtimeControlAllowed === true && context.runtimeControlApprovalMode !== "disallowed") {
    scopes.add("authorized_runtime_control");
  }
  return scopes;
}

export function selectGatewayModelLoopTools(
  tools: ITool[],
  context: GatewayToolScopeContext = {},
): ITool[] {
  const scopes = resolveGatewayToolScopes(context);
  return tools.filter((tool) => isGatewayToolInScope(tool, scopes));
}

function isGatewayToolInScope(tool: ITool, scopes: ReadonlySet<GatewayToolScope>): boolean {
  const name = tool.metadata.name;
  if (scopes.has("read_workspace") && GATEWAY_READ_WORKSPACE_TOOL_NAMES.has(name)) return true;
  if (scopes.has("read_runtime_status") && GATEWAY_RUNTIME_STATUS_TOOL_NAMES.has(name)) return true;
  if (scopes.has("request_approval") && GATEWAY_REQUEST_APPROVAL_TOOL_NAMES.has(name)) return true;
  if (scopes.has("approved_write") && GATEWAY_APPROVED_WRITE_TOOL_NAMES.has(name)) return true;
  if (scopes.has("approved_execute") && GATEWAY_APPROVED_EXECUTE_TOOL_NAMES.has(name)) return true;
  if (scopes.has("approved_durable_run") && GATEWAY_APPROVED_DURABLE_RUN_TOOL_NAMES.has(name)) return true;
  if (scopes.has("authorized_runtime_control") && GATEWAY_AUTHORIZED_RUNTIME_CONTROL_TOOL_NAMES.has(name)) return true;
  return false;
}

function selectDirectModelLoopTools(
  tools: ITool[],
  turnContext: ChatTurnContext,
  runtimeControlContext: RuntimeControlChatContext | null,
  approvalCapable: boolean,
): ITool[] {
  if (!isGatewaySurfaceTurn(turnContext, runtimeControlContext)) {
    return tools;
  }
  return selectGatewayModelLoopTools(tools, {
    runtimeControlAllowed: runtimeControlContext?.allowed,
    runtimeControlApprovalMode: runtimeControlContext?.approvalMode,
    approvedWrite: approvalCapable,
    approvedExecute: approvalCapable,
    approvedDurableRun: approvalCapable,
  });
}

function isGatewaySurfaceTurn(
  turnContext: ChatTurnContext,
  runtimeControlContext: RuntimeControlChatContext | null,
): boolean {
  return (runtimeControlContext?.replyTarget?.surface ?? turnContext.modelVisible.runtime.replyTarget?.surface) === "gateway";
}

async function executeWithTools(
  host: ChatRunnerRouteHost,
  turnContext: ChatTurnContext,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  systemPrompt?: string,
  goalId?: string,
  runtimeControlContext?: RuntimeControlChatContext | null,
  start?: number,
  options: {
    tools: ITool[];
    streamFinalText: boolean;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  } = {
    tools: host.deps.registry?.listAll() ?? [],
    streamFinalText: true,
  },
): Promise<{ output: string; usage: ChatUsageCounter }> {
  const llmClient = host.deps.llmClient;
  if (!llmClient) {
    throw new ToolLoopTerminalError("model_request_aborted", "Gateway model/tool loop cannot run because no language model client is configured.");
  }
  const supportsNativeToolCalling = llmClient.supportsToolCalling?.() !== false;
  const initialModelRequest = buildChatModelRequest({
    purpose: "tool_call",
    turnContext,
    systemPrompt,
    availableTools: options.tools,
    activatedTools: host.activatedTools,
    supportsNativeToolCalling,
  });
  const messages: LLMMessage[] = [...initialModelRequest.messages];
  const startedAt = start ?? Date.now();
  const deadlineAt = options.timeoutMs ? startedAt + options.timeoutMs : null;
  const allowedToolNames = new Set(options.tools.map((tool) => tool.metadata.name));
  const toolCallContext = await buildToolCallContext(host, goalId, runtimeControlContext, start, turnContext, {
    abortSignal: options.abortSignal,
    timeoutMs: remainingTimeoutMs(deadlineAt),
  });
  const usage = zeroUsageCounter();
  let previousToolCycleFingerprint: string | null = null;
  let repeatedToolCycleCount = 0;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    throwIfAbortedOrTimedOut(options.abortSignal, deadlineAt, "model_request");
    const modelRequest = buildChatModelRequest({
      purpose: "tool_call",
      turnContext,
      systemPrompt,
      availableTools: options.tools,
      activatedTools: host.activatedTools,
      supportsNativeToolCalling,
      messages,
    });
    let response: LLMResponse;
    try {
      host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
      response = await withAbortAndTimeout(
        (execution) => sendLLMMessage(host, llmClient, modelRequest.messages, {
          ...modelRequest.options,
          abortSignal: execution.abortSignal,
          ...(execution.timeoutMs !== undefined ? { timeoutMs: execution.timeoutMs } : {}),
        }, assistantBuffer, eventContext, {
          emitAssistantDeltas: options.streamFinalText,
        }),
        options.abortSignal,
        remainingTimeoutMs(deadlineAt),
        "model_request",
      );
    } catch (err) {
      if (err instanceof ToolLoopTerminalError) throw err;
      const interruption = terminalModelInterruptionFromError(err);
      if (interruption) throw interruption;
      console.error("[chat-runner] executeWithTools error:", err);
      const hint = err instanceof Error ? `: ${err.message}` : "";
      throw new Error(`Sorry, I encountered an error processing your request${hint}.`);
    }
    addUsageCounter(usage, usageFromLLMResponse(response));

    const toolCalls = response.tool_calls?.length
      ? response.tool_calls
      : supportsNativeToolCalling
        ? []
        : extractPromptedToolCalls({
            content: response.content,
            tools: modelRequest.toolDefinitions,
            createId: () => `prompted-${loop}-${crypto.randomUUID()}`,
          }).map((call): ToolCallResult => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {}),
            },
          }));

    if (!supportsNativeToolCalling && toolCalls.length > 0) {
      assistantBuffer.text = "";
    }

    if (toolCalls.length === 0) {
      return {
        output: response.content || assistantBuffer.text || "(no response)",
        usage,
      };
    }

    messages.push({ role: "assistant", content: response.content || "" });

    const toolCycleResults: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // ignore parse errors, use empty args
      }
      if (!allowedToolNames.has(tc.function.name)) {
        host.eventBridge.emitActivity("tool", formatToolActivity("Failed", tc.function.name, "Tool is not available in this gateway scope"), eventContext, tc.id);
        host.eventBridge.emitEvent({
          type: "tool_end",
          toolCallId: tc.id,
          toolName: tc.function.name,
          success: false,
          summary: "Tool is not available in this gateway scope.",
          durationMs: 0,
          ...host.eventBridge.eventBase(eventContext),
        });
        throw new ToolLoopTerminalError("policy_blocked", `Tool ${tc.function.name} is not available in this gateway scope.`);
      }
      throwIfAbortedOrTimedOut(options.abortSignal, deadlineAt, "tool_call");
      const toolResult = await withAbortAndTimeout(
        (execution) => dispatchToolCall(
          host,
          tc.id,
          tc.function.name,
          args,
          {
            ...toolCallContext,
            abortSignal: execution.abortSignal,
            ...(execution.timeoutMs !== undefined ? { timeoutMs: execution.timeoutMs } : {}),
            callId: tc.id,
          },
          eventContext,
        ),
        options.abortSignal,
        remainingTimeoutMs(deadlineAt),
        "tool_call",
      );
      if (tc.function.name === "tool_search") {
        activateToolSearchResults(host.activatedTools, toolResult);
      }
      toolCycleResults.push({ name: tc.function.name, args, result: toolResult });
      messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
    }

    const toolCycleFingerprint = stableToolCycleFingerprint(toolCycleResults);
    if (toolCycleFingerprint === previousToolCycleFingerprint) {
      repeatedToolCycleCount++;
      if (repeatedToolCycleCount >= TOOL_LOOP_STUCK_REPEAT_LIMIT) {
        throw new ToolLoopTerminalError(
          "stalled_tool_loop",
          "The gateway model/tool loop repeated the same tool call and received the same result without making progress.",
        );
      }
    } else {
      previousToolCycleFingerprint = toolCycleFingerprint;
      repeatedToolCycleCount = 0;
    }
  }

  throw new ToolLoopTerminalError(
    "tool_loop_exhausted",
    `The gateway model/tool loop reached the maximum of ${MAX_TOOL_LOOPS} tool iterations without a final assistant answer.`,
  );
}

function terminalModelInterruptionFromError(err: unknown): ToolLoopTerminalError | null {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    return new ToolLoopTerminalError("model_request_aborted", message);
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return new ToolLoopTerminalError("model_request_timeout", message);
  }
  return null;
}

function remainingTimeoutMs(deadlineAt: number | null): number | undefined {
  if (deadlineAt === null) return undefined;
  return Math.max(0, deadlineAt - Date.now());
}

function throwIfAbortedOrTimedOut(
  abortSignal: AbortSignal | undefined,
  deadlineAt: number | null,
  phase: "model_request" | "tool_call",
): void {
  if (abortSignal?.aborted) {
    throw new ToolLoopTerminalError(
      phase === "model_request" ? "model_request_aborted" : "tool_call_aborted",
      phase === "model_request"
        ? "The gateway model request was aborted before it completed."
        : "The gateway tool call was aborted before it completed.",
    );
  }
  const remaining = remainingTimeoutMs(deadlineAt);
  if (remaining !== undefined && remaining <= 0) {
    throw new ToolLoopTerminalError(
      phase === "model_request" ? "model_request_timeout" : "tool_call_timeout",
      phase === "model_request"
        ? "The gateway model request timed out before it completed."
        : "The gateway tool call timed out before it completed.",
    );
  }
}

async function withAbortAndTimeout<T>(
  operation: (execution: { abortSignal: AbortSignal; timeoutMs?: number }) => Promise<T>,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  phase: "model_request" | "tool_call",
): Promise<T> {
  throwIfAbortedOrTimedOut(abortSignal, timeoutMs === undefined ? null : Date.now() + timeoutMs, phase);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const operationPromise = operation({
    abortSignal: controller.signal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const racers: Promise<T>[] = [operationPromise];
  if (timeoutMs !== undefined) {
    racers.push(new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        const err = new ToolLoopTerminalError(
          phase === "model_request" ? "model_request_timeout" : "tool_call_timeout",
          phase === "model_request"
            ? "The gateway model request timed out before it completed."
            : "The gateway tool call timed out before it completed.",
        );
        reject(err);
        abortController(controller, err);
      }, timeoutMs);
    }));
  }
  if (abortSignal) {
    racers.push(new Promise<T>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new ToolLoopTerminalError(
          phase === "model_request" ? "model_request_aborted" : "tool_call_aborted",
          phase === "model_request"
            ? "The gateway model request was aborted before it completed."
            : "The gateway tool call was aborted before it completed.",
        ));
        return;
      }
      abortHandler = () => {
        const err = new ToolLoopTerminalError(
          phase === "model_request" ? "model_request_aborted" : "tool_call_aborted",
          phase === "model_request"
            ? "The gateway model request was aborted before it completed."
            : "The gateway tool call was aborted before it completed.",
        );
        reject(err);
        abortController(controller, err);
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }
  try {
    return await Promise.race(racers);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}

function abortController(controller: AbortController, reason: unknown): void {
  if (controller.signal.aborted) return;
  controller.abort(reason);
}

function stableToolCycleFingerprint(
  results: Array<{ name: string; args: Record<string, unknown>; result: string }>,
): string {
  return JSON.stringify(results.map((item) => ({
    name: item.name,
    args: stableJsonValue(item.args),
    result: item.result,
  })));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function toolLoopTerminalEvidence(error: ToolLoopTerminalError) {
  if (error.code === "approval_denied" || error.code === "policy_blocked") {
    return {
      code: error.code,
      stoppedReason: error.code,
      signals: [{
        kind: "approval" as const,
        status: error.code === "approval_denied" ? "denied" as const : "blocked" as const,
        code: error.code,
      }],
    };
  }
  const isInterruption =
    error.code === "model_request_timeout"
    || error.code === "model_request_aborted"
    || error.code === "tool_call_timeout"
    || error.code === "tool_call_aborted";
  const stoppedReason = error.code === "model_request_aborted" || error.code === "tool_call_aborted"
    ? "aborted"
    : isInterruption
      ? "timeout"
      : "stalled_tool_loop";
  if (isInterruption) {
    return {
      code: error.code,
      stoppedReason: error.code,
      signals: [{
        kind: "runtime" as const,
        stoppedReason,
        code: error.code,
      }],
    };
  }
  return {
    code: error.code,
    stoppedReason: error.code,
    signals: [{
      kind: "runtime" as const,
      operationState: "daemon_loop" as const,
      stoppedReason,
      code: error.code,
    }],
  };
}

async function persistDirectRouteResult(
  host: ChatRunnerRouteHost,
  output: string,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  const elapsed_ms = Date.now() - start;
  if (!assistantBuffer.text) {
    host.eventBridge.pushAssistantDelta(output, assistantBuffer, eventContext);
  }
  await history.appendAssistantMessage(output);
  host.eventBridge.emitEvent({
    type: "assistant_final",
    text: output,
    persisted: true,
    ...host.eventBridge.eventBase(eventContext),
  });
  host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
  return { success: true, output, elapsed_ms };
}

async function formatConfigureGuidance(
  host: ChatRunnerRouteHost,
  target: "telegram_gateway" | "gateway" | "provider" | "daemon" | "notification" | "slack" | "unknown",
  setupSecretIntake: SetupSecretIntakeResult | null = null,
  languageHint: TurnLanguageHint,
  eventContext: ChatEventContext,
): Promise<string> {
  const suppliedSecretKinds = setupSecretIntake?.suppliedSecrets.map((secret) => secret.kind) ?? [];
  if (target === "telegram_gateway") {
    const provider = host.deps.gatewaySetupStatusProvider ?? createGatewaySetupStatusProvider();
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:started",
      kind: "started",
      operation: "telegram_setup",
      title: "Started Telegram setup",
      detail: "Checking daemon and gateway config state.",
      createdAt: new Date().toISOString(),
      languageHint,
    }), eventContext);
    const status = await provider.getTelegramStatus(host.getProviderConfigBaseDir());
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:checked-status",
      kind: "checked_status",
      operation: "telegram_setup",
      title: "Checked daemon status",
      detail: status.daemon.running
        ? `Running on port ${status.daemon.port}.`
        : `Not responding on port ${status.daemon.port}.`,
      createdAt: new Date().toISOString(),
      languageHint,
      metadata: {
        daemon_running: status.daemon.running,
        daemon_port: status.daemon.port,
      },
    }), eventContext);
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:read-config",
      kind: "read_config",
      operation: "telegram_setup",
      title: "Read Telegram config",
      detail: formatTelegramConfigProgressDetail(status),
      createdAt: new Date().toISOString(),
      languageHint,
      metadata: {
        config_exists: status.config.exists,
        has_bot_token: status.config.hasBotToken,
        has_home_chat: status.config.hasHomeChat,
      },
    }), eventContext);
    const suppliedTelegramToken = suppliedSecretKinds.includes("telegram_bot_token");
    const telegramSecret = setupSecretIntake?.suppliedSecrets.find((secret) => secret.kind === "telegram_bot_token");
    if (telegramSecret) {
      await host.setPendingSetupDialogue(createTelegramConfirmWriteDialogue(telegramSecret, {
        replacesExistingSecret: status.config.hasBotToken,
      }));
    }
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:planned-action",
      kind: telegramSecret ? "awaiting_approval" : "planned_action",
      operation: "telegram_setup",
      title: "Prepared next setup step",
      detail: telegramSecret
        ? status.config.hasBotToken
            ? "Prepared an approval-gated config write from the redacted token. Confirming will replace the existing token."
            : "Prepared an approval-gated config write from the redacted token."
        : "Returning guidance. If a token is pasted, PulSeed will redact it and prepare confirmation.",
      createdAt: new Date().toISOString(),
      languageHint,
      metadata: {
        pending_write: telegramSecret !== undefined,
      },
    }), eventContext);
    return formatTelegramConfigureGuidance(status, suppliedTelegramToken, telegramSecret !== undefined);
  }
  if (target === "gateway") {
    const discordSecret = setupSecretIntake?.suppliedSecrets.find((secret) => secret.kind === "discord_bot_token");
    if (discordSecret) {
      const dialogue = createDiscordAdapterPlanDialogue();
      await host.setPendingSetupDialogue({ publicState: dialogue });
      return [
        "Discord gateway setup plan",
        "",
        "- Setup dialogue state: blocked.",
        "- Selected channel: discord.",
        "- A Discord bot token was supplied and redacted, but PulSeed needs application ID, home channel ID, identity key, webhook host/port, and access policy before a chat-assisted config write can be safe.",
        "",
        "Recommended command path:",
        "```sh",
        dialogue.action?.command ?? "pulseed gateway setup",
        "pulseed daemon start",
        "pulseed daemon status",
        "```",
        "",
        "This uses the same typed setup dialogue contract as Telegram, but Discord remains an adapter-plan path until the missing non-secret fields can be collected safely.",
      ].join("\n");
    }
    return [
      "Gateway setup is a configuration flow.",
      "",
      "Run `pulseed gateway setup`, then start or restart the daemon with `pulseed daemon start`.",
    ].join("\n");
  }
  return [
    "This looks like setup/configuration rather than a code-edit task.",
    "",
    "Use `pulseed setup` for the main wizard, `pulseed gateway setup` for chat channels, or the channel-specific setup command when available.",
  ].join("\n");
}

async function dispatchToolCall(
  host: ChatRunnerRouteHost,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  context: ToolCallContext,
  eventContext: ChatEventContext,
): Promise<string> {
  if (!host.deps.registry) {
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, "No tool registry configured"), eventContext, toolCallId);
    return JSON.stringify({ error: "No tool registry configured" });
  }
  const tool = host.deps.registry.get(name);
  if (!tool) {
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, `Unknown tool: ${name}`), eventContext, toolCallId);
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  const activityCategory = tool.metadata.activityCategory;
  const startTime = Date.now();
  try {
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, `Invalid input: ${parsed.error.message}`), eventContext, toolCallId);
      host.eventBridge.emitEvent({
        type: "tool_end",
        toolCallId,
        toolName: name,
        success: false,
        summary: `Invalid input: ${parsed.error.message}`,
        durationMs: Date.now() - startTime,
        ...(activityCategory ? { activityCategory } : {}),
        ...host.eventBridge.eventBase(eventContext),
      });
      return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
    }

    host.eventBridge.emitEvent({
      type: "tool_start",
      toolCallId,
      toolName: name,
      args,
      ...(activityCategory ? { activityCategory } : {}),
      ...host.eventBridge.eventBase(eventContext),
    });
    host.eventBridge.emitActivity("tool", formatToolActivity("Running", name, JSON.stringify(args)), eventContext, toolCallId);

    let result: ToolResult;
    if (host.deps.toolExecutor) {
      host.eventBridge.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "running",
        message: "running",
        ...(activityCategory ? { activityCategory } : {}),
        ...host.eventBridge.eventBase(eventContext),
      });
      host.deps.onToolStart?.(name, args);
      result = await host.deps.toolExecutor.execute(name, parsed.data, context);
    } else {
      const permResult = await tool.checkPermissions(parsed.data, context);
      if (permResult.status === "denied") {
        host.eventBridge.emitEvent({
          type: "tool_end",
          toolCallId,
          toolName: name,
          success: false,
          summary: permResult.reason,
          durationMs: Date.now() - startTime,
          ...(activityCategory ? { activityCategory } : {}),
          ...host.eventBridge.eventBase(eventContext),
        });
        return `Tool ${name} denied: ${permResult.reason}`;
      }
      if (permResult.status === "needs_approval") {
        host.eventBridge.emitActivity("tool", formatToolActivity("Running", name, `awaiting approval: ${permResult.reason}`), eventContext, toolCallId);
        host.eventBridge.emitEvent({
          type: "tool_update",
          toolCallId,
          toolName: name,
          status: "awaiting_approval",
          message: permResult.reason,
          ...(activityCategory ? { activityCategory } : {}),
          ...host.eventBridge.eventBase(eventContext),
        });
        const approved = await context.approvalFn({
          toolName: name,
          input: parsed.data,
          reason: permResult.reason,
          permissionLevel: tool.metadata.permissionLevel,
          isDestructive: tool.metadata.isDestructive,
          reversibility: "unknown",
        });
        if (!approved) {
          host.eventBridge.emitEvent({
            type: "tool_end",
            toolCallId,
            toolName: name,
            success: false,
            summary: `Not approved: ${permResult.reason}`,
            durationMs: Date.now() - startTime,
            ...(activityCategory ? { activityCategory } : {}),
            ...host.eventBridge.eventBase(eventContext),
          });
          throw new ToolLoopTerminalError("approval_denied", `Tool ${name} not approved: ${permResult.reason}`);
        }
      }
      host.eventBridge.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "running",
        message: "running",
        ...(activityCategory ? { activityCategory } : {}),
        ...host.eventBridge.eventBase(eventContext),
      });
      host.deps.onToolStart?.(name, args);
      result = await tool.call(parsed.data, context);
    }

    const durationMs = Date.now() - startTime;
    host.deps.onToolEnd?.(name, { success: result.success, summary: result.summary || "...", durationMs });
    host.eventBridge.emitActivity(
      "tool",
      formatToolActivity(result.success ? "Finished" : "Failed", name, result.summary || "..."),
      eventContext,
      toolCallId
    );
    host.eventBridge.emitEvent({
      type: "tool_update",
      toolCallId,
      toolName: name,
      status: "result",
      message: result.summary || "...",
      ...(activityCategory ? { activityCategory } : {}),
      ...host.eventBridge.eventBase(eventContext),
    });
    host.eventBridge.emitEvent({
      type: "tool_end",
      toolCallId,
      toolName: name,
      success: result.success,
      summary: result.summary || "...",
      durationMs,
      ...(activityCategory ? { activityCategory } : {}),
      ...host.eventBridge.eventBase(eventContext),
    });
    const terminalToolFailure = terminalToolFailureFromResult(name, tool, result);
    if (terminalToolFailure) {
      throw terminalToolFailure;
    }
    return result.data != null ? JSON.stringify(result.data) : (result.summary ?? "(no result)");
  } catch (err) {
    if (err instanceof ToolLoopTerminalError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const terminalInterruption = terminalToolInterruptionFromMessage(message);
    if (terminalInterruption) {
      throw terminalInterruption;
    }
    const durationMs = Date.now() - startTime;
    host.deps.onToolEnd?.(name, { success: false, summary: message, durationMs });
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, message), eventContext, toolCallId);
    host.eventBridge.emitEvent({
      type: "tool_end",
      toolCallId,
      toolName: name,
      success: false,
      summary: message,
      durationMs,
      ...(activityCategory ? { activityCategory } : {}),
      ...host.eventBridge.eventBase(eventContext),
    });
    return JSON.stringify({ error: `Tool ${name} failed: ${message}` });
  }
}

function terminalToolInterruptionFromMessage(message: string): ToolLoopTerminalError | null {
  const normalized = message.toLowerCase();
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    return new ToolLoopTerminalError("tool_call_aborted", message);
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return new ToolLoopTerminalError("tool_call_timeout", message);
  }
  return null;
}

function terminalToolFailureFromResult(
  name: string,
  tool: ITool,
  result: ToolResult,
): ToolLoopTerminalError | null {
  if (result.success) return null;
  const reason = result.execution?.reason;
  if (reason === "approval_denied") {
    return new ToolLoopTerminalError(
      "approval_denied",
      result.execution?.message ?? result.error ?? result.summary ?? `Tool ${name} was denied by approval policy.`,
    );
  }
  if (
    reason === "policy_blocked"
    && (tool.metadata.permissionLevel !== "read_only" || tool.metadata.isDestructive)
  ) {
    return new ToolLoopTerminalError(
      "policy_blocked",
      result.execution?.message ?? result.error ?? result.summary ?? `Tool ${name} was blocked by policy.`,
    );
  }
  return null;
}

async function sendLLMMessage(
  host: ChatRunnerRouteHost,
  llmClient: ILLMClient,
  messages: LLMMessage[],
  options: LLMRequestOptions | undefined,
  assistantBuffer: AssistantBuffer,
  eventContext: ChatEventContext,
  behavior: { emitAssistantDeltas?: boolean } = {},
): Promise<LLMResponse> {
  const emitAssistantDeltas = behavior.emitAssistantDeltas ?? true;
  let streamed = false;
  if (llmClient.sendMessageStream) {
    const response = await llmClient.sendMessageStream(messages, options, {
      onTextDelta: (delta) => {
        streamed = true;
        if (emitAssistantDeltas) {
          host.eventBridge.pushAssistantDelta(delta, assistantBuffer, eventContext);
        }
      },
    });
    if (emitAssistantDeltas && !streamed && response.content) {
      host.eventBridge.pushAssistantDelta(response.content, assistantBuffer, eventContext);
    }
    return response;
  }

  const response = await llmClient.sendMessage(messages, options);
  if (emitAssistantDeltas && response.content) {
    host.eventBridge.pushAssistantDelta(response.content, assistantBuffer, eventContext);
  }
  return response;
}

async function buildToolCallContext(
  host: ChatRunnerRouteHost,
  goalId = host.deps.goalId,
  runtimeControlContext?: RuntimeControlChatContext | null,
  start?: number,
  turnContext?: ChatTurnContext,
  execution?: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ToolCallContext> {
  const executionPolicy = turnContext?.hostOnly.execution.executionPolicy ?? await host.getSessionExecutionPolicy();
  const runtimeContext = turnContext?.hostOnly.runtime.runtimeControlContext ?? runtimeControlContext;
  return {
    cwd: turnContext?.hostOnly.execution.executionCwd ?? host.getSessionCwd() ?? process.cwd(),
    goalId: turnContext?.hostOnly.execution.goalId ?? goalId ?? "",
    trustBalance: 0,
    preApproved: false,
    approvalFn: agentLoopApprovalFn(host, runtimeContext),
    executionPolicy,
    ...(host.deps.permissionGrantContext?.sessionId
      ? { sessionId: host.deps.permissionGrantContext.sessionId }
      : host.getConversationSessionId()
        ? { sessionId: host.getConversationSessionId()! }
        : {}),
    ...(turnContext?.modelVisible.turn.runId ? { runId: turnContext.modelVisible.turn.runId } : {}),
    ...(turnContext?.modelVisible.turn.turnId ? { turnId: turnContext.modelVisible.turn.turnId } : {}),
    ...(host.deps.permissionGrantContext?.projectId ? { projectId: host.deps.permissionGrantContext.projectId } : {}),
    ...(host.deps.permissionGrantStore ? { permissionGrantStore: host.deps.permissionGrantStore } : {}),
    ...(host.deps.permissionWaitPlanStore ? { permissionWaitPlanStore: host.deps.permissionWaitPlanStore } : {}),
    ...(host.deps.capabilityVerificationStore ? { capabilityVerificationStore: host.deps.capabilityVerificationStore } : {}),
    ...(host.deps.capabilityExecutionResolver ? { capabilityExecutionResolver: host.deps.capabilityExecutionResolver } : {}),
    ...(execution?.abortSignal ? { abortSignal: execution.abortSignal } : {}),
    ...(execution?.timeoutMs !== undefined ? { timeoutMs: execution.timeoutMs } : {}),
    ...(host.getConversationSessionId() ? { conversationSessionId: host.getConversationSessionId()! } : {}),
    providerConfigBaseDir: host.getProviderConfigBaseDir(),
    setupSecretIntake: host.getSetupSecretIntake(),
    setupDialogue: {
      get: () => host.getPendingSetupDialogue(),
      set: (dialogue) => host.setPendingSetupDialogue(dialogue as SetupDialogueRuntimeState | null),
    },
    runSpecConfirmation: {
      get: () => host.getPendingRunSpecConfirmation(),
      set: (confirmation) => host.setPendingRunSpecConfirmation(confirmation as RunSpecConfirmationState | null),
      ...(typeof start === "number" ? { currentTurnStartedAt: new Date(start).toISOString() } : {}),
    },
    runtimeReplyTarget: (runtimeContext?.replyTarget ?? turnContext?.hostOnly.runtime.fallbackReplyTarget ?? host.deps.runtimeReplyTarget ?? null) as Record<string, unknown> | null,
    runtimeControlActor: (runtimeContext?.actor ?? turnContext?.hostOnly.runtime.fallbackActor ?? host.deps.runtimeControlActor ?? null) as Record<string, unknown> | null,
    runtimeControlAllowed: turnContext?.modelVisible.runtime.runtimeControlAllowed ?? runtimeContext?.allowed ?? true,
    runtimeControlApprovalMode: turnContext?.modelVisible.runtime.approvalMode ?? runtimeContext?.approvalMode ?? "interactive",
  };
}

function agentLoopApprovalFn(
  host: ChatRunnerRouteHost,
  runtimeControlContext?: RuntimeControlChatContext | null,
): (request: ApprovalRequest) => Promise<boolean> {
  return async (request) => {
    if (request.toolName === "request_runtime_control" && runtimeControlContext?.approvalFn) {
      return runtimeControlContext.approvalFn(request.reason);
    }
    if (host.deps.approvalRequestFn) {
      return host.deps.approvalRequestFn(request);
    }
    if (host.deps.approvalFn) {
      return host.deps.approvalFn(request.reason);
    }
    return false;
  };
}

type AgentLoopResumeStateResult =
  | { kind: "loaded"; state: AgentLoopSessionState }
  | { kind: "blocked"; code: "resume_state_missing" | "resume_state_not_resumable"; message: string };

async function loadResumableAgentLoopState(host: ChatRunnerRouteHost): Promise<AgentLoopResumeStateResult> {
  const sessionId = host.getNativeAgentLoopSessionId();
  if (!sessionId) {
    return {
      kind: "blocked",
      code: "resume_state_missing",
      message: formatMissingResumableChatStateMessage(),
    };
  }
  const state = await new AgentLoopSessionStateCatalog(host.getProviderConfigBaseDir()).load(sessionId);
  if (!state) {
    return {
      kind: "blocked",
      code: "resume_state_missing",
      message: formatMissingResumableChatStateMessage(),
    };
  }
  if (state.status !== "running") {
    return {
      kind: "blocked",
      code: "resume_state_not_resumable",
      message: formatNonResumableAgentLoopStateMessage(state.status),
    };
  }
  return { kind: "loaded", state };
}

function formatMissingResumableChatStateMessage(): string {
  return "I could not find a chat that can safely continue.";
}

function formatNonResumableAgentLoopStateMessage(status: AgentLoopSessionState["status"] | "unknown"): string {
  if (status === "failed") {
    return "The saved chat work stopped before it could safely continue; inspect what was running or start a new attempt.";
  }
  if (status === "completed") {
    return "The saved chat work already completed; inspect what finished or start a new attempt.";
  }
  return "The saved chat work is not in a state PulSeed can safely continue; inspect what was running or start a new attempt.";
}

function activateToolSearchResults(activatedTools: Set<string>, toolResult: string): void {
  try {
    const parsed = JSON.parse(toolResult) as unknown;
    const results = Array.isArray(parsed) ? parsed : null;
    if (results) {
      for (const item of results) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["name"] === "string") {
          activatedTools.add((item as Record<string, unknown>)["name"] as string);
        }
      }
    }
  } catch {
    // Non-JSON result or unexpected shape — ignore
  }
}

export async function resolveSessionExecutionPolicy(
  currentPolicy: ExecutionPolicy | null,
  sessionCwd: string | null
): Promise<ExecutionPolicy> {
  if (currentPolicy) return currentPolicy;
  const config = await loadProviderConfig({ saveMigration: false });
  return resolveExecutionPolicy({
    workspaceRoot: sessionCwd ?? process.cwd(),
    security: config.agent_loop?.security,
  });
}
