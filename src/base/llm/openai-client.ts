import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { BaseLLMClient, DEFAULT_MAX_TOKENS, DEFAULT_LLM_TIMEOUT_MS, MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS, RATE_LIMIT_RETRY_DELAYS_MS, isRateLimitError, getRateLimitRetryDelay } from "./base-llm-client.js";
import { type ILLMClient, type LLMMessage, type LLMRequestOptions, type LLMResponse, type LLMStreamHandlers, type ToolCallResult } from "./llm-client.js";
import { sleep } from "../utils/sleep.js";
import { LLMError } from "../utils/errors.js";

// ─── Constants ───

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_TEMPERATURE = 0.2;

export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Model prefixes that do not support the temperature parameter */
const REASONING_MODEL_PREFIXES = ["o1", "o3", "o4", "gpt-5"];

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

function shouldSendReasoningEffort(model: string, effort: OpenAIReasoningEffort | undefined): effort is OpenAIReasoningEffort {
  return Boolean(effort) && (isReasoningModel(model) || model.includes("codex"));
}

function shouldFallbackToResponses(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("not a chat model") ||
    msg.includes("v1/chat/completions") ||
    msg.includes("Did you mean to use v1/completions")
  );
}

// ─── OpenAILLMClient ───

export interface OpenAIClientConfig {
  /** API key for OpenAI. Required. */
  apiKey?: string;
  /** Default: "gpt-4o" */
  model?: string;
  /** Optional base URL for Azure OpenAI or proxy endpoints */
  baseURL?: string;
  /** Optional lighter model for routine tasks (observation, verification, etc.) */
  lightModel?: string;
  /** Optional reasoning effort for supported OpenAI reasoning models. */
  reasoningEffort?: OpenAIReasoningEffort;
}

/**
 * LLM client for OpenAI.
 *
 * Primary path: Chat Completions API.
 * Fallback: Responses API when the selected model is not compatible with
 * /v1/chat/completions (e.g., some Codex-style models).
 *
 * Set PULSEED_LLM_PROVIDER=openai to activate via CLIRunner.
 * Optionally set OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_BASE_URL to configure.
 */
export class OpenAILLMClient extends BaseLLMClient implements ILLMClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly reasoningEffort: OpenAIReasoningEffort | undefined;

  constructor(config: OpenAIClientConfig = {}) {
    super();
    if (!config.apiKey) {
      throw new LLMError(
        "OpenAILLMClient: no API key provided. Pass apiKey to constructor."
      );
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
    this.lightModel = config.lightModel;
    this.reasoningEffort = config.reasoningEffort;
  }

  /**
   * Send a message to the OpenAI chat completions API with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff on network errors.
   * Retries up to RATE_LIMIT_RETRY_DELAYS_MS.length times on HTTP 429 with extended backoff.
   *
   * For reasoning models (o1, o3, o4), temperature is omitted as it is not supported.
   * System prompt is sent as a "developer" role message, prepended to the messages array.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = this.resolveEffectiveModel(options?.model ?? this.model, options?.model_tier);
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const system = options?.system;

    // Build OpenAI messages array
    const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) {
      openAiMessages.push({ role: "developer" as const, content: system });
    }
    for (const msg of messages) {
      openAiMessages.push({ role: msg.role, content: msg.content });
    }

    // Reasoning models do not accept the temperature parameter
    const createParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: openAiMessages,
      max_completion_tokens: max_tokens,
      ...(options?.tools?.length
        ? {
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters as OpenAI.FunctionParameters,
              },
            })),
          }
        : {}),
      ...(isReasoningModel(model) ? {} : { temperature }),
      ...(shouldSendReasoningEffort(model, this.reasoningEffort) ? { reasoning_effort: this.reasoningEffort } : {}),
    };

    let lastError: unknown;
    let normalAttempts = 0;
    let rateLimitAttempts = 0;

    while (normalAttempts < MAX_RETRY_ATTEMPTS) {
      try {
        try {
          const response = await this.client.chat.completions.create(
            createParams,
            { timeout: DEFAULT_LLM_TIMEOUT_MS, ...(options?.abortSignal ? { signal: options.abortSignal } : {}) }
          );

          const choice = response.choices[0];
          const content = choice?.message.content ?? "";
          const stop_reason = choice?.finish_reason ?? "unknown";
          const tool_calls = mapOpenAIToolCalls(choice?.message.tool_calls);

          return {
            content,
            usage: {
              input_tokens: response.usage?.prompt_tokens ?? 0,
              output_tokens: response.usage?.completion_tokens ?? 0,
            },
            stop_reason,
            ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
          };
        } catch (err) {
          // Some models (notably Codex-style) are not compatible with the
          // chat completions endpoint. In that case, fall back to Responses API.
          if (!shouldFallbackToResponses(err)) throw err;
          return this.sendViaResponsesApi(model, messages, {
            max_tokens,
            temperature,
            system,
            reasoningEffort: this.reasoningEffort,
            abortSignal: options?.abortSignal,
            tools: options?.tools,
          });
        }
      } catch (err) {
        lastError = err;
        // Rate limit: retry with extended backoff (does not count against normalAttempts)
        if (isRateLimitError(err) && rateLimitAttempts < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          await sleep(getRateLimitRetryDelay(err, rateLimitAttempts));
          rateLimitAttempts++;
          continue;
        }
        // Only retry on network/transient errors, not on HTTP 4xx client errors (excluding 429)
        const isNetworkError =
          err instanceof TypeError ||
          (err instanceof Error &&
            !err.message.startsWith("OpenAILLMClient: HTTP 4"));

        normalAttempts++;
        if (normalAttempts < MAX_RETRY_ATTEMPTS && isNetworkError) {
          await sleep(RETRY_DELAYS_MS[normalAttempts - 1] ?? 1000);
        } else if (!isNetworkError) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  async sendMessageStream(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    handlers: LLMStreamHandlers
  ): Promise<LLMResponse> {
    const model = this.resolveEffectiveModel(options?.model ?? this.model, options?.model_tier);
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const system = options?.system;

    const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) {
      openAiMessages.push({ role: "developer" as const, content: system });
    }
    for (const msg of messages) {
      openAiMessages.push({ role: msg.role, content: msg.content });
    }

    const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: openAiMessages,
      max_completion_tokens: max_tokens,
      stream: true,
      ...(options?.tools?.length
        ? {
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters as OpenAI.FunctionParameters,
              },
            })),
          }
        : {}),
      ...(isReasoningModel(model) ? {} : { temperature }),
      ...(shouldSendReasoningEffort(model, this.reasoningEffort) ? { reasoning_effort: this.reasoningEffort } : {}),
    };

    try {
      const stream = this.client.chat.completions.stream(
        createParams,
        { timeout: DEFAULT_LLM_TIMEOUT_MS, ...(options?.abortSignal ? { signal: options.abortSignal } : {}) }
      );
      stream.on("content", (delta: string) => {
        handlers.onTextDelta?.(delta);
      });

      const [completion, message] = await Promise.all([
        stream.finalChatCompletion(),
        stream.finalMessage(),
      ]);

      const tool_calls = mapOpenAIToolCalls(message.tool_calls);

      return {
        content: message.content ?? "",
        usage: {
          input_tokens: completion.usage?.prompt_tokens ?? 0,
          output_tokens: completion.usage?.completion_tokens ?? 0,
        },
        stop_reason: completion.choices[0]?.finish_reason ?? "unknown",
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      };
    } catch (err) {
      if (!shouldFallbackToResponses(err)) throw err;
      return this.sendViaResponsesApiStream(model, messages, {
        max_tokens,
        temperature,
        system,
        reasoningEffort: this.reasoningEffort,
        abortSignal: options?.abortSignal,
        tools: options?.tools,
      }, handlers);
    }
  }

  private async sendViaResponsesApi(
    model: string,
    messages: LLMMessage[],
    options: { max_tokens: number; temperature: number; system?: string; reasoningEffort?: OpenAIReasoningEffort; abortSignal?: AbortSignal; tools?: LLMRequestOptions["tools"] }
  ): Promise<LLMResponse> {
    const input = formatResponsesInput(messages, options.system);

    // Use Responses API (SDK supports this as of openai v4+).
    // The TypeScript types for the Responses API are not yet in the openai
    // package typings, so we cast through unknown to access this endpoint.
    const responsesApi = (this.client as unknown as { responses: { create: (params: Record<string, unknown>, requestOptions?: Record<string, unknown>) => Promise<unknown> } }).responses;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LLMError(`OpenAILLMClient: Responses API timed out after ${DEFAULT_LLM_TIMEOUT_MS}ms`)),
        DEFAULT_LLM_TIMEOUT_MS
      );
    });
    const responseParams = {
      model,
      input,
      max_output_tokens: options.max_tokens,
      ...(isReasoningModel(model) ? {} : { temperature: options.temperature }),
      ...(shouldSendReasoningEffort(model, options.reasoningEffort) ? { reasoning: { effort: options.reasoningEffort } } : {}),
      ...(options.tools?.length ? { tools: mapResponsesTools(options.tools), tool_choice: "auto" } : {}),
    };
    const responsePromise = options.abortSignal
      ? responsesApi.create(responseParams, { signal: options.abortSignal })
      : responsesApi.create(responseParams);
    let resp: Record<string, unknown>;
    try {
      resp = await Promise.race([responsePromise, timeout]) as Record<string, unknown>;
    } finally {
      clearTimeout(timer!);
    }

    return responseFromResponsesObject(resp);
  }

  private async sendViaResponsesApiStream(
    model: string,
    messages: LLMMessage[],
    options: { max_tokens: number; temperature: number; system?: string; reasoningEffort?: OpenAIReasoningEffort; abortSignal?: AbortSignal; tools?: LLMRequestOptions["tools"] },
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const input = formatResponsesInput(messages, options.system);
    const responsesApi = (this.client as unknown as {
      responses: {
        create: (params: Record<string, unknown>, requestOptions?: Record<string, unknown>) => Promise<unknown>;
      };
    }).responses;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LLMError(`OpenAILLMClient: Responses API timed out after ${DEFAULT_LLM_TIMEOUT_MS}ms`)),
        DEFAULT_LLM_TIMEOUT_MS
      );
    });
    const responseParams = {
      model,
      input,
      max_output_tokens: options.max_tokens,
      stream: true,
      ...(isReasoningModel(model) ? {} : { temperature: options.temperature }),
      ...(shouldSendReasoningEffort(model, options.reasoningEffort) ? { reasoning: { effort: options.reasoningEffort } } : {}),
      ...(options.tools?.length ? { tools: mapResponsesTools(options.tools), tool_choice: "auto" } : {}),
    };
    const abortController = new AbortController();
    const abortFromParent = () => abortController.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) {
      abortFromParent();
    } else {
      options.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
    }

    const streamPromise = (async (): Promise<LLMResponse> => {
      const responseStream = await responsesApi.create(
        responseParams,
        { signal: abortController.signal }
      );
      if (abortController.signal.aborted) {
        throw new LLMError("OpenAILLMClient: Responses API stream aborted");
      }
      if (!isAsyncIterable(responseStream)) {
        return responseFromResponsesObject(responseStream);
      }

      let content = "";
      let finalResponse: Record<string, unknown> | null = null;
      const toolCalls: ToolCallResult[] = [];
      for await (const event of responseStream) {
        if (!isRecord(event)) continue;
        if (abortController.signal.aborted) {
          throw new LLMError("OpenAILLMClient: Responses API stream aborted");
        }
        if (event["type"] === "error") {
          throw new LLMError(`OpenAILLMClient: Responses API stream error: ${String(event["message"] ?? "unknown error")}`);
        }
        if (event["type"] === "response.output_text.delta" && typeof event["delta"] === "string") {
          content += event["delta"];
          handlers.onTextDelta?.(event["delta"]);
          continue;
        }
        if (event["type"] === "response.function_call_arguments.done") {
          toolCalls.push({
            id: responseToolCallId(event),
            type: "function",
            function: {
              name: typeof event["name"] === "string" ? event["name"] : "",
              arguments: typeof event["arguments"] === "string" ? event["arguments"] : "{}",
            },
          });
          continue;
        }
        if (event["type"] === "response.failed") {
          const response = isRecord(event["response"]) ? event["response"] : null;
          const error = isRecord(response?.["error"]) ? response["error"] : null;
          throw new LLMError(`OpenAILLMClient: Responses API stream failed: ${String(error?.["message"] ?? response?.["status"] ?? "unknown failure")}`);
        }
        if (
          (event["type"] === "response.completed" || event["type"] === "response.incomplete") &&
          isRecord(event["response"])
        ) {
          finalResponse = event["response"];
        }
      }
      if (abortController.signal.aborted) {
        throw new LLMError("OpenAILLMClient: Responses API stream aborted");
      }
      if (!finalResponse) {
        throw new LLMError("OpenAILLMClient: Responses API stream ended without a terminal response");
      }

      const fromFinal = responseFromResponsesObject(finalResponse);
      const mergedToolCalls = fromFinal.tool_calls?.length ? fromFinal.tool_calls : toolCalls;
      return {
        content: fromFinal.content || content,
        usage: fromFinal.usage,
        stop_reason: fromFinal.stop_reason,
        ...(mergedToolCalls.length > 0 ? { tool_calls: mergedToolCalls } : {}),
      };
    })();

    try {
      return await Promise.race([streamPromise, timeout]);
    } finally {
      abortController.abort();
      options.abortSignal?.removeEventListener("abort", abortFromParent);
      clearTimeout(timer!);
    }
  }
}

function formatResponsesInput(messages: LLMMessage[], system: string | undefined): string {
  return [
    system ? `SYSTEM:\n${system}` : null,
    ...messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && Symbol.asyncIterator in value;
}

function responseFromResponsesObject(value: unknown): LLMResponse {
  const resp = isRecord(value) ? value : {};
  const usage = isRecord(resp["usage"]) ? resp["usage"] : {};
  const tool_calls = toolCallsFromResponsesObject(resp);
  return {
    content: typeof resp["output_text"] === "string" ? resp["output_text"] : "",
    usage: {
      input_tokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0,
      output_tokens: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0,
    },
    stop_reason: typeof resp["status"] === "string" ? resp["status"] : "unknown",
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
  };
}

function mapResponsesTools(tools: NonNullable<LLMRequestOptions["tools"]>): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: null,
  }));
}

function toolCallsFromResponsesObject(resp: Record<string, unknown>): ToolCallResult[] {
  const output = Array.isArray(resp["output"]) ? resp["output"] : [];
  return output
    .filter((item): item is Record<string, unknown> => isRecord(item) && item["type"] === "function_call")
    .map((item) => ({
      id: responseToolCallId(item),
      type: "function" as const,
      function: {
        name: typeof item["name"] === "string" ? item["name"] : "",
        arguments: typeof item["arguments"] === "string" ? item["arguments"] : "{}",
      },
    }));
}

function responseToolCallId(item: Record<string, unknown>): string {
  return typeof item["call_id"] === "string"
    ? item["call_id"]
    : typeof item["id"] === "string"
      ? item["id"]
      : typeof item["item_id"] === "string"
        ? item["item_id"]
        : randomUUID();
}


function mapOpenAIToolCalls(
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined
): ToolCallResult[] {
  if (!toolCalls?.length) return [];
  return toolCalls
    .filter((call): call is OpenAI.Chat.ChatCompletionMessageFunctionToolCall =>
      !("type" in call) || call.type === "function"
    )
    .map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));
}
