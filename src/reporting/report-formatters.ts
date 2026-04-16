import type { Report } from "../base/types/report.js";
import type { CharacterConfig } from "../base/types/character.js";
import type { ExecutionSummaryParams, NotificationType, NotificationContext } from "./reporting-types.js";

// ─── getVerbosityLevel ───

export function getVerbosityLevel(characterConfig: CharacterConfig): "brief" | "normal" | "detailed" {
  const p = characterConfig.proactivity_level;
  if (p === 1) return "brief";
  if (p <= 3) return "normal";
  return "detailed";
}

export function readMetadataOrContent<T>(
  metadataValue: T | null | undefined,
  content: string,
  pattern: RegExp,
  parse: (match: RegExpMatchArray) => T
): T | null {
  if (metadataValue !== undefined && metadataValue !== null) return metadataValue;
  const match = content.match(pattern);
  return match ? parse(match) : null;
}

export function buildSectionedReportContent(args: {
  heading: string;
  goalId: string;
  body: string;
  generatedAt: string;
}): string {
  return (
    `## ${args.heading}\n\n` +
    `**Goal**: ${args.goalId}\n\n` +
    `${args.body}\n\n` +
    `_Generated at ${args.generatedAt}_`
  );
}

// ─── formatReportForCLI ───

export function formatReportForCLI(report: Report): string {
  if (report.report_type === "execution_summary") {
    const m = report.metadata;
    const loopNum = readMetadataOrContent(
      m?.loop_index,
      report.content,
      /Loop (\d+)/,
      (match) => parseInt(match[1], 10)
    );
    const gapValue = readMetadataOrContent(
      m?.gap_aggregate,
      report.content,
      /\*\*Score\*\*:\s*([\d.]+)/,
      (match) => parseFloat(match[1])
    );
    const taskPart =
      m?.task_id != null && m?.task_action != null
        ? `task: ${m.task_id} (${m.task_action})`
        : (() => {
            const taskIdMatch = report.content.match(/\*\*Task ID\*\*:\s*(.+)/);
            const actionMatch = report.content.match(/\*\*Action\*\*:\s*(.+)/);
            return taskIdMatch && actionMatch
              ? `task: ${taskIdMatch[1].trim()} (${actionMatch[1].trim()})`
              : "no task";
          })();
    const elapsedValue = readMetadataOrContent(
      m?.elapsed_ms,
      report.content,
      /^([\d.]+)s$/m,
      (match) => parseFloat(match[1]) * 1000
    );
    const goalId = report.goal_id ?? "(no goal)";
    return `[Loop ${loopNum ?? "?"}] ${goalId} | gap: ${gapValue !== null ? gapValue.toFixed(2) : "?.??"} | ${taskPart} | ${elapsedValue !== null ? `${(elapsedValue / 1000).toFixed(1)}s` : "?s"}`;
  }

  if (report.report_type === "daily_summary") {
    const dateMatch = report.title.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : "?";
    const loops = readMetadataOrContent(
      report.metadata?.loops_run,
      report.content,
      /\*\*Loops run\*\*:\s*(\d+)/,
      (match) => parseInt(match[1], 10)
    );
    const goalId = report.goal_id ?? "(no goal)";
    return `[Daily ${date}] ${goalId} | ${loops ?? "?"} loops`;
  }

  if (report.report_type === "weekly_report") {
    const dateMatch = report.title.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : "?";
    const totalLoops = readMetadataOrContent(
      report.metadata?.total_loops,
      report.content,
      /\*\*Total loops run\*\*:\s*(\d+)/,
      (match) => parseInt(match[1], 10)
    );
    const goalId = report.goal_id ?? "(no goal)";
    return `[Weekly ${date}] ${goalId} | ${totalLoops ?? "?"} total loops`;
  }

  // Notification types / fallback
  return `[${report.report_type}] ${report.goal_id ?? "(no goal)"} | ${report.title}`;
}

// ─── buildExecutionSummaryContent ───

export function buildExecutionSummaryContent(
  params: ExecutionSummaryParams,
  verbosity: "brief" | "normal" | "detailed"
): string {
  const {
    loopIndex,
    observation,
    gapAggregate,
    taskResult,
    stallDetected,
    pivotOccurred,
    elapsedMs,
  } = params;

  const now = new Date().toISOString();
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  const isStructuralEvent = stallDetected || pivotOccurred || taskResult === null;
  const useBrief = verbosity === "brief" && !isStructuralEvent;

  if (useBrief) {
    const gapSummary = gapAggregate.toFixed(4);
    const progressSummary =
      observation.length > 0
        ? observation
            .map((o) => `${o.dimensionName}: ${o.progress.toFixed(1)}`)
            .join(", ")
        : "no observations";
    return `Loop ${loopIndex} | gap: ${gapSummary} | ${progressSummary} | ${elapsedSec}s`;
  }

  // Normal or detailed: full format
  let obsTable = "| Dimension | Progress | Confidence |\n|---|---|---|\n";
  if (observation.length === 0) {
    obsTable += "| (none) | — | — |\n";
  } else {
    for (const obs of observation) {
      const progress = obs.progress.toFixed(1);
      const confidence = (obs.confidence * 100).toFixed(1) + "%";
      obsTable += `| ${obs.dimensionName} | ${progress} | ${confidence} |\n`;
    }
  }

  let taskSection = "_No task executed this loop._";
  if (taskResult !== null) {
    taskSection =
      `- **Task ID**: ${taskResult.taskId}\n` +
      `- **Action**: ${taskResult.action}\n` +
      `- **Dimension**: ${taskResult.dimension}`;
  }

  const stallStatus = stallDetected ? "Yes" : "No";
  const pivotStatus = pivotOccurred ? "Yes" : "No";

  return (
    `## Execution Summary — Loop ${loopIndex}\n\n` +
    `**Timestamp**: ${now}\n\n` +
    `### Observation Results\n\n${obsTable}\n` +
    `### Gap Aggregate\n\n` +
    `**Score**: ${gapAggregate.toFixed(4)}\n\n` +
    `### Task Result\n\n${taskSection}\n\n` +
    `### Status\n\n` +
    `- **Stall detected**: ${stallStatus}\n` +
    `- **Strategy pivot**: ${pivotStatus}\n\n` +
    `### Elapsed Time\n\n${elapsedSec}s`
  );
}

// ─── buildNotificationContent ───

export function buildNotificationContent(
  type: NotificationType,
  context: NotificationContext,
  characterConfig: CharacterConfig
): { reportType: Report["report_type"]; title: string; content: string } {
  const now = new Date().toISOString();
  const { goalId, message, details } = context;

  let reportType: Report["report_type"];
  let title: string;

  switch (type) {
    case "urgent":
      reportType = "urgent_alert";
      title = `Urgent: ${message}`;
      break;
    case "approval_required":
      reportType = "approval_request";
      title = `Approval Required: ${message}`;
      break;
    case "stall_escalation":
      reportType = "stall_escalation";
      title = `Stall Escalation: ${message}`;
      break;
    case "completed":
      reportType = "goal_completion";
      title = `Goal Completed: ${message}`;
      break;
    case "capability_insufficient":
      reportType = "capability_escalation";
      title = `Capability Insufficient: ${message}`;
      break;
  }

  const detailsSection = details ? `\n\n### Details\n\n${details}` : "";

  const directness = characterConfig.communication_directness;
  const isEscalation = type === "stall_escalation" || type === "capability_insufficient";
  const isStall = type === "stall_escalation";
  let suggestionsSection = "";
  if (directness <= 2) {
    if (isEscalation) {
      suggestionsSection = "\n\n### Suggested next actions:\n\n- Review current strategy and consider pivoting\n- Check available resources and constraints\n- Escalate to human operator if needed";
    }
  } else if (directness === 3) {
    if (isEscalation && !isStall) {
      suggestionsSection = "\n\n### Suggested next actions:\n\n- Review current strategy and consider pivoting\n- Check available resources and constraints\n- Escalate to human operator if needed";
    }
  }

  const content =
    `## ${title}\n\n` +
    `**Goal**: ${goalId}\n\n` +
    `### Message\n\n${message}${detailsSection}${suggestionsSection}\n\n` +
    `_Generated at ${now}_`;

  return { reportType, title, content };
}
