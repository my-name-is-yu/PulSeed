import { describe, expect, it } from "vitest";

import {
  bestArtifactFromEvidence,
  phaseStatusToOutcome,
  selectLatestVerifiedArtifact,
  summarizeVerificationEvidence,
  taskActionToOutcome,
  truncateOneLine,
  verificationToOutcome,
} from "../durable-loop/iteration-kernel-evidence-helpers.js";
import {
  RuntimeEvidenceEntrySchema,
  type RuntimeEvidenceEntry,
} from "../../../runtime/store/evidence-ledger.js";

function makeEvidenceEntry(overrides: Partial<RuntimeEvidenceEntry> = {}): RuntimeEvidenceEntry {
  const { scope, artifacts, raw_refs, ...rest } = overrides;
  return RuntimeEvidenceEntrySchema.parse({
    schema_version: "runtime-evidence-entry-v1",
    id: "entry-1",
    occurred_at: "2026-05-10T00:00:00.000Z",
    kind: "execution",
    ...rest,
    scope: {
      goal_id: "goal-1",
      ...scope,
    },
    artifacts: artifacts ?? [],
    raw_refs: raw_refs ?? [],
  });
}

describe("iteration kernel evidence helpers", () => {
  it("selects the newest verified entry when it already carries an artifact", () => {
    const selected = selectLatestVerifiedArtifact([
      makeEvidenceEntry({
        id: "verify-new",
        occurred_at: "2026-05-10T00:03:00.000Z",
        kind: "verification",
        verification: { verdict: "pass", summary: "verified" },
        artifacts: [{ label: "final-report", path: "reports/final.md", kind: "report" }],
      }),
      makeEvidenceEntry({
        id: "verify-old",
        occurred_at: "2026-05-10T00:02:00.000Z",
        kind: "verification",
        verification: { verdict: "pass" },
        artifacts: [{ label: "old-report", path: "reports/old.md", kind: "report" }],
      }),
    ]);

    expect(selected?.id).toBe("verify-new");
  });

  it("falls back to the latest task artifact that existed before a passing verification", () => {
    const selected = selectLatestVerifiedArtifact([
      makeEvidenceEntry({
        id: "future-artifact",
        occurred_at: "2026-05-10T00:04:00.000Z",
        kind: "artifact",
        scope: { task_id: "task-1" },
        artifacts: [{ label: "future", path: "reports/future.md", kind: "report" }],
      }),
      makeEvidenceEntry({
        id: "verify-task",
        occurred_at: "2026-05-10T00:03:00.000Z",
        kind: "verification",
        scope: { task_id: "task-1" },
        verification: { verdict: "pass" },
      }),
      makeEvidenceEntry({
        id: "execution-artifact",
        occurred_at: "2026-05-10T00:02:00.000Z",
        kind: "execution",
        scope: { task_id: "task-1" },
        artifacts: [{ label: "execution-output", path: "reports/output.md", kind: "report" }],
      }),
    ]);

    expect(selected?.id).toBe("execution-artifact");
  });

  it("normalizes runtime evidence into finalization artifacts", () => {
    const artifact = bestArtifactFromEvidence(makeEvidenceEntry({
      id: "entry-artifact",
      occurred_at: "2026-05-10T00:05:00.000Z",
      kind: "artifact",
      summary: "artifact summary",
      artifacts: [{
        label: "summary.md",
        path: "tmp/summary.md",
        state_relative_path: "runtime/summary.md",
        kind: "report",
      }],
    }));

    expect(artifact).toMatchObject({
      id: "summary.md",
      label: "summary.md",
      kind: "report",
      summary: "artifact summary",
      path: "tmp/summary.md",
      state_relative_path: "runtime/summary.md",
      occurred_at: "2026-05-10T00:05:00.000Z",
      source: "runtime_evidence_ledger",
    });
  });

  it("keeps phase, task action, and verification outcome mappings explicit", () => {
    expect(phaseStatusToOutcome("completed")).toBe("continued");
    expect(phaseStatusToOutcome("failed")).toBe("failed");
    expect(phaseStatusToOutcome("low_confidence")).toBe("inconclusive");

    expect(taskActionToOutcome("completed")).toBe("improved");
    expect(taskActionToOutcome("approval_denied")).toBe("blocked");
    expect(taskActionToOutcome("discard")).toBe("failed");
    expect(taskActionToOutcome("keep")).toBe("inconclusive");

    expect(verificationToOutcome("pass")).toBe("improved");
    expect(verificationToOutcome("fail")).toBe("failed");
    expect(verificationToOutcome("partial")).toBe("inconclusive");
  });

  it("summarizes verification evidence on one bounded line", () => {
    expect(summarizeVerificationEvidence([
      { layer: "mechanical", description: "first\nline", confidence: 0.8 },
      { layer: "mechanical", description: "second\tline", confidence: 0.7 },
    ])).toBe("first line; second line");

    expect(truncateOneLine("alpha\nbeta gamma", 12)).toBe("alpha bet...");
  });
});
