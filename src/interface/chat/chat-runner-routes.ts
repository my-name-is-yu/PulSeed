import type { IAdapter, AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, ToolCallResult } from "../../base/llm/llm-client.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import type { ApprovalRequest, ITool, ToolCallContext } from "../../tools/types.js";
import { extractPromptedToolCalls } from "../../orchestrator/execution/agent-loop/prompted-tool-protocol.js";
import { verifyChatAction } from "./chat-verifier.js";
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
import { gateRuntimeEvidenceBoundFinalAnswer } from "./runtime-evidence-gate.js";
import { generateGatewayCommentaryPreamble } from "./gateway-commentary-preamble.js";
import {
  buildGatewayToolUseRetryMessage,
  evaluateGatewayToolUseContract,
} from "./gateway-tool-use-contract.js";
import {
  createDiscordAdapterPlanDialogue,
  createTelegramConfirmWriteDialogue,
  type SetupDialogueRuntimeState,
} from "./setup-dialogue.js";
import {
  sameLanguageResponseInstruction,
  type TurnLanguageHint,
} from "./turn-language.js";
import { createOperationProgressItem } from "./operation-progress.js";
import { createRunSpecStore, formatRunSpecSetupProposal } from "../../runtime/run-spec/index.js";
import type { RunSpecConfirmationState } from "./chat-history.js";
import { buildStaticSystemPrompt } from "./grounding.js";
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

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_RETRIES = 2;
const MAX_TOOL_LOOPS = 5;

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

export async function executeRunSpecDraftRoute(
  host: ChatRunnerRouteHost,
  route: Extract<SelectedChatRoute, { kind: "run_spec_draft" }>,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  const store = createRunSpecStore(host.deps.stateManager);
  await store.save(route.draft);
  const proposal = formatRunSpecSetupProposal(route.draft);
  const output = [
    proposal,
    "",
    "PulSeed prepared this as typed long-running work. It has not started background work.",
    "Reply with approval to confirm, cancel to discard it, or provide updated workspace/deadline/metric details.",
  ].join("\n");
  await host.setPendingRunSpecConfirmation({
    state: "pending",
    spec: route.draft,
    prompt: output,
    createdAt: route.draft.created_at,
    updatedAt: route.draft.updated_at,
  });
  host.eventBridge.emitCheckpoint("Long-running work confirmation pending", "A typed background-work draft is awaiting confirmation.", eventContext, "route");
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
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
  const output = await formatConfigureGuidance(host, route.intent.configure_target ?? "unknown", host.getSetupSecretIntake(), host.getTurnLanguageHint(), eventContext);
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
}

export async function executeClarifyRoute(
  host: ChatRunnerRouteHost,
  _route: SelectedChatRoute,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  const output = [
    "I need one more detail before taking action.",
    "",
    "Tell me whether you want setup guidance, a configuration flow, or a code/test change.",
  ].join("\n");
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
}

export async function executeAssistRoute(
  host: ChatRunnerRouteHost,
  params: {
    turnContext: ChatTurnContext;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    history: { appendAssistantMessage(message: string): Promise<void>; recordUsage(phase: string, usage: ChatUsageCounter): void };
    start: number;
  },
): Promise<ChatRunResult> {
  if (!host.deps.llmClient) {
    return persistDirectRouteResult(
      host,
      "I can answer this as guidance, but no language model is configured for read-only chat.",
      params.eventContext,
      params.assistantBuffer,
      params.history,
      params.start,
    );
  }
  host.eventBridge.emitCheckpoint("Read-only assist selected", "The message will be answered without coding-agent execution.", params.eventContext, "route");
  const modelRequest = buildChatModelRequest({
    purpose: "ordinary_chat",
    turnContext: params.turnContext,
    systemPrompt: [
      params.turnContext.modelVisible.instructions.systemPrompt || buildStaticSystemPrompt(host.getProviderConfigBaseDir()),
      "Answer read-only. Provide concise operational guidance. Do not ask to edit files or run commands unless the user explicitly asks for execution.",
      sameLanguageResponseInstruction(host.getTurnLanguageHint()),
    ].join(" "),
    maxTokens: 1000,
    temperature: 0,
  });
  const response = await sendLLMMessage(host, host.deps.llmClient, modelRequest.messages, {
    ...modelRequest.options,
  }, params.assistantBuffer, params.eventContext);
  const usage = usageFromLLMResponse(response);
  if (hasUsage(usage)) params.history.recordUsage("assist", usage);
  return persistDirectRouteResult(
    host,
    params.assistantBuffer.text || response.content || "(no response)",
    params.eventContext,
    params.assistantBuffer,
    params.history,
    params.start,
  );
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
    host.eventBridge.emitCheckpoint(resumeOnly ? "Session resumed" : "Working turn started", resumeOnly
      ? "Saved chat state is ready to continue."
      : "PulSeed can now inspect, plan, edit, or verify with visible tool activity.", eventContext, "execution");
    await emitGatewayCommentaryPreamble(host, turnContext, eventContext, "agent_loop", activeAbortSignal);
    host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
    const result = await host.deps.chatAgentLoopRunner!.execute({
      message: turnContext.modelVisible.prompts.basePrompt,
      cwd: turnContext.hostOnly.execution.executionCwd,
      goalId: turnContext.hostOnly.execution.goalId,
      history: turnContext.modelVisible.conversation.priorTurns,
      eventSink: host.eventBridge.createAgentLoopEventSink(eventContext, assistantBuffer, {
        streamFinalCandidate: () => !shouldGateRuntimeEvidenceForTurn(turnContext),
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
    if (result.output && shouldGateRuntimeEvidenceForTurn(turnContext)) {
      const gate = await gateRuntimeEvidenceBoundFinalAnswer({
        turnContext,
        assistantOutput: result.output,
        hasRuntimeEvidence: host.eventBridge.hasRuntimeEvidenceForTurn(eventContext),
        runtimeEvidenceRefs: host.eventBridge.getRuntimeEvidenceRefsForTurn(eventContext),
        llmClient: host.getRuntimeEvidenceGateClient(),
      });
      if (gate.blocked) {
        host.eventBridge.emitCheckpoint(
          "Runtime evidence required",
          gate.reason ?? "The final answer made an unverified runtime status claim.",
          eventContext,
          "runtime-evidence",
        );
      }
      result.output = gate.output;
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
      host.eventBridge.emitCheckpoint("Response ready", "The agent-loop response has been persisted for this turn.", eventContext, "complete");
      host.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
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

export async function executeToolLoopRoute(
  host: ChatRunnerRouteHost,
  params: {
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
    start: number;
  }
): Promise<ChatRunResult> {
  try {
    host.eventBridge.emitCheckpoint("Tool loop started", "The model will choose tools from the active catalog.", params.eventContext, "execution");
    await emitGatewayCommentaryPreamble(host, params.turnContext, params.eventContext, "tool_loop", params.activeAbortSignal);
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
        tools: host.deps.registry?.listAll() ?? [],
        streamFinalText: !shouldGateRuntimeEvidenceForTurn(params.turnContext),
        failClosedOnToolContractUnavailable: false,
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
    let output = toolResult.output;
    if (shouldGateRuntimeEvidenceForTurn(params.turnContext)) {
      const gate = await gateRuntimeEvidenceBoundFinalAnswer({
        turnContext: params.turnContext,
        assistantOutput: toolResult.output,
        hasRuntimeEvidence: host.eventBridge.hasRuntimeEvidenceForTurn(params.eventContext),
        runtimeEvidenceRefs: host.eventBridge.getRuntimeEvidenceRefsForTurn(params.eventContext),
        llmClient: host.getRuntimeEvidenceGateClient(),
      });
      if (gate.blocked) {
        host.eventBridge.emitCheckpoint(
          "Runtime evidence required",
          gate.reason ?? "The final answer made an unverified runtime status claim.",
          params.eventContext,
          "runtime-evidence",
        );
      }
      output = gate.output;
    }
    if (!params.assistantBuffer.text) {
      host.eventBridge.pushAssistantDelta(output, params.assistantBuffer, params.eventContext);
    }
    await params.history.appendAssistantMessage(output);
    host.eventBridge.emitCheckpoint("Response ready", "The tool-loop response has been persisted for this turn.", params.eventContext, "complete");
    host.eventBridge.emitActivity("lifecycle", "Finalizing response...", params.eventContext, "lifecycle:finalizing");
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
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      params.assistantBuffer.text,
      params.eventContext,
      {},
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

export async function executeGatewayModelLoopRoute(
  host: ChatRunnerRouteHost,
  params: Parameters<typeof executeToolLoopRoute>[1],
): Promise<ChatRunResult> {
  try {
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
        tools: selectGatewayModelLoopTools(host.deps.registry?.listAll() ?? []),
        streamFinalText: true,
        failClosedOnToolContractUnavailable: true,
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
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      params.assistantBuffer.text,
      params.eventContext,
      {},
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

export async function executeAdapterRoute(
  host: ChatRunnerRouteHost,
  params: {
    turnContext: ChatTurnContext;
    timeoutMs: number;
    systemPrompt?: string;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    gitRoot: string;
    start: number;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
    };
  }
): Promise<ChatRunResult> {
  const task: AgentTask = {
    prompt: params.turnContext.modelVisible.prompts.prompt,
    timeout_ms: params.timeoutMs,
    adapter_type: host.deps.adapter.adapterType,
    cwd: params.turnContext.hostOnly.execution.cwd,
    ...(params.systemPrompt ? {
      system_prompt: renderSystemPromptWithTurnContext(
        params.turnContext.modelVisible.instructions.systemPrompt,
        params.turnContext.modelVisible,
      ),
    } : {}),
  };
  const resolvedTimeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  host.eventBridge.emitCheckpoint("Adapter started", "The configured adapter has the current prompt and project context.", params.eventContext, "execution");
  host.eventBridge.emitActivity("lifecycle", "Calling adapter...", params.eventContext, "lifecycle:adapter");
  const adapterPromise = host.deps.adapter.execute(task);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Chat adapter timed out after ${resolvedTimeoutMs}ms`)), resolvedTimeoutMs)
  );
  let result: Awaited<ReturnType<IAdapter["execute"]>>;
  try {
    result = await Promise.race([adapterPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      params.assistantBuffer.text,
      params.eventContext,
      {},
      host.deps.llmClient
    );
    const timeoutElapsedMs = Date.now() - params.start;
    host.eventBridge.emitLifecycleEndEvent("error", timeoutElapsedMs, params.eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: timeoutElapsedMs,
    };
  }
  if (!result.output && result.error) {
    result = { ...result, output: `Error: ${result.error}` };
  }
  const elapsed_ms = Date.now() - params.start;
  if (result.output) {
    host.eventBridge.pushAssistantDelta(result.output, params.assistantBuffer, params.eventContext);
  }

  const diffArtifact = await collectGitDiffArtifact(params.gitRoot);
  if (diffArtifact) {
    let retries = 0;
    const VERIFY_TIMEOUT_MS = 30_000;
    host.eventBridge.emitCheckpoint("Changes detected", "Verification is starting because the turn changed the working tree.", params.eventContext, "changes");
    host.eventBridge.emitActivity("lifecycle", "Checking result...", params.eventContext, "lifecycle:checking");
    let verification = await Promise.race([
      verifyChatAction(params.gitRoot, host.deps.toolExecutor, { force: true }),
      new Promise<{ passed: true }>((resolve) =>
        setTimeout(() => resolve({ passed: true }), VERIFY_TIMEOUT_MS)
      ),
    ]);

    while (!verification.passed && retries < MAX_VERIFY_RETRIES) {
      retries++;
      host.eventBridge.emitCheckpoint("Verification retry", `Attempt ${retries} of ${MAX_VERIFY_RETRIES} is repairing failed checks.`, params.eventContext, `verification-retry-${retries}`);
      const retryPrompt = `The previous changes caused test failures. Please fix them.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`;
      const retryTask: AgentTask = { ...task, prompt: retryPrompt };
      result = await host.deps.adapter.execute(retryTask);
      verification = await verifyChatAction(params.gitRoot, host.deps.toolExecutor, { force: true });
    }

    if (!verification.passed) {
      const finalDiffArtifact = await collectGitDiffArtifact(params.gitRoot);
      if (finalDiffArtifact) {
        host.eventBridge.emitDiffArtifact(finalDiffArtifact, params.eventContext);
      }
      host.eventBridge.emitCheckpoint("Verification failed", `Checks are still failing after ${MAX_VERIFY_RETRIES} retries.`, params.eventContext, "verification");
      const failureOutput = await host.eventBridge.emitLifecycleErrorEventWithFallback(
        `Changes applied but tests are still failing after ${MAX_VERIFY_RETRIES} retries.`,
        params.assistantBuffer.text,
        params.eventContext,
        {
          code: "verification_failed",
          signals: [{ kind: "verification", status: "failed" }],
        },
        host.deps.llmClient
      );
      host.eventBridge.emitLifecycleEndEvent("error", Date.now() - params.start, params.eventContext, false);
      return {
        success: false,
        output: `${failureOutput}\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`.trim(),
        elapsed_ms: Date.now() - params.start,
      };
    }
    const finalDiffArtifact = await collectGitDiffArtifact(params.gitRoot);
    if (finalDiffArtifact) {
      host.eventBridge.emitDiffArtifact(finalDiffArtifact, params.eventContext);
    }
    host.eventBridge.emitCheckpoint("Verification passed", "Changed files passed the configured chat verification.", params.eventContext, "verification");
  }

  if (result.success) {
    await params.history.appendAssistantMessage(result.output);
    host.eventBridge.emitCheckpoint("Response ready", "The assistant response has been persisted for this turn.", params.eventContext, "complete");
    host.eventBridge.emitActivity("lifecycle", "Finalizing response...", params.eventContext, "lifecycle:finalizing");
    host.eventBridge.emitEvent({
      type: "assistant_final",
      text: result.output,
      persisted: true,
      ...host.eventBridge.eventBase(params.eventContext),
    });
    host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, params.eventContext, true);
  } else {
    const partialText = params.assistantBuffer.text !== result.output ? params.assistantBuffer.text : "";
    result.output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      result.output || result.error || "Unknown error",
      partialText,
      params.eventContext,
      {
        stoppedReason: result.stopped_reason,
        signals: [{
          kind: "adapter",
          adapterType: host.deps.adapter.adapterType,
          stoppedReason: result.stopped_reason,
        }],
      },
      host.deps.llmClient
    );
    host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, params.eventContext, false);
  }

  return {
    success: result.success,
    output: result.output,
    elapsed_ms,
  };
}

function shouldGateRuntimeEvidenceForTurn(turnContext: ChatTurnContext): boolean {
  return turnContext.modelVisible.runtime.replyTarget?.surface === "gateway";
}

const GATEWAY_MODEL_LOOP_TOOL_NAMES = new Set([
  "tool_search",
  "list_dir",
  "read",
  "grep",
  "glob",
  "get_gateway_setup_status",
  "prepare_gateway_setup_guidance",
  "prepare_gateway_config_write",
  "confirm_gateway_config_write",
  "cancel_gateway_config_write",
  "get_runtime_status",
  "request_runtime_control",
  "draft_run_spec",
  "update_run_spec_draft",
  "cancel_run_spec_draft",
  "runspec_propose",
  "runspec_confirm",
  "start_durable_run",
  "run_start",
]);

function selectGatewayModelLoopTools(tools: ITool[]): ITool[] {
  if (tools.length <= 12) return tools;
  return tools.filter((tool) => {
    if (GATEWAY_MODEL_LOOP_TOOL_NAMES.has(tool.metadata.name)) return true;
    if (tool.metadata.alwaysLoad && tool.metadata.isReadOnly) return true;
    return false;
  });
}

async function emitGatewayCommentaryPreamble(
  host: ChatRunnerRouteHost,
  turnContext: ChatTurnContext,
  eventContext: ChatEventContext,
  routeKind: "agent_loop" | "tool_loop",
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) return;
  const preamble = await generateGatewayCommentaryPreamble({
    turnContext,
    routeKind,
    llmClient: host.getGatewayCommentaryClient(),
    abortSignal,
  });
  if (abortSignal?.aborted) return;
  if (!preamble) return;
  await withTimeout(
    host.eventBridge.emitGatewayCommentaryAndFlush(
      preamble,
      eventContext,
      `preamble:${routeKind}:${eventContext.turnId}`,
    ),
    300,
    abortSignal,
  );
}

async function withTimeout(promise: Promise<void>, timeoutMs: number, abortSignal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  promise.catch(() => undefined);
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
      ...(abortSignal
        ? [
            new Promise<void>((resolve) => {
              abortListener = () => resolve();
              abortSignal.addEventListener("abort", abortListener, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (abortSignal && abortListener !== null) {
      abortSignal.removeEventListener("abort", abortListener);
    }
  }
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
    failClosedOnToolContractUnavailable?: boolean;
  } = {
    tools: host.deps.registry?.listAll() ?? [],
    streamFinalText: true,
    failClosedOnToolContractUnavailable: false,
  },
): Promise<{ output: string; usage: ChatUsageCounter }> {
  const llmClient = host.deps.llmClient!;
  const supportsNativeToolCalling = llmClient.supportsToolCalling?.() !== false;
  if (options.tools.length === 0) {
    const ordinaryChatRequest = buildChatModelRequest({
      purpose: "ordinary_chat",
      turnContext,
      systemPrompt: [
        systemPrompt,
        "You are Seedy on a gateway chat surface.",
        "Answer ordinary casual messages directly and briefly in the user's language.",
        "Do not claim current workspace, runtime, command, process, repository, file, or local-machine facts without tool evidence.",
        sameLanguageResponseInstruction(host.getTurnLanguageHint()),
      ].filter((section): section is string => Boolean(section?.trim())).join("\n\n"),
      maxTokens: 1000,
      temperature: 0,
    });
    host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
    const response = await sendLLMMessage(host, llmClient, ordinaryChatRequest.messages, {
      ...ordinaryChatRequest.options,
      model_tier: "light",
    }, assistantBuffer, eventContext, {
      emitAssistantDeltas: options.streamFinalText,
    });
    return {
      output: response.content || assistantBuffer.text || "(no response)",
      usage: usageFromLLMResponse(response),
    };
  }

  const initialModelRequest = buildChatModelRequest({
    purpose: "tool_call",
    turnContext,
    systemPrompt,
    availableTools: options.tools,
    activatedTools: host.activatedTools,
    supportsNativeToolCalling,
  });
  const messages: LLMMessage[] = [...initialModelRequest.messages];
  const toolCallContext = await buildToolCallContext(host, goalId, runtimeControlContext, start, turnContext);
  const usage = zeroUsageCounter();
  let noToolContractRetries = 0;
  let executedToolThisTurn = false;
  let lastNoToolContractReason: string | undefined;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
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
      const shouldStreamThisModelResponse = options.streamFinalText && executedToolThisTurn;
      response = await sendLLMMessage(host, llmClient, modelRequest.messages, modelRequest.options, assistantBuffer, eventContext, {
        emitAssistantDeltas: shouldStreamThisModelResponse,
      });
    } catch (err) {
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
      const output = response.content || assistantBuffer.text || "(no response)";
      if (!executedToolThisTurn && noToolContractRetries < 1 && loop < MAX_TOOL_LOOPS - 1) {
        const decision = await evaluateGatewayToolUseContract({
          turnContext,
          assistantOutput: output,
          availableTools: options.tools,
          llmClient,
        });
        if (decision.verdict === "retry_with_tools") {
          noToolContractRetries += 1;
          lastNoToolContractReason = decision.reason;
          host.eventBridge.emitCheckpoint(
            "Tool evidence required",
            decision.reason,
            eventContext,
            "runtime-evidence",
          );
          messages.push({ role: "assistant", content: output });
          messages.push({ role: "user", content: buildGatewayToolUseRetryMessage(decision) });
          continue;
        }
        if (decision.verdict === "tool_unavailable" && options.failClosedOnToolContractUnavailable) {
          lastNoToolContractReason = decision.reason;
          return {
            output: noToolEvidenceFailureOutput(lastNoToolContractReason),
            usage,
          };
        }
      }
      if (!executedToolThisTurn && noToolContractRetries > 0) {
        return {
          output: noToolEvidenceFailureOutput(lastNoToolContractReason),
          usage,
        };
      }
      return {
        output,
        usage,
      };
    }

    messages.push({ role: "assistant", content: response.content || "" });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // ignore parse errors, use empty args
      }
      const toolResult = await dispatchToolCall(
        host,
        tc.id,
        tc.function.name,
        args,
        toolCallContext,
        eventContext
      );
      executedToolThisTurn = true;
      if (tc.function.name === "tool_search") {
        activateToolSearchResults(host.activatedTools, toolResult);
      }
      messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
    }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  return {
    output: lastAssistant?.content || "I was unable to complete the request within the allowed tool call limit.",
    usage,
  };
}

function noToolEvidenceFailureOutput(reason?: string): string {
  return [
    "I could not complete that current-state check because the gateway model did not call an available same-turn evidence tool after being required to do so.",
    "No local workspace or PulSeed runtime claim was made from this turn.",
    ...(reason ? [`Reason: ${reason}`] : []),
  ].join("\n");
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
  host.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
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

    let result: { success: boolean; summary: string; data?: unknown; error?: string };
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
          return `Tool ${name} not approved: ${permResult.reason}`;
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
    return result.data != null ? JSON.stringify(result.data) : (result.summary ?? "(no result)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
  let modelDeltaActivityEmitted = false;
  if (llmClient.sendMessageStream) {
    const response = await llmClient.sendMessageStream(messages, options, {
      onModelTextDeltaReceived: (delta) => {
        if (!modelDeltaActivityEmitted && delta.trim().length > 0) {
          modelDeltaActivityEmitted = true;
          host.eventBridge.emitActivity("lifecycle", "Receiving model output...", eventContext, "lifecycle:model-delta");
        }
      },
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
