import { describe, expect, it } from "vitest";

const {
  buildGoalDescription,
  classifyScenarioState,
  isDaemonCycleSettledState,
  selectScenarios,
} = await import("../../scripts/goal-canary-supervisor.mjs") as {
  buildGoalDescription: (scenario: Record<string, unknown>, workspace: string) => string;
  classifyScenarioState: (scenario: unknown, latest: unknown, context?: unknown) => {
    done: boolean;
    blocked: boolean;
    classification: string;
  };
  isDaemonCycleSettledState: (value: unknown) => boolean;
  selectScenarios: (options: { scenarioSlugs: string[]; maxScenarios: number }) => Array<{ slug: string }>;
};

const scenario = {
  restartAfterExpectedArtifactSeen: true,
  expectedArtifact: "reports/restart.json",
};

const context = {
  restarted: true,
  restartInterruptedRunningTask: true,
  interruptedTaskId: "task-restart",
  restartStartedAt: "2026-05-08T00:00:10.000Z",
  restartCutoffEventAt: "2026-05-08T00:00:05.000Z",
};

function latest(overrides: {
  taskId?: string;
  taskStatus?: string;
  verificationVerdict?: string | null;
  latestEventType?: string | null;
  latestEventAt?: string | null;
  taskHistory?: unknown[];
} = {}) {
  const taskId = overrides.taskId ?? "task-restart";
  const latestEventType = overrides.latestEventType ?? "succeeded";
  const latestEventAt = overrides.latestEventAt ?? "2026-05-08T00:00:20.000Z";

  return {
    task: {
      id: taskId,
      status: overrides.taskStatus ?? "completed",
      verification_verdict: overrides.verificationVerdict ?? "pass",
    },
    ledger: {
      summary: {
        latest_event_type: latestEventType,
        latest_event_at: latestEventAt,
      },
      events: latestEventType
        ? [{ type: latestEventType, ts: latestEventAt }]
        : [],
    },
    taskHistory: overrides.taskHistory ?? [{
      task_id: taskId,
      recovery_source: "daemon_shutdown",
      completed_at: "2026-05-08T00:00:20.000Z",
    }],
    workspaceFiles: ["reports/restart.json"],
  };
}

describe("goal canary supervisor restart classification", () => {
  it("accepts a post-restart succeeded ledger with fresh daemon recovery history", () => {
    expect(classifyScenarioState(scenario, latest(), context)).toEqual({
      done: true,
      blocked: false,
      classification: "task_succeeded",
    });
  });

  it("rejects a stale pre-restart succeeded ledger", () => {
    expect(classifyScenarioState(
      scenario,
      latest({ latestEventAt: "2026-05-08T00:00:05.000Z" }),
      context,
    )).toEqual({
      done: false,
      blocked: true,
      classification: "stale_restart_success_ledger",
    });
  });

  it("rejects success from a task that was not the interrupted running task", () => {
    expect(classifyScenarioState(scenario, latest(), {
      ...context,
      interruptedTaskId: "different-task",
    })).toEqual({
      done: false,
      blocked: true,
      classification: "restart_not_exercised_before_success",
    });
  });

  it("rejects success without fresh daemon recovery history", () => {
    expect(classifyScenarioState(
      scenario,
      latest({
        taskHistory: [{
          task_id: "task-restart",
          recovery_source: "daemon_shutdown",
          completed_at: "2026-05-08T00:00:09.999Z",
        }],
      }),
      context,
    )).toEqual({
      done: false,
      blocked: true,
      classification: "missing_fresh_restart_recovery_history",
    });
  });

  it("waits for the restart success ledger instead of passing on completed task state only", () => {
    expect(classifyScenarioState(
      scenario,
      latest({ latestEventType: "started", latestEventAt: "2026-05-08T00:00:05.000Z" }),
      context,
    )).toEqual({
      done: false,
      blocked: false,
      classification: "awaiting_restart_success_ledger",
    });
  });
});

describe("goal canary supervisor expected artifact JSON classification", () => {
  const packagingScenario = {
    expectedArtifact: "reports/packaged-cli.json",
    expectedArtifactJson: {
      cli_runner_executable: true,
      cli_runner_exists: true,
      packaged_artifact_verification_passed: true,
    },
  };

  function packagingLatest(overrides: {
    taskStatus?: string;
    latestEventType?: string | null;
    expectedArtifactJson?: unknown;
  } = {}) {
    const latestEventType = overrides.latestEventType ?? "succeeded";

    return {
      task: {
        id: "task-package",
        status: overrides.taskStatus ?? "completed",
        verification_verdict: "pass",
      },
      ledger: {
        summary: {
          latest_event_type: latestEventType,
          latest_event_at: "2026-05-08T00:00:20.000Z",
        },
        events: latestEventType
          ? [{ type: latestEventType, ts: "2026-05-08T00:00:20.000Z" }]
          : [],
      },
      workspaceFiles: ["reports/packaged-cli.json"],
      expectedArtifactJson: Object.hasOwn(overrides, "expectedArtifactJson")
        ? overrides.expectedArtifactJson
        : {
            cli_runner_executable: true,
            cli_runner_exists: true,
            packaged_artifact_verification_passed: true,
          },
    };
  }

  it("rejects terminal success when an expected artifact JSON field has the wrong value", () => {
    expect(classifyScenarioState(
      packagingScenario,
      packagingLatest({
        expectedArtifactJson: {
          cli_runner_executable: true,
          cli_runner_exists: true,
          packaged_artifact_verification_passed: false,
        },
      }),
    )).toEqual({
      done: false,
      blocked: true,
      classification: "expected_artifact_json_mismatch_packaged_artifact_verification_passed",
    });
  });

  it("rejects artifact plus verifier pass when the expected artifact JSON is missing", () => {
    expect(classifyScenarioState(
      packagingScenario,
      packagingLatest({
        taskStatus: "running",
        latestEventType: "started",
        expectedArtifactJson: null,
      }),
    )).toEqual({
      done: false,
      blocked: true,
      classification: "expected_artifact_json_missing",
    });
  });

  it("accepts artifact plus verifier pass only when the expected artifact JSON matches", () => {
    expect(classifyScenarioState(
      packagingScenario,
      packagingLatest({
        taskStatus: "running",
        latestEventType: "started",
      }),
    )).toEqual({
      done: true,
      blocked: false,
      classification: "artifact_and_verification_passed",
    });
  });

  it("passes the expected artifact JSON contract into the goal description", () => {
    const description = buildGoalDescription({
      ...packagingScenario,
      title: "Goal canary: CLI packaging and build surface",
      seedDist: true,
      workspaceFiles: { "README.md": "# CLI packaging/build canary\n" },
    }, "/tmp/pulseed-canary-workspace");

    expect(description).toContain("Expected artifact JSON contract:");
    expect(description).toContain("\"cli_runner_executable\":true");
    expect(description).toContain("\"cli_runner_exists\":true");
    expect(description).toContain("\"packaged_artifact_verification_passed\":true");
    expect(description).toContain("Do not replace those required fields with alternate names or synonyms.");
  });
});

describe("goal canary supervisor scenario selection", () => {
  it("preserves the requested scenario order", () => {
    const selected = selectScenarios({
      scenarioSlugs: [
        "completion-judger-fallback",
        "non-git-workspace-handoff",
        "daemon-stop-restart",
      ],
      maxScenarios: 10,
    });

    expect(selected.map((scenario) => scenario.slug)).toEqual([
      "completion-judger-fallback",
      "non-git-workspace-handoff",
      "daemon-stop-restart",
    ]);
  });

  it("applies maxScenarios after preserving requested order", () => {
    const selected = selectScenarios({
      scenarioSlugs: [
        "completion-judger-fallback",
        "non-git-workspace-handoff",
        "daemon-stop-restart",
      ],
      maxScenarios: 2,
    });

    expect(selected.map((scenario) => scenario.slug)).toEqual([
      "completion-judger-fallback",
      "non-git-workspace-handoff",
    ]);
  });
});

describe("goal canary supervisor daemon settlement classification", () => {
  it("accepts a running daemon only after a bounded cycle has completed", () => {
    expect(isDaemonCycleSettledState({
      status: "running",
      loop_count: 1,
      last_loop_at: "2026-05-08T00:00:20.000Z",
    })).toBe(true);
  });

  it("rejects task-success timing while the daemon cycle is still in flight", () => {
    expect(isDaemonCycleSettledState({
      status: "running",
      loop_count: 0,
      last_loop_at: null,
    })).toBe(false);
  });

  it("rejects historical stopped state because it cannot prove a live clean stop point", () => {
    expect(isDaemonCycleSettledState({
      status: "stopped",
      loop_count: 1,
      last_loop_at: "2026-05-08T00:00:20.000Z",
    })).toBe(false);
  });
});
