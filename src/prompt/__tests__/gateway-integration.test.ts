/**
 * gateway-integration.test.ts
 * Integration tests for the full PromptGateway pipeline:
 * ContextAssembler → prompt construction → mock LLM → Zod parse
 */

import { describe, it, expect, vi } from "vitest";
import { ContextAssembler } from "../context-assembler.js";
import { PromptGateway } from "../gateway.js";
import { TaskGenerationResponseSchema } from "../purposes/task-generation.js";
import { ObservationResponseSchema } from "../purposes/observation.js";
import { PURPOSE_CONFIGS } from "../purposes/index.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../llm/llm-client.js";
import type { ZodSchema } from "zod";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeGoalState() {
  return {
    title: "Increase test coverage",
    description: "Ensure 90% coverage across all modules",
    active_strategy: { hypothesis: "Add unit tests for uncovered branches" },
    dimensions: [
      {
        name: "coverage",
        current_value: 0.65,
        threshold: { value: 0.9 },
        gap: 0.25,
        history: [
          { timestamp: "2026-03-20T10:00:00Z", value: 0.60 },
          { timestamp: "2026-03-21T10:00:00Z", value: 0.65 },
        ],
      },
    ],
  };
}

/** Minimal ILLMClient mock that captures calls and returns preset responses */
function makeMockLLMClient(responses: string[]): ILLMClient & {
  capturedMessages: LLMMessage[][];
  capturedOptions: (LLMRequestOptions | undefined)[];
} {
  let callIndex = 0;
  const capturedMessages: LLMMessage[][] = [];
  const capturedOptions: (LLMRequestOptions | undefined)[] = [];

  return {
    capturedMessages,
    capturedOptions,
    async sendMessage(messages, options): Promise<LLMResponse> {
      capturedMessages.push(messages);
      capturedOptions.push(options);
      const content = responses[callIndex++] ?? "{}";
      return { content, usage: { input_tokens: 50, output_tokens: content.length }, stop_reason: "end_turn" };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      // Extract JSON from content (handles markdown code blocks)
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
      const jsonStr = match[1] ?? content;
      const parsed = JSON.parse(jsonStr.trim());
      return schema.parse(parsed);
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PromptGateway integration", () => {
  it("Full pipeline: task_generation purpose", async () => {
    const fakeGoalState = makeFakeGoalState();

    const assembler = new ContextAssembler({
      stateManager: {
        loadGoalState: async () => fakeGoalState,
      },
      reflectionGetter: async () => [
        {
          why_it_worked_or_failed: "Tests were skipped for edge cases",
          what_to_do_differently: "Always test boundary conditions",
          what_was_attempted: "Added tests for main path only",
        },
      ],
      memoryLifecycle: {
        selectForWorkingMemory: async () => ({
          shortTerm: [],
          lessons: [
            {
              relevance_tags: ["HIGH"],
              lesson: "Small incremental test additions are more reliable than large batch additions",
            },
          ],
        }),
      },
    });

    const taskGenResponse = JSON.stringify({
      work_description: "Add tests for coverage module boundary cases",
      success_criteria: "Coverage reaches 70%",
      estimated_complexity: "medium",
      rationale: "Targeting boundary cases gives the largest coverage gain",
    });

    const mockLLM = makeMockLLMClient([taskGenResponse]);
    const gateway = new PromptGateway(mockLLM, assembler);

    const result = await gateway.execute({
      purpose: "task_generation",
      goalId: "goal-001",
      responseSchema: TaskGenerationResponseSchema,
    });

    // LLM was called exactly once
    expect(mockLLM.capturedMessages).toHaveLength(1);

    // System prompt is passed through (assembler default takes precedence via assembled.systemPrompt || config.systemPrompt)
    const opts = mockLLM.capturedOptions[0];
    expect(opts?.system).toBeTruthy();

    // User message contains goal context XML
    const userMessage = mockLLM.capturedMessages[0]?.[0]?.content ?? "";
    expect(userMessage).toContain("<goal_definition>");
    expect(userMessage).toContain("Increase test coverage");

    // reflections slot is active for task_generation
    expect(userMessage).toContain("<reflections>");

    // lessons slot is active for task_generation
    expect(userMessage).toContain("<lessons>");

    // Parsed result matches expected schema shape
    expect(result.work_description).toBe("Add tests for coverage module boundary cases");
    expect(result.success_criteria).toBe("Coverage reaches 70%");
    expect(result.estimated_complexity).toBe("medium");
  });

  it("Full pipeline: observation purpose", async () => {
    const fakeGoalState = makeFakeGoalState();

    const assembler = new ContextAssembler({
      stateManager: {
        loadGoalState: async () => fakeGoalState,
      },
      contextProvider: {
        buildWorkspaceContextItems: async () => [
          { label: "coverage-report", content: "65% line coverage" },
        ],
      },
    });

    const observationResponse = JSON.stringify({
      score: 0.65,
      confidence: 0.9,
      reasoning: "Current coverage is 65%, target is 90%",
      evidence: ["coverage report shows 65%"],
    });

    const mockLLM = makeMockLLMClient([observationResponse]);
    const gateway = new PromptGateway(mockLLM, assembler);

    const result = await gateway.execute({
      purpose: "observation",
      goalId: "goal-001",
      dimensionName: "coverage",
      responseSchema: ObservationResponseSchema,
    });

    const userMessage = mockLLM.capturedMessages[0]?.[0]?.content ?? "";

    // observation purpose includes dimension_history
    expect(userMessage).toContain("<dimension_history>");

    // observation purpose includes workspace_state
    expect(userMessage).toContain("<workspace_state>");
    expect(userMessage).toContain("65% line coverage");

    // observation purpose does NOT include lessons slot
    expect(userMessage).not.toContain("<lessons>");

    // Parsed result matches schema
    expect(result.score).toBe(0.65);
    expect(result.confidence).toBe(0.9);
  });

  it("Budget trimming integration", async () => {
    // Very small budget forces trimming
    const assembler = new ContextAssembler({
      budgetTokens: 100,
      stateManager: {
        loadGoalState: async () => ({
          title: "A".repeat(200),
          description: "B".repeat(200),
          active_strategy: { hypothesis: "C".repeat(200) },
          dimensions: [
            { name: "dim1", current_value: 0.5, threshold: { value: 1.0 }, gap: 0.5, history: [] },
          ],
        }),
      },
      memoryLifecycle: {
        selectForWorkingMemory: async () => ({
          shortTerm: [],
          lessons: Array.from({ length: 10 }, (_, i) => ({
            relevance_tags: ["HIGH"],
            lesson: `Lesson ${i}: ${"x".repeat(100)}`,
          })),
        }),
      },
    });

    const mockLLM = makeMockLLMClient([
      JSON.stringify({ work_description: "do something", success_criteria: "it works" }),
    ]);
    const gateway = new PromptGateway(mockLLM, assembler);

    const result = await gateway.execute({
      purpose: "task_generation",
      goalId: "goal-budget",
      responseSchema: TaskGenerationResponseSchema,
    });

    const userMessage = mockLLM.capturedMessages[0]?.[0]?.content ?? "";
    // Token estimate: length / 4; message should be near or under the budget
    const tokenEstimate = Math.ceil(userMessage.length / 4);
    expect(tokenEstimate).toBeLessThanOrEqual(110); // small buffer for trimming boundary

    expect(result.work_description).toBe("do something");
  });

  it("Graceful degradation: missing deps", async () => {
    // ContextAssembler with no deps — should produce minimal/empty context but not throw
    const assembler = new ContextAssembler({});

    const mockLLM = makeMockLLMClient([
      JSON.stringify({ work_description: "fallback task", success_criteria: "done" }),
    ]);
    const gateway = new PromptGateway(mockLLM, assembler);

    const result = await gateway.execute({
      purpose: "task_generation",
      goalId: "goal-empty",
      responseSchema: TaskGenerationResponseSchema,
    });

    // Should succeed even with no context
    expect(result.work_description).toBe("fallback task");

    // User message may be empty or minimal — just ensure LLM was called
    expect(mockLLM.capturedMessages).toHaveLength(1);
  });

  it("Error propagation: LLM throws", async () => {
    const assembler = new ContextAssembler({});

    const errorLLM: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        throw new Error("network timeout");
      },
      parseJSON<T>(content: string, schema: ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
    };

    const gateway = new PromptGateway(errorLLM, assembler);

    await expect(
      gateway.execute({
        purpose: "task_generation",
        goalId: "goal-err",
        responseSchema: TaskGenerationResponseSchema,
      })
    ).rejects.toThrow(/task_generation/);

    await expect(
      gateway.execute({
        purpose: "task_generation",
        goalId: "goal-err",
        responseSchema: TaskGenerationResponseSchema,
      })
    ).rejects.toThrow(/goal-err/);
  });
});
