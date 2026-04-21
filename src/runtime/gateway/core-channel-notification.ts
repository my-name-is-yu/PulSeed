import type { NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";

export const CORE_GATEWAY_SUPPORTED_EVENTS: NotificationEventType[] = [
  "goal_progress",
  "goal_complete",
  "task_blocked",
  "approval_needed",
  "stall_detected",
  "trust_change",
  "schedule_change_detected",
  "schedule_heartbeat_failure",
  "schedule_escalation",
  "schedule_report_ready",
];

export function supportsCoreGatewayNotification(eventType: NotificationEventType): boolean {
  return CORE_GATEWAY_SUPPORTED_EVENTS.includes(eventType);
}

export function formatPlaintextNotification(event: NotificationEvent): string {
  const detailKeys = Object.keys(event.details);
  const detailSuffix = detailKeys.length > 0 ? ` | details: ${detailKeys.join(",")}` : "";
  const content = typeof event.details["content"] === "string" ? `\n\n${event.details["content"]}` : "";
  return `[${event.severity}] ${event.summary} (goal ${event.goal_id})${detailSuffix}${content}`;
}

export function formatTelegramNotification(event: NotificationEvent): string {
  const severityIcon = event.severity === "critical"
    ? "[CRITICAL]"
    : event.severity === "warning"
      ? "[WARN]"
      : "[INFO]";
  const lines: string[] = [
    `${severityIcon} *${event.type}*`,
    `Goal: ${event.goal_id}`,
    event.summary,
  ];
  if (Object.keys(event.details).length > 0) {
    lines.push(
      Object.entries(event.details)
        .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
        .join("\n")
    );
  }
  return lines.join("\n");
}
