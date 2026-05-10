import type { ChatEvent } from "../../interface/chat/chat-events.js";
import {
  formatGatewayLifecycleFailureMessage,
  renderGatewayActivityEvent,
  renderGatewayAgentTimelineItem,
  renderGatewayOperationProgress,
} from "./chat-event-rendering.js";
import {
  type GatewayDisplayPolicy,
  type ResolvedGatewayChannelDisplayContract,
  resolveGatewayChannelDisplayContract,
} from "./channel-display-policy.js";

export interface NonTuiDisplayMessageRef {
  readonly id: string;
}

export interface NonTuiDisplayTransport {
  sendProgress(text: string): Promise<NonTuiDisplayMessageRef>;
  editProgress(ref: NonTuiDisplayMessageRef, text: string): Promise<void>;
  deleteProgress(ref: NonTuiDisplayMessageRef): Promise<void>;
  sendFinal(text: string): Promise<NonTuiDisplayMessageRef>;
  editFinal(ref: NonTuiDisplayMessageRef, text: string): Promise<void>;
}

export interface NonTuiDisplayProjectorOptions {
  readonly display: ResolvedGatewayChannelDisplayContract;
  readonly transport: NonTuiDisplayTransport;
}

interface ProgressEntry {
  readonly id: string;
  readonly text: string;
}

export class NonTuiDisplayProjector {
  private readonly policy: GatewayDisplayPolicy;
  private readonly transport: NonTuiDisplayTransport;
  private readonly maxMessageLength: number | undefined;
  private progressRef: NonTuiDisplayMessageRef | null = null;
  private finalRef: NonTuiDisplayMessageRef | null = null;
  private lastProgressText = "";
  private lastFinalText = "";
  private finalText = "";
  private sawFinalSignal = false;
  private readonly progressEntries = new Map<string, ProgressEntry>();

  constructor(options: NonTuiDisplayProjectorOptions) {
    this.policy = options.display.policy;
    this.transport = options.transport;
    this.maxMessageLength = options.display.capabilities.maxMessageLength;
  }

  async handle(event: ChatEvent): Promise<void> {
    switch (event.type) {
      case "tool_start":
        if (event.presentation?.suppressTranscript || this.policy.toolProgress === "off") return;
        await this.upsertProgress(`tool:${event.toolCallId}`, `Started ${event.toolName}.`);
        return;
      case "tool_update":
        if (event.presentation?.suppressTranscript || this.policy.toolProgress === "off") return;
        await this.upsertProgress(`tool:${event.toolCallId}`, `${event.toolName}: ${event.message}`);
        return;
      case "tool_end":
        if (event.presentation?.suppressTranscript || this.policy.toolProgress === "off") return;
        await this.upsertProgress(
          `tool:${event.toolCallId}`,
          `${event.success ? "Finished" : "Failed"} ${event.toolName}: ${event.summary}`,
        );
        return;
      case "activity": {
        const text = renderGatewayActivityEvent(event);
        if (!text) return;
        await this.upsertProgress(
          event.sourceId ? `activity:${event.sourceId}` : `activity:${event.kind}`,
          text,
        );
        return;
      }
      case "operation_progress":
        await this.upsertProgress(`operation:${event.item.id}`, renderGatewayOperationProgress(event.item));
        return;
      case "agent_timeline":
        if (event.item.visibility !== "user") return;
        if (event.item.kind === "final") {
          this.sawFinalSignal = true;
          return;
        }
        {
          const text = renderGatewayAgentTimelineItem(event.item);
          if (!text) return;
          await this.upsertProgress(
            `timeline:${event.item.sourceEventId}`,
            text,
          );
        }
        return;
      case "assistant_delta":
        await this.updateFinal(event.text, false);
        return;
      case "assistant_final":
        this.sawFinalSignal = true;
        await this.updateFinal(event.text, true);
        return;
      case "lifecycle_error":
        await this.updateFinal(formatGatewayLifecycleFailureMessage(event.error, event.partialText, event.recovery), true);
        return;
      case "lifecycle_end":
        if (event.status === "completed") {
          await this.cleanupProgress();
        }
        return;
      case "lifecycle_start":
      case "turn_steer":
        return;
    }
  }

  get renderedAssistantOutput(): boolean {
    return this.sawFinalSignal || this.finalRef !== null || this.finalText.trim().length > 0;
  }

  private async upsertProgress(id: string, text: string): Promise<void> {
    if (this.policy.progressSurface === "off") return;
    const normalized = text.trim();
    if (!normalized) return;

    this.progressEntries.set(id, { id, text: normalized });
    const rendered = this.renderProgress();
    if (rendered === this.lastProgressText) return;

    if (this.progressRef === null || this.policy.progressSurface === "single_status") {
      this.progressRef = await this.transport.sendProgress(rendered);
    } else {
      await this.transport.editProgress(this.progressRef, rendered);
    }
    this.lastProgressText = rendered;
  }

  private renderProgress(): string {
    const entries = Array.from(this.progressEntries.values()).slice(-this.policy.progressMaxItems);
    const lines = entries.map((entry) => `- ${entry.text}`);
    const rendered = lines.join("\n");
    if (rendered.length <= this.policy.progressMaxChars) return rendered;
    return rendered.slice(0, this.policy.progressMaxChars - 1).trimEnd();
  }

  private async updateFinal(text: string, complete: boolean): Promise<void> {
    const nextText = text || this.finalText;
    if (!nextText || nextText === this.lastFinalText) return;
    this.finalText = nextText;

    if (this.policy.finalSurface === "edit_stream") {
      if (this.finalRef === null) {
        this.finalRef = await this.transport.sendFinal(nextText);
      } else {
        await this.transport.editFinal(this.finalRef, nextText);
      }
      this.lastFinalText = nextText;
      return;
    }

    if (!complete) return;

    if (this.policy.finalSurface === "send_once") {
      if (this.finalRef === null) {
        this.finalRef = await this.transport.sendFinal(nextText);
        this.lastFinalText = nextText;
      }
      return;
    }

    if (this.finalRef === null) {
      const chunks = this.chunkFinal(nextText);
      for (const chunk of chunks) {
        this.finalRef = await this.transport.sendFinal(chunk);
      }
      this.lastFinalText = nextText;
    }
  }

  private chunkFinal(text: string): string[] {
    const limit = this.maxMessageLength;
    if (!limit || text.length <= limit) return [text];
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += limit) {
      chunks.push(text.slice(index, index + limit));
    }
    return chunks;
  }

  private async cleanupProgress(): Promise<void> {
    if (this.progressRef === null) return;
    if (this.policy.cleanupPolicy === "delete") {
      await this.transport.deleteProgress(this.progressRef);
      this.progressRef = null;
      this.lastProgressText = "";
      return;
    }
    if (this.policy.cleanupPolicy === "collapse") {
      const collapsed = "Completed.";
      if (collapsed !== this.lastProgressText) {
        await this.transport.editProgress(this.progressRef, collapsed);
        this.lastProgressText = collapsed;
      }
    }
  }
}

export function createNonTuiDisplayProjector(
  options: Omit<NonTuiDisplayProjectorOptions, "display"> & {
    readonly display?: ResolvedGatewayChannelDisplayContract;
  },
): NonTuiDisplayProjector {
  return new NonTuiDisplayProjector({
    transport: options.transport,
    display: options.display ?? resolveGatewayChannelDisplayContract(undefined),
  });
}
