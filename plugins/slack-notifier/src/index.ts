import type {
  INotifier,
  NotificationEvent,
  NotificationEventType,
} from "pulseed";

// ─── Supported events (must match plugin.yaml) ───

const SUPPORTED_EVENTS: NotificationEventType[] = [
  "goal_complete",
  "approval_needed",
  "stall_detected",
  "task_blocked",
];

// ─── Severity emoji mapping ───

const SEVERITY_EMOJI: Record<NotificationEvent["severity"], string> = {
  info: "green_circle",
  warning: "yellow_circle",
  critical: "red_circle",
};

// ─── Config ───

export interface SlackNotifierConfig {
  webhook_url: string;
  channel?: string;
  mention_on_critical?: boolean;
}

// ─── Message formatting ───

function formatSlackMessage(
  event: NotificationEvent,
  config: SlackNotifierConfig
): object {
  const emoji = SEVERITY_EMOJI[event.severity];
  const mentionOnCritical = config.mention_on_critical ?? true;
  const mention =
    mentionOnCritical && event.severity === "critical" ? "<!channel> " : "";

  const text = `${mention}:${emoji}: *${event.summary}*`;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Goal: \`${event.goal_id}\` | Event: \`${event.type}\` | ${new Date(event.timestamp).toISOString()}`,
        },
      ],
    },
  ];

  const payload: Record<string, unknown> = { text, blocks };

  if (config.channel) {
    payload["channel"] = config.channel;
  }

  return payload;
}

// ─── SlackNotifier implementation ───

export class SlackNotifier implements INotifier {
  readonly name = "slack-notifier";

  private config: SlackNotifierConfig;

  constructor(config: SlackNotifierConfig) {
    if (!config.webhook_url) {
      throw new Error("slack-notifier: webhook_url is required");
    }
    this.config = config;
  }

  supports(eventType: NotificationEventType): boolean {
    return SUPPORTED_EVENTS.includes(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    const payload = formatSlackMessage(event, this.config);

    const response = await fetch(this.config.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `slack-notifier: webhook returned ${response.status}: ${body}`
      );
    }
  }
}

// ─── Default export (required by PluginLoader) ───
//
// The PluginLoader instantiates the notifier via module.default.
// When SLACK_WEBHOOK_URL is not set (e.g. during unit tests that import
// the class directly), the default export is null so the module-level
// import does not throw. PluginLoader validates the interface at load time
// and will reject a null export with a clear error.

const _webhookUrl = process.env["SLACK_WEBHOOK_URL"];

export default _webhookUrl
  ? new SlackNotifier({
      webhook_url: _webhookUrl,
      channel: process.env["SLACK_CHANNEL"],
      mention_on_critical: process.env["SLACK_MENTION_ON_CRITICAL"] !== "false",
    })
  : null;
