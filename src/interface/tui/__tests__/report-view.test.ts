import React from "react";
import { renderToString } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportView } from "../report-view.js";
import { ReportSchema } from "../../../base/types/report.js";

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
    useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
  };
});

describe("ReportView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides raw goal identifiers in the default report view", async () => {
    const report = ReportSchema.parse({
      id: "report-1",
      report_type: "daily_summary",
      goal_id: "goal-1",
      title: "Daily Summary",
      content: "Task completed.",
      verbosity: "standard",
      generated_at: new Date("2026-04-18T00:00:00.000Z").toISOString(),
      delivered_at: null,
      read: false,
      metadata: {},
    });

    const output = renderToString(
      React.createElement(ReportView, {
        report,
        onDismiss: () => {},
      }),
      { columns: 80 },
    );

    expect(output).toContain("Daily Summary");
    expect(output).not.toContain("goal: goal-1");
    expect(output).not.toContain("goal-1");
  });

  it("shows raw goal identifiers only in diagnostic report view", async () => {
    const report = ReportSchema.parse({
      id: "report-1",
      report_type: "daily_summary",
      goal_id: "goal-1",
      title: "Daily Summary",
      content: "Task completed.",
      verbosity: "standard",
      generated_at: new Date("2026-04-18T00:00:00.000Z").toISOString(),
      delivered_at: null,
      read: false,
      metadata: {},
    });

    const output = renderToString(
      React.createElement(ReportView, {
        report,
        detail: "diagnostic",
        onDismiss: () => {},
      }),
      { columns: 80 },
    );

    expect(output).toContain("goal: goal-1");
  });

  it("renders structured verification diffs from report metadata", async () => {
    const report = ReportSchema.parse({
      id: "report-1",
      report_type: "execution_summary",
      goal_id: "goal-1",
      title: "Execution Summary - Loop 1",
      content: "## Execution Summary\n\nTask completed.",
      verbosity: "standard",
      generated_at: new Date("2026-04-18T00:00:00.000Z").toISOString(),
      delivered_at: null,
      read: false,
      metadata: {
        task_verification_diffs: [
          {
            path: "src/example.ts",
            patch: [
              "diff --git a/src/example.ts b/src/example.ts",
              "@@ -1 +1 @@",
              "-before",
              "+after",
            ].join("\n"),
          },
        ],
      },
    });

    const output = renderToString(
      React.createElement(ReportView, {
        report,
        onDismiss: () => {},
      }),
      { columns: 80 },
    );

    expect(output).toContain("File Diff");
    expect(output).toContain("src/example.ts");
    expect(output).toContain("-before");
    expect(output).toContain("+after");
  });
});
