// ─── ReportView ───
//
// Renders a PulSeed Report object in a formatted, readable way inside the TUI.
// Handles all 3 primary report types (execution_summary, daily_summary,
// weekly_report) with type-specific headers, plus a generic fallback for
// notification types (urgent_alert, approval_request, stall_escalation, etc.).

import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { renderMarkdownLines } from "./markdown-renderer.js";
import type { MarkdownLine } from "./markdown-renderer.js";
import type { Report } from "../../base/types/report.js";
import { reportColor } from "./theme.js";
import { DiffLine } from "./diff-view.js";

function reportIcon(reportType: Report["report_type"]): string {
  switch (reportType) {
    case "execution_summary":
      return "[ LOOP ]";
    case "daily_summary":
      return "[ DAILY ]";
    case "weekly_report":
      return "[ WEEKLY ]";
    case "urgent_alert":
      return "[ URGENT ]";
    case "approval_request":
      return "[ APPROVAL ]";
    case "stall_escalation":
      return "[ STALL ]";
    case "goal_completion":
      return "[ DONE ]";
    case "capability_escalation":
      return "[ CAPABILITY ]";
    case "strategy_change":
      return "[ STRATEGY ]";
    default:
      return "[ REPORT ]";
  }
}

// ─── ReportView ───

export interface ReportViewProps {
  report: Report;
  onDismiss: () => void;
  detail?: "default" | "diagnostic";
}

type ReportViewLine =
  | { kind: "markdown"; line: MarkdownLine }
  | { kind: "diff"; text: string };

function buildReportViewLines(report: Report, detail: ReportViewProps["detail"] = "default"): ReportViewLine[] {
  const content = detail === "diagnostic" ? report.content : hideGeneratedGoalIdLine(report);
  const lines: ReportViewLine[] = renderMarkdownLines(content).map((line) => ({
    kind: "markdown",
    line,
  }));
  const fileDiffs = report.metadata?.task_verification_diffs ?? [];
  if (fileDiffs.length === 0) {
    return lines;
  }

  const lastLine = lines[lines.length - 1];
  if (lastLine && lastLine.kind === "markdown" && lastLine.line.text !== "") {
    lines.push({ kind: "markdown", line: { text: "" } });
  }

  lines.push({ kind: "markdown", line: { text: "File Diff", bold: true } });
  lines.push({ kind: "markdown", line: { text: "" } });

  for (const fileDiff of fileDiffs) {
    lines.push({ kind: "markdown", line: { text: fileDiff.path, bold: true } });
    for (const diffLine of fileDiff.patch.split("\n")) {
      lines.push({ kind: "diff", text: diffLine });
    }
    lines.push({ kind: "markdown", line: { text: "" } });
  }

  return lines;
}

function hideGeneratedGoalIdLine(report: Report): string {
  if (report.goal_id === null) return report.content;
  const generatedGoalLine = `**Goal**: ${report.goal_id}`;
  return report.content
    .split("\n")
    .filter((line) => line.trim() !== generatedGoalLine)
    .join("\n");
}

export function ReportView({ report, onDismiss, detail = "default" }: ReportViewProps) {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const [scrollOffset, setScrollOffset] = useState(0);

  const color = reportColor(report.report_type);
  const icon = reportIcon(report.report_type);
  const reportLines = buildReportViewLines(report, detail);
  const showGoalDiagnostic = detail === "diagnostic" && report.goal_id !== null;

  const generatedAt = report.generated_at
    ? new Date(report.generated_at).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

  // Reserve rows for header, separators, footer, and the optional diagnostic goal row.
  const reservedRows = showGoalDiagnostic ? 7 : 6;
  const visibleLineCount = Math.max(1, termRows - reservedRows);
  const maxScroll = Math.max(0, reportLines.length - visibleLineCount);
  const clampedOffset = Math.min(scrollOffset, maxScroll);
  const visibleReportLines = reportLines.slice(clampedOffset, clampedOffset + visibleLineCount);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onDismiss();
      return;
    }
    if (key.upArrow || input === "k") {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {icon} {report.title}
        </Text>
        {generatedAt !== "" && (
          <Text dimColor>{generatedAt}</Text>
        )}
      </Box>

      {showGoalDiagnostic && (
        <Text dimColor>goal: {report.goal_id}</Text>
      )}

      <Text dimColor>{"─".repeat(40)}</Text>

      <Box flexDirection="column">
        {visibleReportLines.map((entry, i) => {
          if (entry.kind === "diff") {
            return <DiffLine key={i} line={entry.text} />;
          }

          const { line } = entry;
          if (line.text === "") {
            return <Text key={i}> </Text>;
          }
          const props: Record<string, unknown> = {};
          if (line.bold) props.bold = true;
          if (line.dim) props.dimColor = true;
          return (
            <Text key={i} {...props}>
              {line.text}
            </Text>
          );
        })}
      </Box>

      <Text dimColor>{"─".repeat(40)}</Text>
      <Text dimColor>↑↓ scroll • q/Esc to close</Text>
    </Box>
  );
}
