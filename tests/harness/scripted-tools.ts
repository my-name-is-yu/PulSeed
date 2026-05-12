import type { JsonObject, ScriptedToolStep } from "./types.js";

export class ScriptedToolRunner {
  private index = 0;
  private readonly mutations: JsonObject[] = [];

  constructor(private readonly steps: ScriptedToolStep[] = []) {}

  run(name: string, args: JsonObject = {}): JsonObject {
    const step = this.steps[this.index];
    if (!step) {
      throw new Error(`No scripted tool step for ${name} at index ${this.index}.`);
    }
    if (step.name !== name) {
      throw new Error(`Expected scripted tool ${step.name}, got ${name}.`);
    }
    if (step.approval_required && step.approved !== true) {
      return {
        success: false,
        reason: "approval_denied",
        tool: name,
      };
    }
    this.index += 1;
    if (step.side_effect_artifact) {
      this.mutations.push({
        tool: name,
        args,
        artifact: structuredClone(step.side_effect_artifact),
      });
    }
    return structuredClone(step.result);
  }

  mutationArtifacts(): JsonObject[] {
    return this.mutations.map((mutation) => structuredClone(mutation));
  }
}
