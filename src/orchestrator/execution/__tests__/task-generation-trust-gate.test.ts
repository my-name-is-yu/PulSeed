import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import { saveDreamConfig } from "../../../platform/dream/dream-config.js";
import { generateTask } from "../task/task-generation.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

function createSpyLLMClient(response: string): ILLMClient & {
  calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }>;
} {
  const calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  return {
    calls,
    async sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
      calls.push({ messages, options });
      return {
        content: response,
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) ?? [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Repair the verification boundary",
  "rationale": "Keep the planner aligned with verified guidance",
  "approach": "Patch the narrow verification seam and rerun focused checks",
  "success_criteria": [
    {
      "description": "Focused verification passes",
      "verification_method": "npm test -- verification",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["verification boundary"],
    "out_of_scope": ["broad unrelated refactors"],
    "blast_radius": "verification path only"
  },
  "constraints": ["Keep changes narrow"],
  "artifact_contract": {
    "required": false,
    "required_artifacts": []
  },
  "reversibility": "reversible",
  "estimated_duration": null
}
\`\`\``;

describe("generateTask planner trust gate", () => {
  let tmpDir = "";
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("task-generation-trust-gate-");
    stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeGoal({
      id: "goal-1",
      title: "Stabilize verification",
      description: "Prefer only verified procedural guidance",
      dimensions: [{
        name: "verification",
        label: "verification",
        current_value: 0.2,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: new Date().toISOString(),
        history: [],
        weight: 1,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      }],
    }) as any);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("uses failure reflections only and suppresses unverified lessons by default", async () => {
    const llmClient = createSpyLLMClient(VALID_TASK_RESPONSE);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const knowledgeManager = {
      loadKnowledge: async () => [
        {
          entry_id: "reflection-success",
          question: "Reflection: success",
          answer: JSON.stringify({
            what_was_attempted: "Applied a broad workaround",
            outcome: "success",
            why_it_worked_or_failed: "Looked good locally",
            what_to_do_differently: "Repeat the workaround",
          }),
          sources: [],
          confidence: 0.9,
          acquired_at: "2026-04-28T00:00:00.000Z",
          acquisition_task_id: "task-success",
          superseded_by: null,
          tags: ["reflection"],
          embedding_id: null,
        },
        {
          entry_id: "reflection-fail",
          question: "Reflection: fail",
          answer: JSON.stringify({
            what_was_attempted: "Retried the same flaky command",
            outcome: "fail",
            why_it_worked_or_failed: "The command was nondeterministic",
            what_to_do_differently: "Use focused verification instead",
          }),
          sources: [],
          confidence: 0.3,
          acquired_at: "2026-04-28T01:00:00.000Z",
          acquisition_task_id: "task-fail",
          superseded_by: null,
          tags: ["reflection"],
          embedding_id: null,
        },
      ],
    } as const;
    const memoryLifecycle = {
      selectForWorkingMemory: async () => ({
        shortTerm: [],
        lessons: [
          { type: "failure_pattern", lesson: "Do not trust green self-report without verification", relevance_tags: ["HIGH"] },
        ],
      }),
    };

    await generateTask(
      {
        stateManager,
        llmClient,
        strategyManager,
        knowledgeManager: knowledgeManager as never,
        memoryLifecycle,
      },
      "goal-1",
      "verification",
    );

    const userMessage = llmClient.calls[0]!.messages[0]!.content;
    expect(userMessage).toContain("The command was nondeterministic");
    expect(userMessage).toContain("Use focused verification instead");
    expect(userMessage).not.toContain("Looked good locally");
    expect(userMessage).not.toContain("Repeat the workaround");
    expect(userMessage).not.toContain("lessons_learned");
  });

  it("allows raw lessons and successful reflections when verified-only mode is disabled", async () => {
    const llmClient = createSpyLLMClient(VALID_TASK_RESPONSE);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const knowledgeManager = {
      loadKnowledge: async () => [
        {
          entry_id: "reflection-success",
          question: "Reflection: success",
          answer: JSON.stringify({
            what_was_attempted: "Applied a broad workaround",
            outcome: "success",
            why_it_worked_or_failed: "Looked good locally",
            what_to_do_differently: "Repeat the workaround",
          }),
          sources: [],
          confidence: 0.9,
          acquired_at: "2026-04-28T00:00:00.000Z",
          acquisition_task_id: "task-success",
          superseded_by: null,
          tags: ["reflection"],
          embedding_id: null,
        },
      ],
    } as const;
    const memoryLifecycle = {
      selectForWorkingMemory: async () => ({
        shortTerm: [],
        lessons: [
          { type: "failure_pattern", lesson: "Carry over the raw lesson block", relevance_tags: ["HIGH"] },
        ],
      }),
    };
    await saveDreamConfig({
      activation: {
        verifiedPlannerHintsOnly: false,
        semanticWorkingMemory: true,
        crossGoalLessons: true,
        semanticContext: true,
        autoAcquireKnowledge: true,
        learnedPatternHints: true,
        playbookHints: true,
        workflowHints: true,
        strategyTemplates: true,
        decisionHeuristics: true,
        graphTraversal: true,
      },
    }, stateManager.getBaseDir());

    await generateTask(
      {
        stateManager,
        llmClient,
        strategyManager,
        knowledgeManager: knowledgeManager as never,
        memoryLifecycle,
      },
      "goal-1",
      "verification",
    );

    const userMessage = llmClient.calls[0]!.messages[0]!.content;
    expect(userMessage).toContain("Looked good locally");
    expect(userMessage).toContain("Repeat the workaround");
    expect(userMessage).toContain("lessons_learned");
    expect(userMessage).toContain("Carry over the raw lesson block");
  });
});
