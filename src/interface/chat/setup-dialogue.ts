import { z } from "zod/v3";
import { randomUUID } from "node:crypto";
import type { SetupSecretIntakeItem } from "./setup-secret-intake.js";

export const SetupDialogueStateSchema = z.enum([
  "diagnose",
  "offer",
  "awaiting_secret",
  "confirm_write",
  "writing",
  "restart_offer",
  "verify",
  "done",
  "blocked",
]);
export type SetupDialogueState = z.infer<typeof SetupDialogueStateSchema>;

export const SetupDialogueChannelSchema = z.enum([
  "telegram",
  "discord",
  "gateway",
  "provider",
]);
export type SetupDialogueChannel = z.infer<typeof SetupDialogueChannelSchema>;

export const SetupDialogueActionSchema = z.object({
  kind: z.enum(["write_gateway_config", "adapter_plan"]),
  channel: SetupDialogueChannelSchema,
  command: z.string(),
  requiresApproval: z.boolean(),
  secretKinds: z.array(z.string()),
  status: z.enum(["pending", "completed", "blocked"]).default("pending"),
}).passthrough();
export type SetupDialogueAction = z.infer<typeof SetupDialogueActionSchema>;

export const SetupDialogueSecretRefSchema = z.object({
  id: z.string(),
  kind: z.string(),
  redaction: z.string(),
  suppliedAt: z.string(),
});
export type SetupDialogueSecretRef = z.infer<typeof SetupDialogueSecretRefSchema>;

export const SetupDialoguePublicStateSchema = z.object({
  id: z.string(),
  state: SetupDialogueStateSchema,
  selectedChannel: SetupDialogueChannelSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  action: SetupDialogueActionSchema.optional(),
  pendingSecret: SetupDialogueSecretRefSchema.optional(),
  replacesExistingSecret: z.boolean().optional(),
  note: z.string().optional(),
}).passthrough();
export type SetupDialoguePublicState = z.infer<typeof SetupDialoguePublicStateSchema>;

export interface SetupDialogueRuntimeState {
  publicState: SetupDialoguePublicState;
  secretValue?: string;
}

export const SETUP_WRITE_CONFIRM_COMMAND = "/confirm-setup-write";
export const LEGACY_TELEGRAM_CONFIRM_COMMAND = "/confirm-telegram-setup";

export function createTelegramConfirmWriteDialogue(
  secret: SetupSecretIntakeItem,
  options: { replacesExistingSecret?: boolean; now?: string } = {}
): SetupDialogueRuntimeState {
  const now = options.now ?? new Date().toISOString();
  return {
    publicState: {
      id: randomUUID(),
      state: "confirm_write",
      selectedChannel: "telegram",
      createdAt: now,
      updatedAt: now,
      pendingSecret: {
        id: secret.id,
        kind: secret.kind,
        redaction: secret.redaction,
        suppliedAt: secret.suppliedAt,
      },
      action: {
        kind: "write_gateway_config",
        channel: "telegram",
        command: SETUP_WRITE_CONFIRM_COMMAND,
        requiresApproval: true,
        secretKinds: [secret.kind],
        status: "pending",
      },
      ...(options.replacesExistingSecret ? { replacesExistingSecret: true } : {}),
    },
    secretValue: secret.value,
  };
}

export function createDiscordAdapterPlanDialogue(now = new Date().toISOString()): SetupDialoguePublicState {
  return {
    id: randomUUID(),
    state: "blocked",
    selectedChannel: "discord",
    createdAt: now,
    updatedAt: now,
    note: "Discord setup needs application_id, bot_token, channel_id, identity_key, host, port, and access policy before a chat-assisted write can be safely offered.",
    action: {
      kind: "adapter_plan",
      channel: "discord",
      command: "pulseed gateway setup",
      requiresApproval: false,
      secretKinds: ["discord_bot_token"],
      status: "blocked",
    },
  };
}

export function isSetupWriteConfirmCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === SETUP_WRITE_CONFIRM_COMMAND || trimmed === LEGACY_TELEGRAM_CONFIRM_COMMAND;
}
