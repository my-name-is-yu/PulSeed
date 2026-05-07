import { describe, expect, it } from "vitest";

const { classifyScenarioState } = await import("../../scripts/goal-canary-supervisor.mjs") as {
  classifyScenarioState: (scenario: unknown, latest: unknown, context?: unknown) => {
    done: boolean;
    blocked: boolean;
    classification: string;
  };
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
