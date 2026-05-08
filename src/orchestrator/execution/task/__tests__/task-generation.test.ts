import { describe, expect, it } from "vitest";
import { TaskSchema, type Task } from "../../../../base/types/task.js";
import { evaluateTaskComplexity } from "../task-generation.js";

function task(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: "task-1",
    goal_id: "goal-1",
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "Update README and docs",
    rationale: "Improve quality",
    approach: "Make a bounded edit",
    success_criteria: [{
      description: "File updated",
      verification_method: "test -f README.md",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["README.md"],
      out_of_scope: [],
      blast_radius: "single file",
    },
    constraints: [],
    artifact_contract: {
      required: false,
      required_artifacts: [],
    },
    created_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  });
}

describe("evaluateTaskComplexity", () => {
  it("does not classify short single-scope tasks as large from freeform conjunctions", () => {
    const result = evaluateTaskComplexity(task({
      work_description: "Update README and docs",
      scope_boundary: {
        in_scope: ["README.md"],
        out_of_scope: [],
        blast_radius: "single file",
      },
    }));

    expect(result).toBe("small");
  });

  it("classifies structured multi-scope tasks as large", () => {
    const result = evaluateTaskComplexity(task({
      work_description: "Update documentation",
      scope_boundary: {
        in_scope: ["README.md", "docs/api.md"],
        out_of_scope: [],
        blast_radius: "two docs files",
      },
    }));

    expect(result).toBe("large");
  });

  it("classifies structured artifact and duration signals without reading description keywords", () => {
    expect(evaluateTaskComplexity(task({
      artifact_contract: {
        required: true,
        required_artifacts: [{
          kind: "metrics_json",
          path: "reports/metrics.json",
          required_fields: ["score"],
          fresh_after_task_start: true,
        }],
      },
    }))).toBe("medium");

    expect(evaluateTaskComplexity(task({
      artifact_contract: {
        required: true,
        required_artifacts: [
          {
            kind: "metrics_json",
            path: "reports/metrics.json",
            required_fields: ["score"],
            fresh_after_task_start: true,
          },
          {
            kind: "submission_csv",
            path: "submission.csv",
            required_fields: ["id", "target"],
            fresh_after_task_start: true,
          },
        ],
      },
    }))).toBe("large");

    expect(evaluateTaskComplexity(task({
      estimated_duration: { value: 2, unit: "days" },
    }))).toBe("large");
  });
});
