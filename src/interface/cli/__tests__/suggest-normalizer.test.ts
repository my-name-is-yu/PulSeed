import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import { gatherProjectContext, generateSuggestOutput, hasRepositorySuggestionSurface, normalizeSuggestPayload } from "../commands/suggest-normalizer.js";

const validSuggestionWithRepoContext = {
  title: "Add tests",
  rationale: "Coverage is low",
  steps: ["Write unit tests"],
  success_criteria: ["Tests pass"],
  repo_context: { path: "src/foo.ts" },
};

const validInput = {
  suggestions: [validSuggestionWithRepoContext],
};

describe("normalizeSuggestPayload fast-path", () => {
  it("skips oversized package.json when gathering project context", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-suggest-context-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({
          name: "oversized-package-name",
          description: "This package metadata should be skipped",
          padding: "x".repeat(512 * 1024),
        }),
      );

      const context = await gatherProjectContext(tmpDir);

      expect(context).not.toContain("oversized-package-name");
      expect(context).toContain("Files:");
      expect(context).toContain("package.json");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects repository suggestion surface from exact filesystem entries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-suggest-surface-"));
    try {
      expect(hasRepositorySuggestionSurface(tmpDir)).toBe(false);
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Notes\n");
      expect(hasRepositorySuggestionSurface(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves repo_context when isSoftwareGoal=true", () => {
    const result = normalizeSuggestPayload(validInput, ".", ".", "context", 3, [], true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toEqual({ path: "src/foo.ts" });
  });

  it("strips repo_context when isSoftwareGoal=false", () => {
    const result = normalizeSuggestPayload(validInput, ".", ".", "context", 3, [], false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toBeUndefined();
    // other fields are preserved
    expect(result.suggestions[0]!.title).toBe("Add tests");
  });

  it("works fine when isSoftwareGoal=false and no repo_context present", () => {
    const inputWithoutRepoContext = {
      suggestions: [
        {
          title: "Improve docs",
          rationale: "Docs are outdated",
          steps: ["Update README"],
          success_criteria: ["README is accurate"],
        },
      ],
    };
    const result = normalizeSuggestPayload(inputWithoutRepoContext, ".", ".", "context", 3, [], false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toBeUndefined();
    expect(result.suggestions[0]!.title).toBe("Improve docs");
  });

  it("does not force non-software legacy suggestions into repository file updates", () => {
    const result = normalizeSuggestPayload(
      {
        title: "Improve sleep routine",
        description: "Create a stable bedtime plan",
        rationale: "Rest quality matters",
        dimensions_hint: ["sleep_consistency"],
      },
      ".",
      ".",
      "Personal health journal",
      3,
      [],
      false
    );

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toBeUndefined();
    expect(result.suggestions[0]!.steps[0]).toBe("Create a stable bedtime plan");
    expect(JSON.stringify(result.suggestions[0])).not.toMatch(/README|package\.json|src\//i);
  });

  it("uses a general title fallback for non-software legacy suggestions", () => {
    const result = normalizeSuggestPayload(
      {
        description: "Create a stable bedtime plan",
        dimensions_hint: ["sleep_consistency"],
      },
      ".",
      ".",
      "Personal health journal",
      3,
      [],
      false
    );

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.title).toBe("Concrete improvement");
    expect(JSON.stringify(result.suggestions[0])).not.toMatch(/repository/i);
  });

  it("uses a general fallback when non-software output has no candidates", () => {
    const result = normalizeSuggestPayload({}, ".", ".", "Personal journal about sleep and exercise", 3, [], false);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toBeUndefined();
    expect(JSON.stringify(result.suggestions[0])).not.toMatch(/README|package\.json|src\/|repository/i);
  });

  it("keeps retry instructions general when the typed surface is general", async () => {
    const contexts: string[] = [];
    const suggestGoals = async (context: string) => {
      contexts.push(context);
      return contexts.length === 1 ? [] : validInput;
    };

    await generateSuggestOutput(
      suggestGoals,
      "Personal journal about sleep and exercise",
      {
        maxSuggestions: 2,
        existingGoals: [],
        repoPath: ".",
        suggestionSurface: "general",
        capabilityDetector: {} as CapabilityDetector,
      }
    );

    expect(contexts[1]).toContain("concrete, measurable suggestions");
    expect(contexts[1]).not.toContain("repository-scoped");
  });
});
