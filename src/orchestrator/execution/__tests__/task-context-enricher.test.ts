import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { buildEnrichedKnowledgeContext } from "../task/task-context-enricher.js";
import { saveDreamConfig } from "../../../platform/dream/dream-config.js";

vi.mock("../reflection-generator.js", () => ({
  getFailureReflectionsForGoal: vi.fn(),
  getReflectionsForGoal: vi.fn(),
  formatReflectionsForPrompt: vi.fn(),
}));

import {
  getFailureReflectionsForGoal,
  getReflectionsForGoal,
  formatReflectionsForPrompt,
} from "../reflection-generator.js";

describe("buildEnrichedKnowledgeContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends transfer snippets and formatted reflections", async () => {
    const tmpDir = makeTempDir("context-enricher-");
    const stateManager = new StateManager(tmpDir);
    vi.mocked(getFailureReflectionsForGoal).mockResolvedValue([{ id: "r1" }] as never);
    vi.mocked(getReflectionsForGoal).mockResolvedValue([] as never);
    vi.mocked(formatReflectionsForPrompt).mockReturnValue("reflection context");

    try {
      const result = await buildEnrichedKnowledgeContext({
        goalId: "goal-1",
        knowledgeContext: "base context",
        knowledgeTransfer: {
          detectCandidatesRealtime: vi.fn().mockResolvedValue({
            contextSnippets: ["snippet A", "snippet B"],
          }),
        } as never,
        knowledgeManager: {} as never,
        stateManager,
      });

      expect(result).toBe("base context\nreflection context");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("continues without enrichment when transfer lookup fails", async () => {
    const tmpDir = makeTempDir("context-enricher-fail-");
    const stateManager = new StateManager(tmpDir);
    vi.mocked(getFailureReflectionsForGoal).mockResolvedValue([]);
    vi.mocked(getReflectionsForGoal).mockResolvedValue([] as never);
    vi.mocked(formatReflectionsForPrompt).mockReturnValue("");
    const warn = vi.fn();

    try {
      const result = await buildEnrichedKnowledgeContext({
        goalId: "goal-2",
        knowledgeContext: "base context",
        knowledgeTransfer: {
          detectCandidatesRealtime: vi.fn().mockRejectedValue(new Error("boom")),
        } as never,
        logger: { warn } as never,
        stateManager,
      });

      expect(result).toBe("base context");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("restores full reflection history when verified-only mode is disabled", async () => {
    const tmpDir = makeTempDir("context-enricher-optout-");
    const stateManager = new StateManager(tmpDir);
    vi.mocked(getFailureReflectionsForGoal).mockResolvedValue([] as never);
    vi.mocked(getReflectionsForGoal).mockResolvedValue([{ id: "r-full" }] as never);
    vi.mocked(formatReflectionsForPrompt).mockReturnValue("full reflection context");

    await saveDreamConfig({
      activation: {
        verifiedPlannerHintsOnly: false,
        semanticWorkingMemory: false,
        crossGoalLessons: false,
        semanticContext: false,
        autoAcquireKnowledge: false,
        learnedPatternHints: false,
        playbookHints: false,
        workflowHints: false,
        strategyTemplates: false,
        decisionHeuristics: false,
        graphTraversal: false,
      },
    }, tmpDir);

    try {
      const result = await buildEnrichedKnowledgeContext({
        goalId: "goal-3",
        knowledgeContext: "base context",
        knowledgeTransfer: {
          detectCandidatesRealtime: vi.fn().mockResolvedValue({
            contextSnippets: ["snippet A"],
          }),
        } as never,
        knowledgeManager: {} as never,
        stateManager,
      });

      expect(result).toBe("base context\nsnippet A\nfull reflection context");
      expect(getReflectionsForGoal).toHaveBeenCalledOnce();
      expect(getFailureReflectionsForGoal).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
