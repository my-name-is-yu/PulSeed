import type { TelegramAPI } from "./telegram-api.js";
import {
  NonTuiDisplayProjector,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  createGatewayDisplayPolicy,
  type ChatEvent,
  type NonTuiDisplayMessageRef,
  type NonTuiDisplayTransport,
} from "pulseed";

export class TelegramChatEventAdapter {
  private readonly api: TelegramAPI;
  private readonly chatId: number;
  private readonly projector: NonTuiDisplayProjector;

  constructor(api: TelegramAPI, chatId: number) {
    this.api = api;
    this.chatId = chatId;
    this.projector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "collapse",
        },
      },
      transport: new TelegramPluginDisplayTransport(api, chatId),
    });
  }

  get renderedAssistantOutput(): boolean {
    return this.projector.renderedAssistantOutput;
  }

  async handle(event: ChatEvent): Promise<void> {
    await this.projector.handle(event);
  }

  async sendFinalFallback(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.projector.handle({
      type: "assistant_final",
      runId: "fallback",
      turnId: "fallback",
      createdAt: new Date().toISOString(),
      text,
      persisted: false,
    });
  }
}

class TelegramPluginDisplayTransport implements NonTuiDisplayTransport {
  constructor(
    private readonly api: TelegramAPI,
    private readonly chatId: number,
  ) {}

  async sendProgress(text: string): Promise<NonTuiDisplayMessageRef> {
    const messageId = await this.api.sendPlainMessage(this.chatId, text);
    return { id: String(messageId) };
  }

  async editProgress(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.api.editMessageText(this.chatId, Number(ref.id), text);
  }

  async deleteProgress(ref: NonTuiDisplayMessageRef): Promise<void> {
    await this.api.deleteMessage(this.chatId, Number(ref.id));
  }

  async sendFinal(text: string): Promise<NonTuiDisplayMessageRef> {
    const messageId = await this.api.sendPlainMessage(this.chatId, text);
    return { id: String(messageId) };
  }

  async editFinal(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.api.editMessageText(this.chatId, Number(ref.id), text);
  }
}
