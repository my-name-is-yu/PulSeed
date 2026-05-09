import { ReportSchema, type Report } from "../base/types/report.js";
import {
  buildSectionedReportContent,
  readMetadataOrContent,
} from "./report-formatters.js";

type BooleanReportMetadataKey = "stall_detected" | "pivot_occurred";
type CountReportMetadataKey = "loops_run" | "stall_count" | "pivot_count";

export interface BuildDailySummaryReportInput {
  id: string;
  goalId: string;
  allReports: Report[];
  now: Date;
}

export interface BuildWeeklyReportInput {
  id: string;
  goalId: string;
  allReports: Report[];
  now: Date;
}

export function buildDailySummaryReport(input: BuildDailySummaryReportInput): Report {
  const reportNow = input.now.toISOString();
  const todayPrefix = reportNow.slice(0, 10);
  const todayReports = input.allReports.filter((report) => (
    report.report_type === "execution_summary" &&
    report.generated_at.startsWith(todayPrefix)
  ));

  const loopsRun = todayReports.length;
  const progressChange = summarizeDailyProgressChange(todayReports);
  const stallCount = todayReports.filter((report) => readReportBoolean(
    report,
    "stall_detected",
    /\*\*Stall detected\*\*:\s*Yes/,
  )).length;
  const pivotCount = todayReports.filter((report) => readReportBoolean(
    report,
    "pivot_occurred",
    /\*\*Strategy pivot\*\*:\s*Yes/,
  )).length;

  const content = buildSectionedReportContent({
    heading: `Daily Summary — ${todayPrefix}`,
    goalId: input.goalId,
    generatedAt: reportNow,
    body:
      `### Activity\n\n` +
      `- **Loops run**: ${loopsRun}\n` +
      `- **Stalls detected**: ${stallCount}\n` +
      `- **Strategy pivots**: ${pivotCount}\n\n` +
      `### Progress\n\n` +
      `- **Overall gap change**: ${progressChange}`,
  });

  return ReportSchema.parse({
    id: input.id,
    report_type: "daily_summary",
    goal_id: input.goalId,
    title: `Daily Summary — ${todayPrefix}`,
    content,
    verbosity: "standard",
    generated_at: reportNow,
    delivered_at: null,
    read: false,
    metadata: {
      loops_run: loopsRun,
      stall_count: stallCount,
      pivot_count: pivotCount,
      progress_change: progressChange,
    },
  });
}

export function buildWeeklyReport(input: BuildWeeklyReportInput): Report {
  const reportNow = input.now.toISOString();
  const dailySummaries = input.allReports.filter((report) => {
    if (report.report_type !== "daily_summary") return false;
    const generatedAt = new Date(report.generated_at);
    const diffDays = (input.now.getTime() - generatedAt.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays <= 7;
  });

  const daysWithActivity = dailySummaries.length;
  const totalLoops = dailySummaries.reduce((sum, report) => sum + readDailyLoopCount(report), 0);
  const totalStalls = dailySummaries.reduce((sum, report) => sum + readDailyCount(
    report,
    "stall_count",
    /\*\*Stalls detected\*\*:\s*(\d+)/,
  ), 0);
  const totalPivots = dailySummaries.reduce((sum, report) => sum + readDailyCount(
    report,
    "pivot_count",
    /\*\*Strategy pivots\*\*:\s*(\d+)/,
  ), 0);

  const trendSection = buildWeeklyTrendSection(dailySummaries);
  const content = buildSectionedReportContent({
    heading: "Weekly Report",
    goalId: input.goalId,
    generatedAt: reportNow,
    body:
      `**Period**: Last 7 days (ending ${reportNow.slice(0, 10)})\n\n` +
      `### Summary\n\n` +
      `- **Days with activity**: ${daysWithActivity}\n` +
      `- **Total loops run**: ${totalLoops}\n` +
      `- **Total stalls**: ${totalStalls}\n` +
      `- **Total pivots**: ${totalPivots}\n\n` +
      `### Daily Trend\n\n${trendSection}`,
  });

  return ReportSchema.parse({
    id: input.id,
    report_type: "weekly_report",
    goal_id: input.goalId,
    title: `Weekly Report — ${reportNow.slice(0, 10)}`,
    content,
    verbosity: "standard",
    generated_at: reportNow,
    delivered_at: null,
    read: false,
    metadata: {
      total_loops: totalLoops,
      total_stalls: totalStalls,
      total_pivots: totalPivots,
    },
  });
}

function summarizeDailyProgressChange(todayReports: Report[]): string {
  if (todayReports.length === 0) return "N/A";
  if (todayReports.length === 1) return "Single loop (no change to compute)";

  const firstGap = readReportGap(todayReports[0]);
  const lastGap = readReportGap(todayReports[todayReports.length - 1]);
  if (firstGap === null || lastGap === null) return "Could not parse gap data";

  const delta = firstGap - lastGap;
  return delta >= 0
    ? `▼ ${delta.toFixed(4)} (gap reduced)`
    : `▲ ${Math.abs(delta).toFixed(4)} (gap grew)`;
}

function buildWeeklyTrendSection(dailySummaries: Report[]): string {
  if (dailySummaries.length === 0) return "_No daily activity in the last 7 days._";
  const sortedSummaries = [...dailySummaries].sort((left, right) =>
    left.generated_at.localeCompare(right.generated_at)
  );
  return sortedSummaries.map((report) => {
    const date = report.generated_at.slice(0, 10);
    const loops = readDailyLoopCount(report);
    const progress = readDailyProgress(report);
    return `- **${date}**: ${loops} loops | Gap change: ${progress}`;
  }).join("\n");
}

function readReportGap(report: Report): number | null {
  return readMetadataOrContent(
    report.metadata?.gap_aggregate,
    report.content,
    /\*\*Score\*\*:\s*([\d.]+)/,
    (match) => parseFloat(match[1])
  );
}

function readReportBoolean(
  report: Report,
  metadataKey: BooleanReportMetadataKey,
  fallbackPattern: RegExp
): boolean {
  return readMetadataOrContent(
    report.metadata?.[metadataKey],
    report.content,
    fallbackPattern,
    () => true
  ) ?? false;
}

function readDailyLoopCount(report: Report): number {
  return readDailyCount(report, "loops_run", /\*\*Loops run\*\*:\s*(\d+)/);
}

function readDailyCount(report: Report, metadataKey: CountReportMetadataKey, fallbackPattern: RegExp): number {
  const count = readMetadataOrContent(
    report.metadata?.[metadataKey],
    report.content,
    fallbackPattern,
    (match) => parseInt(match[1], 10)
  );
  return count ?? 0;
}

function readDailyProgress(report: Report): string {
  return readMetadataOrContent(
    report.metadata?.progress_change,
    report.content,
    /\*\*Overall gap change\*\*:\s*(.+)/,
    (match) => match[1].trim()
  ) ?? "N/A";
}
