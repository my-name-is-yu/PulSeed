import * as http from "node:http";
import { WhatsAppCloudClient } from "./whatsapp-client.js";
import { dispatchChatInput, type ChatContinuationInput } from "./shared-manager.js";
import type { WhatsAppWebhookConfig } from "./config.js";
import {
  buildChannelPolicyMetadata,
  buildExternalSurfaceDecision,
  evaluateChannelAccess,
  resolveChannelRoute,
  parseExternalAdapterJson,
  readExternalAdapterHttpBody,
  respondExternalAdapterJson,
  verifyOptionalHmacSha256Signature,
} from "pulseed";

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

export class WhatsAppWebhookServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: WhatsAppWebhookConfig,
    private readonly client: WhatsAppCloudClient,
    private readonly fetchChatReply: typeof dispatchChatInput = dispatchChatInput
  ) {}

  async start(): Promise<void> {
    if (this.server !== null) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.host, resolve);
    });
  }

  async stop(): Promise<void> {
    if (this.server === null) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? this.config.host}`);

    if (req.method === "GET" && url.pathname === this.config.path) {
      this.handleVerification(req, res, url);
      return;
    }

    if (req.method !== "POST" || url.pathname !== this.config.path) {
      respondExternalAdapterJson(res, 404, { error: "not_found" });
      return;
    }

    const bodyResult = await readExternalAdapterHttpBody(req);
    if (bodyResult.status !== "ok") {
      respondExternalAdapterJson(res, bodyResult.statusCode, bodyResult.payload);
      return;
    }

    if (!this.verifySignature(req, bodyResult.body)) {
      respondExternalAdapterJson(res, 401, { error: "invalid_signature" });
      return;
    }

    const parsed = parseExternalAdapterJson<WhatsAppWebhookPayload>(bodyResult.body);
    if (parsed.status !== "ok") {
      respondExternalAdapterJson(res, parsed.statusCode, parsed.payload);
      return;
    }

    const messages = this.extractMessages(parsed.value);
    for (const message of messages) {
      void this.processMessage(message).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[whatsapp-webhook] failed to process message: ${msg}`);
      });
    }

    respondExternalAdapterJson(res, 200, { ok: true });
  }

  private handleVerification(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === this.config.verify_token && challenge !== null) {
      res.statusCode = 200;
      res.end(challenge);
      return;
    }

    respondExternalAdapterJson(res, 403, { error: "verification_failed" });
  }

  private async processMessage(message: {
    id?: string;
    from?: string;
    timestamp?: string;
    text?: { body?: string };
    type?: string;
  }): Promise<void> {
    if (message.from === undefined || message.text?.body === undefined || message.text.body.trim().length === 0) {
      return;
    }

    const channelContext = {
      platform: "whatsapp",
      senderId: message.from,
      conversationId: message.from,
    };
    const access = evaluateChannelAccess(
      {
        allowedSenderIds: this.config.allowed_sender_ids,
        deniedSenderIds: this.config.denied_sender_ids,
        runtimeControlAllowedSenderIds: this.config.runtime_control_allowed_sender_ids,
      },
      channelContext
    );
    if (!access.allowed) {
      return;
    }
    const route = resolveChannelRoute(
      {
        identityKey: this.config.identity_key,
        senderGoalMap: this.config.sender_goal_map,
        defaultGoalId: this.config.default_goal_id,
      },
      channelContext
    );
    const externalSurface = buildExternalSurfaceDecision(channelContext, access, route);
    const input: ChatContinuationInput = {
      platform: "whatsapp",
      identity_key: route.identityKey ?? this.config.identity_key,
      conversation_id: message.from,
      sender_id: message.from,
      message_id: message.id,
      text: message.text.body,
      externalSurface,
      metadata: {
        ...buildChannelPolicyMetadata(channelContext, access, route, externalSurface),
        message_type: message.type,
        timestamp: message.timestamp,
        ...(route.goalId ? { goal_id: route.goalId } : {}),
      },
    };

    const reply = await this.fetchChatReply(input);
    const content = reply ?? "Received.";
    await this.client.sendTextMessage({
      to: message.from,
      body: content,
    });
  }

  private extractMessages(payload: WhatsAppWebhookPayload): Array<{
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }> {
    const messages: Array<{
      id?: string;
      from?: string;
      timestamp?: string;
      type?: string;
      text?: { body?: string };
    }> = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          messages.push(message);
        }
      }
    }

    return messages;
  }

  private verifySignature(req: http.IncomingMessage, body: string): boolean {
    return verifyOptionalHmacSha256Signature({
      secret: this.config.app_secret,
      body,
      signatureHeader: req.headers["x-hub-signature-256"],
    });
  }
}
