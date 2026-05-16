import { formatExternalAdapterHttpFailure } from "pulseed";

export interface DiscordOutboundMessage {
  content: string;
  allowed_mentions?: {
    parse: string[];
  };
}

export class DiscordAPI {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendChannelMessage(channelId: string, content: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      } satisfies DiscordOutboundMessage),
    });

    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "channel send failed",
        statusVerb: "with",
      }));
    }
  }

  async sendInteractionFollowUp(
    applicationId: string,
    interactionToken: string,
    content: string
  ): Promise<void> {
    const response = await this.fetchImpl(
      `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          allowed_mentions: { parse: [] },
        } satisfies DiscordOutboundMessage),
      }
    );

    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "follow-up send failed",
        statusVerb: "with",
      }));
    }
  }
}
