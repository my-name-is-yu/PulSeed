import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// ─── Mock the openai SDK ───
//
// We mock the entire "openai" module so no real HTTP calls are made.
// Each test controls what `chat.completions.create` returns via
// `mockCreate`.

const mockCreate = vi.fn();
const mockStream = vi.fn();
const mockResponsesCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(function() { return {
      chat: {
        completions: {
          create: mockCreate,
          stream: mockStream,
        },
      },
      responses: {
        create: mockResponsesCreate,
      },
    }; }),
  };
});

import { OpenAILLMClient } from "../openai-client.js";

// ─── Helpers ───

function makeCompletionResponse(
  content: string,
  finishReason = "stop",
  promptTokens = 10,
  completionTokens = 5,
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
) {
  return {
    choices: [
      {
        message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
  };
}

function makeResponsesStream(chunks: string[], response: Record<string, unknown>) {
  return makeResponsesEventStream([
    ...chunks.map((delta) => ({ type: "response.output_text.delta", delta })),
    { type: "response.completed", response },
  ]);
}

function makeResponsesEventStream(events: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

// ─── Tests ───

describe("OpenAILLMClient", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockResponsesCreate.mockReset();
    // Ensure OPENAI_API_KEY is not set by default so constructor tests are
    // isolated. Individual tests that need a valid key set it explicitly.
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
  });

  // ─── Constructor ───

  describe("constructor", () => {
    it("throws if no API key and OPENAI_API_KEY env var is not set", () => {
      expect(() => new OpenAILLMClient()).toThrow(
        /no API key provided/
      );
    });

    it("does not throw when apiKey is provided directly", () => {
      expect(() => new OpenAILLMClient({ apiKey: "sk-test" })).not.toThrow();
    });

    it("does not throw when apiKey is provided in config", () => {
      expect(() => new OpenAILLMClient({ apiKey: "sk-from-config" })).not.toThrow();
    });

    it("default model is 'gpt-4o'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("hello"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4o");
    });

    it("uses custom model when specified in config", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-4-turbo" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4-turbo");
    });
  });

  // ─── sendMessage ───

  describe("sendMessage", () => {
    it("maps LLMMessage array to OpenAI messages format", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("response"));

      await client.sendMessage([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);
    });

    it("preserves assistant tool calls and tool result messages for Chat Completions", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("response"));

      await client.sendMessage([
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "Reading the file.",
          tool_calls: [{
            id: "call-read",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"file_path\":\"README.md\"}",
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-read",
          name: "read",
          content: "{\"exists\":true}",
        },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "Reading the file.",
          tool_calls: [{
            id: "call-read",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"file_path\":\"README.md\"}",
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-read",
          content: "{\"exists\":true}",
        },
      ]);
    });

    it("prepends system as developer role message when options.system is provided", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        system: "You are a helpful assistant.",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0]).toEqual({
        role: "developer",
        content: "You are a helpful assistant.",
      });
      expect(callArgs.messages[1]).toEqual({ role: "user", content: "hi" });
    });

    it("does not prepend developer message when no system option is given", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(1);
      expect(callArgs.messages[0]).toEqual({ role: "user", content: "hi" });
    });

    it("maps response content, usage, and stop_reason correctly", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(
        makeCompletionResponse("the answer", "stop", 20, 8)
      );

      const result = await client.sendMessage([
        { role: "user", content: "question" },
      ]);

      expect(result.content).toBe("the answer");
      expect(result.stop_reason).toBe("stop");
      expect(result.usage.input_tokens).toBe(20);
      expect(result.usage.output_tokens).toBe(8);
    });

    it("omits temperature for reasoning models starting with 'o1'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "o1-mini" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("omits temperature for reasoning models starting with 'o3'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "o3" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("omits temperature for reasoning models starting with 'o4'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "o4-mini" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("omits temperature for GPT-5 reasoning models", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-5.5" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("passes configured reasoning effort to chat completions", async () => {
      const client = new OpenAILLMClient({
        apiKey: "sk-test",
        model: "gpt-5.5",
        reasoningEffort: "low",
      });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.reasoning_effort).toBe("low");
    });

    it("does not pass reasoning effort to non-reasoning models", async () => {
      const client = new OpenAILLMClient({
        apiKey: "sk-test",
        model: "gpt-4o",
        reasoningEffort: "low",
      });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("reasoning_effort");
    });

    it("includes temperature for non-reasoning models", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-4o" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).toHaveProperty("temperature");
    });

    it("respects temperature override from options for non-reasoning model", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        temperature: 0.8,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.8);
    });

    it("overrides model via options.model", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-4o" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        model: "gpt-4-turbo",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4-turbo");
    });

    it("respects max_tokens override from options", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        max_tokens: 128,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_completion_tokens).toBe(128);
    });

    it("passes tools through and maps returned tool calls", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse(
        "",
        "tool_calls",
        10,
        5,
        [{ id: "call-1", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }]
      ));

      const result = await client.sendMessage([{ role: "user", content: "inspect the repo" }], {
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(1);
      expect(result.tool_calls?.[0]).toMatchObject({
        id: "call-1",
        function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      });
    });

    it("preserves structured tool transcript in the Responses API fallback", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      mockCreate.mockRejectedValueOnce(
        new Error("This is not a chat model and not supported in the v1/chat/completions endpoint")
      );
      mockResponsesCreate.mockResolvedValueOnce({
        output_text: "done",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      });

      await client.sendMessage([
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "Reading.",
          tool_calls: [{
            id: "call-read",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"file_path\":\"README.md\"}",
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-read",
          name: "read",
          content: "{\"exists\":true}",
        },
      ], {
        system: "system prompt",
      });

      const params = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params.instructions).toBe("system prompt");
      expect(params.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect" }],
        },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Reading.", annotations: [] }],
          status: "completed",
        },
        {
          type: "function_call",
          id: "call-read",
          call_id: "call-read",
          name: "read",
          arguments: "{\"file_path\":\"README.md\"}",
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call-read",
          output: "{\"exists\":true}",
        },
      ]);
    });
  });

  // ─── Retry logic ───

  describe("retry logic", () => {
    it("retries on failure and succeeds on second attempt", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });

      mockCreate
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(makeCompletionResponse("success"));

      vi.useFakeTimers();
      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.content).toBe("success");
    });

    it("retries up to 3 times and throws after all attempts fail", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });

      mockCreate.mockRejectedValue(new Error("persistent error"));

      vi.useFakeTimers();
      const promise = client
        .sendMessage([{ role: "user", content: "hi" }])
        .catch((e) => e);
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("persistent error");
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });

  describe("sendMessageStream", () => {
    it("streams through the Responses API fallback for non-chat models", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      const onTextDelta = vi.fn();
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce(makeResponsesStream(["fallback ", "output"], {
        output_text: "fallback output",
        status: "completed",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
        },
      }));

      const result = await client.sendMessageStream(
        [{ role: "user", content: "hello" }],
        undefined,
        { onTextDelta }
      );

      expect(result.content).toBe("fallback output");
      expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
      expect(onTextDelta.mock.calls.map((call) => call[0])).toEqual(["fallback ", "output"]);
      expect(mockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({
        stream: true,
      }), expect.any(Object));
      expect(mockResponsesCreate).toHaveBeenCalledOnce();
    });

    it("passes tools through the Responses API fallback and maps function calls", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce(makeResponsesEventStream([
        {
          type: "response.function_call_arguments.done",
          item_id: "fc-1",
          name: "read_file",
          arguments: "{\"path\":\"README.md\"}",
        },
        {
          type: "response.completed",
          response: {
            output_text: "",
            status: "completed",
            usage: { input_tokens: 12, output_tokens: 7 },
            output: [{
              type: "function_call",
              call_id: "call-1",
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            }],
          },
        },
      ]));

      const result = await client.sendMessageStream(
        [{ role: "user", content: "inspect" }],
        {
          tools: [{
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          }],
        },
        { onTextDelta: vi.fn() }
      );

      expect(mockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({
        tools: [expect.objectContaining({
          type: "function",
          name: "read_file",
          description: "Read a file",
        })],
        tool_choice: "auto",
      }), expect.any(Object));
      expect(result.tool_calls).toEqual([{
        id: "call-1",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"README.md\"}",
        },
      }]);
    });

    it("does not return a successful partial response when the parent aborts mid-stream", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      const controller = new AbortController();
      const onTextDelta = vi.fn();
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: "response.output_text.delta", delta: "partial" };
          controller.abort(new Error("operator stop requested"));
          yield { type: "response.output_text.delta", delta: " should not render" };
        },
      });

      await expect(client.sendMessageStream(
        [{ role: "user", content: "hello" }],
        { abortSignal: controller.signal },
        { onTextDelta }
      )).rejects.toThrow("aborted");
      expect(onTextDelta.mock.calls.map((call) => call[0])).toEqual(["partial"]);
    });

    it("throws on Responses API stream error events", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce(makeResponsesEventStream([
        { type: "error", message: "provider failed" },
      ]));

      await expect(client.sendMessageStream(
        [{ role: "user", content: "hello" }],
        undefined,
        { onTextDelta: vi.fn() }
      )).rejects.toThrow("provider failed");
    });

    it("throws when a Responses API stream ends without a terminal response", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      const onTextDelta = vi.fn();
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce(makeResponsesEventStream([
        { type: "response.output_text.delta", delta: "partial" },
      ]));

      await expect(client.sendMessageStream(
        [{ role: "user", content: "hello" }],
        undefined,
        { onTextDelta }
      )).rejects.toThrow("ended without a terminal response");
      expect(onTextDelta.mock.calls.map((call) => call[0])).toEqual(["partial"]);
    });

    it("passes reasoning effort to the Responses API fallback", async () => {
      const client = new OpenAILLMClient({
        apiKey: "sk-test",
        model: "codex-mini-latest",
        reasoningEffort: "high",
      });
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce(makeResponsesStream(["fallback output"], {
        output_text: "fallback output",
        status: "completed",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
        },
      }));

      await client.sendMessageStream(
        [{ role: "user", content: "hello" }],
        undefined,
        { onTextDelta: vi.fn() }
      );

      expect(mockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({
        reasoning: { effort: "high" },
      }), expect.any(Object));
    });

    it("clears the Responses API fallback timeout when an abort rejects the request", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      const controller = new AbortController();
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockImplementationOnce(async () => {
        controller.abort(new Error("operator stop requested"));
        throw new DOMException("operator stop requested", "AbortError");
      });

      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      await expect(
        client.sendMessageStream(
          [{ role: "user", content: "hello" }],
          { abortSignal: controller.signal },
          { onTextDelta: vi.fn() }
        )
      ).rejects.toThrow("operator stop requested");
      vi.useRealTimers();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  // ─── parseJSON ───

  describe("parseJSON", () => {
    const schema = z.object({ name: z.string(), count: z.number() });

    it("parses valid bare JSON", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const result = client.parseJSON('{"name":"test","count":42}', schema);
      expect(result).toEqual({ name: "test", count: 42 });
    });

    it("extracts JSON from ```json code fence", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const content = "```json\n{\"name\":\"hello\",\"count\":1}\n```";
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "hello", count: 1 });
    });

    it("extracts JSON from generic ``` code fence", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const content = "```\n{\"name\":\"world\",\"count\":99}\n```";
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "world", count: 99 });
    });

    it("throws on invalid JSON", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      expect(() => client.parseJSON("not json at all", schema)).toThrow(
        "LLM response JSON parse failed"
      );
    });

    it("throws on schema validation failure", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      expect(() =>
        client.parseJSON('{"name":123,"count":"wrong"}', schema)
      ).toThrow();
    });

    it("includes original content in error message on parse failure", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const badContent = "this is not json";
      expect(() => client.parseJSON(badContent, schema)).toThrow(badContent);
    });
  });
});
