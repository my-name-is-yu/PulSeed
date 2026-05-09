import { describe, expect, it } from "vitest";
import { LongRunningResultSchema } from "../long-running-runtime-schemas.js";
import {
  renderArtifacts,
  renderEvidence,
  renderSummaryMarkdown,
} from "../long-running-report-render.js";

describe("long-running report renderer", () => {
  it("renders evidence and artifact fallbacks", () => {
    expect(renderEvidence([])).toEqual(["- none"]);
    expect(renderArtifacts([])).toEqual(["- none"]);
  });

  it("renders canonical result summaries without dropping optional next-action details", () => {
    const result = LongRunningResultSchema.parse({
      schema_version: "long-running-result-v1",
      objective: "Run a durable benchmark",
      status: "blocked",
      evidence: [{
        kind: "metric",
        label: "score",
        value: 0.72,
        summary: "validation fold",
        path: "metrics.json",
      }],
      artifacts: [{
        label: "metrics",
        state_relative_path: "runtime/artifacts/run-1/metrics.json",
        kind: "metrics",
      }],
      failures: ["approval pending"],
      next_action: {
        type: "retry",
        summary: "Retry after approval",
        reason: "operator gate",
        command: "pulseed run resume",
        due_at: "2026-05-10T03:00:00.000Z",
        owner: "operator",
      },
      source: {
        kind: "manual",
      },
      created_at: "2026-05-10T02:00:00.000Z",
    });

    const markdown = renderSummaryMarkdown(result);
    expect(markdown).toContain("## Objective\nRun a durable benchmark");
    expect(markdown).toContain("## Status\nblocked");
    expect(markdown).toContain("## Evidence\n- metric score: 0.72 (validation fold) [metrics.json]");
    expect(markdown).toContain("## Artifacts\n- metrics: runtime/artifacts/run-1/metrics.json");
    expect(markdown).toContain("## Failures\n- approval pending");
    expect(markdown).toContain([
      "## Next Action",
      "- Type: retry",
      "- Summary: Retry after approval",
      "- Reason: operator gate",
      "- Command: pulseed run resume",
      "- Due at: 2026-05-10T03:00:00.000Z",
      "- Owner: operator",
    ].join("\n"));
  });
});
