import {
  assertExternalAdapterIntegerInRange,
  assertExternalAdapterNonEmptyString,
  assertExternalAdapterStringArray,
  assertExternalAdapterStringMap,
  loadExternalAdapterConfigJson,
} from "pulseed";

const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface WhatsAppWebhookConfig {
  phone_number_id: string;
  access_token: string;
  verify_token: string;
  recipient_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  host: string;
  port: number;
  path: string;
  app_secret?: string;
}

export function loadConfig(pluginDir: string): WhatsAppWebhookConfig {
  return validateConfig(loadExternalAdapterConfigJson(pluginDir, "whatsapp-webhook"));
}

function validateConfig(cfg: Record<string, unknown>): WhatsAppWebhookConfig {
  const host = cfg["host"] ?? "127.0.0.1";
  const port = cfg["port"] ?? 8788;
  const pathValue = cfg["path"] ?? "/webhook";
  const runtimeControlAllowedSenderIds = cfg["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = cfg["allowed_sender_ids"] ?? cfg["allow_from"] ?? [];
  const deniedSenderIds = cfg["denied_sender_ids"] ?? cfg["deny_from"] ?? [];
  const senderGoalMap = cfg["sender_goal_map"] ?? cfg["goal_routes"] ?? {};

  assertExternalAdapterNonEmptyString(cfg["phone_number_id"], "whatsapp-webhook: phone_number_id must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["access_token"], "whatsapp-webhook: access_token must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["verify_token"], "whatsapp-webhook: verify_token must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["recipient_id"], "whatsapp-webhook: recipient_id must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["identity_key"], "whatsapp-webhook: identity_key must be a non-empty string");
  assertExternalAdapterNonEmptyString(host, "whatsapp-webhook: host must be a non-empty string");
  assertExternalAdapterIntegerInRange(port, MIN_PORT, MAX_PORT, `whatsapp-webhook: port must be a safe integer between ${MIN_PORT} and ${MAX_PORT}`);
  assertExternalAdapterNonEmptyString(pathValue, "whatsapp-webhook: path must be a non-empty string");
  if (cfg["app_secret"] !== undefined && typeof cfg["app_secret"] !== "string") {
    throw new Error("whatsapp-webhook: app_secret must be a string when set");
  }
  assertExternalAdapterStringArray(runtimeControlAllowedSenderIds, "whatsapp-webhook: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  for (const [key, value] of Object.entries({
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: deniedSenderIds,
  })) {
    assertExternalAdapterStringArray(value, `whatsapp-webhook: ${key} must be an array of non-empty strings`);
  }
  assertExternalAdapterStringMap(senderGoalMap, "whatsapp-webhook: sender_goal_map must be an object mapping IDs to goal IDs");
  if (cfg["default_goal_id"] !== undefined) {
    assertExternalAdapterNonEmptyString(cfg["default_goal_id"], "whatsapp-webhook: default_goal_id must be a non-empty string when set");
  }

  return {
    phone_number_id: cfg["phone_number_id"] as string,
    access_token: cfg["access_token"] as string,
    verify_token: cfg["verify_token"] as string,
    recipient_id: cfg["recipient_id"] as string,
    identity_key: cfg["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    host,
    port,
    path: pathValue,
    app_secret: cfg["app_secret"] as string | undefined,
  };
}
