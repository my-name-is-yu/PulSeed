import type { ActivityKind, ChatEvent, ChatEventHandler } from "./chat-events.js";
import type { ActiveChatTurn, ChatEventContext } from "./turn-state.js";
import type {
  AgentLoopEvent,
  AgentLoopEventSink,
} from "../../orchestrator/execution/agent-loop/agent-loop-events.js";
import {
  createAgentTimelineActivitySummary,
  projectAgentLoopEventToTimeline,
  type AgentTimelineItem,
} from "../../orchestrator/execution/agent-loop/agent-timeline.js";
import {
  DIFF_ARTIFACT_MAX_LINES,
  formatIntentInput,
  formatToolActivity,
  previewActivityText,
  type GitDiffArtifact,
} from "./chat-runner-support.js";
import {
  classifyFailureRecovery,
  classifyFailureRecoveryWithFallback,
  formatLifecycleFailureMessage,
  type FailureRecoveryEvidence,
  type FailureRecoverySignal,
} from "./failure-recovery.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { redactSetupSecrets, redactSetupSecretsDeep } from "./setup-secret-intake.js";
import {
  createOperationProgressItem,
  operationProgressFromAgentActivitySummary,
  type OperationProgressItem,
} from "./operation-progress.js";
import { createTextUserInput, type UserInput } from "./user-input.js";
import { createTurnStartOperation, type TurnOperation } from "./turn-protocol.js";

export type { ActiveChatTurn } from "./turn-state.js";

export interface AssistantBuffer {
  text: string;
}

export class ChatRunnerEventBridge {
  private activeTurn: ActiveChatTurn | null = null;
  private readonly timelineActivityItemsByRun = new Map<string, AgentTimelineItem[]>();
  private eventRecorder: ((event: ChatEvent) => Promise<void> | void) | null = null;
  private eventRecorderQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly onEventGetter: () => ChatEventHandler | undefined,
  ) {}

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  getActiveTurn(): ActiveChatTurn | null {
    return this.activeTurn;
  }

  setEventRecorder(recorder: ((event: ChatEvent) => Promise<void> | void) | null): void {
    this.eventRecorder = recorder;
  }

  async flushEventRecorder(): Promise<void> {
    await this.eventRecorderQueue;
  }

  createEventContext(): ChatEventContext {
    return {
      runId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
    };
  }

  eventBase(context: ChatEventContext): ChatEventContext & { createdAt: string } {
    return { ...context, createdAt: new Date().toISOString() };
  }

  beginActiveTurn(context: ChatEventContext, cwd: string): ActiveChatTurn {
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const turn: ActiveChatTurn = {
      context,
      cwd,
      startedAt: Date.now(),
      abortController: new AbortController(),
      finished,
      resolveFinished,
      recentEvents: [],
      recentFailureSignals: [],
      interruptRequested: false,
    };
    this.activeTurn = turn;
    return turn;
  }

  finishActiveTurn(context: ChatEventContext): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.context.runId !== context.runId) return;
    activeTurn.resolveFinished();
    this.activeTurn = null;
    this.timelineActivityItemsByRun.delete(context.runId);
  }

  waitForActiveTurn(turn: ActiveChatTurn, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      turn.finished.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  emitEphemeralAssistantResult(
    input: string,
    output: string,
    success: boolean,
    start: number,
    options: {
      context?: ChatEventContext;
      finishActiveTurn?: boolean;
      operation?: TurnOperation;
      userInput?: UserInput;
    } = {},
  ): {
    success: boolean;
    output: string;
    elapsed_ms: number;
  } {
    const context = options.context
      ?? (options.operation
        ? { runId: options.operation.runId, turnId: options.operation.turnId }
        : this.createEventContext());
    const userInput = options.userInput ?? createTextUserInput(input);
    this.emitEvent({
      type: "lifecycle_start",
      input,
      userInput,
      operation: options.operation ?? createTurnStartOperation({
        context,
        cwd: "",
        userInput,
      }),
      ...this.eventBase(context),
    });
    this.emitEvent({
      type: "assistant_final",
      text: output,
      persisted: false,
      ...this.eventBase(context),
    });
    const elapsed_ms = Date.now() - start;
    this.emitEvent({
      type: "lifecycle_end",
      status: success ? "completed" : "error",
      elapsedMs: elapsed_ms,
      persisted: false,
      ...this.eventBase(context),
    });
    const shouldFinishActiveTurn = options.finishActiveTurn ?? options.operation?.kind !== "TurnSteer";
    if (shouldFinishActiveTurn) {
      this.finishActiveTurn(context);
    }
    return { success, output, elapsed_ms };
  }

  createAgentLoopEventSink(eventContext: ChatEventContext): AgentLoopEventSink {
    return {
      emit: async (event: AgentLoopEvent) => {
        const timelineItem = projectAgentLoopEventToTimeline(event);
        this.emitTimelineSummaryBeforeCompletion(eventContext, timelineItem);
        this.rememberTimelineActivityItem(eventContext, timelineItem);
        this.emitEvent({
          type: "agent_timeline",
          item: timelineItem,
          ...this.eventBase(eventContext),
        });

        if (event.type === "tool_call_started") {
          const detail = event.inputPreview ? previewActivityText(event.inputPreview) : undefined;
          this.emitActivity("tool", formatToolActivity("Running", event.toolName, detail), eventContext, event.callId);
          this.emitEvent({
            type: "tool_start",
            toolCallId: event.callId,
            toolName: event.toolName,
            args: this.parseAgentLoopPreview(event.inputPreview),
            ...(event.activityCategory ? { activityCategory: event.activityCategory } : {}),
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          this.emitEvent({
            type: "tool_update",
            toolCallId: event.callId,
            toolName: event.toolName,
            status: "running",
            message: "started",
            ...(event.activityCategory ? { activityCategory: event.activityCategory } : {}),
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "tool_call_finished") {
          if (!event.success) {
            this.rememberActiveTurnFailureSignal(eventContext, {
              kind: "tool",
              toolName: event.toolName,
              status: event.disposition === "cancelled"
                ? "cancelled"
                : event.disposition === "approval_denied"
                  ? "approval_denied"
                  : "failed",
              ...(event.disposition ? { disposition: event.disposition } : {}),
            });
          }
          this.emitActivity(
            "tool",
            formatToolActivity(event.success ? "Finished" : "Failed", event.toolName, event.outputPreview),
            eventContext,
            event.callId
          );
          this.emitEvent({
            type: "tool_end",
            toolCallId: event.callId,
            toolName: event.toolName,
            success: event.success,
            summary: event.outputPreview,
            durationMs: event.durationMs,
            ...(event.activityCategory ? { activityCategory: event.activityCategory } : {}),
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "assistant_message" && event.phase === "commentary" && event.contentPreview) {
          this.emitActivity("commentary", previewActivityText(event.contentPreview, 120), eventContext, `commentary:${event.eventId}`);
          return;
        }

        if (event.type === "plan_update") {
          this.emitActivity("tool", `Plan changed: ${previewActivityText(event.summary)}`, eventContext, `plan:${event.turnId}`);
          this.emitCheckpoint("Plan updated", previewActivityText(event.summary, 160), eventContext, `plan:${event.eventId}`);
          this.emitEvent({
            type: "tool_update",
            toolCallId: `plan:${event.turnId}:${event.createdAt}`,
            toolName: "update_plan",
            status: "result",
            message: event.summary,
            activityCategory: "planning",
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "approval_request") {
          this.rememberActiveTurnFailureSignal(eventContext, {
            kind: "approval",
            status: "requested",
            toolName: event.toolName,
            permissionLevel: event.permissionLevel,
            isDestructive: event.isDestructive,
          });
          this.emitActivity("tool", formatToolActivity("Running", event.toolName, `awaiting approval: ${event.reason}`), eventContext, event.callId);
          this.emitCheckpoint("Approval requested", `${event.toolName}: ${event.reason}`, eventContext, `approval:${event.callId}`);
          this.emitEvent({
            type: "tool_update",
            toolCallId: event.callId,
            toolName: event.toolName,
            status: "awaiting_approval",
            message: event.reason,
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "approval") {
          this.rememberActiveTurnFailureSignal(eventContext, {
            kind: "approval",
            status: event.status,
            toolName: event.toolName,
          });
          this.emitActivity("tool", formatToolActivity("Finished", event.toolName, `approval ${event.status}: ${event.reason}`), eventContext);
          this.emitEvent({
            type: "tool_update",
            toolCallId: `approval:${event.turnId}:${event.createdAt}`,
            toolName: event.toolName,
            status: "result",
            message: `approval ${event.status}: ${event.reason}`,
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "resumed") {
          this.emitEvent({
            type: "tool_update",
            toolCallId: `resume:${event.turnId}:${event.createdAt}`,
            toolName: "agentloop_resume",
            status: "result",
            message: `resumed ${event.restoredMessages} message(s) from ${event.fromUpdatedAt}`,
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "context_compaction") {
          this.emitEvent({
            type: "tool_update",
            toolCallId: `compaction:${event.turnId}:${event.createdAt}`,
            toolName: "context_compaction",
            status: "result",
            message: `${event.phase} ${event.reason}: ${event.inputMessages} -> ${event.outputMessages}`,
            presentation: { suppressTranscript: true },
            ...this.eventBase(eventContext),
          });
        }

        if (event.type === "stopped") {
          this.rememberActiveTurnFailureSignal(eventContext, {
            kind: "runtime",
            stoppedReason: event.reason,
            operationState: "agent_loop",
          });
        }
      },
    };
  }

  emitEvent(event: ChatEvent): void {
    void this.deliverEvent(event);
  }

  async emitEventAndFlush(event: ChatEvent): Promise<void> {
    await this.deliverEvent(event);
  }

  private async deliverEvent(event: ChatEvent): Promise<void> {
    const safeEvent = redactChatEvent(event);
    this.rememberActiveTurnEvent(safeEvent);
    this.enqueueRecordedEvent(safeEvent);
    try {
      await this.onEventGetter()?.(safeEvent);
    } catch (err) {
      console.warn("[chat] event flush failed", {
        eventType: safeEvent.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private enqueueRecordedEvent(event: ChatEvent): void {
    const recorder = this.eventRecorder;
    if (!recorder) return;
    this.eventRecorderQueue = this.eventRecorderQueue.then(async () => {
      await recorder(event);
    }).catch((err) => {
      console.warn("[chat] event journal persist failed", {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private rememberTimelineActivityItem(eventContext: ChatEventContext, item: AgentTimelineItem): void {
    if (item.kind !== "tool" && item.kind !== "approval") return;
    const existing = this.timelineActivityItemsByRun.get(eventContext.runId) ?? [];
    this.timelineActivityItemsByRun.set(eventContext.runId, [...existing, item]);
  }

  private emitTimelineSummaryBeforeCompletion(eventContext: ChatEventContext, nextItem: AgentTimelineItem): void {
    if (nextItem.kind !== "final" && nextItem.kind !== "stopped") return;
    const items = this.timelineActivityItemsByRun.get(eventContext.runId) ?? [];
    const summary = createAgentTimelineActivitySummary({
      id: `agent-timeline:${eventContext.turnId}:activity-summary:${nextItem.sourceEventId}`,
      sourceEventId: `activity-summary:${nextItem.sourceEventId}`,
      sessionId: nextItem.sessionId,
      traceId: nextItem.traceId,
      turnId: nextItem.turnId,
      goalId: nextItem.goalId,
      ...(nextItem.taskId ? { taskId: nextItem.taskId } : {}),
      createdAt: nextItem.createdAt,
      items,
    });
    if (!summary) return;
    this.timelineActivityItemsByRun.delete(eventContext.runId);
    this.emitOperationProgress(operationProgressFromAgentActivitySummary(summary, eventContext.languageHint), eventContext);
    this.emitEvent({
      type: "agent_timeline",
      item: summary,
      ...this.eventBase(eventContext),
    });
  }

  emitOperationProgress(item: OperationProgressItem, eventContext: ChatEventContext): void {
    this.emitEvent(this.createOperationProgressEvent(item, eventContext));
  }

  async emitOperationProgressAndFlush(item: OperationProgressItem, eventContext: ChatEventContext): Promise<void> {
    await this.emitEventAndFlush(this.createOperationProgressEvent(item, eventContext));
  }

  private createOperationProgressEvent(item: OperationProgressItem, eventContext: ChatEventContext): ChatEvent {
    const safeItem = createOperationProgressItem({
      ...item,
      ...(eventContext.languageHint && !item.languageHint ? { languageHint: eventContext.languageHint } : {}),
    });
    return {
      type: "operation_progress",
      item: safeItem,
      ...this.eventBase(eventContext),
    };
  }

  emitActivity(
    kind: ActivityKind,
    message: string,
    eventContext: ChatEventContext,
    sourceId?: string,
    transient = true
  ): void {
    const safeMessage = redactSetupSecrets(message);
    if (!safeMessage.trim()) return;
    this.emitEvent({
      type: "activity",
      kind,
      message: safeMessage,
      ...(sourceId ? { sourceId } : {}),
      transient,
      ...this.eventBase(eventContext),
    });
  }

  emitIntent(
    input: string,
    selectedRoute: { kind: string; reason?: string; intent?: { kind: string } } | null,
    eventContext: ChatEventContext
  ): void {
    const subject = formatIntentInput(input);
    let nextStep = "continue from the saved chat state before taking further action.";
    let reason = "continuation needs the prior chat context before any further action.";
    if ((selectedRoute?.kind === "runtime_control" || selectedRoute?.kind === "runtime_control_blocked") && selectedRoute.intent) {
      nextStep = `prepare the ${selectedRoute.intent.kind} runtime-control request.`;
      reason = "runtime changes need an explicit operation plan and approval path.";
    } else if (selectedRoute?.kind === "configure") {
      nextStep = "prepare configuration guidance for the requested setup flow.";
      reason = "setup requests should return actionable configuration steps before any tool-backed execution.";
    } else if (selectedRoute?.kind === "assist") {
      nextStep = "answer directly from the current conversation context.";
      reason = "this request can be handled as assistance without continuing saved tool-backed work.";
    } else if (selectedRoute?.kind === "clarify") {
      nextStep = "ask for the missing detail needed to choose the right next action.";
      reason = "the current request is ambiguous and needs clarification before execution.";
    } else if (selectedRoute?.kind === "agent_loop") {
      nextStep = "gather workspace context, then inspect or change files with visible tool activity.";
      reason = "this request may require multiple tool-backed steps.";
    } else if (selectedRoute?.kind === "tool_loop") {
      nextStep = "call the model with the tool catalog, then execute selected tools with visible activity.";
      reason = "the available tools are needed to answer from current project state.";
    } else if (selectedRoute?.kind === "adapter") {
      nextStep = "prepare project context before handing the turn to the configured adapter.";
      reason = "the adapter needs the current workspace context to act correctly.";
    }
    const message = [
      `I understand the request as ${subject || "the current request"}.`,
      `Next I will ${nextStep}`,
      `This is needed because ${reason}`,
    ].join("\n");
    this.emitActivity("commentary", message, eventContext, "intent:first-step", false);
  }

  emitCheckpoint(
    title: string,
    detail: string,
    eventContext: ChatEventContext,
    sourceKey: string
  ): void {
    const message = detail ? `${title}: ${detail}` : title;
    this.emitActivity("checkpoint", message, eventContext, `checkpoint:${sourceKey}`, false);
  }

  emitDiffArtifact(
    artifact: GitDiffArtifact,
    eventContext: ChatEventContext
  ): void {
    const sections = [
      "Changed files",
      "",
      "Modified files",
      artifact.nameStatus || artifact.stat,
      "",
      "Diff summary",
      artifact.stat,
      "",
      "Inline patch",
      "```diff",
      artifact.patch || "(patch unavailable)",
      artifact.truncated ? `... truncated after ${DIFF_ARTIFACT_MAX_LINES} lines; run /review for the full diff.` : "",
      "```",
      "",
      "Files inspected are shown separately in the activity log.",
    ].filter((line) => line !== "").join("\n");
    this.emitActivity("diff", sections, eventContext, "diff:working-tree", false);
  }

  pushAssistantDelta(
    delta: string,
    assistantBuffer: AssistantBuffer,
    eventContext: ChatEventContext
  ): void {
    if (!delta) return;
    const safeDelta = redactSetupSecrets(delta);
    assistantBuffer.text += safeDelta;
    this.emitEvent({
      type: "assistant_delta",
      delta: safeDelta,
      text: assistantBuffer.text,
      ...this.eventBase(eventContext),
    });
  }

  emitLifecycleEndEvent(
    status: "completed" | "error",
    elapsedMs: number,
    eventContext: ChatEventContext,
    persisted: boolean
  ): void {
    this.emitEvent({
      type: "lifecycle_end",
      status,
      elapsedMs,
      persisted,
      ...this.eventBase(eventContext),
    });
    this.finishActiveTurn(eventContext);
  }

  emitLifecycleErrorEvent(
    error: string,
    partialText: string,
    eventContext: ChatEventContext,
    evidence: FailureRecoveryEvidence = {}
  ): string {
    const recovery = classifyFailureRecovery(this.buildFailureRecoveryEvidence(error, eventContext, evidence));
    this.emitEvent({
      type: "lifecycle_error",
      error,
      partialText,
      persisted: false,
      recovery,
      ...this.eventBase(eventContext),
    });
    return formatLifecycleFailureMessage(error, partialText, recovery);
  }

  async emitLifecycleErrorEventWithFallback(
    error: string,
    partialText: string,
    eventContext: ChatEventContext,
    evidence: FailureRecoveryEvidence = {},
    llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">
  ): Promise<string> {
    const recovery = await classifyFailureRecoveryWithFallback(
      this.buildFailureRecoveryEvidence(error, eventContext, evidence),
      llmClient
    );
    this.emitEvent({
      type: "lifecycle_error",
      error,
      partialText,
      persisted: false,
      recovery,
      ...this.eventBase(eventContext),
    });
    return formatLifecycleFailureMessage(error, partialText, recovery);
  }

  private buildFailureRecoveryEvidence(
    error: string,
    eventContext: ChatEventContext,
    evidence: FailureRecoveryEvidence
  ): FailureRecoveryEvidence {
    return {
      ...evidence,
      error,
      signals: [
        ...this.collectActiveTurnFailureSignals(eventContext),
        ...(evidence.signals ?? []),
      ],
    };
  }

  private rememberActiveTurnFailureSignal(eventContext: ChatEventContext, signal: FailureRecoverySignal): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.context.turnId !== eventContext.turnId) return;
    activeTurn.recentFailureSignals = [...activeTurn.recentFailureSignals, signal].slice(-12);
  }

  private collectActiveTurnFailureSignals(eventContext: ChatEventContext): FailureRecoverySignal[] {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.context.turnId !== eventContext.turnId) return [];
    return activeTurn.recentFailureSignals;
  }

  private rememberActiveTurnEvent(event: ChatEvent): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.context.turnId !== event.turnId) return;
    let summary: string | null = null;
    if (event.type === "activity") {
      summary = previewActivityText(event.message, 140);
    } else if (event.type === "tool_start") {
      summary = `Started ${event.toolName}`;
    } else if (event.type === "tool_update") {
      summary = `${event.toolName}: ${previewActivityText(event.message, 100)}`;
    } else if (event.type === "tool_end") {
      summary = `${event.success ? "Finished" : "Failed"} ${event.toolName}: ${previewActivityText(event.summary, 100)}`;
    }
    if (!summary) return;
    activeTurn.recentEvents = [...activeTurn.recentEvents, summary].slice(-12);
  }

  private parseAgentLoopPreview(preview: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(preview) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    return preview ? { preview: redactSetupSecrets(preview) } : {};
  }
}

function redactChatEvent(event: ChatEvent): ChatEvent {
  return redactSetupSecretsDeep(event);
}
