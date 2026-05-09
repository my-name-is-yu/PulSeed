import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import {
  captureVerifiedTaskPlaybook,
  deleteDreamPlaybook,
  loadDreamPlaybooks,
  recordDreamPlaybookReuseOutcome,
  setDreamPlaybookStatus,
} from "../playbook-memory.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["type_safety"],
    primary_dimension: "type_safety",
    work_description: "Repair the provider config type boundary",
    rationale: "Keep provider config validation strict without widening runtime acceptance",
    approach: "Patch the boundary, keep validation strict, and rerun focused typecheck",
    success_criteria: [
      {
        description: "Focused typecheck passes",
        verification_method: "npm run typecheck",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["provider config boundary"],
      out_of_scope: ["broad runtime widening"],
      blast_radius: "provider config only",
    },
    constraints: ["Do not widen runtime acceptance"],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "verification",
    status: "completed",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-04-21T10:00:00.000Z",
    ...overrides,
  };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    task_id: "task-1",
    verdict: "pass",
    confidence: 0.86,
    evidence: [
      {
        layer: "mechanical",
        description: "Focused typecheck passed after the boundary fix",
        confidence: 0.91,
      },
    ],
    dimension_updates: [],
    timestamp: "2026-04-21T10:05:00.000Z",
    ...overrides,
  };
}

describe("playbook-memory", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("captures a promoted playbook from a verifier-backed passing task", async () => {
    tmpDir = makeTempDir("playbook-memory-");

    const record = await captureVerifiedTaskPlaybook(tmpDir, {
      task: makeTask(),
      verificationResult: makeVerificationResult(),
    });

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      status: "promoted",
      title: "Repair the provider config type boundary",
      applicability: expect.objectContaining({
        goal_ids: ["goal-1"],
        primary_dimensions: ["type_safety"],
        task_categories: ["verification"],
      }),
      usage: expect.objectContaining({
        verified_success_count: 1,
      }),
    });

    const playbooks = await loadDreamPlaybooks(tmpDir);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]?.playbook_id).toBe(record?.playbook_id);
  });

  it("keeps low-confidence verifier passes as candidates and excludes them from promoted queries", async () => {
    tmpDir = makeTempDir("playbook-memory-candidate-");

    await captureVerifiedTaskPlaybook(tmpDir, {
      task: makeTask({ id: "task-candidate" }),
      verificationResult: makeVerificationResult({
        task_id: "task-candidate",
        confidence: 0.6,
      }),
    });

    const promoted = await loadDreamPlaybooks(tmpDir, { statuses: ["promoted"] });
    const all = await loadDreamPlaybooks(tmpDir);
    expect(promoted).toHaveLength(0);
    expect(all[0]).toMatchObject({ status: "candidate" });
  });

  it("allows disabling and deleting a stored playbook", async () => {
    tmpDir = makeTempDir("playbook-memory-governance-");

    const record = await captureVerifiedTaskPlaybook(tmpDir, {
      task: makeTask(),
      verificationResult: makeVerificationResult(),
    });
    expect(record).not.toBeNull();

    const disabled = await setDreamPlaybookStatus(tmpDir, record!.playbook_id, "disabled");
    expect(disabled).toMatchObject({
      status: "disabled",
      governance: expect.objectContaining({
        review_state: "disabled",
      }),
    });

    await expect(deleteDreamPlaybook(tmpDir, record!.playbook_id)).resolves.toBe(true);
    await expect(loadDreamPlaybooks(tmpDir)).resolves.toEqual([]);
  });

  it("demotes a promoted playbook after repeated failed reuse", async () => {
    tmpDir = makeTempDir("playbook-memory-demotion-");

    const record = await captureVerifiedTaskPlaybook(tmpDir, {
      task: makeTask(),
      verificationResult: makeVerificationResult(),
    });
    expect(record?.status).toBe("promoted");

    await recordDreamPlaybookReuseOutcome(tmpDir, {
      playbookIds: [record!.playbook_id],
      verificationResult: {
        ...makeVerificationResult(),
        verdict: "fail",
        confidence: 0.4,
        timestamp: "2026-04-21T10:06:00.000Z",
      },
    });
    const [afterFirstFailure] = await loadDreamPlaybooks(tmpDir);
    expect(afterFirstFailure).toMatchObject({
      status: "promoted",
      usage: expect.objectContaining({
        retrieved_count: 1,
        failed_reuse_count: 1,
      }),
    });

    await recordDreamPlaybookReuseOutcome(tmpDir, {
      playbookIds: [record!.playbook_id],
      verificationResult: {
        ...makeVerificationResult(),
        verdict: "partial",
        confidence: 0.45,
        timestamp: "2026-04-21T10:07:00.000Z",
      },
    });
    const [afterSecondFailure] = await loadDreamPlaybooks(tmpDir);
    expect(afterSecondFailure).toMatchObject({
      status: "candidate",
      usage: expect.objectContaining({
        retrieved_count: 2,
        failed_reuse_count: 2,
      }),
    });
  });
});
