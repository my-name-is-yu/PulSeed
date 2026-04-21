import { describe, expect, it } from "vitest";
import {
  formatAgentLoopResolvedProfileSummary,
  resolveAgentLoopDefaultProfile,
  summarizeAgentLoopResolvedProfile,
} from "../agent-loop-default-profile.js";
import { createAgentLoopSession } from "../agent-loop-session.js";
import { ToolRegistryAgentLoopToolRouter } from "../agent-loop-tool-router.js";
import { StaticCorePhasePolicyRegistry } from "../../../loop/core-loop/phase-policy.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ReadPulseedFileTool } from "../../../../tools/fs/ReadPulseedFileTool/ReadPulseedFileTool.js";
import { TestRunnerTool } from "../../../../tools/system/TestRunnerTool/TestRunnerTool.js";

describe("resolveAgentLoopDefaultProfile", () => {
  it("preserves current task defaults", () => {
    const profile = resolveAgentLoopDefaultProfile({
      surface: "task",
      workspaceRoot: "/repo",
      security: {
        sandbox_mode: "workspace_write",
        approval_policy: "on_request",
        network_access: false,
        trust_project_instructions: true,
      },
    });

    expect(profile.name).toBe("task");
    expect(profile.budget.maxModelTurns).toBe(12);
    expect(profile.budget.compactionMaxMessages).toBe(8);
    expect(profile.toolPolicy).toEqual({});
    expect(profile.reasoningEffort).toBe("medium");
    expect(profile.executionPolicy).toMatchObject({
      sandboxMode: "workspace_write",
      approvalPolicy: "never",
      networkAccess: false,
      trustProjectInstructions: true,
    });
    expect(profile.worktreePolicy).toEqual({
      enabled: true,
      cleanupPolicy: "on_success",
    });
  });

  it("merges chat overrides on top of the current defaults", () => {
    const profile = resolveAgentLoopDefaultProfile({
      surface: "chat",
      workspaceRoot: "/repo",
      budget: { maxModelTurns: 4 },
      toolPolicy: {
        allowedTools: ["read-pulseed-file"],
        requiredTools: ["read-pulseed-file"],
      },
    });

    expect(profile.name).toBe("chat");
    expect(profile.budget.maxModelTurns).toBe(4);
    expect(profile.budget.maxToolCalls).toBe(40);
    expect(profile.reasoningEffort).toBe("low");
    expect(profile.toolPolicy).toEqual({
      allowedTools: ["read-pulseed-file"],
      requiredTools: ["read-pulseed-file"],
    });
  });

  it("preserves current core phase defaults", () => {
    const profile = resolveAgentLoopDefaultProfile({
      surface: "core_phase",
      phase: "observe_evidence",
    });

    expect(profile.name).toBe("core_phase:observe_evidence");
    expect(profile.budget.maxModelTurns).toBe(6);
    expect(profile.toolPolicy.allowedTools).toEqual([
      "read-pulseed-file",
      "glob",
      "grep",
      "git_log",
      "shell_command",
      "soil_query",
      "tool_search",
    ]);
    expect(profile.corePhase).toEqual({
      enabled: true,
      maxInvocationsPerIteration: 1,
      failPolicy: "fallback_deterministic",
    });
    expect(profile.reasoningEffort).toBe("low");
  });

  it("resolves review posture to a dedicated read-only profile", () => {
    const profile = resolveAgentLoopDefaultProfile({
      surface: "review",
      workspaceRoot: "/repo",
      security: {
        sandbox_mode: "workspace_write",
        approval_policy: "on_request",
        network_access: false,
        trust_project_instructions: true,
      },
    });

    expect(profile.toolPolicy.allowedTools).toContain("git_diff");
    expect(profile.toolPolicy.allowedTools).toContain("test-runner");
    expect(profile.executionPolicy).toMatchObject({
      sandboxMode: "read_only",
      approvalPolicy: "never",
      networkAccess: false,
      trustProjectInstructions: true,
    });
    expect(
      formatAgentLoopResolvedProfileSummary(summarizeAgentLoopResolvedProfile(profile)),
    ).toBe([
      "profile_id: review",
      "resolved_posture: sandbox=read_only approval=never network=off reasoning=medium",
    ].join("\n"));
  });

  it("keeps real registry tool names visible through the router", () => {
    const registry = new ToolRegistry();
    registry.register(new ReadPulseedFileTool());
    registry.register(new TestRunnerTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const profile = resolveAgentLoopDefaultProfile({
      surface: "review",
      workspaceRoot: "/repo",
    });

    const visible = router.modelVisibleTools({
      session: createAgentLoopSession({
        sessionId: "session-1",
        traceId: "trace-1",
        stateStore: { load: async () => null, save: async () => undefined },
      }),
      turnId: "turn-1",
      goalId: "review",
      profileName: profile.name,
      cwd: "/repo",
      model: { providerId: "openai", modelId: "gpt-5.4-mini" },
      modelInfo: {
        ref: { providerId: "openai", modelId: "gpt-5.4-mini" },
        displayName: "openai/gpt-5.4-mini",
        capabilities: {
          toolCalling: true,
          parallelToolCalls: true,
          streaming: false,
          structuredOutput: true,
          reasoning: true,
          attachments: false,
          interleavedThinking: false,
          inputModalities: ["text"],
          outputModalities: ["text"],
        },
      },
      reasoningEffort: profile.reasoningEffort,
      messages: [],
      outputSchema: { parse: (value: unknown) => value } as never,
      budget: profile.budget,
      toolPolicy: profile.toolPolicy,
      toolCallContext: {
        cwd: "/repo",
        goalId: "review",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
      executionPolicy: profile.executionPolicy,
    });

    expect(visible.map((tool) => tool.function.name)).toEqual([
      "read-pulseed-file",
      "test-runner",
    ]);
  });
});

describe("StaticCorePhasePolicyRegistry", () => {
  it("resolves defaults through the shared profile resolver", () => {
    const registry = new StaticCorePhasePolicyRegistry();
    const policy = registry.get("knowledge_refresh");

    expect(policy.enabled).toBe(true);
    expect(policy.requiredTools).toEqual(["soil_query"]);
    expect(policy.allowedTools).toContain("knowledge_query");
    expect(policy.budget.maxWallClockMs).toBe(90_000);
    expect(policy.failPolicy).toBe("return_low_confidence");
  });
});
