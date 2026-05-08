import { describe, expect, it, vi } from "vitest";
import type { ILLMClient } from "../../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../../base/llm/provider-config.js";
import { createBuiltinTools } from "../../../../tools/builtin/index.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolRegistryAgentLoopToolRouter } from "../agent-loop-tool-router.js";
import { resolveAgentLoopDefaultProfileFromProviderConfig } from "../agent-loop-default-profile.js";
import {
  createAgentLoopModelInfo,
  createNativeChatAgentLoopRunner,
  createNativeReviewAgentLoopRunner,
  createNativeTaskAgentLoopRunner,
} from "../task-agent-loop-factory.js";

function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: "openai",
    model: "gpt-5.5",
    adapter: "openai_codex_cli",
    reasoning_effort: "high",
    agent_loop: {
      security: {
        sandbox_mode: "workspace_write",
        approval_policy: "on_request",
        network_access: false,
        trust_project_instructions: true,
      },
      worktree: {
        enabled: true,
        base_dir: "/tmp/provider-worktrees",
        keep_for_debug: true,
        cleanup_policy: "always",
      },
    },
    ...overrides,
  } as ProviderConfig;
}

function makeProviderConfigWithoutAgentLoop(): ProviderConfig {
  return {
    provider: "openai",
    model: "gpt-5.5",
    adapter: "openai_codex_cli",
    reasoning_effort: "minimal",
  } as ProviderConfig;
}

function makeLlmClient(): ILLMClient {
  return {
    supportsToolCalling: vi.fn().mockReturnValue(false),
  } as unknown as ILLMClient;
}

function makeToolExecutor(registry: ToolRegistry): ToolExecutor {
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
}

function contextLimitFor(providerConfig: Partial<ProviderConfig>): number | undefined {
  return createAgentLoopModelInfo(makeProviderConfig({
    adapter: "agent_loop",
    ...providerConfig,
  }), makeLlmClient()).capabilities.contextLimitTokens;
}

describe("createNative*AgentLoopRunner", () => {
  it("infers agent-loop context limits from exact provider model contracts", () => {
    expect(contextLimitFor({ provider: "openai", model: "gpt-5.5" })).toBe(1_000_000);
    expect(contextLimitFor({ provider: "openai", model: "gpt-4o" })).toBe(128_000);
    expect(contextLimitFor({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(200_000);
  });

  it("does not infer context limits from misleading model substrings", () => {
    expect(contextLimitFor({ provider: "openai", model: "vendor-gpt-5-proxy" })).toBeUndefined();
    expect(contextLimitFor({ provider: "openai", model: "qwen-compatible" })).toBeUndefined();
    expect(contextLimitFor({ provider: "anthropic", model: "not-claude-compatible" })).toBeUndefined();
    expect(contextLimitFor({ provider: "ollama", model: "qwen3:4b" })).toBeUndefined();
    expect(contextLimitFor({ provider: "ollama", model: "custom-local-model" })).toBeUndefined();
  });

  it("keeps task profile defaults for budget, reasoning, and worktree policy", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    const runner = createNativeTaskAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultReasoningEffort).toBe("high");
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(deps.defaultWorktreePolicy).toEqual(profile.worktreePolicy);
    expect(profile.worktreePolicy).toEqual({
      enabled: true,
      baseDir: "/tmp/provider-worktrees",
      keepForDebug: true,
      cleanupPolicy: "always",
    });
  });

  it("restores fallback task defaults when provider config omits agent_loop settings", () => {
    const providerConfig = makeProviderConfigWithoutAgentLoop();
    const registry = new ToolRegistry();
    const runner = createNativeTaskAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultReasoningEffort).toBe("minimal");
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(deps.defaultWorktreePolicy).toEqual(profile.worktreePolicy);
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

  it("does not force code-search tools as task completion prerequisites", () => {
    const providerConfig = makeProviderConfig();
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(profile.toolPolicy.requiredTools ?? []).toEqual([]);

    const explicitProfile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
      toolPolicy: { requiredTools: ["task_get"] },
    });
    expect(explicitProfile.toolPolicy.requiredTools).toEqual(["task_get"]);
  });

  it("keeps chat profile defaults for budget, reasoning, and execution policy", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    const runner = createNativeChatAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "chat",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultReasoningEffort).toBe("high");
    expect(deps.defaultProfileName).toBe(profile.name);
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
    expect(profile.toolPolicy.allowedTools).toEqual(
      expect.arrayContaining([
        "kaggle_workspace_prepare",
        "kaggle_experiment_start",
        "kaggle_experiment_read",
        "kaggle_experiment_list",
        "kaggle_experiment_stop",
        "kaggle_metric_report",
        "kaggle_compare_experiments",
        "kaggle_submission_prepare",
        "kaggle_list_submissions",
        "kaggle_leaderboard_snapshot",
        "core_goal_status",
        "core_tend_goal",
        "core_goal_start",
        "draft_run_spec",
        "update_run_spec_draft",
        "cancel_run_spec_draft",
        "runspec_propose",
        "runspec_confirm",
        "run_start",
        "get_gateway_setup_status",
        "prepare_gateway_setup_guidance",
        "prepare_gateway_config_write",
        "confirm_gateway_config_write",
        "cancel_gateway_config_write",
        "get_runtime_status",
        "request_runtime_control",
        "runs_observe",
        "run_pause",
        "run_resume",
        "run_cancel",
        "sessions_list",
        "sessions_read",
        "sessions_children",
      ]),
    );
    expect(profile.toolPolicy.allowedTools).not.toEqual(expect.arrayContaining([
      "sessions_spawn",
      "sessions_send",
      "sessions_update",
      "sessions_claim",
      "sessions_cancel",
      "sessions_retry",
    ]));
    expect(profile.toolPolicy.allowedTools).not.toContain("kaggle_submit");
  });

  it("makes registered Kaggle training tools model-visible in chat while hiding submit", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      registry,
      stateManager: { getBaseDir: () => "/tmp/pulseed-test" } as never,
      llmClient: makeLlmClient() as never,
      runtimeControlService: { request: vi.fn() } as never,
    })) {
      registry.register(tool);
    }
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "chat",
      workspaceRoot: "/repo",
      providerConfig,
    });
    const router = new ToolRegistryAgentLoopToolRouter(registry);

    const visibleTools = router.modelVisibleTools({
      cwd: "/repo",
      goalId: "chat",
      toolPolicy: profile.toolPolicy,
    } as never).map((tool) => tool.function.name);

    expect(visibleTools).toEqual(
      expect.arrayContaining([
        "code_search",
        "code_read_context",
        "code_search_repair",
        "kaggle_workspace_prepare",
        "kaggle_experiment_start",
        "kaggle_experiment_read",
        "kaggle_experiment_list",
        "kaggle_experiment_stop",
        "kaggle_metric_report",
        "kaggle_compare_experiments",
        "kaggle_submission_prepare",
        "kaggle_list_submissions",
        "kaggle_leaderboard_snapshot",
        "core_goal_status",
        "core_tend_goal",
        "core_goal_start",
        "draft_run_spec",
        "update_run_spec_draft",
        "cancel_run_spec_draft",
        "runspec_propose",
        "runspec_confirm",
        "run_start",
        "get_gateway_setup_status",
        "prepare_gateway_setup_guidance",
        "prepare_gateway_config_write",
        "confirm_gateway_config_write",
        "cancel_gateway_config_write",
        "get_runtime_status",
        "request_runtime_control",
        "runs_observe",
        "run_pause",
        "run_resume",
        "run_cancel",
      ]),
    );
    expect(visibleTools).not.toContain("glob");
    expect(visibleTools).not.toContain("grep");
    expect(visibleTools).not.toContain("read");
    expect(visibleTools).not.toContain("start_durable_run");
    expect(visibleTools).not.toContain("kaggle_submit");
  });

  it("keeps review profile defaults for budget, tools, and execution posture", () => {
    const providerConfig = makeProviderConfig();
    const registry = new ToolRegistry();
    const runner = createNativeReviewAgentLoopRunner({
      llmClient: makeLlmClient(),
      providerConfig,
      toolRegistry: registry,
      toolExecutor: makeToolExecutor(registry),
      cwd: "/repo",
    });

    const deps = (runner as unknown as { deps: Record<string, unknown> }).deps;
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "review",
      workspaceRoot: "/repo",
      providerConfig,
    });

    expect(deps.defaultBudget).toEqual(profile.budget);
    expect(deps.defaultToolPolicy).toEqual(profile.toolPolicy);
    expect(deps.defaultReasoningEffort).toBe(profile.reasoningEffort);
    expect(deps.defaultReasoningEffort).toBe("high");
    expect(deps.defaultExecutionPolicy).toEqual(profile.executionPolicy);
  });

  it("keeps explicit native profile reasoning above provider config reasoning", () => {
    const providerConfig = makeProviderConfig();
    const profile = resolveAgentLoopDefaultProfileFromProviderConfig({
      surface: "task",
      workspaceRoot: "/repo",
      providerConfig,
      reasoningEffort: "low",
    });

    expect(profile.reasoningEffort).toBe("low");
  });
});
