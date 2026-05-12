import type { JsonObject, ScriptedLlmTurn } from "./types.js";

export class ScriptedLlm {
  private index = 0;
  private readonly transcript: Array<{ request: JsonObject; response: JsonObject }> = [];

  constructor(
    private readonly turns: ScriptedLlmTurn[] = [],
    private readonly options: { allowRealLlm?: boolean } = {},
  ) {
    if (this.options.allowRealLlm) {
      throw new Error("Real LLM providers are not allowed in the default trace harness.");
    }
  }

  send(request: JsonObject): JsonObject {
    const turn = this.turns[this.index];
    if (!turn) {
      throw new Error(`No scripted LLM response for request index ${this.index}.`);
    }
    this.index += 1;
    this.transcript.push({ request: structuredClone(request), response: structuredClone(turn.response) });
    return structuredClone(turn.response);
  }

  calls(): number {
    return this.index;
  }

  recordedTranscript(): Array<{ request: JsonObject; response: JsonObject }> {
    return this.transcript.map((entry) => structuredClone(entry));
  }
}
