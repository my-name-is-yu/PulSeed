import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import type { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import type { AgentLoopModelClient, AgentLoopModelRegistry } from "../agent-loop-model.js";
import { TaskAgentLoopRunner } from "../task-agent-loop-runner.js";
import { AgentLoopContextAssembler } from "../agent-loop-context-assembler.js";

const { finalize, prepareTaskAgentLoopWorkspace } = vi.hoisted(() => ({
  finalize: vi.fn(),
  prepareTaskAgentLoopWorkspace: vi.fn(),
}));

vi.mock("../task-agent-loop-worktree.js", () => ({
  prepareTaskAgentLoopWorkspace,
}));

function makeTask(): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    work_description: "Implement grounding safely",
    approach: "Make the minimal code change",
    success_criteria: [],
  } as unknown as Task;
}

function makeArtifactTask(): Task {
  return {
    ...makeTask(),
    artifact_contract: {
      required: true,
      required_artifacts: [
        {
          kind: "metrics_json",
          path: "reports/sequence_hazard_auc.json",
          required_fields: ["mean_roc_auc", "sequence_hazard_features"],
          field_types: {
            mean_roc_auc: "number",
            sequence_hazard_features: "array",
          },
          fresh_after_task_start: true,
        },
      ],
    },
    success_criteria: [
      {
        description: "script validates the task artifact contract",
        verification_method: ".venv/bin/python src/experiments/train_sequence_hazard_auc.py --check-contract",
        is_blocking: true,
      },
    ],
  } as unknown as Task;
}

describe("TaskAgentLoopRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finalizes the workspace when grounding assembly throws before execution", async () => {
    finalize.mockResolvedValue({
      requestedCwd: "/repo",
      executionCwd: "/repo/.wt",
      isolated: true,
      cleanupStatus: "cleaned_up",
    });
    prepareTaskAgentLoopWorkspace.mockResolvedValue({
      requestedCwd: "/repo",
      executionCwd: "/repo/.wt",
      isolated: true,
      finalize,
    });

    const boundedRunner = {
      run: vi.fn(),
    } as unknown as BoundedAgentLoopRunner;
    const modelInfo = {
      ref: { providerId: "test", modelId: "model" },
      displayName: "test/model",
      capabilities: {},
    };
    const runner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient: {
        getModelInfo: vi.fn().mockResolvedValue(modelInfo),
      } as unknown as AgentLoopModelClient,
      modelRegistry: {
        defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
      } as unknown as AgentLoopModelRegistry,
      contextAssembler: {
        groundingGateway: null as never,
        assembleTask: vi.fn().mockRejectedValue(new Error("grounding failed")),
      } as unknown as NonNullable<ConstructorParameters<typeof TaskAgentLoopRunner>[0]["contextAssembler"]>,
    });

    await expect(runner.runTask({ task: makeTask(), cwd: "/repo" })).rejects.toThrow("grounding failed");
    expect((boundedRunner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(finalize).toHaveBeenCalledWith({ success: false, changedFiles: [] });
  });

  it("continues into the bounded runner when Soil vector prefetch fails auth", async () => {
    const cwd = process.cwd();
    finalize.mockResolvedValue({
      requestedCwd: cwd,
      executionCwd: cwd,
      isolated: false,
      cleanupStatus: "not_requested",
    });
    prepareTaskAgentLoopWorkspace.mockResolvedValue({
      requestedCwd: cwd,
      executionCwd: cwd,
      isolated: false,
      finalize,
    });
    const boundedRunner = {
      run: vi.fn().mockResolvedValue({
        success: true,
        output: {
          status: "done",
          finalAnswer: "finished",
          summary: "summary",
          filesChanged: [],
          testsRun: [],
          completionEvidence: ["bounded runner reached"],
          verificationHints: [],
          blockers: [],
        },
        finalText: "finished",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    } as unknown as BoundedAgentLoopRunner;
    const modelInfo = {
      ref: { providerId: "test", modelId: "model" },
      displayName: "test/model",
      capabilities: {},
    };
    const vectorIndex = {
      search: vi.fn().mockRejectedValue(new Error("OpenAI embedding request failed: 401 Unauthorized")),
    };
    const runner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient: {
        getModelInfo: vi.fn().mockResolvedValue(modelInfo),
      } as unknown as AgentLoopModelClient,
      modelRegistry: {
        defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
      } as unknown as AgentLoopModelRegistry,
      contextAssembler: new AgentLoopContextAssembler(),
      soilPrefetch: async () => {
        await vectorIndex.search("query", 5, 0);
        return null;
      },
    });

    const result = await runner.runTask({ task: makeTask(), cwd });

    expect(vectorIndex.search).toHaveBeenCalled();
    expect(boundedRunner.run).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const turn = (boundedRunner.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = turn.messages.find((message: { role: string }) => message.role === "user")?.content;
    expect(userMessage).toContain("Soil prefetch failed; continuing without Soil context");
    expect(userMessage).toContain("OpenAI embedding request failed: 401 Unauthorized");
  });

  it("passes exact artifact contract and verification command into the assembled task prompt", async () => {
    const cwd = process.cwd();
    finalize.mockResolvedValue({
      requestedCwd: cwd,
      executionCwd: cwd,
      isolated: false,
      cleanupStatus: "not_requested",
    });
    prepareTaskAgentLoopWorkspace.mockResolvedValue({
      requestedCwd: cwd,
      executionCwd: cwd,
      isolated: false,
      finalize,
    });
    const boundedRunner = {
      run: vi.fn().mockResolvedValue({
        success: true,
        output: {
          status: "done",
          finalAnswer: "finished",
          summary: "summary",
          filesChanged: [],
          testsRun: [],
          completionEvidence: ["bounded runner reached"],
          verificationHints: [],
          blockers: [],
        },
        finalText: "finished",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    } as unknown as BoundedAgentLoopRunner;
    const modelInfo = {
      ref: { providerId: "test", modelId: "model" },
      displayName: "test/model",
      capabilities: {},
    };
    const runner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient: {
        getModelInfo: vi.fn().mockResolvedValue(modelInfo),
      } as unknown as AgentLoopModelClient,
      modelRegistry: {
        defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
      } as unknown as AgentLoopModelRegistry,
      contextAssembler: new AgentLoopContextAssembler(),
    });

    await runner.runTask({ task: makeArtifactTask(), cwd });

    const turn = (boundedRunner.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = turn.messages.find((message: { role: string }) => message.role === "user")?.content;
    expect(userMessage).toContain("Artifact contract:");
    expect(userMessage).toContain("\"mean_roc_auc\"");
    expect(userMessage).toContain("\"sequence_hazard_features\"");
    expect(userMessage).toContain("\"field_types\"");
    expect(userMessage).toContain(".venv/bin/python src/experiments/train_sequence_hazard_auc.py --check-contract");
    expect(userMessage).toContain("must validate the exact required_artifacts, required_fields, and field_types above");
    expect(userMessage).toContain("PulSeed enforces fresh_after_task_start relative to the task start time");
  });
});
