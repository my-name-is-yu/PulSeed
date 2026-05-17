import type { ChatEvent } from "../../interface/chat/chat-events.js";
import {
  SurfaceDeliveryProjectionSchema,
  renderSurfaceDeliveryProjection,
} from "../attention/index.js";
import {
  formatGatewayLifecycleFailureMessage,
  redactSetupSecrets,
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
import {
  admitGatewayChannelActionCapabilityRecord,
  type GatewayCapabilityDecisionRecorder,
} from "./gateway-channel-capability-admission.js";

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
  readonly channelType?: string;
  readonly capabilityDecisionRecorder?: GatewayCapabilityDecisionRecorder;
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
  private readonly channelType: string;
  private readonly maxMessageLength: number | undefined;
  private progressRef: NonTuiDisplayMessageRef | null = null;
  private finalRef: NonTuiDisplayMessageRef | null = null;
  private lastProgressText = "";
  private lastFinalText = "";
  private lastFinalEditAt = 0;
  private finalText = "";
  private sawFinalSignal = false;
  private readonly capabilityDecisionRecorder: GatewayCapabilityDecisionRecorder | undefined;
  private readonly progressEntries = new Map<string, ProgressEntry>();

  constructor(options: NonTuiDisplayProjectorOptions) {
    this.policy = options.display.policy;
    this.transport = options.transport;
    this.channelType = options.channelType ?? "non_tui";
    this.maxMessageLength = options.display.capabilities.maxMessageLength;
    this.capabilityDecisionRecorder = options.capabilityDecisionRecorder;
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
      case "surface_delivery":
        {
          this.sawFinalSignal = true;
          const projection = SurfaceDeliveryProjectionSchema.parse(event.projection);
          const text = renderSurfaceDeliveryProjection(projection);
          if (!text) return;
          await this.updateFinal(redactSetupSecrets(text), true);
        }
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
      case "user_feedback":
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
    if (this.finalRef !== null) return;
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
      await this.admitGatewayDisplayAction("progress_send", {
        reportId: id,
        textLength: rendered.length,
      });
      this.progressRef = await this.transport.sendProgress(rendered);
    } else {
      await this.admitGatewayDisplayAction("progress_edit", {
        reportId: this.progressRef.id,
        textLength: rendered.length,
      });
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
    const nextDisplayText = nextText;
    if (!nextDisplayText || nextDisplayText === this.lastFinalText) return;

    if (this.policy.finalSurface === "edit_stream") {
      if (!complete && !this.shouldCommitPartialFinal(nextDisplayText)) return;
      if (this.finalRef === null) {
        await this.cleanupProgressBeforeFirstFinal();
        await this.admitGatewayDisplayAction("final_send", {
          reportId: "assistant_final",
          textLength: nextDisplayText.length,
        });
        this.finalRef = await this.transport.sendFinal(nextDisplayText);
      } else {
        await this.admitGatewayDisplayAction("final_edit", {
          reportId: this.finalRef.id,
          textLength: nextDisplayText.length,
        });
        await this.transport.editFinal(this.finalRef, nextDisplayText);
      }
      this.lastFinalText = nextDisplayText;
      this.lastFinalEditAt = Date.now();
      return;
    }

    if (!complete) return;

    if (this.policy.finalSurface === "send_once") {
      if (this.finalRef === null) {
        await this.cleanupProgressBeforeFirstFinal();
        await this.admitGatewayDisplayAction("final_send", {
          reportId: "assistant_final",
          textLength: nextDisplayText.length,
        });
        this.finalRef = await this.transport.sendFinal(nextDisplayText);
        this.lastFinalText = nextDisplayText;
      }
      return;
    }

    if (this.finalRef === null) {
      await this.cleanupProgressBeforeFirstFinal();
      const chunks = this.chunkFinal(nextDisplayText);
      for (const chunk of chunks) {
        await this.admitGatewayDisplayAction("final_chunk_send", {
          reportId: "assistant_final_chunk",
          textLength: chunk.length,
        });
        this.finalRef = await this.transport.sendFinal(chunk);
      }
      this.lastFinalText = nextDisplayText;
    }
  }

  private async cleanupProgressBeforeFirstFinal(): Promise<void> {
    try {
      await this.cleanupProgress();
    } catch {
      // Final delivery must not depend on best-effort status cleanup.
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
    let remaining = text;
    while (remaining.length > limit) {
      const chunk = splitMarkdownChunk(remaining, limit);
      chunks.push(chunk.text);
      remaining = chunk.remaining;
      if (!remaining) break;
    }
    if (remaining) {
      chunks.push(remaining);
    }
    return chunks;
  }

  private async cleanupProgress(): Promise<void> {
    if (this.progressRef === null) return;
    if (this.finalRef !== null) return;
    if (this.policy.cleanupPolicy === "delete") {
      await this.admitGatewayDisplayAction("progress_delete", {
        reportId: this.progressRef.id,
        textLength: 0,
      });
      await this.transport.deleteProgress(this.progressRef);
      this.progressRef = null;
      this.lastProgressText = "";
      return;
    }
    if (this.policy.cleanupPolicy === "collapse") return;
  }

  private async admitGatewayDisplayAction(
    reportType: string,
    input: { reportId: string; textLength: number },
  ): Promise<void> {
    const record = admitGatewayChannelActionCapabilityRecord({
      channelType: this.channelType,
      reportType,
      routeRef: `gateway_channel:${this.channelType}`,
      reportId: input.reportId,
      textLength: input.textLength,
      callId: `gateway-display:${this.channelType}:${reportType}:${input.reportId}`,
    });
    await this.capabilityDecisionRecorder?.(record);
  }
}

function splitMarkdownChunk(text: string, limit: number): { text: string; remaining: string } {
  const breakIndex = findMarkdownBreakIndex(text, limit);
  const rawHead = text.slice(0, breakIndex);
  const head = rawHead.trimEnd() || text.slice(0, Math.max(1, limit));
  const tailStart = head === rawHead.trimEnd() ? breakIndex : head.length;
  const tail = text.slice(tailStart).replace(/^\s+/, "");
  const openFence = detectOpenFence(head);
  if (!openFence) {
    return { text: head, remaining: tail };
  }
  const closeLine = openFence.marker;
  const reopenLine = openFence.info ? `${openFence.marker}${openFence.info}` : openFence.marker;
  const reserved = closeLine.length + reopenLine.length + 2;
  const forcedIndex = Math.max(1, Math.min(breakIndex, limit - reserved));
  const forcedHead = text.slice(0, forcedIndex).trimEnd();
  return {
    text: `${forcedHead}\n${closeLine}`,
    remaining: `${reopenLine}\n${text.slice(forcedIndex).replace(/^\n+/, "")}`,
  };
}

function findMarkdownBreakIndex(text: string, limit: number): number {
  const bounded = text.slice(0, limit);
  const candidates = [
    ...findCandidateBreaks(bounded, "\n\n", 2),
    ...findCandidateBreaks(bounded, "\n", 1),
    ...findSentenceBreaks(bounded),
    ...findCandidateBreaks(bounded, " ", 1),
  ].filter((index) => index > 0 && index <= limit);
  for (const index of candidates.sort((left, right) => right - left)) {
    if (!detectOpenFence(text.slice(0, index))) return index;
  }
  return Math.max(1, limit);
}

function findCandidateBreaks(text: string, needle: string, skip: number): number[] {
  const breaks: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    breaks.push(index + skip);
    index = text.indexOf(needle, index + skip);
  }
  return breaks;
}

function findSentenceBreaks(text: string): number[] {
  const breaks: number[] = [];
  for (const match of text.matchAll(/[.!?。！？](?=\s|$)/g)) {
    breaks.push((match.index ?? 0) + 1);
  }
  return breaks;
}

function detectOpenFence(text: string): { marker: string; info: string } | null {
  let open: { marker: string; info: string } | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^(```+|~~~+)(.*)$/);
    if (!match) continue;
    const marker = match[1]!;
    if (!open) {
      open = { marker: marker.startsWith("~") ? "~~~" : "```", info: (match[2] ?? "").trim() };
      continue;
    }
    if (marker.startsWith(open.marker[0]!)) {
      open = null;
    }
  }
  return open;
}

export function createNonTuiDisplayProjector(
  options: Omit<NonTuiDisplayProjectorOptions, "display"> & {
    readonly display?: ResolvedGatewayChannelDisplayContract;
  },
): NonTuiDisplayProjector {
  return new NonTuiDisplayProjector({
    transport: options.transport,
    display: options.display ?? resolveGatewayChannelDisplayContract(undefined),
    channelType: options.channelType,
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
