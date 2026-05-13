import type { Report } from "../base/types/report.js";
import type { CharacterConfig } from "../platform/traits/types/character.js";
import { createCompanionCharacterPolicyProjection } from "../runtime/decision/companion-character-policy-projection.js";
import type { ExecutionSummaryParams, NotificationType, NotificationContext } from "./reporting-types.js";

// ─── getVerbosityLevel ───

export function getVerbosityLevel(characterConfig: CharacterConfig): "brief" | "normal" | "detailed" {
  return createCompanionCharacterPolicyProjection({
    characterConfig,
    projectionId: "reporting:execution-summary:character-policy",
  }).surface_policy.execution_summary_verbosity;
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

function formatDiffEvidenceSource(
  source: ExecutionSummaryParams["taskResult"] extends infer T
    ? T extends { diffEvidenceSource?: infer S } ? S | undefined : undefined
    : never
): string | null {
  if (source === "git") return "git diff";
  if (source === "filesystem_artifact") return "filesystem/artifact evidence (git unavailable)";
  if (source === "unavailable") return "unavailable";
  return null;
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
    waitStatus,
    finalizationStatus,
    executionMode,
  } = params;

  const now = new Date().toISOString();
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  const structuralExecutionMode = executionMode
    ? isStructuralExecutionMode(executionMode)
    : false;

  const isStructuralEvent =
    stallDetected
    || pivotOccurred
    || taskResult === null
    || structuralExecutionMode
    || waitStatus !== undefined
    || finalizationStatus !== undefined;
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
    const diffEvidenceSource = formatDiffEvidenceSource(taskResult.diffEvidenceSource);
    const changedPaths = taskResult.verificationDiffs
      ?.map((diff) => diff.path)
      .filter((path, index, all) => path.length > 0 && all.indexOf(path) === index)
      ?? [];
    const unsafePaths = taskResult.verificationDiffs
      ?.filter((diff) => diff.safe_to_revert === false)
      .map((diff) => diff.path)
      .filter((path, index, all) => path.length > 0 && all.indexOf(path) === index)
      ?? [];
    taskSection =
      `- **Task ID**: ${taskResult.taskId}\n` +
      `- **Action**: ${taskResult.action}\n` +
      `- **Dimension**: ${taskResult.dimension}` +
      (diffEvidenceSource ? `\n- **Changed-path evidence source**: ${diffEvidenceSource}` : "") +
      (changedPaths.length > 0 ? `\n- **Changed filesystem paths**: ${changedPaths.join(", ")}` : "") +
      (unsafePaths.length > 0 ? `\n- **Safety handoff**: git restore was not used for overlapping dirty path(s): ${unsafePaths.join(", ")}` : "") +
      (taskResult.artifactContractStatus?.applicable
        ? `\n- **Artifact-contract status**: ${taskResult.artifactContractStatus.passed ? "passed" : "failed"} — ${taskResult.artifactContractStatus.description}`
        : "");
  }

  const stallStatus = stallDetected ? "Yes" : "No";
  const pivotStatus = pivotOccurred ? "Yes" : "No";
  const waitSection = waitStatus ? formatWaitStatusSection(waitStatus) : "";
  const executionModeSection = executionMode ? formatExecutionModeSection(executionMode) : "";
  const finalizationSection = finalizationStatus ? formatFinalizationStatusSection(finalizationStatus) : "";

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
    executionModeSection +
    waitSection +
    finalizationSection +
    `### Elapsed Time\n\n${elapsedSec}s`
  );
}

function isStructuralExecutionMode(
  executionMode: NonNullable<ExecutionSummaryParams["executionMode"]>
): boolean {
  return executionMode.mode !== "exploration" || executionMode.finalization_mode !== "no_deadline";
}

function formatExecutionModeSection(
  executionMode: NonNullable<ExecutionSummaryParams["executionMode"]>
): string {
  const lines = [
    "### Execution Mode",
    "",
    `- **Mode**: ${executionMode.mode}`,
    `- **Source**: ${executionMode.source}`,
    `- **Reason**: ${executionMode.reason}`,
  ];
  if (executionMode.approval_required_to_explore !== undefined) {
    lines.push(`- **Approval required to explore**: ${executionMode.approval_required_to_explore ? "Yes" : "No"}`);
  }
  return `${lines.join("\n")}\n\n`;
}

function formatWaitStatusSection(waitStatus: NonNullable<ExecutionSummaryParams["waitStatus"]>): string {
  const lines = [
    "### Wait Status",
    "",
    `- **Status**: ${waitStatus.status}`,
  ];

  if (waitStatus.strategyId) {
    lines.push(`- **Strategy ID**: ${waitStatus.strategyId}`);
  }
  if (waitStatus.details) {
    lines.push(`- **Details**: ${waitStatus.details}`);
  }
  if (waitStatus.approvalId) {
    lines.push(`- **Approval ID**: ${waitStatus.approvalId}`);
  }
  if (waitStatus.observeOnly !== undefined) {
    lines.push(`- **Observe only**: ${waitStatus.observeOnly ? "Yes" : "No"}`);
  }
  if (waitStatus.suppressed !== undefined) {
    lines.push(`- **Task suppressed**: ${waitStatus.suppressed ? "Yes" : "No"}`);
  }
  if (waitStatus.expired !== undefined) {
    lines.push(`- **Wait expired**: ${waitStatus.expired ? "Yes" : "No"}`);
  }
  if (waitStatus.skipReason) {
    lines.push(`- **Skip reason**: ${waitStatus.skipReason}`);
  }

  return `${lines.join("\n")}\n\n`;
}

function formatFinalizationStatusSection(
  status: NonNullable<ExecutionSummaryParams["finalizationStatus"]>
): string {
  const lines = [
    "### Deadline Finalization",
    "",
    `- **Mode**: ${status.mode}`,
    `- **Deadline**: ${status.deadline ?? "-"}`,
    `- **Remaining exploration**: ${formatDurationMs(status.remaining_exploration_ms)}`,
    `- **Reserved finalization**: ${formatDurationMs(status.reserved_finalization_ms)}`,
    `- **Reason**: ${status.reason}`,
  ];

  const plan = status.finalization_plan;
  if (plan) {
    lines.push(`- **Deliverable**: ${plan.deliverable_contract ?? "-"}`);
    lines.push(`- **Best artifact**: ${plan.best_artifact?.label ?? "-"}`);
    if (plan.verification_steps.length > 0) {
      lines.push(`- **Verification steps**: ${plan.verification_steps.join("; ")}`);
    }
    if (plan.approval_required_actions.length > 0) {
      lines.push(
        `- **Approval-required actions**: ${plan.approval_required_actions
          .map((action) => action.label)
          .join("; ")}`
      );
    }
  }

  return `${lines.join("\n")}\n\n`;
}

function formatDurationMs(value: number | null): string {
  if (value === null) return "-";
  if (value <= 0) return "0m";
  const minutes = Math.ceil(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

// ─── buildNotificationContent ───

export function buildNotificationContent(
  type: NotificationType,
  context: NotificationContext,
  characterConfig: CharacterConfig
): { reportType: Report["report_type"]; title: string; content: string } {
  const now = new Date().toISOString();
  const { goalId, message, details } = context;
  const characterPolicy = createCompanionCharacterPolicyProjection({
    characterConfig,
    projectionId: `reporting:notification:${type}:${goalId}`,
    evaluatedAt: now,
    sourceRefs: [{
      kind: "character_config",
      ref: "reporting-engine:character-config",
      role: "surface",
    }],
  });

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

  const suggestionPolicy = characterPolicy.surface_policy.escalation_suggestion_policy;
  const isEscalation = type === "stall_escalation" || type === "capability_insufficient";
  const isStall = type === "stall_escalation";
  let suggestionsSection = "";
  if (
    isEscalation
    && (
      suggestionPolicy === "include_for_all_escalations"
      || (suggestionPolicy === "include_for_non_stall_escalations" && !isStall)
    )
  ) {
    suggestionsSection = "\n\n### Suggested next actions:\n\n- Review current strategy and consider pivoting\n- Check available resources and constraints\n- Escalate to human operator if needed";
  }

  const content =
    `## ${title}\n\n` +
    `**Goal**: ${goalId}\n\n` +
    `### Message\n\n${message}${detailsSection}${suggestionsSection}\n\n` +
    `_Generated at ${now}_`;

  return { reportType, title, content };
}
