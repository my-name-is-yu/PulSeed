import { getGatewayChannelDir } from "../../base/utils/paths.js";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { RuntimeControlService } from "../../runtime/control/index.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { SetupDialogueRuntimeState } from "./setup-dialogue.js";

interface TelegramGatewayConfig {
  bot_token: string;
  chat_id?: number;
  allowed_user_ids: unknown[];
  denied_user_ids: unknown[];
  allowed_chat_ids: unknown[];
  denied_chat_ids: unknown[];
  runtime_control_allowed_user_ids: unknown[];
  chat_goal_map: Record<string, unknown>;
  user_goal_map: Record<string, unknown>;
  default_goal_id?: string;
  allow_all: boolean;
  polling_timeout: number;
  identity_key?: string;
}

export interface TelegramGatewayConfigWriteRequest {
  pending: SetupDialogueRuntimeState;
  baseDir: string;
  approvalFn: (description: string) => Promise<boolean>;
  runtimeControlService?: Pick<RuntimeControlService, "request">;
  actor?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
}

export type TelegramGatewayConfigWriteResult =
  | {
      success: true;
      accessClosedByDefault: boolean;
      refresh: {
        success: boolean;
        message: string;
        operationId?: string;
        state?: string;
        unavailable?: boolean;
      };
    }
  | {
      success: false;
      message: string;
    };

export async function confirmTelegramGatewayConfigWrite(
  request: TelegramGatewayConfigWriteRequest
): Promise<TelegramGatewayConfigWriteResult> {
  const { pending, baseDir, approvalFn } = request;
  const configDir = getGatewayChannelDir("telegram-bot", baseDir);
  const configPath = `${configDir}/config.json`;
  const current = await readJsonFileOrNull<Partial<TelegramGatewayConfig>>(configPath);
  const nextAllowAll = typeof current?.allow_all === "boolean" ? current.allow_all : false;
  const nextAllowedUserIds = Array.isArray(current?.allowed_user_ids) ? current.allowed_user_ids : [];
  const nextRuntimeControlAllowedUserIds = Array.isArray(current?.runtime_control_allowed_user_ids)
    ? current.runtime_control_allowed_user_ids
    : [];
  const accessClosedByDefault = !nextAllowAll && nextAllowedUserIds.length === 0 && nextRuntimeControlAllowedUserIds.length === 0;
  const approved = await approvalFn([
    "Write Telegram gateway config from the redacted chat-supplied bot token.",
    pending.publicState.replacesExistingSecret
      ? "This will replace the existing configured Telegram bot token."
      : "",
    accessClosedByDefault
      ? "Access will remain closed by default with allow_all=false until allowed Telegram user IDs are configured."
      : "Existing Telegram access policy will be preserved.",
  ].filter(Boolean).join(" "));
  if (!approved) {
    return { success: false, message: "Telegram setup was not changed because approval was denied." };
  }

  const nextConfig: TelegramGatewayConfig = {
    bot_token: pending.secretValue!,
    ...(typeof current?.chat_id === "number" ? { chat_id: current.chat_id } : {}),
    allowed_user_ids: nextAllowedUserIds,
    denied_user_ids: Array.isArray(current?.denied_user_ids) ? current.denied_user_ids : [],
    allowed_chat_ids: Array.isArray(current?.allowed_chat_ids) ? current.allowed_chat_ids : [],
    denied_chat_ids: Array.isArray(current?.denied_chat_ids) ? current.denied_chat_ids : [],
    runtime_control_allowed_user_ids: nextRuntimeControlAllowedUserIds,
    chat_goal_map: current?.chat_goal_map ?? {},
    user_goal_map: current?.user_goal_map ?? {},
    ...(current?.default_goal_id ? { default_goal_id: current.default_goal_id } : {}),
    allow_all: nextAllowAll,
    polling_timeout: current?.polling_timeout ?? 30,
    ...(current?.identity_key ? { identity_key: current.identity_key } : {}),
  };
  await writeJsonFileAtomic(configPath, nextConfig);

  return {
    success: true,
    accessClosedByDefault,
    refresh: await requestTelegramGatewayRefresh({
      baseDir,
      runtimeControlService: request.runtimeControlService,
      actor: request.actor,
      replyTarget: request.replyTarget,
      approvalFn,
    }),
  };
}

async function requestTelegramGatewayRefresh(params: {
  baseDir: string;
  runtimeControlService?: Pick<RuntimeControlService, "request">;
  actor?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (description: string) => Promise<boolean>;
}): Promise<{ success: boolean; message: string; operationId?: string; state?: string; unavailable?: boolean }> {
  if (!params.runtimeControlService) {
    return {
      success: false,
      unavailable: true,
      message: "This chat surface cannot request a gateway reload yet.",
    };
  }
  const result = await params.runtimeControlService.request({
    intent: {
      kind: "restart_gateway",
      reason: "Apply updated Telegram gateway config after approved setup write.",
    },
    cwd: params.baseDir,
    ...(params.actor ? { requestedBy: params.actor } : {}),
    ...(params.replyTarget ? { replyTarget: params.replyTarget } : {}),
    ...(params.approvalFn ? { approvalFn: params.approvalFn } : {}),
  });
  return {
    success: result.success,
    message: result.message,
    ...(result.operationId ? { operationId: result.operationId } : {}),
    ...(result.state ? { state: result.state } : {}),
  };
}
