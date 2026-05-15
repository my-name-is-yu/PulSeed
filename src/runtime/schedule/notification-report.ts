import { stableId } from "../personal-agent/index.js";

export function buildScheduleNotificationReport(payload: Record<string, unknown>): Record<string, unknown> {
  const reportType = stringValue(payload["report_type"]) ?? "execution_summary";
  const entryId = stringValue(payload["entry_id"]) ?? "entry:none";
  const entryName = stringValue(payload["entry_name"]) ?? entryId;
  const generatedAt = validDateTimeOrNow(stringValue(payload["generated_at"]) ?? stringValue(payload["fired_at"]));
  const id = stringValue(payload["id"]) ?? `schedule-report:${stableId(stableJson({
    reportType,
    entryId,
    payload,
  }))}`;
  const title = stringValue(payload["title"]) ?? titleForScheduleReport(reportType, entryName);
  const content = stringValue(payload["content"]) ?? contentForScheduleReport(payload);
  const goalId = stringValue(payload["goal_id"]) ?? stringValue(payload["target_goal_id"]) ?? null;

  return {
    ...payload,
    id,
    report_type: reportType,
    goal_id: goalId,
    title,
    content,
    verbosity: stringValue(payload["verbosity"]) ?? "standard",
    generated_at: generatedAt,
    delivered_at: payload["delivered_at"] === null || typeof payload["delivered_at"] === "string"
      ? payload["delivered_at"]
      : null,
    read: typeof payload["read"] === "boolean" ? payload["read"] : false,
  };
}

function titleForScheduleReport(reportType: string, entryName: string): string {
  switch (reportType) {
    case "schedule_change":
      return `Schedule change: ${entryName}`;
    case "schedule_heartbeat_failure":
      return `Schedule heartbeat failure: ${entryName}`;
    case "schedule_escalation":
      return `Schedule escalation: ${entryName}`;
    case "schedule_report_ready":
      return `Schedule report ready: ${entryName}`;
    default:
      return `Schedule notification: ${entryName}`;
  }
}

function contentForScheduleReport(payload: Record<string, unknown>): string {
  const fields = [
    stringValue(payload["details"]),
    stringValue(payload["output_summary"]),
    stringValue(payload["output"]),
    stringValue(payload["error_message"]),
  ].filter((value): value is string => Boolean(value));
  if (fields.length > 0) return fields.join("\n");
  return stableJson(payload);
}

function validDateTimeOrNow(value: string | undefined): string {
  if (value) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeForStableJson(child)])
    );
  }
  return value;
}
