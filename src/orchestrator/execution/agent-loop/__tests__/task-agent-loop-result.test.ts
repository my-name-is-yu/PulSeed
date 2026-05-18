import { describe, expect, it } from "vitest";
import { TaskAgentLoopOutputSchema, taskAgentLoopResultToAgentResult } from "../task-agent-loop-result.js";

describe("taskAgentLoopResultToAgentResult", () => {
  it("normalizes common final JSON aliases instead of burning repair turns", () => {
    const parsed = TaskAgentLoopOutputSchema.parse({
      status: "completed",
      summary: "Created the experiment and verified artifacts.",
      changed_files: ["src/experiments/train_group_target_encoding_auc.py"],
      completionEvidence: [
        {
          type: "runtime_verification",
          command: ".venv/bin/python src/experiments/train_group_target_encoding_auc.py --contract-check",
          status: "passed",
          output: "Contract OK",
        },
      ],
    });

    expect(parsed).toMatchObject({
      status: "done",
      finalAnswer: "Created the experiment and verified artifacts.",
      filesChanged: ["src/experiments/train_group_target_encoding_auc.py"],
      completionEvidence: [
        "runtime_verification; .venv/bin/python src/experiments/train_group_target_encoding_auc.py --contract-check; passed; Contract OK",
      ],
    });
  });

  it("carries apply_patch artifacts as concrete changed paths", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "done",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "done",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 1,
      compactions: 0,
      changedFiles: [],
      toolResults: [{
        toolName: "apply_patch",
        success: true,
        artifacts: ["reports/result.md", "../outside.md", "/tmp/outside.md"],
        outputSummary: "Patch applied: reports/result.md",
        durationMs: 1,
      }],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.filesChanged).toBe(true);
    expect(result.filesChangedPaths).toEqual(["reports/result.md"]);
    expect(result.agentLoop?.filesChangedPaths).toEqual(["reports/result.md"]);
  });

  it("does not carry check-only apply_patch artifacts as changed paths", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "done",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "done",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 1,
      compactions: 0,
      changedFiles: [],
      toolResults: [{
        toolName: "apply_patch",
        success: true,
        artifacts: ["reports/check-only.md"],
        checkOnly: true,
        outputSummary: "Patch check passed: reports/check-only.md",
        durationMs: 1,
      }],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.filesChanged).toBe(false);
    expect(result.filesChangedPaths).toEqual([]);
    expect(result.agentLoop?.filesChangedPaths).toEqual([]);
  });

  it("carries non-patch tool artifacts as completion artifacts without treating them as file edits", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "finished",
        summary: "finished",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "finished",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 1,
      compactions: 0,
      changedFiles: [],
      toolResults: [{
        toolName: "arc_agi3_finish",
        success: true,
        artifacts: ["/state/arc-agi-3/runs/run-1/run.json"],
        outputSummary: "Finished ARC run",
        durationMs: 1,
      }],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.filesChanged).toBe(false);
    expect(result.completionArtifacts).toEqual([{
      path: "/state/arc-agi-3/runs/run-1/run.json",
      sourceTool: "arc_agi3_finish",
    }]);
    expect(result.agentLoop?.completionArtifacts).toEqual(result.completionArtifacts);
    expect(result.agentLoop?.completionEvidence).toContain(
      "completion artifact from arc_agi3_finish: /state/arc-agi-3/runs/run-1/run.json"
    );
  });

  it("does not mark a dirty isolated worktree as completed without handoff", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "done",
        filesChanged: ["README.md"],
        testsRun: [],
        completionEvidence: ["model claimed completion"],
        verificationHints: [],
        blockers: [],
      },
      finalText: "done",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      changedFiles: ["README.md"],
      commandResults: [],
      workspace: {
        requestedCwd: "/repo",
        executionCwd: "/worktrees/task-1",
        isolated: true,
        cleanupStatus: "kept",
        cleanupReason: "worktree has changes",
        dirty: true,
        disposition: "handoff_required",
      },
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.output).toContain("/worktrees/task-1");
    expect(result.error).toContain("operator handoff");
    expect(result.agentLoop).toMatchObject({
      requestedCwd: "/repo",
      executionCwd: "/worktrees/task-1",
      isolatedWorkspace: true,
      workspaceDirty: true,
      workspaceDisposition: "handoff_required",
    });
  });

  it("preserves policy-blocked tool non-execution as the stopped reason", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: false,
      output: null,
      finalText: "shell command was not executed",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 1,
      compactions: 0,
      changedFiles: [],
      commandResults: [{
        toolName: "shell_command",
        command: "python - <<'PY'\nprint('rewrite')\nPY",
        cwd: "/workspace",
        success: false,
        execution: {
          status: "not_executed",
          reason: "policy_blocked",
          message: "Shell command contains unsupported multiline syntax",
        },
        category: "other",
        evidenceEligible: false,
        outputSummary: "blocked by shell policy",
        durationMs: 1,
      }],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("policy_blocked");
    expect(result.output).toContain("Command shell_command was not executed (policy_blocked)");
    expect(result.error).toContain("unsupported multiline syntax");
    expect(result.agentLoop?.verificationHints).toContain(result.output);
  });

  it("does not preserve an older policy block as terminal after a later successful edit recovers", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "recovered",
        summary: "recovered with typed edit",
        filesChanged: ["README.md"],
        testsRun: [],
        completionEvidence: ["typed edit succeeded"],
        verificationHints: [],
        blockers: [],
      },
      finalText: "recovered",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 2,
      toolCalls: 2,
      compactions: 0,
      changedFiles: ["README.md"],
      commandResults: [{
        sequence: 0,
        toolName: "shell_command",
        command: "python - <<'PY'\nprint('rewrite')\nPY",
        cwd: "/workspace",
        success: false,
        execution: {
          status: "not_executed",
          reason: "policy_blocked",
          message: "Shell command contains unsupported multiline syntax",
        },
        category: "other",
        evidenceEligible: false,
        outputSummary: "blocked by shell policy",
        durationMs: 1,
      }],
      toolResults: [{
        sequence: 1,
        toolName: "apply_patch",
        success: true,
        artifacts: ["README.md"],
        outputSummary: "Patch applied: README.md",
        durationMs: 1,
      }],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.success).toBe(true);
    expect(result.stopped_reason).toBe("completed");
    expect(result.error).toBeNull();
  });
});
