import * as path from "node:path";
import { z } from "zod/v3";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../base/utils/json-io.js";
import { getPulseedDirPath } from "../base/utils/paths.js";
import { NotificationConfigSchema } from "../base/types/notification.js";
import type { NotificationConfig, PluginNotifierRoute } from "../base/types/notification.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";

export interface NotificationRoutingUpdate {
  config: NotificationConfig;
  selected_notifiers: string[];
  report_types: string[];
  mode: "all" | "only" | "none";
  enabled: boolean | null;
  applied: boolean;
  summary: string;
  decision: NotificationRoutingDecision;
}

const MIN_NOTIFICATION_ROUTING_CONFIDENCE = 0.7;

export const PluginNotifierIdSchema = z.enum([
  "discord-bot",
  "whatsapp-webhook",
  "signal-bridge",
  "telegram-bot",
  "slack-notifier",
]);
export type PluginNotifierId = z.infer<typeof PluginNotifierIdSchema>;

export const NotificationReportTypeSchema = z.enum([
  "urgent_alert",
  "approval_request",
  "stall_escalation",
  "goal_completion",
  "daily_summary",
  "weekly_report",
  "execution_summary",
  "strategy_change",
  "capability_escalation",
]);
export type NotificationReportType = z.infer<typeof NotificationReportTypeSchema>;

export const NotificationRoutingDecisionSchema = z.object({
  action: z.enum(["update_routes", "disable_all", "unsupported", "ambiguous"]),
  selected_notifiers: z.array(PluginNotifierIdSchema).default([]),
  report_types: z.array(NotificationReportTypeSchema).default([]),
  mode: z.enum(["all", "only", "none"]).nullable().default(null),
  enabled: z.boolean().nullable().default(null),
  confidence: z.number().min(0).max(1),
  clarification: z.string().optional(),
  reason: z.string().optional(),
});
export type NotificationRoutingDecision = z.output<typeof NotificationRoutingDecisionSchema>;

export interface NotificationRoutingParserContext {
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
}

export function getNotificationConfigPath(baseDir?: string): string {
  return path.join(baseDir ?? getPulseedDirPath(), "notification.json");
}

export async function loadNotificationConfig(
  configPath = getNotificationConfigPath(),
  options: { invalid?: "default" | "throw" } = {}
): Promise<NotificationConfig> {
  const raw = await readJsonFileOrNull(configPath);
  if (raw === null) {
    return NotificationConfigSchema.parse({});
  }
  const result = NotificationConfigSchema.safeParse(raw);
  if (!result.success) {
    if (options.invalid === "throw") {
      throw new Error(`Invalid notification config: ${result.error.message}`);
    }
    return NotificationConfigSchema.parse({});
  }
  return result.data;
}

export async function saveNotificationConfig(configPath: string, config: NotificationConfig): Promise<void> {
  const parsed = NotificationConfigSchema.parse(config);
  await writeJsonFileAtomic(configPath, parsed);
}

export async function applyNaturalLanguageNotificationRouting(
  instruction: string,
  configPath = getNotificationConfigPath(),
  context: NotificationRoutingParserContext = {},
): Promise<NotificationRoutingUpdate> {
  const config = await loadNotificationConfig(configPath, { invalid: "throw" });
  const update = await applyNaturalLanguageNotificationRoutingToConfig(config, instruction, context);
  if (update.applied) {
    await saveNotificationConfig(configPath, update.config);
  }
  return update;
}

export async function applyNaturalLanguageNotificationRoutingToConfig(
  config: NotificationConfig,
  instruction: string,
  context: NotificationRoutingParserContext = {},
): Promise<NotificationRoutingUpdate> {
  const decision = await parseNotificationRoutingInstruction(instruction, context);
  return applyNotificationRoutingDecisionToConfig(config, decision, instruction);
}

export function applyNotificationRoutingDecisionToConfig(
  config: NotificationConfig,
  rawDecision: NotificationRoutingDecision,
  instruction = "",
): NotificationRoutingUpdate {
  const decision = normalizeRoutingDecision(rawDecision);
  const selected = decision.selected_notifiers;
  const reportTypes = decision.report_types;

  const nextConfig = NotificationConfigSchema.parse(config);
  const currentRoutes = nextConfig.plugin_notifiers.routes;
  const blocked = decision.action === "ambiguous"
    || decision.action === "unsupported"
    || decision.confidence < MIN_NOTIFICATION_ROUTING_CONFIDENCE;

  if (blocked) {
    return {
      config: nextConfig,
      selected_notifiers: selected,
      report_types: reportTypes,
      mode: nextConfig.plugin_notifiers.mode,
      enabled: null,
      applied: false,
      summary: buildBlockedSummary(decision, instruction),
      decision,
    };
  }

  if (decision.action === "disable_all") {
    nextConfig.plugin_notifiers = {
      mode: "none",
      routes: currentRoutes,
    };
  } else {
    const mode = decision.mode ?? "all";
    const enabled = decision.enabled ?? true;
    nextConfig.plugin_notifiers = {
      mode,
      routes: mergeRoutes(currentRoutes, selected, reportTypes, enabled),
    };
  }

  const parsed = NotificationConfigSchema.parse(nextConfig);
  return {
    config: parsed,
    selected_notifiers: selected,
    report_types: reportTypes,
    mode: parsed.plugin_notifiers.mode,
    enabled: decision.action === "disable_all" ? false : decision.enabled ?? true,
    applied: true,
    summary: buildSummary(parsed.plugin_notifiers.mode, selected, reportTypes, decision, instruction),
    decision,
  };
}

function mergeRoutes(
  routes: PluginNotifierRoute[],
  selected: string[],
  reportTypes: string[],
  enabled: boolean
): PluginNotifierRoute[] {
  const byId = new Map(routes.map((route) => [route.id, { ...route }]));
  for (const id of selected) {
    const existing = byId.get(id);
    byId.set(id, {
      id,
      enabled,
      report_types: reportTypes.length > 0 ? reportTypes : existing?.report_types ?? [],
    });
  }
  return Array.from(byId.values());
}

export async function parseNotificationRoutingInstruction(
  instruction: string,
  context: NotificationRoutingParserContext = {},
): Promise<NotificationRoutingDecision> {
  const trimmed = instruction.trim();
  const llmClient = context.llmClient;
  if (!trimmed) {
    return {
      action: "ambiguous",
      selected_notifiers: [],
      report_types: [],
      mode: null,
      enabled: null,
      confidence: 0,
      clarification: "Provide the notification routing change to apply.",
      reason: "empty instruction",
    };
  }
  if (!llmClient) {
    return {
      action: "unsupported",
      selected_notifiers: [],
      report_types: [],
      mode: null,
      enabled: null,
      confidence: 0,
      clarification: "Notification routing changes need the structured routing parser, but no model client is available.",
      reason: "model unavailable",
    };
  }
  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getNotificationRoutingPrompt(), max_tokens: 700, temperature: 0 },
    );
    const parsed = NotificationRoutingDecisionSchema.parse(
      llmClient.parseJSON(response.content, NotificationRoutingDecisionSchema)
    );
    return normalizeRoutingDecision(parsed);
  } catch (err) {
    return {
      action: "unsupported",
      selected_notifiers: [],
      report_types: [],
      mode: null,
      enabled: null,
      confidence: 0,
      clarification: "Notification routing instruction could not be parsed into the routing schema.",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSummary(
  mode: "all" | "only" | "none",
  selected: string[],
  reportTypes: string[],
  decision: NotificationRoutingDecision,
  instruction: string
): string {
  if (mode === "none") {
    return "Plugin notification delivery disabled from instruction: " + instruction;
  }
  const target = selected.length > 0 ? selected.join(", ") : "(no specific plugin notifier)";
  const reportScope = reportTypes.length > 0 ? reportTypes.join(", ") : "all report types";
  const enabled = decision.enabled === false ? "disabled" : "enabled";
  return `Plugin notification routing set to ${mode}: ${target} ${enabled} for ${reportScope}`;
}

function buildBlockedSummary(decision: NotificationRoutingDecision, instruction: string): string {
  const reason = decision.clarification ?? decision.reason ?? "instruction was ambiguous or unsupported";
  const source = instruction ? ` from instruction: ${instruction}` : "";
  return `Plugin notification routing unchanged${source}. ${reason}`;
}

function normalizeRoutingDecision(decision: NotificationRoutingDecision): NotificationRoutingDecision {
  const selected = unique(decision.selected_notifiers);
  const reportTypes = unique(decision.report_types);
  if (decision.action === "disable_all") {
    return {
      ...decision,
      selected_notifiers: [],
      report_types: [],
      mode: "none",
      enabled: false,
    };
  }
  if (decision.action !== "update_routes") {
    return {
      ...decision,
      selected_notifiers: selected,
      report_types: reportTypes,
      mode: null,
      enabled: null,
    };
  }
  if (selected.length === 0) {
    return {
      ...decision,
      action: "ambiguous",
      selected_notifiers: [],
      report_types: reportTypes,
      mode: null,
      enabled: null,
      clarification: decision.clarification ?? "No supported plugin notifier target was selected.",
    };
  }
  return {
    ...decision,
    selected_notifiers: selected,
    report_types: reportTypes,
    mode: decision.mode ?? "all",
    enabled: decision.enabled ?? true,
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function getNotificationRoutingPrompt(): string {
  return `${getInternalIdentityPrefix("assistant")} Convert the operator's notification-routing instruction into the typed PulSeed notification routing schema.

Do not guess. If the instruction is vague, unsupported, or does not clearly ask to change plugin notification routing, return ambiguous or unsupported. If the user asks to disable every plugin notifier, return disable_all. If the user asks to disable one or more specific notifiers, return update_routes with enabled false. If the user asks for a single selected route to be exclusive, use mode only. Otherwise use mode all.

Supported plugin notifier ids:
- discord-bot
- whatsapp-webhook
- signal-bridge
- telegram-bot
- slack-notifier

Supported report types:
- urgent_alert
- approval_request
- stall_escalation
- goal_completion
- daily_summary
- weekly_report
- execution_summary
- strategy_change
- capability_escalation

Respond only as JSON:
{
  "action": "update_routes" | "disable_all" | "unsupported" | "ambiguous",
  "selected_notifiers": ["discord-bot"],
  "report_types": ["weekly_report"],
  "mode": "all" | "only" | "none" | null,
  "enabled": true | false | null,
  "confidence": 0.0-1.0,
  "clarification": "question or explanation when ambiguous/unsupported",
  "reason": "short rationale"
}`;
}
