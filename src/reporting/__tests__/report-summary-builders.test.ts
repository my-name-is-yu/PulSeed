import { describe, expect, it } from "vitest";
import { ReportSchema, type Report } from "../../base/types/report.js";
import {
  buildDailySummaryReport,
  buildWeeklyReport,
} from "../report-summary-builders.js";

const NOW = new Date("2026-05-10T04:00:00.000Z");

function executionReport(input: {
  id: string;
  generatedAt: string;
  goalId?: string;
  gap?: number;
  stall?: boolean;
  pivot?: boolean;
  content?: string;
  metadata?: Report["metadata"];
}): Report {
  return ReportSchema.parse({
    id: input.id,
    report_type: "execution_summary",
    goal_id: input.goalId ?? "goal-1",
    title: `Execution Summary ${input.id}`,
    content: input.content ?? [
      "# Execution Summary",
      input.gap === undefined ? "" : `**Score**: ${input.gap.toFixed(4)}`,
      input.stall ? "**Stall detected**: Yes" : "**Stall detected**: No",
      input.pivot ? "**Strategy pivot**: Yes" : "**Strategy pivot**: No",
    ].join("\n"),
    verbosity: "standard",
    generated_at: input.generatedAt,
    delivered_at: null,
    read: false,
    metadata: Object.prototype.hasOwnProperty.call(input, "metadata")
      ? input.metadata
      : {
        ...(input.gap === undefined ? {} : { gap_aggregate: input.gap }),
        ...(input.stall === undefined ? {} : { stall_detected: input.stall }),
        ...(input.pivot === undefined ? {} : { pivot_occurred: input.pivot }),
      },
  });
}

function dailyReport(input: {
  id: string;
  generatedAt: string;
  loops?: number;
  stalls?: number;
  pivots?: number;
  progress?: string;
  content?: string;
  metadata?: Report["metadata"];
}): Report {
  return ReportSchema.parse({
    id: input.id,
    report_type: "daily_summary",
    goal_id: "goal-1",
    title: `Daily Summary ${input.generatedAt.slice(0, 10)}`,
    content: input.content ?? [
      "# Daily Summary",
      `- **Loops run**: ${input.loops ?? 0}`,
      `- **Stalls detected**: ${input.stalls ?? 0}`,
      `- **Strategy pivots**: ${input.pivots ?? 0}`,
      `- **Overall gap change**: ${input.progress ?? "N/A"}`,
    ].join("\n"),
    verbosity: "standard",
    generated_at: input.generatedAt,
    delivered_at: null,
    read: false,
    metadata: Object.prototype.hasOwnProperty.call(input, "metadata")
      ? input.metadata
      : {
        loops_run: input.loops ?? 0,
        stall_count: input.stalls ?? 0,
        pivot_count: input.pivots ?? 0,
        progress_change: input.progress ?? "N/A",
      },
  });
}

describe("report summary builders", () => {
  it("builds daily summary metrics from structured execution metadata", () => {
    const report = buildDailySummaryReport({
      id: "daily-1",
      goalId: "goal-1",
      now: NOW,
      allReports: [
        executionReport({
          id: "loop-1",
          generatedAt: "2026-05-10T00:00:00.000Z",
          gap: 0.8,
          stall: true,
          pivot: false,
        }),
        executionReport({
          id: "loop-2",
          generatedAt: "2026-05-10T01:00:00.000Z",
          gap: 0.5,
          stall: false,
          pivot: true,
        }),
        executionReport({
          id: "old-loop",
          generatedAt: "2026-05-09T23:59:59.000Z",
          gap: 0.1,
          stall: true,
          pivot: true,
        }),
      ],
    });

    expect(report.report_type).toBe("daily_summary");
    expect(report.title).toBe("Daily Summary — 2026-05-10");
    expect(report.metadata).toMatchObject({
      loops_run: 2,
      stall_count: 1,
      pivot_count: 1,
      progress_change: "▼ 0.3000 (gap reduced)",
    });
    expect(report.content).toContain("**Loops run**: 2");
    expect(report.content).toContain("gap reduced");
  });

  it("keeps markdown fallback parsing for legacy execution summaries without metadata", () => {
    const report = buildDailySummaryReport({
      id: "daily-legacy",
      goalId: "goal-1",
      now: NOW,
      allReports: [
        executionReport({
          id: "legacy-1",
          generatedAt: "2026-05-10T00:00:00.000Z",
          content: "**Score**: 0.3000\n**Stall detected**: Yes\n**Strategy pivot**: No",
          metadata: undefined,
        }),
        executionReport({
          id: "legacy-2",
          generatedAt: "2026-05-10T01:00:00.000Z",
          content: "**Score**: 0.7000\n**Stall detected**: No\n**Strategy pivot**: Yes",
          metadata: undefined,
        }),
      ],
    });

    expect(report.metadata).toMatchObject({
      loops_run: 2,
      stall_count: 1,
      pivot_count: 1,
      progress_change: "▲ 0.4000 (gap grew)",
    });
  });

  it("builds weekly summary totals and chronological trends from daily summaries", () => {
    const report = buildWeeklyReport({
      id: "weekly-1",
      goalId: "goal-1",
      now: NOW,
      allReports: [
        dailyReport({
          id: "daily-2",
          generatedAt: "2026-05-09T00:00:00.000Z",
          loops: 3,
          stalls: 1,
          pivots: 2,
          progress: "▼ 0.1000 (gap reduced)",
        }),
        dailyReport({
          id: "daily-1",
          generatedAt: "2026-05-08T00:00:00.000Z",
          loops: 2,
          stalls: 0,
          pivots: 1,
          progress: "N/A",
        }),
        dailyReport({
          id: "old-daily",
          generatedAt: "2026-05-01T00:00:00.000Z",
          loops: 99,
          stalls: 99,
          pivots: 99,
        }),
      ],
    });

    expect(report.metadata).toMatchObject({
      total_loops: 5,
      total_stalls: 1,
      total_pivots: 3,
    });
    expect(report.content).toContain("**Days with activity**: 2");
    expect(report.content.indexOf("2026-05-08")).toBeLessThan(report.content.indexOf("2026-05-09"));
    expect(report.content).not.toContain("2026-05-01");
  });

  it("keeps daily summary markdown fallback when weekly metadata is absent", () => {
    const report = buildWeeklyReport({
      id: "weekly-legacy",
      goalId: "goal-1",
      now: NOW,
      allReports: [
        dailyReport({
          id: "legacy-daily",
          generatedAt: "2026-05-10T00:00:00.000Z",
          metadata: undefined,
          content: [
            "- **Loops run**: 4",
            "- **Stalls detected**: 2",
            "- **Strategy pivots**: 1",
            "- **Overall gap change**: ▼ 0.2500 (gap reduced)",
          ].join("\n"),
        }),
      ],
    });

    expect(report.metadata).toMatchObject({
      total_loops: 4,
      total_stalls: 2,
      total_pivots: 1,
    });
    expect(report.content).toContain("2026-05-10");
    expect(report.content).toContain("▼ 0.2500 (gap reduced)");
  });
});
