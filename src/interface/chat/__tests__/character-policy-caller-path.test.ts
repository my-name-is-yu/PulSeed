import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChatRunner } from "../chat-runner.js";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import type { SelectedChatRoute } from "../ingress-router.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

function makeStateManager(): StateManager {
  const dir = makeTempDir("pulseed-character-policy-chat-");
  tempDirs.push(dir);
  return new StateManager(dir);
}

function gatewayModelRoute(): SelectedChatRoute {
  return {
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function makeAdapter(): IAdapter {
  const result: AgentResult = {
    success: true,
    output: "adapter unused",
    error: null,
    exit_code: 0,
    elapsed_ms: 1,
    stopped_reason: "completed",
  };
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeLlmClient(content: string): ILLMClient & {
  sendMessageStream: ReturnType<typeof vi.fn>;
} {
  const response: LLMResponse = {
    content,
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: "end_turn",
    tool_calls: [],
  };
  return {
    sendMessage: vi.fn().mockResolvedValue(response),
    sendMessageStream: vi.fn().mockResolvedValue(response),
    supportsToolCalling: vi.fn(() => true),
    parseJSON: vi.fn((value: string, schema: z.ZodSchema<unknown>) => schema.parse(JSON.parse(value))),
  } as unknown as ILLMClient & { sendMessageStream: ReturnType<typeof vi.fn> };
}

function makeDeps(stateManager: StateManager, llmClient: ILLMClient): ChatRunnerDeps {
  return {
    stateManager,
    adapter: makeAdapter(),
    llmClient,
  };
}

function firstSystemPrompt(llmClient: { sendMessageStream: ReturnType<typeof vi.fn> }): string {
  const options = llmClient.sendMessageStream.mock.calls[0]?.[1] as LLMRequestOptions | undefined;
  expect(options?.system).toBeTypeOf("string");
  return options!.system as string;
}

function expectNoRawCharacterKnobs(system: string): void {
  expect(system).not.toContain("caution_level");
  expect(system).not.toContain("stall_flexibility");
  expect(system).not.toContain("communication_directness");
  expect(system).not.toContain("proactivity_level");
}

describe("chat character policy caller paths", () => {
  it("passes high-directness character policy through the normal ChatRunner gateway reply path without approval bypass", async () => {
    const stateManager = makeStateManager();
    await stateManager.init();
    await new CharacterConfigManager(stateManager).save({
      caution_level: 5,
      stall_flexibility: 5,
      communication_directness: 5,
      proactivity_level: 5,
    });
    const llmClient = makeLlmClient("direct character reply");
    const runner = new ChatRunner(makeDeps(stateManager, llmClient));

    const result = await runner.execute("hello", stateManager.getBaseDir(), 5_000, {
      routeSelector: async () => gatewayModelRoute(),
      runtimeControlContext: {
        allowed: false,
        approvalMode: "disallowed",
        explicit: true,
      },
    });

    expect(result).toMatchObject({ success: true, output: "direct character reply" });
    const system = firstSystemPrompt(llmClient);
    expect(system).toContain("character_policy_ref: character_config_policy:character-policy:chat:");
    expect(system).toContain("character_directness: direct");
    expect(system).toContain("character_initiative_posture: high_detail");
    expect(system).toContain("character_visible_reason: brief");
    expect(system).toContain("character_can_relax_approval_boundary: false");
    expect(system).toContain("character_can_grant_autonomy: false");
    expect(system).toContain("runtime_control_allowed: false");
    expect(system).toContain("approval_mode: disallowed");
    expectNoRawCharacterKnobs(system);
  });

  it("passes low-proactivity character policy through Telegram/cross-platform ingress without exposing raw knobs", async () => {
    const stateManager = makeStateManager();
    await stateManager.init();
    await new CharacterConfigManager(stateManager).save({
      caution_level: 1,
      stall_flexibility: 1,
      communication_directness: 1,
      proactivity_level: 1,
    });
    const llmClient = makeLlmClient("quiet character reply");
    const manager = new CrossPlatformChatSessionManager(makeDeps(stateManager, llmClient));

    const output = await manager.processIncomingMessage({
      text: "hello from telegram",
      platform: "telegram",
      conversation_id: "chat-1",
      sender_id: "user-1",
      cwd: stateManager.getBaseDir(),
      runtimeControl: {
        allowed: false,
        approvalMode: "disallowed",
      },
    });

    expect(output).toBe("quiet character reply");
    const system = firstSystemPrompt(llmClient);
    expect(system).toContain("character_policy_ref: character_config_policy:character-policy:chat:");
    expect(system).toContain("character_directness: considerate");
    expect(system).toContain("character_initiative_posture: events_only");
    expect(system).toContain("character_visible_reason: none");
    expect(system).toContain("character_execution_summary_verbosity: brief");
    expect(system).toContain("character_can_relax_safety_boundary: false");
    expect(system).toContain("character_can_grant_autonomy: false");
    expect(system).toContain("runtime_control_allowed: false");
    expect(system).toContain("approval_mode: disallowed");
    expectNoRawCharacterKnobs(system);
  });

  it("merges relationship normal-surface context with character policy on the gateway caller path", async () => {
    const stateManager = makeStateManager();
    await stateManager.init();
    await new CharacterConfigManager(stateManager).save({
      caution_level: 5,
      stall_flexibility: 5,
      communication_directness: 5,
      proactivity_level: 5,
    });
    await upsertRelationshipProfileItem(stateManager.getBaseDir(), {
      stableKey: "operator.gateway_style",
      kind: "preference",
      value: "Prefer terse gateway answers.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval"],
      sensitivity: "private",
      now: "2026-05-14T00:00:00.000Z",
    });
    const llmClient = makeLlmClient("relationship-aware reply");
    const runner = new ChatRunner(makeDeps(stateManager, llmClient));

    const result = await runner.execute("hello", stateManager.getBaseDir(), 5_000, {
      routeSelector: async () => gatewayModelRoute(),
      runtimeControlContext: {
        allowed: false,
        approvalMode: "disallowed",
        explicit: true,
      },
    });

    expect(result).toMatchObject({ success: true, output: "relationship-aware reply" });
    const system = firstSystemPrompt(llmClient);
    expect(system).toContain("relationship_surface_ref: relationship-normal-surface:chat:");
    expect(system).toContain("relationship_surface_projection_ref: surface_projection:surface:relationship-profile:chat:");
    expect(system).toContain("relationship_core_memory_projection_ref: memory_projection:core-memory:relationship-normal-surface:chat:");
    expect(system).toContain("relationship_character_policy_ref: character_policy_projection:character_config_policy:character-policy:chat:");
    expect(system).toContain("relationship_included_count: 1");
    expect(system).toContain("relationship_included[0]: role=preference; use=tone_adaptation");
    expect(system).toContain("relationship_normal_surface_debug_visible: false");
    expect(system).toContain("character_can_relax_approval_boundary: false");
    expect(system).toContain("character_can_grant_autonomy: false");
    expect(system).not.toContain("Prefer terse gateway answers.");
    expect(system).not.toContain("caution_level");
    expect(system).not.toContain("proactivity_level");
  });
});
