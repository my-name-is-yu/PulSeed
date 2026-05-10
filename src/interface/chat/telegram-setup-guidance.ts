import type { TelegramSetupStatus } from "./gateway-setup-status.js";
import { SETUP_WRITE_CONFIRM_COMMAND } from "./setup-dialogue.js";

export interface TelegramSetupGuidanceData {
  channel: "telegram";
  state: TelegramSetupStatus["state"];
  config_path: string;
  daemon: { running: boolean; port: number };
  gateway: { load_state: string };
  config: {
    exists: boolean;
    has_bot_token: boolean;
    has_home_chat: boolean;
    allow_all: boolean;
    allowed_user_count: number;
    runtime_control_allowed_user_count: number;
    identity_key_configured: boolean;
  };
  next_action: {
    kind: "configure_bot_token" | "send_sethome" | "verify_delivery";
    required: boolean;
    description: string;
  };
  command_tokens: {
    recommended_path: string[];
    confirm_write: typeof SETUP_WRITE_CONFIRM_COMMAND;
    set_home: "/sethome";
  };
  safety: {
    writes_config: false;
    writes_secret: false;
    requires_approval_before_write: true;
    shell_fallback_allowed: false;
    access_closed_by_default: boolean;
  };
  pending_write: {
    exists: boolean;
    state: "none" | "confirm_write";
    replaces_existing_secret: boolean;
    secret_kind: "telegram_bot_token" | null;
  };
  redaction: {
    raw_secret_in_summary: false;
    raw_secret_in_data: false;
    redaction_marker_present: boolean;
  };
}

export function formatTelegramConfigProgressDetail(status: TelegramSetupStatus): string {
  if (!status.config.exists) return "Config file does not exist yet.";
  if (!status.config.hasBotToken) return "Config file exists, but no bot token is configured.";
  if (!status.config.hasHomeChat) return "Bot token is configured, but no home chat is set.";
  return "Bot token and home chat are configured.";
}

export function formatTelegramConfigureGuidance(
  status: TelegramSetupStatus,
  suppliedTelegramToken: boolean,
  pendingActionCreated: boolean
): string {
  const guidance = buildTelegramSetupGuidanceData(status, suppliedTelegramToken, pendingActionCreated);
  const lines = [
    "Telegram gateway status",
    "",
    guidance.daemon.running
      ? `- Daemon: running on port ${guidance.daemon.port}; gateway load state is ${guidance.gateway.load_state}.`
      : `- Daemon: not responding on port ${guidance.daemon.port}.`,
  ];

  if (guidance.state === "unconfigured") {
    lines.push(
      "- Telegram: not configured.",
      "",
      "Recommended command path:",
      "```sh",
      ...guidance.command_tokens.recommended_path,
      "```",
      "",
      "Create or open a bot with @BotFather, then enter the token in `pulseed telegram setup`."
    );
  } else if (guidance.state === "partially_configured") {
    lines.push(
      "- Telegram config: bot token is configured, but no home chat is set.",
      `- Gateway loaded in daemon: ${guidance.gateway.load_state}.`,
      "",
      "Next step:",
      `- Send \`${guidance.command_tokens.set_home}\` to the Telegram bot from the chat that should receive PulSeed replies.`,
      "- Then run `pulseed daemon status` to verify the gateway."
    );
  } else {
    lines.push(
      "- Telegram config: configured.",
      guidance.config.has_home_chat
        ? "- Home chat: configured."
        : `- Home chat: not set; send \`${guidance.command_tokens.set_home}\` if this bot should reply into a specific chat.`,
      `- Gateway loaded in daemon: ${guidance.gateway.load_state}.`,
      "",
      "Verification:",
      "- Send a message to the Telegram bot.",
      "- Run `pulseed daemon status` if delivery does not work."
    );
  }

  lines.push(
    "",
    guidance.pending_write.exists
      ? guidance.pending_write.replaces_existing_secret
        ? `I received a Telegram bot token in this turn and kept it redacted from chat history and activity. Confirming will replace the existing configured token. Reply \`${guidance.command_tokens.confirm_write}\` or approve in natural language to request an approval-gated config write.`
        : `I received a Telegram bot token in this turn and kept it redacted from chat history and activity. Reply \`${guidance.command_tokens.confirm_write}\` or approve in natural language to request an approval-gated config write.`
      : suppliedTelegramToken
        ? "I received a Telegram bot token in this turn and kept it redacted from chat history and activity, but no setup action could be prepared."
        : "If you prefer chat-assisted setup, paste the token here; PulSeed will redact it from history and prepare an approval-gated confirmation before writing config."
  );

  if (!guidance.daemon.running && guidance.state !== "unconfigured") {
    lines.push(
      "",
      "The config will not take effect until the daemon is started or restarted."
    );
  } else if (guidance.daemon.running && guidance.state !== "unconfigured") {
    lines.push(
      "",
      "If Telegram was configured or changed through chat-assisted setup, PulSeed will request a gateway reload after the approved write.",
      "For config changes made outside PulSeed chat setup, run `pulseed daemon restart` if delivery does not pick up the updated gateway config."
    );
  }

  return lines.join("\n");
}

export function buildTelegramSetupGuidanceData(
  status: TelegramSetupStatus,
  suppliedTelegramToken: boolean,
  pendingActionCreated: boolean
): TelegramSetupGuidanceData {
  const nextAction = status.state === "unconfigured"
    ? {
      kind: "configure_bot_token" as const,
      required: true,
      description: "Configure a Telegram bot token before gateway delivery can work.",
    }
    : !status.config.hasHomeChat
      ? {
        kind: "send_sethome" as const,
        required: true,
        description: "Send /sethome from the Telegram chat that should receive PulSeed replies.",
      }
      : {
        kind: "verify_delivery" as const,
        required: false,
        description: "Send a Telegram message and inspect daemon status if delivery fails.",
      };
  return {
    channel: "telegram",
    state: status.state,
    config_path: status.configPath,
    daemon: { running: status.daemon.running, port: status.daemon.port },
    gateway: { load_state: status.gateway.loadState },
    config: {
      exists: status.config.exists,
      has_bot_token: status.config.hasBotToken,
      has_home_chat: status.config.hasHomeChat,
      allow_all: status.config.allowAll,
      allowed_user_count: status.config.allowedUserCount,
      runtime_control_allowed_user_count: status.config.runtimeControlAllowedUserCount,
      identity_key_configured: status.config.identityKeyConfigured,
    },
    next_action: nextAction,
    command_tokens: {
      recommended_path: ["pulseed telegram setup", "pulseed gateway setup", "pulseed daemon start", "pulseed daemon status"],
      confirm_write: SETUP_WRITE_CONFIRM_COMMAND,
      set_home: "/sethome",
    },
    safety: {
      writes_config: false,
      writes_secret: false,
      requires_approval_before_write: true,
      shell_fallback_allowed: false,
      access_closed_by_default: !status.config.allowAll && status.config.allowedUserCount === 0,
    },
    pending_write: {
      exists: pendingActionCreated,
      state: pendingActionCreated ? "confirm_write" : "none",
      replaces_existing_secret: pendingActionCreated && status.config.hasBotToken,
      secret_kind: pendingActionCreated ? "telegram_bot_token" : null,
    },
    redaction: {
      raw_secret_in_summary: false,
      raw_secret_in_data: false,
      redaction_marker_present: suppliedTelegramToken,
    },
  };
}
