import * as path from "node:path";

import type { StateManager } from "../../../base/state/state-manager.js";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { getGatewayChannelDir } from "../../../base/utils/paths.js";
import { isDaemonRunning } from "../../../runtime/daemon/client.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../../../runtime/daemon/runtime-root.js";
import { BUILTIN_GATEWAY_CHANNEL_NAMES, type BuiltinGatewayChannelName } from "../../../runtime/gateway/builtin-channel-names.js";
import { createRuntimeSessionRegistry } from "../../../runtime/session-registry/index.js";
import type { BackgroundRun, RuntimeReplyTarget, RuntimeSession } from "../../../runtime/session-registry/types.js";
import { BackgroundRunLedger } from "../../../runtime/store/background-run-store.js";
import { RuntimeHealthStore } from "../../../runtime/store/health-store.js";
import type { RuntimeHealthSnapshot } from "../../../runtime/store/runtime-schemas.js";
import type { CapabilityOperatorStatusProjection } from "../../../runtime/control/capability-status-projection.js";

export type OperatorChannelState = "missing" | "configured" | "active" | "degraded";
export type RuntimeControlPermissionState = "allowed" | "missing_allowlist" | "unrestricted" | "unsupported";

export interface OperatorChannelBindingStatus {
  name: BuiltinGatewayChannelName | "slack";
  state: OperatorChannelState;
  config_path: string;
  configured: boolean;
  active: boolean;
  degraded: boolean;
  home_target: RuntimeReplyTarget | null;
  identity_key: string | null;
  default_goal_id: string | null;
  goal_bindings: OperatorChannelGoalBinding[];
  runtime_control: {
    state: RuntimeControlPermissionState;
    allowed_count: number;
  };
  access: {
    allow_all: boolean;
    allowed_count: number;
  };
  health: {
    daemon_running: boolean;
    gateway: RuntimeHealthSnapshot["status"] | "missing";
    checked_at: number | null;
  };
  recent_health: {
    inbound_at: string | null;
    outbound_at: string | null;
    last_error: string | null;
  };
  warnings: string[];
}

export interface OperatorBindingStatus {
  schema_version: "operator-binding-status-v1";
  generated_at: string;
  daemon: {
    running: boolean;
    port: number;
    health: RuntimeHealthSnapshot["status"] | "missing";
    runtime_root: string;
  };
  channels: OperatorChannelBindingStatus[];
  capability_runtime: CapabilityOperatorStatusProjection[];
  sessions: RuntimeSession[];
  background_runs: BackgroundRun[];
  warnings: string[];
}

interface ChannelConfigSummary {
  configured: boolean;
  valid: boolean;
  homeTarget: RuntimeReplyTarget | null;
  identityKey: string | null;
  defaultGoalId: string | null;
  goalBindings: OperatorChannelGoalBinding[];
  runtimeControlAllowedCount: number;
  runtimeControlState: RuntimeControlPermissionState;
  accessAllowAll: boolean;
  accessAllowedCount: number;
  warnings: string[];
}

export interface OperatorChannelGoalBinding {
  scope: "conversation" | "sender" | "default";
  subject_id: string | null;
  goal_id: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function goalBindingsFromMap(scope: "conversation" | "sender", value: unknown): OperatorChannelGoalBinding[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([subjectId, goalId]) => {
    const normalizedGoalId = nonEmptyString(goalId);
    return normalizedGoalId ? [{ scope, subject_id: subjectId, goal_id: normalizedGoalId }] : [];
  });
}

function defaultGoalBinding(goalId: string | null): OperatorChannelGoalBinding[] {
  return goalId ? [{ scope: "default", subject_id: null, goal_id: goalId }] : [];
}

const REQUIRED_SENDER_CONFIG_FIELDS = {
  "discord-bot": ["application_id", "bot_token", "channel_id", "identity_key", "command_name", "host"],
  "signal-bridge": ["bridge_url", "account", "recipient_id", "identity_key"],
  "whatsapp-webhook": ["phone_number_id", "access_token", "verify_token", "recipient_id", "identity_key", "host", "path"],
} as const satisfies Record<Exclude<BuiltinGatewayChannelName, "telegram-bot">, readonly string[]>;

function missingRequiredFields(raw: Record<string, unknown>, channel: Exclude<BuiltinGatewayChannelName, "telegram-bot">): string[] {
  return REQUIRED_SENDER_CONFIG_FIELDS[channel].filter((field) => nonEmptyString(raw[field]) === null);
}

function telegramSummary(raw: Record<string, unknown> | null): ChannelConfigSummary {
  if (!raw) return missingSummary();
  const hasBotToken = nonEmptyString(raw["bot_token"]) !== null;
  const warnings: string[] = [];
  const chatId = typeof raw["chat_id"] === "number" ? String(raw["chat_id"]) : null;
  const runtimeAllowedCount = arrayCount(raw["runtime_control_allowed_user_ids"]);
  const allowedUserCount = arrayCount(raw["allowed_user_ids"]);
  const defaultGoalId = nonEmptyString(raw["default_goal_id"]);
  if (!chatId) warnings.push("Missing Telegram home chat. Send /sethome from the target chat.");
  if (runtimeAllowedCount === 0) warnings.push("Missing Telegram runtime-control allowed user list.");
  return {
    configured: true,
    valid: hasBotToken,
    homeTarget: chatId ? { channel: "telegram", target_id: chatId } : null,
    identityKey: nonEmptyString(raw["identity_key"]),
    defaultGoalId,
    goalBindings: [
      ...goalBindingsFromMap("conversation", raw["chat_goal_map"]),
      ...goalBindingsFromMap("sender", raw["user_goal_map"]),
      ...defaultGoalBinding(defaultGoalId),
    ],
    runtimeControlAllowedCount: runtimeAllowedCount,
    runtimeControlState: runtimeAllowedCount > 0 ? "allowed" : "missing_allowlist",
    accessAllowAll: raw["allow_all"] === true,
    accessAllowedCount: allowedUserCount,
    warnings: [
      ...warnings,
      ...(!hasBotToken ? ["Invalid Telegram config: bot_token is missing."] : []),
      ...(raw["allow_all"] === true ? ["Telegram unrestricted allow_all is enabled."] : []),
    ],
  };
}

function senderSummary(raw: Record<string, unknown> | null, channel: Exclude<BuiltinGatewayChannelName, "telegram-bot">): ChannelConfigSummary {
  if (!raw) return missingSummary();
  const runtimeAllowedCount = arrayCount(raw["runtime_control_allowed_sender_ids"]);
  const identityKey = nonEmptyString(raw["identity_key"]);
  const defaultGoalId = nonEmptyString(raw["default_goal_id"]);
  const missingFields = missingRequiredFields(raw, channel);
  const targetId =
    nonEmptyString(raw["channel_id"])
    ?? nonEmptyString(raw["recipient_id"])
    ?? nonEmptyString(raw["account"]);
  const warnings: string[] = [];
  if (runtimeAllowedCount === 0) warnings.push(`Missing ${channel} runtime-control allowed sender list.`);
  if (!targetId) warnings.push(`Missing ${channel} default reply target.`);
  return {
    configured: true,
    valid: missingFields.length === 0,
    homeTarget: targetId ? { channel, target_id: targetId } : null,
    identityKey,
    defaultGoalId,
    goalBindings: [
      ...goalBindingsFromMap("conversation", raw["conversation_goal_map"]),
      ...goalBindingsFromMap("sender", raw["sender_goal_map"]),
      ...defaultGoalBinding(defaultGoalId),
    ],
    runtimeControlAllowedCount: runtimeAllowedCount,
    runtimeControlState: runtimeAllowedCount > 0 ? "allowed" : "missing_allowlist",
    accessAllowAll: false,
    accessAllowedCount: arrayCount(raw["allowed_sender_ids"]),
    warnings: [
      ...warnings,
      ...(missingFields.length > 0 ? [`Invalid ${channel} config: missing ${missingFields.join(", ")}.`] : []),
    ],
  };
}

function missingSummary(): ChannelConfigSummary {
  return {
    configured: false,
    valid: false,
    homeTarget: null,
    identityKey: null,
    defaultGoalId: null,
    goalBindings: [],
    runtimeControlAllowedCount: 0,
    runtimeControlState: "unsupported",
    accessAllowAll: false,
    accessAllowedCount: 0,
    warnings: [],
  };
}

function channelConfigPath(baseDir: string, channel: BuiltinGatewayChannelName): string {
  return path.join(getGatewayChannelDir(channel, baseDir), "config.json");
}

async function loadRawConfig(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readJsonFileOrNull<unknown>(filePath);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

async function loadRecentChannelHealth(configPath: string): Promise<OperatorChannelBindingStatus["recent_health"]> {
  const raw = await readJsonFileOrNull<Record<string, unknown>>(path.join(path.dirname(configPath), "health.json"));
  return {
    inbound_at: nonEmptyString(raw?.["last_inbound_at"]),
    outbound_at: nonEmptyString(raw?.["last_outbound_at"]),
    last_error: nonEmptyString(raw?.["last_error"]),
  };
}

function channelState(summary: ChannelConfigSummary, daemonRunning: boolean, gatewayHealth: RuntimeHealthSnapshot["status"] | "missing"): OperatorChannelState {
  if (!summary.configured) return "missing";
  if (!summary.valid || gatewayHealth === "failed" || gatewayHealth === "degraded") return "degraded";
  if (daemonRunning && gatewayHealth === "ok") return "active";
  return "configured";
}

function activeRun(run: BackgroundRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "failed" || run.status === "timed_out" || run.status === "lost";
}

function formatReplyTarget(target: RuntimeReplyTarget | null): string {
  if (!target) return "-";
  const targetId = target.target_id ?? target.thread_id ?? null;
  return targetId ? `${target.channel}:${targetId}` : target.channel;
}

export async function collectOperatorBindingStatus(stateManager: StateManager): Promise<OperatorBindingStatus> {
  const baseDir = stateManager.getBaseDir();
  const runtimeRoot = resolveConfiguredDaemonRuntimeRoot(baseDir);
  const [daemon, health, registrySnapshot] = await Promise.all([
    isDaemonRunning(baseDir),
    new RuntimeHealthStore(runtimeRoot).loadSnapshot(),
    createRuntimeSessionRegistry({
      stateManager,
      backgroundRunLedger: new BackgroundRunLedger(runtimeRoot),
    }).snapshot(),
  ]);
  const gatewayHealth = health?.components.gateway ?? "missing";
  const channels: OperatorChannelBindingStatus[] = [];
  for (const name of BUILTIN_GATEWAY_CHANNEL_NAMES) {
    const configPath = channelConfigPath(baseDir, name);
    const raw = await loadRawConfig(configPath);
    const recentHealth = await loadRecentChannelHealth(configPath);
    const summary = name === "telegram-bot" ? telegramSummary(raw) : senderSummary(raw, name);
    const state = channelState(summary, daemon.running, gatewayHealth);
    channels.push({
      name,
      state,
      config_path: configPath,
      configured: summary.configured,
      active: state === "active",
      degraded: state === "degraded",
      home_target: summary.homeTarget,
      identity_key: summary.identityKey,
      default_goal_id: summary.defaultGoalId,
      goal_bindings: summary.goalBindings,
      runtime_control: {
        state: summary.runtimeControlState,
        allowed_count: summary.runtimeControlAllowedCount,
      },
      access: {
        allow_all: summary.accessAllowAll,
        allowed_count: summary.accessAllowedCount,
      },
      health: {
        daemon_running: daemon.running,
        gateway: gatewayHealth,
        checked_at: health?.checked_at ?? null,
      },
      recent_health: recentHealth,
      warnings: summary.warnings,
    });
  }

  const warnings = [
    ...registrySnapshot.warnings.map((warning) => warning.message),
    ...channels.flatMap((channel) => channel.warnings.map((warning) => `${channel.name}: ${warning}`)),
    ...(!daemon.running ? ["Daemon is not running."] : []),
  ];

  return {
    schema_version: "operator-binding-status-v1",
    generated_at: new Date().toISOString(),
    daemon: {
      running: daemon.running,
      port: daemon.port,
      health: health?.status ?? "missing",
      runtime_root: runtimeRoot,
    },
    channels,
    capability_runtime: [],
    sessions: registrySnapshot.sessions,
    background_runs: registrySnapshot.background_runs.filter(activeRun),
    warnings,
  };
}

export function printOperatorBindingStatus(status: OperatorBindingStatus): void {
  console.log("Operator bindings:");
  console.log(`Daemon: ${status.daemon.running ? "running" : "down"} (port ${status.daemon.port || "-"}) health=${status.daemon.health} runtime_root=${status.daemon.runtime_root}`);
  console.log("\nChannels:");
  for (const channel of status.channels) {
    console.log(
      `- ${channel.name}: ${channel.state}; home=${formatReplyTarget(channel.home_target)}; identity=${channel.identity_key ?? "-"}; runtime_control=${channel.runtime_control.state} (${channel.runtime_control.allowed_count})`
    );
    console.log(`  access allow_all=${channel.access.allow_all ? "yes" : "no"} allowed=${channel.access.allowed_count}`);
    for (const binding of channel.goal_bindings) {
      const subject = binding.subject_id ? `${binding.scope}:${binding.subject_id}` : binding.scope;
      console.log(`  goal_binding ${subject} -> ${binding.goal_id}`);
    }
  }
  console.log("\nSessions:");
  if (status.sessions.length === 0) {
    console.log("- none");
  } else {
    for (const session of status.sessions) {
      console.log(`- ${session.id} [${session.kind}/${session.status}] workspace=${session.workspace ?? "-"} reply=${formatReplyTarget(session.reply_target)}`);
    }
  }
  console.log("\nBackground runs:");
  if (status.background_runs.length === 0) {
    console.log("- none");
  } else {
    for (const run of status.background_runs) {
      console.log(
        `- ${run.id} [${run.kind}/${run.status}] parent=${run.parent_session_id ?? "-"} goal=${run.goal_id ?? "-"} pinned_reply=${formatReplyTarget(run.pinned_reply_target)}`
      );
    }
  }
  console.log("\nCapability runtime:");
  if (status.capability_runtime.length === 0) {
    console.log("- none");
  } else {
    for (const capability of status.capability_runtime) {
      console.log(
        `- ${capability.capability_id} ${capability.operation_id}: readiness=${capability.readiness.label}; admission=${capability.admission.label}; autonomy=${capability.autonomy.label}; execution=${capability.execution.label}`
      );
      console.log(
        `  can_execute=${capability.execution.can_execute ? "yes" : "no"} may_execute=${capability.execution.may_execute_now ? "yes" : "no"} may_initiate=${capability.execution.may_initiate_autonomously ? "yes" : "no"}`
      );
      for (const warning of capability.warnings) {
        console.log(`  warning ${warning}`);
      }
    }
  }
  if (status.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of status.warnings) console.log(`- ${warning}`);
  }
}
