import type { ChatEvent } from "../../interface/chat/chat-events.js";
import type { SeedyTurnPresence } from "../../interface/chat/seedy-turn-presence.js";
import {
  renderGatewayActivityEvent,
  renderGatewayAgentTimelineItem,
  renderGatewayOperationProgress,
  renderGatewayToolProgressEvent,
} from "./chat-event-rendering.js";
import {
  isTerminalSeedyPresence,
  renderSeedyPresenceFallbackAck,
  renderSeedyPresenceStatusText,
} from "./seedy-presence-rendering.js";
import type {
  NonTuiDisplayMessageRef,
  NonTuiDisplayTransport,
} from "./non-tui-display-projector.js";
import type {
  ResolvedGatewayChannelPresenceContract,
  SeedyPresenceCapabilities,
} from "./channel-presence-policy.js";
import type {
  TypingIndicatorCapability,
  TypingIndicatorContext,
  TypingIndicatorSession,
} from "./channel-adapter.js";

export interface SeedyPresenceTransport {
  sendStatus(text: string): Promise<NonTuiDisplayMessageRef>;
  editStatus(ref: NonTuiDisplayMessageRef, text: string): Promise<void>;
  deleteStatus(ref: NonTuiDisplayMessageRef): Promise<void>;
  sendFallbackAck(text: string): Promise<NonTuiDisplayMessageRef>;
}

export interface SeedyPresenceProjectorOptions {
  readonly presence: ResolvedGatewayChannelPresenceContract;
  readonly transport?: SeedyPresenceTransport;
  readonly typingIndicator?: TypingIndicatorCapability;
  readonly typingContext?: TypingIndicatorContext;
  readonly onError?: (error: unknown, operation: SeedyPresenceProjectorOperation) => void;
}

export interface SeedyPresenceEventProjection {
  readonly assistantOutputRendered?: boolean;
  readonly meaningfulProgressRendered?: boolean;
}

export type SeedyPresenceProjectorOperation =
  | "typing_start"
  | "typing_stop"
  | "status_send"
  | "status_edit"
  | "status_delete"
  | "fallback_ack";

export function createSeedyPresenceTransportFromNonTuiDisplay(
  transport: NonTuiDisplayTransport,
): SeedyPresenceTransport {
  return {
    sendStatus: (text) => transport.sendProgress(text),
    editStatus: (ref, text) => transport.editProgress(ref, text),
    deleteStatus: (ref) => transport.deleteProgress(ref),
    sendFallbackAck: (text) => transport.sendProgress(text),
  };
}

export class SeedyPresenceProjector {
  private readonly capabilities: SeedyPresenceCapabilities;
  private readonly transport: SeedyPresenceTransport | undefined;
  private readonly typingIndicator: TypingIndicatorCapability | undefined;
  private readonly typingContext: TypingIndicatorContext | undefined;
  private readonly onError: ((error: unknown, operation: SeedyPresenceProjectorOperation) => void) | undefined;

  private typingSession: TypingIndicatorSession | null = null;
  private typingStartPromise: Promise<void> | null = null;
  private statusRef: NonTuiDisplayMessageRef | null = null;
  private statusSendPromise: Promise<void> | null = null;
  private fallbackAckPromise: Promise<void> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackAckInFlight = false;
  private fallbackAckSent = false;
  private terminal = false;
  private assistantOutputStarted = false;
  private lastStatusText = "";
  private pendingStatusText = "";

  constructor(options: SeedyPresenceProjectorOptions) {
    this.capabilities = options.presence.capabilities;
    this.transport = options.transport;
    this.typingIndicator = options.typingIndicator;
    this.typingContext = options.typingContext;
    this.onError = options.onError;
  }

  async prepareForEvent(event: ChatEvent): Promise<void> {
    if (this.terminal) return;
    if (!this.shouldUseNativeTypingForEvent(event)) return;
    await this.ensureNativePresence();
  }

  async handle(event: ChatEvent, projection: SeedyPresenceEventProjection = {}): Promise<void> {
    switch (event.type) {
      case "presence_update":
        await this.update(event.presence);
        return;
      case "assistant_delta":
        await this.handleAssistantDelta(projection);
        return;
      case "assistant_final":
        await this.finish("final");
        return;
      case "lifecycle_error":
        await this.finish("error");
        return;
      case "lifecycle_end":
        await this.finish(event.status === "completed" ? "complete" : "error");
        return;
      case "operation_progress":
      case "activity":
      case "agent_timeline":
      case "tool_start":
      case "tool_update":
      case "tool_end":
        if (this.shouldCancelFallbackForProgress(event, projection)) this.cancelFallbackTimer();
        if (this.shouldCancelPendingStatusForProgress(event, projection)) this.cancelStatusTimer();
        if (isMeaningfulProgressEvent(event) && !this.assistantOutputStarted) {
          await this.stopNativePresence();
        }
        return;
      case "lifecycle_start":
      case "turn_steer":
        return;
    }
  }

  async update(presence: SeedyTurnPresence): Promise<void> {
    if (presence.audience !== "user") return;

    if (isTerminalSeedyPresence(presence)) {
      await this.finish("complete");
      return;
    }

    if (this.terminal) return;

    this.ensureFallbackTimer(presence);
    await this.upsertEditableStatus(presence);
  }

  async stop(): Promise<void> {
    await this.finish("stopped");
  }

  async cancel(): Promise<void> {
    await this.finish("stopped");
  }

  get hasSentFallbackAck(): boolean {
    return this.fallbackAckSent;
  }

  private async ensureNativePresence(): Promise<void> {
    if (!this.capabilities.canShowNativeEphemeral) return;
    if (!this.typingIndicator || !this.typingContext || this.typingSession !== null) return;
    if (this.typingIndicator.status !== "native") return;
    if (this.typingStartPromise !== null) {
      await this.typingStartPromise;
      return;
    }

    this.typingStartPromise = this.safe("typing_start", async () => {
      this.typingSession = await this.typingIndicator!.start(this.typingContext!);
    }).then(() => undefined).finally(() => {
      this.typingStartPromise = null;
    });
    await this.typingStartPromise;
  }

  private ensureFallbackTimer(presence: SeedyTurnPresence): void {
    if (!this.shouldUseFallbackAck()) return;
    if (this.fallbackAckSent || this.fallbackAckInFlight || this.fallbackTimer !== null || this.terminal) return;
    const delayMs = this.capabilities.fallbackAckDelayMs;
    if (delayMs <= 0) return;

    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      void this.sendFallbackAck(presence);
    }, delayMs);
    this.fallbackTimer.unref?.();
  }

  private shouldUseFallbackAck(): boolean {
    return this.capabilities.canSendFallbackAck
      && !this.capabilities.canShowNativeEphemeral
      && !this.capabilities.canEditStatus;
  }

  private async sendFallbackAck(presence: SeedyTurnPresence): Promise<void> {
    if (this.terminal || this.fallbackAckSent || this.fallbackAckInFlight || !this.transport) return;
    const text = renderSeedyPresenceFallbackAck(presence, {
      maxChars: this.capabilities.maxStatusChars,
    });
    if (!text) return;

    this.fallbackAckInFlight = true;
    this.fallbackAckPromise = this.safe("fallback_ack", async () => {
      await this.transport!.sendFallbackAck(text);
      this.fallbackAckSent = true;
    }).then(() => undefined).finally(() => {
      this.fallbackAckInFlight = false;
      this.fallbackAckPromise = null;
    });
    await this.fallbackAckPromise;
  }

  private async upsertEditableStatus(presence: SeedyTurnPresence): Promise<void> {
    if (!this.shouldProjectEditableStatus(presence) || !this.transport) return;

    const text = renderSeedyPresenceStatusText(presence, {
      maxChars: this.capabilities.maxStatusChars,
    });
    if (!text || text === this.lastStatusText) return;

    if (this.statusRef === null) {
      await this.queueInitialEditableStatus(text);
      return;
    }

    if (this.statusSendPromise !== null) {
      await this.statusSendPromise;
      if (this.statusRef === null || text === this.lastStatusText) return;
    }

    await this.withNativeOutputPresence("status_edit", async () => {
      await this.transport!.editStatus(this.statusRef!, text);
      this.lastStatusText = text;
    });
  }

  private async queueInitialEditableStatus(text: string): Promise<void> {
    if (this.statusSendPromise !== null) {
      await this.sendInitialEditableStatus(text);
      return;
    }

    const delayMs = this.capabilities.meaningfulStatusDelayMs;
    if (delayMs <= 0) {
      await this.sendInitialEditableStatus(text);
      return;
    }

    this.pendingStatusText = text;
    if (this.statusTimer !== null) return;

    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      const pendingText = this.pendingStatusText;
      this.pendingStatusText = "";
      if (!pendingText || this.terminal || this.statusRef !== null) return;
      void this.sendInitialEditableStatus(pendingText);
    }, delayMs);
    this.statusTimer.unref?.();
  }

  private async sendInitialEditableStatus(text: string): Promise<void> {
    this.cancelStatusTimer();
    if (this.statusSendPromise !== null) {
      await this.statusSendPromise;
      if (this.statusRef === null || text === this.lastStatusText) return;
      await this.withNativeOutputPresence("status_edit", async () => {
        await this.transport!.editStatus(this.statusRef!, text);
        this.lastStatusText = text;
      });
      return;
    }

    this.statusSendPromise = this.withNativeOutputPresence("status_send", async () => {
      this.statusRef = await this.transport!.sendStatus(text);
      this.lastStatusText = text;
    }).then(() => undefined).finally(() => {
      this.statusSendPromise = null;
    });
    await this.statusSendPromise;
  }

  private shouldProjectEditableStatus(presence: SeedyTurnPresence): boolean {
    if (!this.capabilities.canEditStatus) return false;
    if (this.capabilities.surfaceKind === "editable_status") return true;
    if (!this.capabilities.canShowNativeEphemeral) return true;
    return presence.phase === "waiting"
      || presence.phase === "blocked"
      || presence.importance === "action_required"
      || presence.importance === "blocked";
  }

  private async handleAssistantDelta(projection: SeedyPresenceEventProjection): Promise<void> {
    if (this.shouldUseFallbackAck() && projection.assistantOutputRendered !== true) return;
    this.cancelFallbackTimer();
    this.cancelStatusTimer();
    if (projection.assistantOutputRendered !== true) return;
    this.assistantOutputStarted = true;
    await this.ensureNativePresence();
    await this.cleanupEditableStatus("final");
  }

  private async finish(reason: "final" | "complete" | "error" | "stopped"): Promise<void> {
    if (
      this.terminal
      && this.typingSession === null
      && this.statusRef === null
      && this.fallbackAckPromise === null
    ) return;
    this.terminal = true;
    this.cancelFallbackTimer();
    this.cancelStatusTimer();
    await this.waitForPendingTransportStarts();
    await this.stopNativePresence();
    await this.cleanupEditableStatus(reason);
  }

  private async waitForPendingTransportStarts(): Promise<void> {
    await this.typingStartPromise;
    await this.statusSendPromise;
    await this.fallbackAckPromise;
  }

  private cancelFallbackTimer(): void {
    if (this.fallbackTimer === null) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private cancelStatusTimer(): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.pendingStatusText = "";
  }

  private async stopNativePresence(): Promise<void> {
    const session = this.typingSession;
    this.typingSession = null;
    if (session === null) return;
    await this.safe("typing_stop", async () => {
      await session.stop();
    });
  }

  private async cleanupEditableStatus(reason: "final" | "complete" | "error" | "stopped"): Promise<void> {
    if (this.statusRef === null || !this.transport) return;

    const ref = this.statusRef;

    if (this.capabilities.canDeleteStatus) {
      const cleaned = await this.safe("status_delete", async () => {
        await this.transport!.deleteStatus(ref);
      });
      if (cleaned) this.clearEditableStatusRef();
      return;
    }

    if (!this.capabilities.canEditStatus) return;
    const text = cleanupStatusText(reason, this.capabilities.maxStatusChars);
    const cleaned = await this.safe("status_edit", async () => {
      await this.transport!.editStatus(ref, text);
    });
    if (cleaned) this.clearEditableStatusRef();
  }

  private clearEditableStatusRef(): void {
    this.statusRef = null;
    this.lastStatusText = "";
  }

  private async safe(operation: SeedyPresenceProjectorOperation, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      this.onError?.(error, operation);
      return false;
    }
  }

  private async withNativeOutputPresence(
    operation: SeedyPresenceProjectorOperation,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    await this.ensureNativePresence();
    const ok = await this.safe(operation, fn);
    if (!this.assistantOutputStarted) {
      await this.stopNativePresence();
    }
    return ok;
  }

  private shouldUseNativeTypingForEvent(event: ChatEvent): boolean {
    if (!this.capabilities.canShowNativeEphemeral) return false;
    switch (event.type) {
      case "assistant_delta":
      case "assistant_final":
        return false;
      case "lifecycle_error":
        return true;
      case "operation_progress":
      case "activity":
      case "agent_timeline":
      case "tool_start":
      case "tool_update":
      case "tool_end":
        return isMeaningfulProgressEvent(event);
      case "presence_update":
        return false;
      case "lifecycle_start":
      case "turn_steer":
      case "lifecycle_end":
        return false;
    }
  }

  private shouldCancelFallbackForProgress(
    event: Extract<ChatEvent, {
      type:
        | "operation_progress"
        | "activity"
        | "agent_timeline"
        | "tool_start"
        | "tool_update"
        | "tool_end";
    }>,
    projection: SeedyPresenceEventProjection,
  ): boolean {
    if (!isMeaningfulProgressEvent(event)) return false;
    if (!this.shouldUseFallbackAck()) return true;
    return projection.meaningfulProgressRendered === true;
  }

  private shouldCancelPendingStatusForProgress(
    event: Extract<ChatEvent, {
      type:
        | "operation_progress"
        | "activity"
        | "agent_timeline"
        | "tool_start"
        | "tool_update"
        | "tool_end";
    }>,
    projection: SeedyPresenceEventProjection,
  ): boolean {
    if (this.statusTimer === null) return false;
    if (!isMeaningfulProgressEvent(event)) return false;
    return projection.meaningfulProgressRendered === true;
  }

}

function cleanupStatusText(
  reason: "final" | "complete" | "error" | "stopped",
  maxChars: number | undefined,
): string {
  const text = reason === "error" || reason === "stopped" ? "Stopped." : "Done.";
  if (maxChars === undefined || text.length <= maxChars) return text;
  return text.slice(0, Math.max(maxChars, 0));
}

function isMeaningfulProgressEvent(
  event: Extract<ChatEvent, {
    type:
      | "operation_progress"
      | "activity"
      | "agent_timeline"
      | "tool_start"
      | "tool_update"
      | "tool_end";
  }>,
): boolean {
  switch (event.type) {
    case "operation_progress":
      return renderGatewayOperationProgress(event.item) !== null;
    case "activity":
      return renderGatewayActivityEvent(event) !== null;
    case "agent_timeline":
      return event.item.visibility === "user" && renderGatewayAgentTimelineItem(event.item) !== null;
    case "tool_start":
    case "tool_update":
    case "tool_end":
      if (event.presentation?.suppressTranscript) return false;
      return renderGatewayToolProgressEvent(event) !== null;
  }
}
