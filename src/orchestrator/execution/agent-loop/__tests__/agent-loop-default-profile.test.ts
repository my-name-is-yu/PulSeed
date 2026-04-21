import { describe, expect, it } from "vitest";
import {
  formatAgentLoopResolvedProfileSummary,
  resolveAgentLoopDefaultProfile,
  summarizeAgentLoopResolvedProfile,
} from "../agent-loop-default-profile.js";
import { StaticCorePhasePolicyRegistry } from "../../../loop/core-loop/phase-policy.js";

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
    expect(profile.executionPolicy).toMatchObject({
      sandboxMode: "workspace_write",
      approvalPolicy: "on_request",
      networkAccess: false,
      trustProjectInstructions: true,
    });
  });

  it("merges chat overrides on top of the current defaults", () => {
    const profile = resolveAgentLoopDefaultProfile({
      surface: "chat",
      workspaceRoot: "/repo",
      budget: { maxModelTurns: 4 },
      toolPolicy: {
        allowedTools: ["read_pulseed_file"],
        requiredTools: ["read_pulseed_file"],
      },
    });

    expect(profile.name).toBe("chat");
    expect(profile.budget.maxModelTurns).toBe(4);
    expect(profile.budget.maxToolCalls).toBe(40);
    expect(profile.toolPolicy).toEqual({
      allowedTools: ["read_pulseed_file"],
      requiredTools: ["read_pulseed_file"],
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
      "read_pulseed_file",
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
  });

  it("summarizes review posture without changing defaults", () => {
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

    expect(
      formatAgentLoopResolvedProfileSummary(summarizeAgentLoopResolvedProfile(profile)),
    ).toBe([
      "profile_id: review",
      "resolved_posture: sandbox=workspace_write approval=on_request network=off",
    ].join("\n"));
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
