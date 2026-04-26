import type { RankedCandidate } from "../contracts.js";
import type { CodeSearchEvalFixture } from "./fixtures.js";

export interface CodeSearchEvalMetrics {
  targetFileRecallAt10: number;
  targetSymbolRecallAt10: number;
  relevantTestRecallAt10: number;
  generatedEditFalsePositive: number;
}

function recall(expected: string[] | undefined, actual: string[]): number {
  if (!expected || expected.length === 0) return 1;
  const hits = expected.filter((target) => actual.some((candidate) => candidate.includes(target) || target.includes(candidate))).length;
  return hits / expected.length;
}

export function evaluateFixture(fixture: CodeSearchEvalFixture, candidates: RankedCandidate[]): CodeSearchEvalMetrics {
  const top10 = candidates.slice(0, 10);
  const files = top10.map((candidate) => candidate.file);
  const symbols = top10.map((candidate) => candidate.symbol?.name ?? "").filter(Boolean);
  const tests = top10.filter((candidate) => candidate.symbol?.kind === "test" || candidate.file.includes("test")).map((candidate) => candidate.file);
  const generatedEditFalsePositive = top10.some((candidate) =>
    fixture.disallowedEditFiles?.some((file) => candidate.file.includes(file)) && candidate.readRecommendation !== "reference_only"
  ) ? 1 : 0;
  return {
    targetFileRecallAt10: recall(fixture.expectedTargetFiles, files),
    targetSymbolRecallAt10: recall(fixture.expectedTargetSymbols, symbols),
    relevantTestRecallAt10: recall(fixture.expectedTests, tests),
    generatedEditFalsePositive,
  };
}
