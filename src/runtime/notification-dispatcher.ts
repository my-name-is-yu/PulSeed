import type { Logger } from "./logger.js";
import type { Report } from "../base/types/report.js";
import type {
  NotificationChannel,
  NotificationConfig,
  NotificationResult,
  SlackChannel,
  EmailChannel,
  WebhookChannel,
} from "../base/types/notification.js";
import { NotificationConfigSchema } from "../base/types/notification.js";
import type { NotificationEvent, NotificationEventType } from "../base/types/plugin.js";
import type { NotifierRegistry } from "./notifier-registry.js";
import { sendSlack } from "./channels/slack-channel.js";
import { sendEmail } from "./channels/email-channel.js";
import { sendWebhook } from "./channels/webhook-channel.js";
import { NotificationBatcher } from "./notification-batcher.js";
import type { InterventionDecisionKind, InterventionTargetEffect, PersonalAgentRuntimeStore } from "./personal-agent/index.js";
import { buildPersonalAgentDecisionTrace } from "./personal-agent/index.js";
import { projectNotificationAuthority } from "./control/execution-authority-decision.js";
import type { InteractionAuthorityStore } from "./control/interaction-authority-store.js";
import {
  admitCapabilityDescriptor,
  descriptorFromGatewayChannelAction,
  type CapabilityDescriptor,
} from "./capability-plane.js";

// ─── Interface ───

export interface INotificationDispatcher {
  dispatch(report: Report): Promise<NotificationResult[]>;
}

// ─── Report type → NotificationEventType mapping ───

/**
 * Map an internal report_type string to the closest NotificationEventType
 * for routing to INotifier plugins. Returns null when no mapping applies.
 */
function reportTypeToEventType(reportType: string): NotificationEventType | null {
  switch (reportType) {
    case "goal_completion":
      return "goal_complete";
    case "approval_request":
      return "approval_needed";
    case "urgent_alert":
      return "approval_needed";
    case "stall_escalation":
      return "stall_detected";
    case "strategy_change":
      return "goal_progress";
    case "capability_escalation":
      return "task_blocked";
    case "progress_update":
      return "goal_progress";
    case "daily_summary":
      return "goal_progress";
    case "weekly_report":
      return "goal_progress";
    case "execution_summary":
      return "goal_progress";
    case "schedule_change":
      return "schedule_change_detected";
    case "schedule_heartbeat_failure":
      return "schedule_heartbeat_failure";
    case "schedule_escalation":
      return "schedule_escalation";
    case "schedule_report_ready":
      return "schedule_report_ready";
    case "schedule_report":
      return "schedule_report_ready";
    default:
      return null;
  }
}

// ─── NotificationDispatcher ───

export class NotificationDispatcher implements INotificationDispatcher {
  private config: NotificationConfig;
  /** reportType -> timestamp of last successful send */
  private lastSent: Map<string, number> = new Map();
  private notifierRegistry?: NotifierRegistry;
  private readonly logger?: Logger;
  private batcher?: NotificationBatcher;
  private realtimeSink?: (report: Report) => void | Promise<void>;
  private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  private readonly interactionAuthorityStore?: Pick<InteractionAuthorityStore, "recordDecision">;

  constructor(
    config?: Partial<NotificationConfig>,
    notifierRegistry?: NotifierRegistry,
    logger?: Logger,
    personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
    interactionAuthorityStore?: Pick<InteractionAuthorityStore, "recordDecision">,
  ) {
    this.config = NotificationConfigSchema.parse(config ?? {});
    this.notifierRegistry = notifierRegistry;
    this.logger = logger;
    this.personalAgentRuntime = personalAgentRuntime;
    this.interactionAuthorityStore = interactionAuthorityStore;

    if (this.config.batching.enabled) {
      this.batcher = new NotificationBatcher(
        {
          window_minutes: this.config.batching.window_minutes,
          digest_format: this.config.batching.digest_format,
        },
        async (digest) => { await this.sendReport(digest); }
      );
    }
  }

  /** Flush batcher and stop the timer. Call on shutdown. */
  async stop(): Promise<void> {
    await this.batcher?.stop();
  }

  setRealtimeSink(sink: ((report: Report) => void | Promise<void>) | undefined): void {
    this.realtimeSink = sink;
  }

  /** Dispatch report to all configured channels */
  async dispatch(report: Report): Promise<NotificationResult[]> {
    // If batching is enabled, non-immediate reports go to the batcher
    if (this.batcher) {
      const batched = this.batcher.add(report);
      if (batched) {
        await this.recordNotificationDecision(report, [], {
          decision: "hold",
          reason: "Notification report was held by batching policy before any interruption was sent.",
          targetEffect: "hold_concern",
          capabilityDecision: "not_applicable",
        });
        return [];
      }
    }

    return this.sendReport(report);
  }

  /** Send a report directly to all channels (bypasses batching). */
  private async sendReport(report: Report): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];

    const channels = this.getChannelsForReport(report);
    const dnd = this.isDND(report.report_type);
    const cooldown = this.isCooldown(report.report_type);
    if (dnd || cooldown) {
      const suppressionReason = dnd ? "dnd" : "cooldown";
      await this.recordNotificationDecision(report, channels, {
        decision: "suppress",
        reason: dnd
          ? "Notification report was suppressed by do-not-disturb policy before interruption delivery."
          : "Notification report was suppressed by cooldown policy before interruption delivery.",
        targetEffect: "hold_concern",
        capabilityDecision: "not_applicable",
        replayScope: `suppress:${suppressionReason}`,
      });
      for (const channel of channels) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: suppressionReason,
        });
      }
      await this.dispatchToPluginNotifiers(report);
      await this.dispatchRealtimeSink(report);
      return results;
    }

    const acceptedChannels = channels.filter((channel) => this.channelAcceptsReportType(channel, report.report_type));
    const filteredChannels = channels.filter((channel) => !this.channelAcceptsReportType(channel, report.report_type));
    const hasPluginRoute = this.hasPluginRoute(report);

    if (acceptedChannels.length > 0 || hasPluginRoute) {
      await this.recordNotificationDecision(report, acceptedChannels);
    }
    if (filteredChannels.length > 0) {
      await this.recordNotificationDecision(report, filteredChannels, {
        decision: "suppress",
        reason: "Notification report was suppressed for one or more channels by report-type routing policy.",
        targetEffect: "hold_concern",
        capabilityDecision: "not_applicable",
        replayScope: `suppress:filtered:${filteredChannels.map((channel) => channel.type).sort().join(",")}`,
      });
    }
    if (acceptedChannels.length === 0 && !hasPluginRoute && filteredChannels.length === 0) {
      await this.recordNotificationDecision(report, [], {
        decision: "suppress",
        reason: "Notification report had no configured channel or plugin route.",
        targetEffect: "hold_concern",
        capabilityDecision: "not_applicable",
        replayScope: "suppress:no-route",
      });
    }

    for (const channel of acceptedChannels) {
      const descriptor = this.gatewayChannelDescriptor(channel.type, report);
      const admission = admitCapabilityDescriptor({
        descriptor,
        rawInput: {
          report_id: report.id,
          report_type: report.report_type,
          channel_type: channel.type,
        },
        context: {
          preApproved: true,
          authorityRefs: descriptor.authority_requirements.required_refs,
        },
      });
      if (admission.status !== "allowed") {
        await this.recordNotificationDecision(report, [channel], {
          decision: "block",
          reason: admission.reason,
          targetEffect: "none",
          capabilityDecision: "blocked",
          replayScope: `capability-blocked:${channel.type}`,
        });
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "capability_blocked",
          error: admission.reason,
        });
        continue;
      }

      const result = await this.sendToChannel(channel, report);
      results.push(result);

      if (result.success) {
        this.lastSent.set(report.report_type, Date.now());
      }
    }
    for (const channel of filteredChannels) {
      results.push({
        channel_type: channel.type,
        success: false,
        suppressed: true,
        suppression_reason: "filtered",
      });
    }

    // Route to NotifierRegistry plugins (additive, failures don't affect core dispatch)
    await this.dispatchToPluginNotifiers(report);

    await this.dispatchRealtimeSink(report);

    return results;
  }

  /**
   * Route the report to all matching INotifier plugins registered in the
   * NotifierRegistry. Plugin failures are logged but never propagated.
   */
  private async dispatchToPluginNotifiers(report: Report): Promise<void> {
    if (!this.notifierRegistry) return;
    if (this.isDND(report.report_type) || this.isCooldown(report.report_type)) return;

    const eventType = reportTypeToEventType(report.report_type);
    if (eventType === null) return;

    const notifiers = this.notifierRegistry
      .findForEvent(eventType)
      .filter((notifier) => this.pluginNotifierAcceptsReportType(notifier.name, report.report_type));
    if (notifiers.length === 0) return;

    const event: NotificationEvent = {
      type: eventType,
      goal_id: report.goal_id ?? "",
      timestamp: report.generated_at,
      summary: report.title,
      details: {
        report_id: report.id,
        report_type: report.report_type,
        content: report.content,
        verbosity: report.verbosity,
      },
      severity: this.resolveSeverity(report.report_type),
    };

    const admittedNotifiers = notifiers.filter((notifier) => {
      const descriptor = this.gatewayChannelDescriptor(`plugin:${notifier.name}`, report);
      const admission = admitCapabilityDescriptor({
        descriptor,
        rawInput: {
          report_id: report.id,
          report_type: report.report_type,
          channel_type: `plugin:${notifier.name}`,
        },
        context: {
          preApproved: true,
          authorityRefs: descriptor.authority_requirements.required_refs,
        },
      });
      if (admission.status !== "allowed") {
        this.logger?.warn?.(`[NotificationDispatcher] plugin notifier "${notifier.name}" blocked by Capability Plane: ${admission.reason}`);
        return false;
      }
      return true;
    });
    if (admittedNotifiers.length === 0) return;

    const settlements = await Promise.allSettled(
      admittedNotifiers.map((n) => n.notify(event))
    );

    let delivered = false;
    for (let i = 0; i < settlements.length; i++) {
      const result = settlements[i];
      if (result.status === "rejected") {
        const notifierName = admittedNotifiers[i].name;
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger?.error(`[NotificationDispatcher] plugin notifier "${notifierName}" failed: ${reason}`);
      } else {
        delivered = true;
      }
    }
    if (delivered) {
      this.lastSent.set(report.report_type, Date.now());
    }
  }

  /** Derive a severity level from the report type. */
  private resolveSeverity(reportType: string): "info" | "warning" | "critical" {
    if (reportType === "urgent_alert") return "critical";
    if (reportType === "stall_escalation" || reportType === "capability_escalation") return "warning";
    return "info";
  }

  // ─── Private helpers ───

  /**
   * Return the channels applicable to this report. Per-goal overrides take
   * priority over the global channel list.
   */
  private getChannelsForReport(report: Report): NotificationChannel[] {
    if (report.goal_id) {
      const override = this.config.goal_overrides.find(
        (o) => o.goal_id === report.goal_id
      );
      if (override?.channels && override.channels.length > 0) {
        return override.channels;
      }
    }
    return this.config.channels;
  }

  private getCooldownMinutes(reportType: string): number {
    const cooldown = this.config.cooldown as Record<string, number>;
    return cooldown[reportType] ?? 0;
  }

  /** Check if currently in DND hours for the given report type. */
  private isDND(reportType: string): boolean {
    const dnd = this.config.do_not_disturb;
    if (!dnd.enabled) return false;

    // Exceptions bypass DND (urgent_alert, approval_request by default)
    if (dnd.exceptions.includes(reportType)) return false;

    const now = new Date();
    const hour = now.getHours();

    // Handle overnight DND (e.g., 22:00–07:00)
    if (dnd.start_hour > dnd.end_hour) {
      return hour >= dnd.start_hour || hour < dnd.end_hour;
    }
    return hour >= dnd.start_hour && hour < dnd.end_hour;
  }

  /** Check cooldown: true if we should suppress due to recent send. */
  private isCooldown(reportType: string): boolean {
    const cooldownMinutes = this.getCooldownMinutes(reportType);
    if (cooldownMinutes <= 0) return false;

    const lastSent = this.lastSent.get(reportType);
    if (lastSent === undefined) return false;

    const elapsedMs = Date.now() - lastSent;
    return elapsedMs < cooldownMinutes * 60 * 1000;
  }

  /**
   * Return true if the channel should receive this report type.
   * An empty report_types array means "accept all."
   */
  private channelAcceptsReportType(
    channel: NotificationChannel,
    reportType: string
  ): boolean {
    if (channel.report_types.length === 0) return true;
    return channel.report_types.includes(reportType);
  }

  /**
   * Decide whether a registered INotifier should receive this report.
   * mode=all keeps existing behavior unless a per-notifier route disables or narrows it.
   * mode=only sends only to explicitly listed enabled routes.
   * mode=none disables plugin notifier delivery while legacy channels still work.
   */
  private pluginNotifierAcceptsReportType(notifierName: string, reportType: string): boolean {
    const routing = this.config.plugin_notifiers;
    if (routing.mode === "none") {
      return false;
    }

    const route = routing.routes.find((candidate) => candidate.id === notifierName);
    if (routing.mode === "only" && route === undefined) {
      return false;
    }
    if (route?.enabled === false) {
      return false;
    }
    if (route && route.report_types.length > 0) {
      return route.report_types.includes(reportType);
    }
    return true;
  }

  private hasPluginRoute(report: Report): boolean {
    const eventType = reportTypeToEventType(report.report_type);
    return Boolean(this.notifierRegistry && eventType && this.notifierRegistry
      .findForEvent(eventType)
      .some((notifier) => this.pluginNotifierAcceptsReportType(notifier.name, report.report_type)));
  }

  private async dispatchRealtimeSink(report: Report): Promise<void> {
    if (!this.realtimeSink) return;
    try {
      await this.realtimeSink(report);
    } catch (err) {
      this.logger?.warn?.(`[NotificationDispatcher] realtime sink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Dispatch to the correct sender based on channel type. */
  private async sendToChannel(
    channel: NotificationChannel,
    report: Report
  ): Promise<NotificationResult> {
    switch (channel.type) {
      case "slack":
        return sendSlack(channel as SlackChannel, report);
      case "email":
        return sendEmail(channel as EmailChannel, report);
      case "webhook":
        return sendWebhook(channel as WebhookChannel, report);
    }
  }

  private async recordNotificationDecision(
    report: Report,
    channels: NotificationChannel[],
    override?: {
      decision: InterventionDecisionKind;
      reason: string;
      targetEffect: InterventionTargetEffect;
      capabilityDecision: "available" | "missing" | "permission_required" | "blocked" | "not_applicable";
      replayScope?: string;
    },
  ): Promise<void> {
    if (!this.personalAgentRuntime && !this.interactionAuthorityStore) return;
    const dnd = this.isDND(report.report_type);
    const cooldown = this.isCooldown(report.report_type);
    const hasPluginRoute = this.hasPluginRoute(report);
    const decision = override?.decision ?? (channels.length === 0 && !hasPluginRoute
      ? "suppress"
      : dnd || cooldown
        ? "suppress"
        : "allow");
    const reason = override?.reason ?? (decision === "allow"
      ? "Notification report was admitted for dispatch after routing policy evaluation."
      : dnd
        ? "Notification report was suppressed by do-not-disturb policy."
        : cooldown
          ? "Notification report was suppressed by cooldown policy."
          : "Notification report had no configured channel or plugin route.");
    await this.interactionAuthorityStore?.recordDecision(projectNotificationAuthority({
      reportId: report.id,
      reportType: report.report_type,
      decidedAt: validDateTimeOrNow(report.generated_at),
      channelRefs: channels.map((channel) => channel.type),
      canNotify: decision === "allow",
      suppressed: decision === "suppress" || decision === "hold",
      quietingRef: override?.replayScope ?? (dnd ? "notification:dnd" : cooldown ? "notification:cooldown" : undefined),
      reason,
    }));
    if (!this.personalAgentRuntime) return;
    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "notification_interruption",
      source: {
        sourceKind: "notification_report",
        sourceId: override?.replayScope ? `${report.id}:${override.replayScope}` : report.id,
        emittedAt: validDateTimeOrNow(report.generated_at),
        sourceEpoch: report.report_type,
        highWatermark: `${report.goal_id ?? "goal:none"}:${report.delivered_at ?? "undelivered"}`,
        replayKey: [
          "notification",
          report.id,
          report.report_type,
          report.generated_at,
          report.goal_id ?? "",
          override?.replayScope ?? "dispatch",
        ].join(":"),
        summary: `Notification report "${report.report_type}" entered interruption policy.`,
        sourceRef: { kind: "report", ref: report.id },
      },
      target: {
        kind: "notification",
        ref: { kind: "report", ref: report.id },
        effect: override?.targetEffect ?? (decision === "allow" ? "send_notification" : "none"),
        summary: report.title,
      },
      decision,
      decisionReason: reason,
      capabilityDecision: override?.capabilityDecision ?? (decision === "allow" ? "available" : "not_applicable"),
      capabilityRefs: [
        ...channels.flatMap((channel) => this.gatewayChannelCapabilityRefs(channel.type, report)),
        ...(hasPluginRoute ? [{ kind: "notification_channel", ref: "plugin_notifier_route" }] : []),
      ],
      policyRef: { kind: "intervention_policy", ref: "policy:notification-interruption-v1" },
      currentRefs: [
        { kind: "report", ref: report.id },
        ...(report.goal_id ? [{ kind: "goal", ref: report.goal_id }] : []),
      ],
    }));
  }

  private gatewayChannelDescriptor(channelType: string, report: Report): CapabilityDescriptor {
    return descriptorFromGatewayChannelAction({
      channelType,
      reportType: report.report_type,
      routeRef: `${channelType}:${report.goal_id ?? "goal:none"}`,
    });
  }

  private gatewayChannelCapabilityRefs(channelType: string, report: Report): Array<{ kind: string; ref: string }> {
    const descriptor = this.gatewayChannelDescriptor(channelType, report);
    return [
      { kind: "capability", ref: descriptor.capability_id },
      { kind: "capability_provider", ref: descriptor.provider_ref },
      { kind: "capability_operation", ref: descriptor.runtime_graph_refs.operation_ref },
      { kind: "capability_readiness", ref: descriptor.readiness_state },
      { kind: "notification_channel", ref: channelType },
    ];
  }
}

function validDateTimeOrNow(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}
