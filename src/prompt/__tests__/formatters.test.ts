import { describe, it, expect } from "vitest";
import {
  wrapXmlTag,
  estimateTokens,
  trimToTokenBudget,
  formatGoalContext,
  formatCurrentState,
  formatObservationHistory,
  formatLessons,
  formatKnowledge,
  formatReflections,
  formatWorkspaceState,
  formatStrategyTemplates,
  formatFailureContext,
  formatTaskResults,
} from "../formatters.js";

describe("wrapXmlTag", () => {
  it("wraps normal content in XML tags", () => {
    const result = wrapXmlTag("goal", "some content");
    expect(result).toBe("<goal>\nsome content\n</goal>");
  });

  it("returns empty string for empty content", () => {
    expect(wrapXmlTag("goal", "")).toBe("");
  });

  it("returns empty string for whitespace-only content", () => {
    expect(wrapXmlTag("goal", "   ")).toBe("");
    expect(wrapXmlTag("goal", "\n\t")).toBe("");
  });
});

describe("estimateTokens", () => {
  it("estimates tokens as ceil(length / 4)", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("a".repeat(101))).toBe(26);
  });
});

describe("trimToTokenBudget", () => {
  it("returns text unchanged when under budget", () => {
    const short = "Hello world";
    expect(trimToTokenBudget(short, 100)).toBe(short);
  });

  it("trims text when over budget and adds truncation notice", () => {
    const long = "a".repeat(400); // 100 tokens
    const result = trimToTokenBudget(long, 10);
    expect(result).toContain("... (truncated)");
    expect(estimateTokens(result)).toBeLessThanOrEqual(20); // some slack for the notice
  });

  it("trims at line boundary when possible", () => {
    const text = "line one\nline two\nline three\n" + "x".repeat(200);
    const result = trimToTokenBudget(text, 5);
    expect(result).toContain("... (truncated)");
  });

  it("returns text when exactly at budget", () => {
    const text = "a".repeat(40); // exactly 10 tokens
    expect(trimToTokenBudget(text, 10)).toBe(text);
  });
});

describe("formatGoalContext", () => {
  it("formats goal with title and description", () => {
    const result = formatGoalContext({ title: "My Goal", description: "Do something" });
    expect(result).toContain("Goal: My Goal");
    expect(result).toContain("Description: Do something");
  });

  it("formats goal with strategy", () => {
    const result = formatGoalContext(
      { title: "My Goal" },
      { hypothesis: "Try approach A" }
    );
    expect(result).toContain("Goal: My Goal");
    expect(result).toContain("Active Strategy: Try approach A");
  });

  it("omits missing fields", () => {
    const result = formatGoalContext({ title: "Minimal" });
    expect(result).toBe("Goal: Minimal");
    expect(result).not.toContain("Description");
    expect(result).not.toContain("Active Strategy");
  });

  it("returns empty string when no fields provided", () => {
    const result = formatGoalContext({});
    expect(result).toBe("");
  });
});

describe("formatCurrentState", () => {
  it("formats multiple dimensions", () => {
    const result = formatCurrentState([
      { name: "coverage", current: 80, target: 100, gap: 20 },
      { name: "speed", current: 5 },
    ]);
    expect(result).toContain("coverage: 80 (target: 100, gap: 20)");
    expect(result).toContain("speed: 5");
  });

  it("returns empty string for empty array", () => {
    expect(formatCurrentState([])).toBe("");
  });

  it("omits target and gap when not provided", () => {
    const result = formatCurrentState([{ name: "score", current: 42 }]);
    expect(result).toBe("score: 42");
  });

  it("includes target but not gap when only target provided", () => {
    const result = formatCurrentState([{ name: "score", current: 42, target: 100 }]);
    expect(result).toBe("score: 42 (target: 100)");
  });
});

describe("formatObservationHistory", () => {
  it("formats history entries", () => {
    const result = formatObservationHistory([
      { timestamp: "2026-01-01", score: 0.5 },
      { timestamp: "2026-01-02", score: 0.7 },
    ]);
    expect(result).toContain("2026-01-01: 0.5");
    expect(result).toContain("2026-01-02: 0.7");
  });

  it("returns empty string for empty history", () => {
    expect(formatObservationHistory([])).toBe("");
  });

  it("includes direction when provided", () => {
    const result = formatObservationHistory(
      [{ timestamp: "2026-01-01", score: 0.5 }],
      "improving"
    );
    expect(result).toContain("Direction: improving");
  });

  it("limits to last 5 entries", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({
      timestamp: `2026-01-0${i + 1}`,
      score: i * 0.1,
    }));
    const result = formatObservationHistory(history);
    expect(result).toContain("last 5");
  });
});

describe("formatLessons", () => {
  it("sorts by importance: HIGH before MEDIUM before LOW", () => {
    const lessons = [
      { importance: "LOW", content: "low lesson" },
      { importance: "HIGH", content: "high lesson" },
      { importance: "MEDIUM", content: "medium lesson" },
    ];
    const result = formatLessons(lessons);
    const highIdx = result.indexOf("high lesson");
    const medIdx = result.indexOf("medium lesson");
    const lowIdx = result.indexOf("low lesson");
    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it("returns empty string for empty array", () => {
    expect(formatLessons([])).toBe("");
  });

  it("formats each lesson with importance tag", () => {
    const result = formatLessons([{ importance: "high", content: "do this" }]);
    expect(result).toBe("- [HIGH] do this");
  });
});

describe("formatKnowledge", () => {
  it("formats Q/A entries", () => {
    const result = formatKnowledge([{ question: "What?", answer: "This." }]);
    expect(result).toContain("Q: What?");
    expect(result).toContain("A: This.");
  });

  it("formats content-only entries", () => {
    const result = formatKnowledge([{ content: "Just some info" }]);
    expect(result).toBe("Just some info");
  });

  it("appends confidence when provided", () => {
    const result = formatKnowledge([
      { question: "Q?", answer: "A.", confidence: 0.9 },
    ]);
    expect(result).toContain("(confidence: 0.9)");
  });

  it("returns empty string for empty array", () => {
    expect(formatKnowledge([])).toBe("");
  });

  it("skips entries with no question/answer or content", () => {
    const result = formatKnowledge([{} as any]);
    expect(result).toBe("");
  });
});

describe("formatReflections", () => {
  it("formats what_failed and suggestion", () => {
    const result = formatReflections([
      { what_failed: "approach A", suggestion: "try B" },
    ]);
    expect(result).toContain("Failed: approach A");
    expect(result).toContain("Suggestion: try B");
  });

  it("formats content-only entries", () => {
    const result = formatReflections([{ content: "just tried something" }]);
    expect(result).toBe("just tried something");
  });

  it("returns empty string for empty array", () => {
    expect(formatReflections([])).toBe("");
  });

  it("separates multiple entries with ---", () => {
    const result = formatReflections([
      { what_failed: "A", suggestion: "B" },
      { what_failed: "C", suggestion: "D" },
    ]);
    expect(result).toContain("---");
  });
});

describe("formatWorkspaceState", () => {
  it("joins items with newlines", () => {
    const result = formatWorkspaceState(["file1.ts", "file2.ts"]);
    expect(result).toBe("file1.ts\nfile2.ts");
  });

  it("returns empty string for empty array", () => {
    expect(formatWorkspaceState([])).toBe("");
  });
});

describe("formatStrategyTemplates", () => {
  it("formats templates with scores", () => {
    const result = formatStrategyTemplates([
      { hypothesis_pattern: "Focus on X", effectiveness_score: 0.8 },
    ]);
    expect(result).toContain("Focus on X");
    expect(result).toContain("effectiveness: 0.8");
  });

  it("returns empty string for empty array", () => {
    expect(formatStrategyTemplates([])).toBe("");
  });
});

describe("formatFailureContext", () => {
  it("formats non-empty context", () => {
    const result = formatFailureContext("Something went wrong");
    expect(result).toContain("Failure Context:");
    expect(result).toContain("Something went wrong");
  });

  it("returns empty string for empty string", () => {
    expect(formatFailureContext("")).toBe("");
  });

  it("returns empty string for whitespace-only string", () => {
    expect(formatFailureContext("   ")).toBe("");
  });
});

describe("formatTaskResults", () => {
  it("formats success results", () => {
    const result = formatTaskResults([
      { task_description: "Run tests", outcome: "All passed", success: true },
    ]);
    expect(result).toContain("[SUCCESS]");
    expect(result).toContain("Run tests");
    expect(result).toContain("All passed");
  });

  it("formats failure results", () => {
    const result = formatTaskResults([
      { task_description: "Deploy", outcome: "Server error", success: false },
    ]);
    expect(result).toContain("[FAILURE]");
  });

  it("returns empty string for empty array", () => {
    expect(formatTaskResults([])).toBe("");
  });
});
