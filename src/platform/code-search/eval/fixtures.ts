import type { CodeSearchTask, Intent, VerificationSignal } from "../contracts.js";

export interface CodeSearchEvalFixture {
  id: string;
  task: string;
  intent: Intent;
  expectedTargetFiles: string[];
  expectedTargetSymbols?: string[];
  expectedTests?: string[];
  disallowedEditFiles?: string[];
  verificationSignal?: VerificationSignal;
}

export const CODE_SEARCH_EVAL_FIXTURES: CodeSearchEvalFixture[] = [
  {
    id: "tool-registration",
    task: "Find where built-in tools are registered and add a code search tool",
    intent: "feature_addition",
    expectedTargetFiles: ["src/tools/builtin/factory.ts", "src/tools/builtin/exports.ts"],
    expectedTargetSymbols: ["createBuiltinTools"],
  },
  {
    id: "generated-routing",
    task: "Avoid editing dist/generated output and find source TypeScript files",
    intent: "bugfix",
    expectedTargetFiles: ["src"],
    disallowedEditFiles: ["dist/generated.js"],
  },
];

export function fixtureToTask(fixture: CodeSearchEvalFixture, cwd: string): CodeSearchTask {
  return {
    task: fixture.task,
    intent: fixture.intent,
    cwd,
  };
}
