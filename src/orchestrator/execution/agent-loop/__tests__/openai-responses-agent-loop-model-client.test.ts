import { describe, expect, it, vi } from "vitest";
import {
  defaultAgentLoopCapabilities,
  OpenAIResponsesAgentLoopModelClient,
  StaticAgentLoopModelRegistry,
} from "../index.js";

describe("OpenAIResponsesAgentLoopModelClient", () => {
  it("does not send internal message phase fields to the Responses API", async () => {
    const registry = new StaticAgentLoopModelRegistry([{
      ref: { providerId: "openai", modelId: "gpt-test" },
      displayName: "openai/gpt-test",
      capabilities: { ...defaultAgentLoopCapabilities },
    }]);
    const client = new OpenAIResponsesAgentLoopModelClient({ apiKey: "test-key" }, registry);
    const create = vi.fn(async (input: unknown) => {
      expect(JSON.stringify(input)).not.toContain("\"phase\"");
      expect(JSON.stringify(input)).not.toContain("\"strict\":true");
      const inputItems = (input as { input: Array<{ type: string; call_id?: string }> }).input;
      expect(inputItems.some((item) => item.type === "function_call" && item.call_id === "call-1")).toBe(true);
      expect(inputItems.some((item) => item.type === "function_call_output" && item.call_id === "call-1")).toBe(true);
      expect(inputItems.findIndex((item) => item.type === "function_call")).toBeLessThan(
        inputItems.findIndex((item) => item.type === "function_call_output"),
      );
      return {
        id: "resp-1",
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "{\"ok\":true}" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    (client as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };

    const protocol = await client.createTurnProtocol({
      model: { providerId: "openai", modelId: "gpt-test" },
      messages: [
        { role: "system", content: "system" },
        {
          role: "assistant",
          content: "Calling tool",
          phase: "commentary",
          toolCalls: [{ id: "call-1", name: "echo", input: { value: "hello" } }],
        },
        { role: "tool", toolCallId: "call-1", toolName: "echo", content: "tool output" },
        { role: "assistant", content: "{\"ok\":true}", phase: "final_answer" },
      ],
      tools: [],
    });

    expect(protocol.responseCompleted).toBe(true);
    expect(protocol.assistant[0]?.content).toBe("{\"ok\":true}");
  });
});
