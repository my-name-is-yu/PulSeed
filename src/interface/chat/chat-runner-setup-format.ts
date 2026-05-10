import {
  SETUP_WRITE_CONFIRM_COMMAND,
  type SetupDialogueRuntimeState,
} from "./setup-dialogue.js";

export function formatPendingSetupConfirmationSubject(
  publicState: SetupDialogueRuntimeState["publicState"],
): string {
  const lines = [
    `Setup dialogue: ${publicState.selectedChannel}`,
    `State: ${publicState.state}`,
    `Action: ${publicState.action?.kind ?? "unknown"}`,
    `Command fallback: ${publicState.action?.command ?? SETUP_WRITE_CONFIRM_COMMAND}`,
    publicState.replacesExistingSecret
      ? "Confirming will replace an existing configured Telegram bot token."
      : "Confirming will write a Telegram gateway config from a redacted chat-supplied token.",
    "Approval is still required before writing config.",
  ];
  return lines.join("\n");
}

export function formatSetupConfirmationCancelled(): string {
  return "Telegram setup config write was cancelled. No token was written.";
}

export function formatTelegramSetupRefreshResult(
  result: { success: boolean; message: string; operationId?: string; state?: string; unavailable?: boolean },
): string {
  if (result.success) {
    const suffix = result.operationId ? ` (${result.operationId})` : "";
    return `PulSeed requested a gateway reload for the updated Telegram config${suffix}: ${result.message}`;
  }
  if (result.unavailable) {
    return `PulSeed could not request a gateway reload from this chat surface: ${result.message}`;
  }
  return `PulSeed requested a gateway reload, but it failed: ${result.message}`;
}
