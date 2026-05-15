import { describe, it, expect } from "vitest";
import type { ZodSchema } from "zod/v3";
import { IntentRecognizer } from "../intent-recognizer.js";
import type { ILLMClient, LLMResponse } from "../../../base/llm/llm-client.js";
import { createSingleMockLLMClient as makeMockLLMClient } from "../../../../tests/helpers/mock-llm.js";

// ─── Exact command grammar ───

describe("IntentRecognizer — exact command grammar", () => {
  const recognizer = new IntentRecognizer();

  it("recognizes loop_stop: '/stop'", async () => {
    const result = await recognizer.recognize("/stop");
    expect(result.intent).toBe("loop_stop");
    expect(result.raw).toBe("/stop");
    expect(result.source).toBe("command");
    expect(result.confidence).toBe(1);
  });

  it("recognizes loop_stop: '/quit'", async () => {
    const result = await recognizer.recognize("/quit");
    expect(result.intent).toBe("loop_stop");
  });

  it("recognizes loop_start: '/run'", async () => {
    const result = await recognizer.recognize("/run");
    expect(result.intent).toBe("loop_start");
  });

  it("recognizes loop_start: '/start'", async () => {
    const result = await recognizer.recognize("/start");
    expect(result.intent).toBe("loop_start");
  });

  it("recognizes status: '/status'", async () => {
    const result = await recognizer.recognize("/status");
    expect(result.intent).toBe("status");
  });

  it("recognizes status diagnostics as an explicit details command", async () => {
    const result = await recognizer.recognize("/status --details");
    expect(result.intent).toBe("status");
    expect(result.params).toEqual({ detail: "diagnostic" });
  });

  it("recognizes report: '/report'", async () => {
    const result = await recognizer.recognize("/report");
    expect(result.intent).toBe("report");
  });

  it("recognizes report diagnostics as an explicit details command", async () => {
    const result = await recognizer.recognize("/report --details");
    expect(result.intent).toBe("report");
    expect(result.params).toEqual({ detail: "diagnostic" });
  });

  it("recognizes goal_list: '/goals'", async () => {
    const result = await recognizer.recognize("/goals");
    expect(result.intent).toBe("goal_list");
  });

  it("recognizes goal diagnostics as an explicit details command", async () => {
    const result = await recognizer.recognize("/goals --details");
    expect(result.intent).toBe("goal_list");
    expect(result.params).toEqual({ detail: "diagnostic" });
  });

  it("recognizes help: '/help'", async () => {
    const result = await recognizer.recognize("/help");
    expect(result.intent).toBe("help");
  });

  it("recognizes help alias: '/?'", async () => {
    const result = await recognizer.recognize("/?");
    expect(result.intent).toBe("help");
  });

  it("recognizes help: '?'", async () => {
    const result = await recognizer.recognize("?");
    expect(result.intent).toBe("help");
  });

  it("returns typed unknown for natural-language input without a classifier", async () => {
    const result = await recognizer.recognize("READMEを書いてほしい");
    expect(result.intent).toBe("unknown");
    expect(result.raw).toBe("READMEを書いてほしい");
    expect(result.source).toBe("unavailable");
  });

  it("preserves original raw input", async () => {
    const input = "  /stop  ";
    const result = await recognizer.recognize(input);
    expect(result.raw).toBe(input);
  });

  it("bare 'help' is NOT the help command without a classifier", async () => {
    const result = await recognizer.recognize("help");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'run' is NOT the run command without a classifier", async () => {
    const result = await recognizer.recognize("run");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'stop' is NOT the stop command without a classifier", async () => {
    const result = await recognizer.recognize("stop");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'status' is NOT the status command without a classifier", async () => {
    const result = await recognizer.recognize("status");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'report' is NOT the report command without a classifier", async () => {
    const result = await recognizer.recognize("report");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'goals' is NOT the goal_list command without a classifier", async () => {
    const result = await recognizer.recognize("goals");
    expect(result.intent).toBe("unknown");
  });

  it("natural sentence 'how does help work?' is NOT the help command without a classifier", async () => {
    const result = await recognizer.recognize("how does help work?");
    expect(result.intent).toBe("unknown");
  });

  it("natural sentence 'how do I run this?' is NOT the run command without a classifier", async () => {
    const result = await recognizer.recognize("how do I run this?");
    expect(result.intent).toBe("unknown");
  });

  it("recognizes dashboard: '/dashboard'", async () => {
    const result = await recognizer.recognize("/dashboard");
    expect(result.intent).toBe("dashboard");
  });

  it("recognizes dashboard alias: '/d'", async () => {
    const result = await recognizer.recognize("/d");
    expect(result.intent).toBe("dashboard");
  });

  it("recognizes dashboard case-insensitively: '/Dashboard'", async () => {
    const result = await recognizer.recognize("/Dashboard");
    expect(result.intent).toBe("dashboard");
  });

  it("fails closed on unknown slash commands without classifier fallback", async () => {
    const llm = makeMockLLMClient(JSON.stringify({
      intent: "loop_start",
      confidence: 0.96,
      params: { goalId: "goal-from-unknown-slash" },
    }));
    const classifierBackedRecognizer = new IntentRecognizer(llm);

    const result = await classifierBackedRecognizer.recognize("/stats please start goal-from-unknown-slash");

    expect(llm.callCount).toBe(0);
    expect(result.intent).toBe("unknown");
    expect(result.source).toBe("command");
    expect(result.confidence).toBe(1);
  });
});

// ─── Natural-language classifier ───

describe("IntentRecognizer — structured natural-language classifier", () => {
  it("returns chat intent with response for conversational input", async () => {
    const mockResponse = JSON.stringify({
      intent: "chat",
      confidence: 0.95,
      response: "PulSeed manages goals with measurable dimensions. You currently have no active goals.",
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("What can PulSeed do?");
    expect(result.intent).toBe("chat");
    expect(result.response).toBe("PulSeed manages goals with measurable dimensions. You currently have no active goals.");
    expect(result.source).toBe("classifier");
    expect(result.confidence).toBe(0.95);
  });

  it("returns goal_create intent with description in params when user clearly wants to create a goal", async () => {
    const mockResponse = JSON.stringify({
      intent: "goal_create",
      confidence: 0.93,
      response: "Creating goal: write a README",
      params: { description: "READMEを書く" },
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("READMEを書いてほしい");
    expect(result.intent).toBe("goal_create");
    expect(result.params?.["description"]).toBe("READMEを書く");
    expect(result.confidence).toBe(0.93);
  });

  it("structured classifier returns loop_start intent with goalId param", async () => {
    const mockResponse = JSON.stringify({
      intent: "loop_start",
      confidence: 0.91,
      response: "Starting goal goal-123.",
      params: { goalId: "goal-123" },
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("goal-123を実行してください");
    expect(result.intent).toBe("loop_start");
    expect(result.params?.["goalId"]).toBe("goal-123");
  });

  it("returns unknown on classifier error without retrying command grammar", async () => {
    const llm: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        throw new Error("LLM unavailable");
      },
      parseJSON<T>(_c: string, _s: ZodSchema<T>): T {
        throw new Error("unreachable");
      },
    };
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("something unknown");
    expect(result.intent).toBe("unknown");
    expect(result.source).toBe("unavailable");
  });

  it("chat intent populates response field on RecognizedIntent", async () => {
    const mockResponse = JSON.stringify({
      intent: "chat",
      confidence: 0.89,
      response: "You can use 'run' to start the goal loop.",
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("how do I start?");
    expect(result.response).toBe("You can use 'run' to start the goal loop.");
    expect(result.params?.["response"]).toBe("You can use 'run' to start the goal loop.");
  });

  it("returns unknown intent when LLM responds with 'unknown'", async () => {
    const mockResponse = JSON.stringify({ intent: "unknown", confidence: 0.8 });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("some ambiguous input");
    expect(result.intent).toBe("unknown");
    expect(result.source).toBe("classifier");
    expect(result.confidence).toBe(0.8);
  });

  it("does not include empty params object when no params returned", async () => {
    const mockResponse = JSON.stringify({ intent: "chat", confidence: 0.9, response: "Hello!" });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("hi");
    // params will contain the response string but not description/goalId keys
    expect(result.params?.["description"]).toBeUndefined();
    expect(result.params?.["goalId"]).toBeUndefined();
  });

  it("routes bare command-like words through the classifier instead of command grammar", async () => {
    const llm = makeMockLLMClient(JSON.stringify({
      intent: "chat",
      confidence: 0.92,
      response: "Tell me which goal you want to run.",
    }));
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("run");

    expect(llm.callCount).toBe(1);
    expect(result.intent).toBe("chat");
    expect(result.source).toBe("classifier");
  });

  it("routes broad English phrases through the classifier instead of broad command matching", async () => {
    const llm = makeMockLLMClient(JSON.stringify({
      intent: "chat",
      confidence: 0.9,
      response: "Here is how to inspect status.",
    }));
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("can you show me the status of the current run?");

    expect(llm.callCount).toBe(1);
    expect(result.intent).toBe("chat");
  });

  it("routes Japanese natural-language requests through the same classifier path", async () => {
    const llm = makeMockLLMClient(JSON.stringify({
      intent: "goal_create",
      confidence: 0.94,
      response: "Creating goal.",
      params: { description: "READMEを更新する" },
    }));
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("READMEを更新するゴールを作って");

    expect(llm.callCount).toBe(1);
    expect(result.intent).toBe("goal_create");
    expect(result.params?.["description"]).toBe("READMEを更新する");
    expect(result.source).toBe("classifier");
  });

  it("routes third-language natural-language requests through the same classifier path", async () => {
    const llm = makeMockLLMClient(JSON.stringify({
      intent: "loop_start",
      confidence: 0.88,
      response: "Starting the requested goal.",
      params: { goalId: "goal-es" },
    }));
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("inicia el objetivo goal-es, por favor");

    expect(llm.callCount).toBe(1);
    expect(result.intent).toBe("loop_start");
    expect(result.params?.["goalId"]).toBe("goal-es");
  });

  it("returns typed unknown for low-confidence natural-language classifications", async () => {
    const llm = makeMockLLMClient(JSON.stringify({
      intent: "loop_stop",
      confidence: 0.41,
      response: "I am not sure whether you want to stop.",
    }));
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("maybe pause later or explain stopping?");

    expect(result.intent).toBe("unknown");
    expect(result.source).toBe("classifier");
    expect(result.confidence).toBe(0.41);
  });
});
