import { z } from "zod";
import { createRuntimeSessionRegistry } from "../../runtime/session-registry/index.js";
import type { BackgroundRun } from "../../runtime/session-registry/index.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { RuntimeControlService } from "../../runtime/control/index.js";
import type { RuntimeControlIntent } from "../../runtime/control/runtime-control-intent.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import { createGatewaySetupStatusProvider, type GatewaySetupStatusProvider } from "../../interface/chat/gateway-setup-status.js";
import {
  createDiscordAdapterPlanDialogue,
  createTelegramConfirmWriteDialogue,
  type SetupDialogueRuntimeState,
} from "../../interface/chat/setup-dialogue.js";
import { SetupSecretIntakeResultSchema, type SetupSecretIntakeItem } from "../../interface/chat/setup-secret-intake.js";
import { detectTurnLanguageHint, UNKNOWN_TURN_LANGUAGE_HINT, type TurnLanguageHint } from "../../interface/chat/turn-language.js";
import { formatRuntimeStatus } from "../../interface/chat/chat-runner-runtime.js";
import { buildTelegramSetupGuidanceData, formatTelegramConfigureGuidance } from "../../interface/chat/telegram-setup-guidance.js";
import { confirmTelegramGatewayConfigWrite } from "../../interface/chat/setup-config-write.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";

const SetupChannelSchema = z.enum(["telegram", "discord", "gateway"]);

const GatewaySetupStatusInputSchema = z.object({
  channel: SetupChannelSchema.default("telegram"),
}).strict();
type GatewaySetupStatusInput = z.infer<typeof GatewaySetupStatusInputSchema>;

const SetupGuidanceInputSchema = z.object({
  channel: SetupChannelSchema.default("telegram"),
  request: z.string().min(1).optional(),
  language: z.enum(["en", "ja", "unknown"]).optional(),
}).strict();
type SetupGuidanceInput = z.infer<typeof SetupGuidanceInputSchema>;

const PrepareConfigWriteInputSchema = z.object({
  channel: z.literal("telegram").default("telegram"),
}).strict();
type PrepareConfigWriteInput = z.infer<typeof PrepareConfigWriteInputSchema>;

const RuntimeStatusInputSchema = z.object({}).strict();
type RuntimeStatusInput = z.infer<typeof RuntimeStatusInputSchema>;

const RuntimeControlDaemonOperationSchema = z.enum([
  "restart_daemon",
  "restart_gateway",
  "reload_config",
  "self_update",
]);

const RuntimeControlInputSchema = z.object({
  operation: RuntimeControlDaemonOperationSchema,
  reason: z.string().min(1),
}).strict();
type RuntimeControlInput = z.infer<typeof RuntimeControlInputSchema>;

const RuntimeRunControlToolInputSchema = z.object({
  run_id: z.string().min(1),
  observed_run_epoch: z.string().min(1),
  reason: z.string().min(1),
}).strict();
type RuntimeRunControlToolInput = z.infer<typeof RuntimeRunControlToolInputSchema>;

export interface SetupRuntimeControlToolDeps {
  stateManager: StateManager;
  gatewaySetupStatusProvider?: GatewaySetupStatusProvider;
  runtimeControlService?: Pick<RuntimeControlService, "request">;
}

export function createSetupRuntimeControlTools(deps: SetupRuntimeControlToolDeps): ITool[] {
  return [
    new GetGatewaySetupStatusTool(deps),
    new PrepareGatewaySetupGuidanceTool(deps),
    new PrepareGatewayConfigWriteTool(deps),
    new ConfirmGatewayConfigWriteTool(deps),
    new CancelGatewayConfigWriteTool(deps),
    new GetRuntimeStatusTool(deps),
    new RequestRuntimeControlTool(deps),
    new RunPauseTool(deps),
    new RunResumeTool(deps),
    new RunCancelTool(deps),
  ];
}

class GetGatewaySetupStatusTool implements ITool<GatewaySetupStatusInput> {
  readonly metadata = makeMetadata("get_gateway_setup_status", "read_only", true);
  readonly inputSchema = GatewaySetupStatusInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Read typed gateway setup status for a channel. This is read-only and never writes secrets.";
  }

  async call(input: GatewaySetupStatusInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    if (input.channel !== "telegram") {
      return toolResult(false, { status: "unsupported_channel", channel: input.channel }, `${input.channel} setup status is not available yet.`, started);
    }
    const status = await setupStatusProvider(this.deps).getTelegramStatus(providerConfigBaseDir(this.deps, context));
    return toolResult(true, {
      channel: status.channel,
      state: status.state,
      configPath: status.configPath,
      daemon: status.daemon,
      gateway: status.gateway,
      config: {
        exists: status.config.exists,
        hasBotToken: status.config.hasBotToken,
        hasHomeChat: status.config.hasHomeChat,
        allowAll: status.config.allowAll,
        allowedUserCount: status.config.allowedUserCount,
        runtimeControlAllowedUserCount: status.config.runtimeControlAllowedUserCount,
        identityKeyConfigured: status.config.identityKeyConfigured,
      },
      nextRequiredAction: nextTelegramSetupAction(status.state, status.config.hasHomeChat),
    }, `Telegram gateway status: ${status.state}`, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

class PrepareGatewaySetupGuidanceTool implements ITool<SetupGuidanceInput> {
  readonly metadata = makeMetadata("prepare_gateway_setup_guidance", "read_only", true);
  readonly inputSchema = SetupGuidanceInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(context?: ToolDescriptionContext): string {
    return [
      "Prepare safe setup guidance for gateway channels without writing secrets.",
      "Use this for natural-language setup requests such as Telegram bot setup.",
      context?.cwd ? `Current cwd: ${context.cwd}.` : "",
    ].filter(Boolean).join(" ");
  }

  async call(input: SetupGuidanceInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const hint = languageHint(input.language, input.request);
    if (input.channel === "telegram") {
      const status = await setupStatusProvider(this.deps).getTelegramStatus(providerConfigBaseDir(this.deps, context));
      const telegramSecret = currentSetupSecret(context, "telegram_bot_token");
      if (telegramSecret) {
        await context.setupDialogue?.set(createTelegramConfirmWriteDialogue(telegramSecret, {
          replacesExistingSecret: status.config.hasBotToken,
        }));
      }
      const guidance = buildTelegramSetupGuidanceData(status, telegramSecret !== null, telegramSecret !== null);
      const message = formatTelegramConfigureGuidance(status, telegramSecret !== null, telegramSecret !== null);
      return toolResult(true, {
        ...guidance,
        user_language: {
          preference: hint.language === "ja" ? "japanese" : "same_as_user_turn",
          script: hint.script ?? "unknown",
          confidence: hint.confidence,
          source: hint.source,
        },
      }, message, started);
    }
    if (input.channel === "discord") {
      const discordSecret = currentSetupSecret(context, "discord_bot_token");
      if (discordSecret) {
        const dialogue = createDiscordAdapterPlanDialogue();
        await context.setupDialogue?.set({ publicState: dialogue });
      }
      return toolResult(true, {
        channel: "discord",
        pending_write: false,
        blocked: true,
      }, "Discord gateway setup needs application ID, home channel ID, identity key, webhook host/port, and access policy before a chat-assisted config write can be prepared. Use `pulseed gateway setup`.", started);
    }
    return toolResult(true, { channel: input.channel }, "Gateway setup is a configuration flow. Use `pulseed gateway setup`, then start or restart the daemon.", started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class PrepareGatewayConfigWriteTool implements ITool<PrepareConfigWriteInput> {
  readonly metadata = makeMetadata("prepare_gateway_config_write", "write_local", false);
  readonly inputSchema = PrepareConfigWriteInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Prepare a protected pending Telegram gateway config write from the current turn's already-redacted secret intake. Does not write config.";
  }

  async call(_input: PrepareConfigWriteInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const telegramSecret = currentSetupSecret(context, "telegram_bot_token");
    if (!telegramSecret) {
      return toolResult(false, { status: "missing_secret" }, "No redacted Telegram bot token is available in this turn. Paste the token again to prepare a protected setup write.", started);
    }
    const status = await setupStatusProvider(this.deps).getTelegramStatus(providerConfigBaseDir(this.deps, context));
    const dialogue = createTelegramConfirmWriteDialogue(telegramSecret, {
      replacesExistingSecret: status.config.hasBotToken,
    });
    await context.setupDialogue?.set(dialogue);
    return toolResult(true, {
      status: "pending_confirmation",
      channel: "telegram",
      dialogue: dialogue.publicState,
    }, "Prepared an approval-gated Telegram config write from the redacted token. No config has been written. Confirm or cancel the pending setup write.", started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class ConfirmGatewayConfigWriteTool implements ITool<PrepareConfigWriteInput> {
  readonly metadata = makeMetadata("confirm_gateway_config_write", "write_local", false);
  readonly inputSchema = PrepareConfigWriteInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Confirm the pending protected Telegram gateway config write. Requires the surface approval callback before writing.";
  }

  async call(_input: PrepareConfigWriteInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const pending = await getSetupDialogue(context);
    if (!pending || pending.publicState.state !== "confirm_write") {
      return toolResult(false, { status: "no_pending_write" }, "No pending setup write is available. Paste the secret again to start a protected setup turn.", started);
    }
    if (pending.publicState.selectedChannel !== "telegram" || pending.publicState.action?.kind !== "write_gateway_config") {
      return toolResult(false, { status: "channel_mismatch" }, `The pending setup dialogue is for ${pending.publicState.selectedChannel}, so it cannot be confirmed as a Telegram config write.`, started);
    }
    if (!pending.secretValue) {
      return toolResult(false, { status: "secret_expired" }, "The pending setup dialogue no longer has a transient secret value. Paste the token again so PulSeed can keep it protected through a fresh confirmation.", started);
    }
    if (!context.approvalFn) {
      return toolResult(false, { status: "approval_unavailable" }, "Telegram setup requires an approval-capable chat surface before writing config. Use `pulseed telegram setup` instead.", started);
    }
    const baseDir = providerConfigBaseDir(this.deps, context);
    const write = await confirmTelegramGatewayConfigWrite({
      pending,
      baseDir,
      approvalFn: toolApprovalFn(context, "confirm_gateway_config_write", { channel: "telegram" }),
      runtimeControlService: runtimeControlAllowed(context) ? this.deps.runtimeControlService : undefined,
      actor: parseActor(context.runtimeControlActor) ?? actorFromReplyTarget(context.runtimeReplyTarget),
      replyTarget: parseReplyTarget(context.runtimeReplyTarget),
    });
    if (!write.success) {
      await context.setupDialogue?.set(null);
      return toolResult(false, { status: "approval_denied" }, write.message, started);
    }
    const completed: SetupDialogueRuntimeState = {
      publicState: {
        ...pending.publicState,
        state: write.refresh.success ? "verify" : "restart_offer",
        updatedAt: new Date().toISOString(),
        action: pending.publicState.action
          ? { ...pending.publicState.action, status: "completed" }
          : pending.publicState.action,
      },
    };
    await context.setupDialogue?.set(completed);
    const message = [
      "Telegram gateway config was written from the redacted chat-supplied token.",
      "",
      write.refresh.message,
      "",
      write.accessClosedByDefault
        ? "Access remains closed until you configure allowed Telegram user IDs or intentionally enable `allow_all` with `pulseed telegram setup`."
        : "Existing Telegram access policy was preserved.",
      "Send `/sethome` from Telegram if no home chat is configured yet.",
    ].join("\n");
    return toolResult(true, {
      status: "written",
      channel: "telegram",
      refresh: write.refresh,
      accessClosedByDefault: write.accessClosedByDefault,
    }, message, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class CancelGatewayConfigWriteTool implements ITool<PrepareConfigWriteInput> {
  readonly metadata = makeMetadata("cancel_gateway_config_write", "write_local", false);
  readonly inputSchema = PrepareConfigWriteInputSchema;
  constructor(_deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Cancel the pending protected gateway config write. Does not write config.";
  }

  async call(_input: PrepareConfigWriteInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    await context.setupDialogue?.set(null);
    return toolResult(true, { status: "cancelled" }, "Telegram setup config write was cancelled. No token was written.", started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class GetRuntimeStatusTool implements ITool<RuntimeStatusInput> {
  readonly metadata = makeMetadata("get_runtime_status", "read_only", true);
  readonly inputSchema = RuntimeStatusInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Read active runtime sessions and background run status. This never mutates runtime lifecycle.";
  }

  async call(_input: RuntimeStatusInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const snapshot = await createRuntimeSessionRegistry({ stateManager: this.deps.stateManager }).snapshot();
    return toolResult(true, snapshot, formatRuntimeStatus(snapshot), started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

class RequestRuntimeControlTool implements ITool<RuntimeControlInput> {
  readonly metadata = makeMetadata("request_runtime_control", "write_local", false);
  readonly inputSchema = RuntimeControlInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Request a typed runtime lifecycle operation through RuntimeControlService. Never use shell fallback for daemon or gateway lifecycle control.";
  }

  async call(input: RuntimeControlInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    if (!runtimeControlAllowed(context)) {
      return toolResult(false, {
        status: "not_executed",
        reason: "runtime_control_disallowed",
        operation: input.operation,
      }, `Runtime control ${input.operation} is not authorized for this chat surface. The operation was not executed, and PulSeed will not fall back to shell tools.`, started);
    }
    if (!this.deps.runtimeControlService) {
      return toolResult(false, {
        status: "not_executed",
        reason: "runtime_control_unavailable",
        operation: input.operation,
      }, `Runtime control ${input.operation} is not available in this chat surface. The operation was not executed, and PulSeed will not fall back to shell tools.`, started);
    }
    const intent: RuntimeControlIntent = {
      kind: input.operation,
      reason: input.reason,
    };
    const result = await this.deps.runtimeControlService.request({
      intent,
      cwd: context.cwd,
      requestedBy: parseActor(context.runtimeControlActor) ?? actorFromReplyTarget(context.runtimeReplyTarget),
      replyTarget: parseReplyTarget(context.runtimeReplyTarget) ?? { surface: "chat" },
      approvalFn: context.runtimeControlApprovalMode === "preapproved"
        ? async () => true
        : toolApprovalFn(context, "request_runtime_control", { ...input }),
    });
    return toolResult(result.success, {
      status: result.success ? "requested" : "not_executed",
      operation: input.operation,
      operationId: result.operationId,
      state: result.state,
    }, result.message, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class RunPauseTool implements ITool<RuntimeRunControlToolInput> {
  readonly metadata = makeMetadata("run_pause", "write_local", false);
  readonly inputSchema = RuntimeRunControlToolInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Request a typed safe pause for an exact runtime run id. Requires the observed_run_epoch returned by runs_observe.";
  }

  call(input: RuntimeRunControlToolInput, context: ToolCallContext): Promise<ToolResult> {
    return requestObservedRunControl(this.deps, "run_pause", "pause_run", input, context);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class RunResumeTool implements ITool<RuntimeRunControlToolInput> {
  readonly metadata = makeMetadata("run_resume", "write_local", false);
  readonly inputSchema = RuntimeRunControlToolInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Request a typed resume for an exact runtime run id. Requires the observed_run_epoch returned by runs_observe.";
  }

  call(input: RuntimeRunControlToolInput, context: ToolCallContext): Promise<ToolResult> {
    return requestObservedRunControl(this.deps, "run_resume", "resume_run", input, context);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class RunCancelTool implements ITool<RuntimeRunControlToolInput> {
  readonly metadata = makeMetadata("run_cancel", "write_local", false, true);
  readonly inputSchema = RuntimeRunControlToolInputSchema;
  constructor(private readonly deps: SetupRuntimeControlToolDeps) {}

  description(): string {
    return "Request typed cancellation for an exact runtime run id. Requires the observed_run_epoch returned by runs_observe.";
  }

  call(input: RuntimeRunControlToolInput, context: ToolCallContext): Promise<ToolResult> {
    return requestObservedRunControl(this.deps, "run_cancel", "cancel_run", input, context);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

function setupStatusProvider(deps: SetupRuntimeControlToolDeps): GatewaySetupStatusProvider {
  return deps.gatewaySetupStatusProvider ?? createGatewaySetupStatusProvider();
}

async function requestObservedRunControl(
  deps: SetupRuntimeControlToolDeps,
  toolName: string,
  operation: Extract<RuntimeControlIntent["kind"], "pause_run" | "resume_run" | "cancel_run">,
  input: RuntimeRunControlToolInput,
  context: ToolCallContext,
): Promise<ToolResult> {
  const started = Date.now();
  if (!runtimeControlAllowed(context)) {
    return toolResult(false, {
      status: "not_executed",
      reason: "runtime_control_disallowed",
      operation,
      run_id: input.run_id,
    }, `Runtime control ${operation} is not authorized for this chat surface. The operation was not executed, and PulSeed will not fall back to shell tools.`, started, {
      status: "not_executed",
      reason: "policy_blocked",
      message: "runtime_control_disallowed",
    });
  }
  if (!deps.runtimeControlService) {
    return toolResult(false, {
      status: "not_executed",
      reason: "runtime_control_unavailable",
      operation,
      run_id: input.run_id,
    }, `Runtime control ${operation} is not available in this chat surface. The operation was not executed, and PulSeed will not fall back to shell tools.`, started, {
      status: "not_executed",
      reason: "policy_blocked",
      message: "runtime_control_unavailable",
    });
  }

  const freshness = await validateObservedRun(deps.stateManager, input);
  if (!freshness.ok) {
    return toolResult(false, freshness.data, freshness.message, started, {
      status: "not_executed",
      reason: "stale_state",
      message: freshness.message,
    });
  }

  const result = await deps.runtimeControlService.request({
    intent: {
      kind: operation,
      reason: input.reason,
      target: { runId: input.run_id },
    },
    cwd: context.cwd,
    requestedBy: parseActor(context.runtimeControlActor) ?? actorFromReplyTarget(context.runtimeReplyTarget),
    replyTarget: parseReplyTarget(context.runtimeReplyTarget) ?? { surface: "chat" },
    approvalFn: context.runtimeControlApprovalMode === "preapproved"
      ? async () => true
      : toolApprovalFn(context, toolName, { ...input }, operation === "cancel_run"),
  });
  return toolResult(result.success, {
    status: result.success ? "requested" : "not_executed",
    operation,
    run_id: freshness.run.id,
    observed_run_epoch: input.observed_run_epoch,
    operationId: result.operationId,
    state: result.state,
  }, result.message, started);
}

async function validateObservedRun(
  stateManager: StateManager,
  input: RuntimeRunControlToolInput,
): Promise<
  | { ok: true; run: BackgroundRun }
  | { ok: false; message: string; data: Record<string, unknown> }
> {
  const snapshot = await createRuntimeSessionRegistry({ stateManager }).snapshot();
  const run = snapshot.background_runs.find((candidate) => candidate.id === input.run_id);
  if (!run) {
    return {
      ok: false,
      message: `Runtime run ${input.run_id} is no longer present; refusing to reuse stale run state.`,
      data: {
        status: "stale_state",
        run_id: input.run_id,
        observed_run_epoch: input.observed_run_epoch,
      },
    };
  }
  const currentEpoch = backgroundRunEpoch(run);
  if (currentEpoch !== input.observed_run_epoch) {
    return {
      ok: false,
      message: `Runtime run ${input.run_id} changed since it was observed; refusing to control stale state.`,
      data: {
        status: "stale_state",
        run_id: input.run_id,
        current_run_epoch: currentEpoch,
        observed_run_epoch: input.observed_run_epoch,
      },
    };
  }
  return { ok: true, run };
}

function backgroundRunEpoch(run: BackgroundRun): string | null {
  return run.updated_at ?? run.started_at ?? run.created_at;
}

function providerConfigBaseDir(deps: SetupRuntimeControlToolDeps, context: ToolCallContext): string {
  return context.providerConfigBaseDir ?? deps.stateManager.getBaseDir();
}

function nextTelegramSetupAction(state: string, hasHomeChat: boolean): string {
  if (state === "unconfigured") return "configure_bot_token";
  if (!hasHomeChat) return "send_sethome";
  return "verify_delivery";
}

function languageHint(language: SetupGuidanceInput["language"], request?: string): TurnLanguageHint {
  if (language === "en" || language === "ja") return { language, confidence: 1, source: "caller" };
  return request ? detectTurnLanguageHint(request) : UNKNOWN_TURN_LANGUAGE_HINT;
}

function currentSetupSecret(context: ToolCallContext, kind: SetupSecretIntakeItem["kind"]): SetupSecretIntakeItem | null {
  const parsed = SetupSecretIntakeResultSchema.safeParse(context.setupSecretIntake);
  if (!parsed.success) return null;
  return parsed.data.suppliedSecrets.find((secret) => secret.kind === kind) ?? null;
}

async function getSetupDialogue(context: ToolCallContext): Promise<SetupDialogueRuntimeState | null> {
  const value = await context.setupDialogue?.get();
  if (!value || typeof value !== "object") return null;
  return value as SetupDialogueRuntimeState;
}

function runtimeControlAllowed(context: ToolCallContext): boolean {
  return context.runtimeControlAllowed !== false && context.runtimeControlApprovalMode !== "disallowed";
}

function parseActor(value: unknown): RuntimeControlActor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const surface = record["surface"];
  if (surface !== "chat" && surface !== "gateway" && surface !== "cli" && surface !== "tui") return undefined;
  return {
    surface,
    ...(typeof record["platform"] === "string" ? { platform: record["platform"] } : {}),
    ...(typeof record["conversation_id"] === "string" ? { conversation_id: record["conversation_id"] } : {}),
    ...(typeof record["identity_key"] === "string" ? { identity_key: record["identity_key"] } : {}),
    ...(typeof record["user_id"] === "string" ? { user_id: record["user_id"] } : {}),
  };
}

function parseReplyTarget(value: unknown): RuntimeControlReplyTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(isReplySurface(record["surface"]) ? { surface: record["surface"] } : {}),
    ...(isReplyChannel(record["channel"]) ? { channel: record["channel"] } : {}),
    ...(typeof record["platform"] === "string" ? { platform: record["platform"] } : {}),
    ...(typeof record["conversation_id"] === "string" ? { conversation_id: record["conversation_id"] } : {}),
    ...(typeof record["message_id"] === "string" ? { message_id: record["message_id"] } : {}),
    ...(typeof record["response_channel"] === "string" ? { response_channel: record["response_channel"] } : {}),
    ...(typeof record["outbox_topic"] === "string" ? { outbox_topic: record["outbox_topic"] } : {}),
    ...(typeof record["identity_key"] === "string" ? { identity_key: record["identity_key"] } : {}),
    ...(typeof record["user_id"] === "string" ? { user_id: record["user_id"] } : {}),
    ...(record["metadata"] && typeof record["metadata"] === "object" && !Array.isArray(record["metadata"]) ? { metadata: record["metadata"] as Record<string, unknown> } : {}),
  };
}

function actorFromReplyTarget(value: unknown): RuntimeControlActor {
  const replyTarget = parseReplyTarget(value);
  return {
    surface: replyTarget?.surface ?? "chat",
    ...(replyTarget?.platform ? { platform: replyTarget.platform } : {}),
    ...(replyTarget?.conversation_id ? { conversation_id: replyTarget.conversation_id } : {}),
    ...(replyTarget?.identity_key ? { identity_key: replyTarget.identity_key } : {}),
    ...(replyTarget?.user_id ? { user_id: replyTarget.user_id } : {}),
  };
}

function toolApprovalFn(
  context: ToolCallContext,
  toolName: string,
  input: Record<string, unknown>,
  isDestructive = false,
): (description: string) => Promise<boolean> {
  return (description) => context.approvalFn({
    toolName,
    input,
    reason: description,
    permissionLevel: "write_local",
    isDestructive,
    reversibility: "unknown",
  });
}

function isReplySurface(value: unknown): value is RuntimeControlReplyTarget["surface"] {
  return value === "chat" || value === "gateway" || value === "cli" || value === "tui";
}

function isReplyChannel(value: unknown): value is RuntimeControlReplyTarget["channel"] {
  return value === "tui" || value === "plugin_gateway" || value === "cli" || value === "web";
}

function makeMetadata(
  name: string,
  permissionLevel: ToolMetadata["permissionLevel"],
  isReadOnly: boolean,
  isDestructive = false,
): ToolMetadata {
  return {
    name,
    aliases: [],
    permissionLevel,
    isReadOnly,
    isDestructive,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 12000,
    tags: ["agentloop", "setup", "runtime-control"],
  };
}

function toolResult(
  success: boolean,
  data: unknown,
  summary: string,
  started: number,
  execution?: ToolResult["execution"],
): ToolResult {
  return {
    success,
    data,
    summary,
    ...(success ? {} : { error: summary }),
    ...(execution ? { execution } : {}),
    durationMs: Date.now() - started,
  };
}
