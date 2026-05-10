import type { ChatEvent } from "../../interface/chat/chat-events.js";
import {
  formatGatewayLifecycleFailureMessage,
  renderGatewayActivityEvent,
  renderGatewayAgentTimelineItem,
  renderGatewayOperationProgress,
  renderGatewayToolProgressEvent,
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

interface ProgressOptions {
  readonly forceSingleStatus?: boolean;
}

const MIN_FINAL_EDIT_INTERVAL_MS = 250;
const FINAL_EDIT_CATCH_UP_CHARS = 240;

export class NonTuiDisplayProjector {
  private readonly policy: GatewayDisplayPolicy;
  private readonly transport: NonTuiDisplayTransport;
  private readonly maxMessageLength: number | undefined;
  private progressRef: NonTuiDisplayMessageRef | null = null;
  private finalRef: NonTuiDisplayMessageRef | null = null;
  private lastProgressText = "";
  private lastFinalText = "";
  private lastFinalEditAt = 0;
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
        {
          const text = renderGatewayToolProgressEvent(event);
          if (!text) return;
          await this.upsertProgress(`tool:${event.toolCallId}`, text);
        }
        return;
      case "tool_update":
        if (event.presentation?.suppressTranscript || this.policy.toolProgress === "off") return;
        {
          const text = renderGatewayToolProgressEvent(event);
          if (!text) return;
          await this.upsertProgress(`tool:${event.toolCallId}`, text, {
            forceSingleStatus: event.status === "awaiting_approval",
          });
        }
        return;
      case "tool_end":
        if (event.presentation?.suppressTranscript || this.policy.toolProgress === "off") return;
        {
          const text = renderGatewayToolProgressEvent(event);
          if (!text) return;
          await this.upsertProgress(`tool:${event.toolCallId}`, text);
        }
        return;
      case "activity": {
        const text = renderGatewayActivityEvent(event);
        if (!text) return;
        await this.upsertProgress(
          event.sourceId ? `activity:${event.sourceId}` : `activity:${event.kind}`,
          text,
          { forceSingleStatus: isActionRequiredActivityEvent(event) },
        );
        return;
      }
      case "operation_progress":
        {
          const text = renderGatewayOperationProgress(event.item);
          if (!text) return;
          await this.upsertProgress(`operation:${event.item.id}`, text, {
            forceSingleStatus: isActionRequiredOperationProgress(event.item),
          });
        }
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
            { forceSingleStatus: isActionRequiredTimelineItem(event.item) },
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

  get deliveredAssistantOutput(): boolean {
    return this.finalRef !== null;
  }

  get deliveredProgressOutput(): boolean {
    return this.progressRef !== null;
  }

  private async upsertProgress(id: string, text: string, options: ProgressOptions = {}): Promise<void> {
    if (this.policy.progressSurface === "off") return;
    const normalized = text.trim();
    if (!normalized) return;

    this.progressEntries.set(id, { id, text: normalized });
    const rendered = this.renderProgress();
    if (rendered === this.lastProgressText) return;

    if (
      this.policy.progressSurface === "single_status" &&
      this.progressRef !== null &&
      !options.forceSingleStatus
    ) {
      return;
    }

    if (this.progressRef === null || this.policy.progressSurface === "single_status") {
      this.progressRef = await this.transport.sendProgress(rendered);
    } else {
      await this.transport.editProgress(this.progressRef, rendered);
    }
    this.lastProgressText = rendered;
  }

  private renderProgress(): string {
    const entries = Array.from(this.progressEntries.values()).slice(-this.policy.progressMaxItems);
    const rendered = entries.length === 1
      ? entries[0]!.text
      : entries.map((entry) => `- ${entry.text}`).join("\n");
    if (rendered.length <= this.policy.progressMaxChars) return rendered;
    return rendered.slice(0, this.policy.progressMaxChars - 1).trimEnd();
  }

  private async updateFinal(text: string, complete: boolean): Promise<void> {
    const nextText = text || this.finalText;
    if (!nextText) return;
    this.finalText = nextText;
    const nextDisplayText = complete ? nextText : stableAssistantDisplayText(nextText);
    if (!nextDisplayText || nextDisplayText === this.lastFinalText) return;

    if (this.policy.finalSurface === "edit_stream") {
      if (!complete && !this.shouldCommitPartialFinal(nextDisplayText)) return;
      if (this.finalRef === null) {
        this.finalRef = await this.transport.sendFinal(nextDisplayText);
      } else {
        await this.transport.editFinal(this.finalRef, nextDisplayText);
      }
      this.lastFinalText = nextDisplayText;
      this.lastFinalEditAt = Date.now();
      return;
    }

    if (!complete) return;

    if (this.policy.finalSurface === "send_once") {
      if (this.finalRef === null) {
        this.finalRef = await this.transport.sendFinal(nextDisplayText);
        this.lastFinalText = nextDisplayText;
      }
      return;
    }

    if (this.finalRef === null) {
      const chunks = this.chunkFinal(nextDisplayText);
      for (const chunk of chunks) {
        this.finalRef = await this.transport.sendFinal(chunk);
      }
      this.lastFinalText = nextDisplayText;
    }
  }

  private shouldCommitPartialFinal(nextText: string): boolean {
    if (this.finalRef === null) return true;
    if (nextText.length - this.lastFinalText.length >= FINAL_EDIT_CATCH_UP_CHARS) return true;
    return Date.now() - this.lastFinalEditAt >= MIN_FINAL_EDIT_INTERVAL_MS;
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

function isActionRequiredOperationProgress(
  item: Extract<ChatEvent, { type: "operation_progress" }>["item"],
): boolean {
  return item.kind === "awaiting_approval" ||
    item.kind === "blocked" ||
    item.publicProgress?.importance === "action_required" ||
    item.publicProgress?.importance === "blocked";
}

function isActionRequiredActivityEvent(
  event: Extract<ChatEvent, { type: "activity" }>,
): boolean {
  return event.presentation?.gatewayNarration?.importance === "action_required" ||
    event.presentation?.gatewayNarration?.importance === "blocked";
}

function isActionRequiredTimelineItem(
  item: Extract<ChatEvent, { type: "agent_timeline" }>["item"],
): boolean {
  if (item.kind === "approval") return true;
  if (item.kind === "tool_observation") return item.state === "denied" || item.state === "blocked";
  return item.kind === "stopped" && item.reason !== "completed";
}

function stableAssistantDisplayText(text: string): string {
  const normalized = text.trimEnd();
  if (!normalized) return "";

  const fenceSafeText = trimUnclosedCodeFence(normalized);
  if (!fenceSafeText) return "";
  if (hasCompleteTrailingCodeFence(fenceSafeText)) return fenceSafeText;

  const newlineIndex = Math.max(fenceSafeText.lastIndexOf("\n\n"), fenceSafeText.lastIndexOf("\n"));
  if (newlineIndex >= 0) {
    return fenceSafeText.slice(0, newlineIndex + 1).trimEnd();
  }

  const sentenceBoundary = findLastSentenceBoundary(fenceSafeText);
  if (sentenceBoundary >= 0) {
    return fenceSafeText.slice(0, sentenceBoundary + 1).trimEnd();
  }

  return "";
}

function trimUnclosedCodeFence(text: string): string {
  const fenceMatches = Array.from(text.matchAll(/```/g));
  if (fenceMatches.length % 2 === 0) return text;
  const openFence = fenceMatches.at(-1)?.index;
  return openFence === undefined ? text : text.slice(0, openFence).trimEnd();
}

function hasCompleteTrailingCodeFence(text: string): boolean {
  const fenceMatches = Array.from(text.matchAll(/```/g));
  return fenceMatches.length > 0 && fenceMatches.length % 2 === 0 && text.endsWith("```");
}

function findLastSentenceBoundary(text: string): number {
  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?" && char !== "。" && char !== "！" && char !== "？") continue;
    const next = text[index + 1];
    if (next === undefined || /\s/.test(next)) return index;
  }
  return -1;
}
