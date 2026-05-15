import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import { upsertRelationshipProfileItem } from "../../../../platform/profile/relationship-profile.js";
import {
  FileCognitionAuditSink,
  createReflectionInputFromCognitionReplay,
} from "../../../../runtime/cognition/index.js";
import { FileCognitiveReplayIndexStore } from "../../../../runtime/visibility/index.js";
import type { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import type { AgentLoopModelClient, AgentLoopModelRegistry } from "../agent-loop-model.js";
import { TaskAgentLoopRunner } from "../task-agent-loop-runner.js";
import { AgentLoopContextAssembler } from "../agent-loop-context-assembler.js";
import { createAgentLoopSession } from "../agent-loop-session.js";

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

  it("continues into the bounded runner through canonical grounding without legacy Soil prefetch", async () => {
    const cwd = process.cwd();
    const cognitionMemoryBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-task-cognition-memory-"));
    await upsertRelationshipProfileItem(cognitionMemoryBaseDir, {
      stableKey: "task.status_style",
      kind: "preference",
      value: "Keep long-running task status concise.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      sensitivity: "private",
      now: "2026-05-14T00:00:00.000Z",
    });
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
      cognitionMemoryBaseDir,
    });

    const result = await runner.runTask({ task: makeTask(), cwd });

    expect(boundedRunner.run).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const turn = (boundedRunner.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = turn.messages.find((message: { role: string }) => message.role === "user")?.content;
    expect(userMessage).not.toContain("Soil prefetch failed");
    expect(result.cognitionOutput).toMatchObject({
      caller_path: "long_running_task_turn",
      selected_intention: {
        goal_ref: {
          goal_id: "goal-1",
        },
      },
      response_plan: {
        guidance_kind: "continue_route",
      },
    });
    expect(result.cognitionOutput?.relationship_state.relationship_refs).toHaveLength(1);
    expect(result.cognitionReplayRecord).toMatchObject({
      record_id: expect.stringMatching(/^cognition:task:task-1:attempt:.+:replay$/),
      caller_path: "long_running_task_turn",
      retention_policy: {
        materialized_content: false,
        refs_only: true,
        invalidates_on_source_tombstone: true,
      },
    });
    expect(result.cognitionReplayIndexEntry).toMatchObject({
      index_entry_id: expect.stringMatching(/^cognition:task:task-1:attempt:.+:replay-index$/),
      owner_store: "runtime_operation",
      normal_surface_visible: false,
      cognition_service_is_owner: false,
    });
    expect(await new FileCognitionAuditSink(cognitionMemoryBaseDir).list()).toHaveLength(1);
    expect(await new FileCognitiveReplayIndexStore(cognitionMemoryBaseDir).list()).toHaveLength(1);
    fs.rmSync(cognitionMemoryBaseDir, { recursive: true, force: true });
  });

  it("keeps task cognition replay records distinct across retry attempts", async () => {
    const cwd = process.cwd();
    const cognitionMemoryBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-task-cognition-retry-"));
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
      run: vi.fn(async (turn) => ({
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
        traceId: turn.session.traceId,
        sessionId: turn.session.sessionId,
        turnId: turn.turnId,
      })),
    } as unknown as BoundedAgentLoopRunner;
    const modelInfo = {
      ref: { providerId: "test", modelId: "model" },
      displayName: "test/model",
      capabilities: {},
    };
    const sessions = [
      createAgentLoopSession({ sessionId: "session-a", traceId: "trace-a" }),
      createAgentLoopSession({ sessionId: "session-b", traceId: "trace-b" }),
    ];
    const runner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient: {
        getModelInfo: vi.fn().mockResolvedValue(modelInfo),
      } as unknown as AgentLoopModelClient,
      modelRegistry: {
        defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
      } as unknown as AgentLoopModelRegistry,
      contextAssembler: new AgentLoopContextAssembler(),
      cognitionMemoryBaseDir,
      createSession: () => sessions.shift()!,
    });

    await runner.runTask({ task: makeTask(), cwd });
    await runner.runTask({ task: makeTask(), cwd });

    const records = await new FileCognitionAuditSink(cognitionMemoryBaseDir).list();
    const index = await new FileCognitiveReplayIndexStore(cognitionMemoryBaseDir).list();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.record_id)).toEqual([
      expect.stringContaining("cognition:task:task-1:attempt:trace-a:"),
      expect.stringContaining("cognition:task:task-1:attempt:trace-b:"),
    ]);
    expect(index).toHaveLength(2);
    expect(new Set(index.map((entry) => entry.index_entry_id)).size).toBe(2);
    fs.rmSync(cognitionMemoryBaseDir, { recursive: true, force: true });
  });

  it("updates task cognition replay with post-run command trace refs", async () => {
    const cwd = process.cwd();
    const cognitionMemoryBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-task-cognition-trace-"));
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
      run: vi.fn(async (turn) => ({
        success: false,
        output: {
          status: "failed",
          finalAnswer: "verification failed",
          summary: "summary",
          filesChanged: [],
          testsRun: ["npm test"],
          completionEvidence: [],
          verificationHints: [],
          blockers: ["verification failed"],
        },
        finalText: "verification failed",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 1,
        compactions: 0,
        changedFiles: [],
        commandResults: [{
          sequence: 1,
          toolName: "shell_command",
          command: "npm test",
          cwd,
          success: false,
          category: "verification",
          evidenceEligible: true,
          evidenceSource: "verification_plan",
          outputSummary: "test failed",
          durationMs: 25,
        }],
        traceId: turn.session.traceId,
        sessionId: turn.session.sessionId,
        turnId: turn.turnId,
      })),
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
      cognitionMemoryBaseDir,
      createSession: () => createAgentLoopSession({ sessionId: "session-post", traceId: "trace-post" }),
    });

    const result = await runner.runTask({ task: makeTask(), cwd });
    const traceEventRefs = result.cognitionReplayRecord?.event_refs.filter((ref) =>
      ref.source_event_type === "agent_loop_command_result"
    ) ?? [];

    expect(traceEventRefs).toHaveLength(1);
    expect(result.cognitionOutput?.situation_model).toMatchObject({
      runtime_phase_ref: { kind: "task_phase", ref: "task-agent-loop:post-run" },
      tool_trace_refs: [{ kind: "agent_loop_command_result", ref: traceEventRefs[0]!.ref }],
    });
    expect(result.cognitionReplayIndexEntry?.source_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: traceEventRefs[0]!.ref,
        source_event_type: "agent_loop_command_result",
      }),
    ]));
    const reflectionInput = createReflectionInputFromCognitionReplay({
      inputId: "reflection:task:post-run",
      record: result.cognitionReplayRecord!,
    });
    expect(reflectionInput.tool_trace_refs).toMatchObject([{
      ref: traceEventRefs[0]!.ref,
      source_event_type: "agent_loop_command_result",
    }]);
    fs.rmSync(cognitionMemoryBaseDir, { recursive: true, force: true });
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
