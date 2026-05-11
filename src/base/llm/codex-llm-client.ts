import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BaseLLMClient } from "./base-llm-client.js";
import {
  type ILLMClient,
  type LLMMessage,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMStreamHandlers,
  type ToolCallResult,
} from "./llm-client.js";
import { sleep } from "../utils/sleep.js";
import { LLMError } from "../utils/errors.js";
import { signalProcessGroup } from "../utils/process-pid.js";
import { isTextFileSizeLimitError, readTextFileWithinLimit } from "../utils/json-io.js";

// ─── Constants ───

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per call
const DEFAULT_RETRY_ATTEMPTS = 3;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const SIGKILL_DELAY_MS = 5000;
const DEFAULT_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_RESPONSE_TEXT_MAX_BYTES = 8 * 1024 * 1024;
type CodexAgentLoopFailureReason = "model_request_timeout" | "model_request_aborted";

type CodexLLMError = LLMError & {
  code?: "ETIMEDOUT" | "ABORT_ERR";
  agentLoopFailureReason?: CodexAgentLoopFailureReason;
};

function codexLLMError(
  message: string,
  code?: CodexLLMError["code"],
  agentLoopFailureReason?: CodexAgentLoopFailureReason,
): CodexLLMError {
  const error = new LLMError(message) as CodexLLMError;
  if (code) error.code = code;
  if (agentLoopFailureReason) error.agentLoopFailureReason = agentLoopFailureReason;
  return error;
}

/**
 * Build a single prompt string from messages and system prompt.
 * Format:
 *   System instruction: <system>
 *
 *   user: <content>
 *   assistant: <content>
 *   ...
 */
function buildPrompt(messages: LLMMessage[], system?: string): string {
  const parts: string[] = [];

  if (system) {
    parts.push(`System instruction: ${system}`);
    parts.push("");
  }

  for (const msg of messages) {
    parts.push(`${msg.role}: ${msg.content}`);
  }

  return parts.join("\n");
}

// ─── CodexLLMClient ───

export interface CodexLLMClientConfig {
  /** ChatGPT OAuth access token. When present, PulSeed uses Codex Responses streaming for chat. */
  apiKey?: string;
  /** Codex Responses base URL. Defaults to ChatGPT backend Codex Responses. */
  baseURL?: string;
  /** Path to the codex CLI executable. Default: "codex" */
  cliPath?: string;
  /** Model to pass via --model flag. Default: uses codex's default (OPENAI_MODEL env or codex config) */
  model?: string;
  /** Light model for routine/cheap calls (model_tier: 'light'). Optional. */
  lightModel?: string;
  /** Optional Codex reasoning effort override for supported models. */
  reasoningEffort?: string;
  /** Repository path passed to Codex for workspace-aware execution. Default: "." */
  repoPath?: string;
  /** Total request timeout per call in milliseconds. Default: 120000 (2 minutes) */
  timeoutMs?: number;
  /** Idle timeout after Codex emits output and then goes quiet. Defaults to timeoutMs. */
  idleTimeoutMs?: number;
  /** Total retry attempts including the initial call. Default: 3, capped at 5. */
  retryAttempts?: number;
  /** Sandbox passed to codex exec. Default: workspace-write. */
  sandboxPolicy?: string;
  /** Pass --skip-git-repo-check. Default: true. */
  skipGitRepoCheck?: boolean;
}

export function isCodexOAuthAccessToken(token: string | undefined): token is string {
  const trimmed = token?.trim();
  if (!trimmed || trimmed.startsWith("sk-")) return false;
  const payload = decodeJwtPayload(trimmed);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return exp > Math.floor(Date.now() / 1000);
}

/**
 * ILLMClient implementation that uses the `codex exec` CLI for LLM calls.
 * Routes all PulSeed internal LLM calls through the Codex CLI, which uses
 * the ChatGPT subscription (no separate API key needed).
 *
 * Uses `codex exec -s danger-full-access -o <tmpfile> "PROMPT"` per call.
 * The -o flag writes the final response to a temp file for clean output.
 * Usage stats are not available from the CLI and will always be 0.
 *
 * Set PULSEED_LLM_PROVIDER=codex to activate via CLIRunner / provider-factory.
 */
export class CodexLLMClient extends BaseLLMClient implements ILLMClient {
  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly cliPath: string;
  private readonly model: string | undefined;
  private readonly repoPath: string;
  private readonly reasoningEffort: string | undefined;
  private readonly totalTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly retryAttempts: number;
  private readonly sandboxPolicy: string;
  private readonly skipGitRepoCheck: boolean;

  constructor(config: CodexLLMClientConfig = {}) {
    super();
    this.apiKey = isCodexOAuthAccessToken(config.apiKey) ? config.apiKey.trim() : undefined;
    this.baseURL = canonicalizeCodexResponsesBaseUrl(config.baseURL);
    this.cliPath = config.cliPath ?? "codex";
    this.model = config.model;
    this.lightModel = config.lightModel;
    this.reasoningEffort = config.reasoningEffort;
    this.repoPath = config.repoPath?.trim() || ".";
    this.totalTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = typeof config.idleTimeoutMs === "number" && Number.isFinite(config.idleTimeoutMs)
      ? Math.max(0, Math.trunc(config.idleTimeoutMs))
      : this.totalTimeoutMs;
    const requestedRetryAttempts = typeof config.retryAttempts === "number" && Number.isFinite(config.retryAttempts)
      ? Math.trunc(config.retryAttempts)
      : DEFAULT_RETRY_ATTEMPTS;
    this.retryAttempts = Math.max(1, Math.min(requestedRetryAttempts, MAX_RETRY_ATTEMPTS));
    this.sandboxPolicy = config.sandboxPolicy ?? "workspace-write";
    this.skipGitRepoCheck = config.skipGitRepoCheck ?? true;
  }

  /**
   * Send a message to the Codex CLI with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff on spawn failures.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    if (this.apiKey) {
      return this.sendViaCodexResponsesStream(messages, options, {});
    }

    const model = this.resolveEffectiveModel(options?.model ?? this.model ?? "", options?.model_tier) || undefined;
    const system = options?.system;

    const prompt = buildPrompt(messages, system);

    let lastError: unknown;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const content = await this._spawnCodex(
          prompt,
          model,
          options?.abortSignal,
          options?.sandboxPolicy ?? this.sandboxPolicy,
          options?.cwd,
          options?.timeoutMs,
          options?.idleTimeoutMs,
        );
        return {
          content,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
          stop_reason: "end_turn",
        };
      } catch (err) {
        lastError = err;
        if (!isRetryableCodexError(err)) {
          break;
        }
        if (attempt < this.retryAttempts - 1) {
          await sleepWithAbort(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!, options?.abortSignal);
        }
      }
    }

    throw lastError;
  }

  /** OAuth-backed Codex Responses supports native provider function/tool calling. */
  supportsToolCalling(): boolean { return Boolean(this.apiKey); }
  usesExternalAgentRuntime(): boolean { return !this.apiKey; }

  async sendMessageStream(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    if (!this.apiKey) {
      const response = await this.sendMessage(messages, options);
      if (response.content) handlers.onTextDelta?.(response.content);
      return response;
    }
    return this.sendViaCodexResponsesStream(messages, options, handlers);
  }

  /**
   * Spawn `codex exec -s <sandbox> [-o <tmpfile>] [--model <model>] "PROMPT"`
   * and return the response content read from the temp output file.
   */
  private async _spawnCodex(
    prompt: string,
    model?: string,
    abortSignal?: AbortSignal,
    sandboxPolicy = this.sandboxPolicy,
    cwd = this.repoPath,
    timeoutMs = this.totalTimeoutMs,
    idleTimeoutMs = this.idleTimeoutMs,
  ): Promise<string> {
    if (abortSignal?.aborted) {
      throw codexLLMError("CodexLLMClient: request aborted by operator stop", "ABORT_ERR", "model_request_aborted");
    }
    // Create a temporary directory asynchronously to avoid blocking the event loop
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-codex-"));
    const tmpFile = path.join(tmpDir, "response.txt");

    return new Promise((resolve, reject) => {

      // Build spawn args: exec -s <sandbox> -o <tmpfile> [--model <model>] -
      // Prompt is sent via stdin (using "-" as positional arg) to avoid arg length limits.
      // --path is not supported by codex-cli 0.114.0+; use cwd instead (see src/adapters/openai-codex.ts)
      const spawnArgs: string[] = [
        "exec",
        "-s",
        sandboxPolicy,
        "-o",
        tmpFile,
      ];

      if (this.skipGitRepoCheck) {
        spawnArgs.splice(3, 0, "--skip-git-repo-check");
      }

      if (model) {
        spawnArgs.push("--model", model);
      }

      if (this.reasoningEffort) {
        spawnArgs.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      }

      spawnArgs.push("-");

      const child = spawn(this.cliPath, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
        cwd,
        detached: process.platform !== "win32",
      });

      let timedOut = false;
      let aborted = false;
      let timeoutReason: "total" | "idle" | undefined;
      let idleTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let sigkillHandle: ReturnType<typeof setTimeout> | undefined;
      let stderrData = "";
      const clearTimers = (options: { keepSigkill?: boolean } = {}): void => {
        if (totalTimeoutHandle) clearTimeout(totalTimeoutHandle);
        if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
        if (!options.keepSigkill && sigkillHandle) clearTimeout(sigkillHandle);
      };
      const killChild = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && typeof child.pid === "number") {
          try {
            const groupSignal = signalProcessGroup(child.pid, signal);
            if (groupSignal.status === "sent") {
              return;
            }
          } catch {
            // Fall back to the immediate child below.
          }
        }
        child.kill(signal);
      };
      const forceKillChild = (): void => {
        try {
          killChild("SIGKILL");
        } catch {
          // process already exited
        }
      };
      const cleanupTmp = (): void => {
        clearTimers();
        abortSignal?.removeEventListener("abort", triggerAbort);
        void _cleanupTmp(tmpDir, tmpFile).catch((cleanupErr) => {
          console.debug("CodexLLMClient: _cleanupTmp failed (non-critical)", String(cleanupErr));
        });
      };
      const scheduleForceKill = (): void => {
        if (sigkillHandle) return;
        sigkillHandle = setTimeout(forceKillChild, SIGKILL_DELAY_MS);
      };
      const triggerTimeout = (reason: "total" | "idle"): void => {
        if (timedOut) return;
        timedOut = true;
        timeoutReason = reason;
        killChild("SIGTERM");
        scheduleForceKill();
      };
      const triggerAbort = (): void => {
        if (aborted || timedOut) return;
        aborted = true;
        killChild("SIGTERM");
        scheduleForceKill();
      };
      if (abortSignal?.aborted) {
        triggerAbort();
      } else {
        abortSignal?.addEventListener("abort", triggerAbort, { once: true });
      }
      const armIdleTimeout = (): void => {
        if (idleTimeoutMs <= 0) return;
        if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = setTimeout(() => triggerTimeout("idle"), idleTimeoutMs);
      };
      const markActivity = (): void => {
        armIdleTimeout();
      };

      const totalTimeoutHandle = timeoutMs > 0
        ? setTimeout(() => triggerTimeout("total"), timeoutMs)
        : undefined;

      child.stdout?.on("data", markActivity);
      child.stderr.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString();
        markActivity();
      });

      // Suppress EPIPE errors on stdin
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") throw err;
      });

      // Write prompt via stdin and close
      child.stdin.write(prompt);
      child.stdin.end();

      child.on("error", (err: Error) => {
        cleanupTmp();
        reject(new LLMError(`CodexLLMClient: spawn error — ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        clearTimers({ keepSigkill: timedOut || aborted });

        if (timedOut) {
          forceKillChild();
          cleanupTmp();
          const timeoutLabel = timeoutReason === "idle" ? "idle timed out" : "request timed out";
          reject(
            codexLLMError(
              `CodexLLMClient: ${timeoutLabel} after ${timeoutReason === "idle" ? idleTimeoutMs : timeoutMs}ms`,
              "ETIMEDOUT",
              "model_request_timeout",
            )
          );
          return;
        }
        if (aborted) {
          forceKillChild();
          cleanupTmp();
          reject(codexLLMError("CodexLLMClient: request aborted by operator stop", "ABORT_ERR", "model_request_aborted"));
          return;
        }

        if (code !== 0) {
          cleanupTmp();
          const detail = stderrData.trim() ? ` — ${stderrData.trim().slice(0, 500)}` : "";
          reject(
            new LLMError(
              `CodexLLMClient: process exited with code ${code}${detail}`
            )
          );
          return;
        }

        // Read response from temp file
        readTextFileWithinLimit(tmpFile, { maxBytes: CODEX_RESPONSE_TEXT_MAX_BYTES })
          .then((raw) => {
            cleanupTmp();
            resolve(raw.trim());
          })
          .catch((readErr) => {
            cleanupTmp();
            if (isTextFileSizeLimitError(readErr)) {
              reject(
                new LLMError(
                  `CodexLLMClient: output file exceeds ${CODEX_RESPONSE_TEXT_MAX_BYTES} bytes`
                )
              );
              return;
            }
            reject(
              new LLMError(
                `CodexLLMClient: failed to read output file — ${String(readErr)}`
              )
            );
          });
      });
    });
  }

  private async sendViaCodexResponsesStream(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new LLMError("CodexLLMClient: Codex Responses streaming requires a ChatGPT OAuth token");
    }
    const model = this.resolveEffectiveModel(options?.model ?? this.model ?? "", options?.model_tier) || "gpt-5.4-mini";
    const abortController = new AbortController();
    const abortFromParent = (): void => abortController.abort(options?.abortSignal?.reason);
    if (options?.abortSignal?.aborted) {
      abortFromParent();
    } else {
      options?.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = options?.timeoutMs ?? this.totalTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(() => abortController.abort(), timeoutMs);
      }
      const response = await fetch(`${this.baseURL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...codexAccountHeader(apiKey),
          originator: "pi",
          "openai-beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(buildCodexResponsesPayload({
          model,
          messages,
          options,
          system: options?.system,
          reasoningEffort: options?.reasoning_effort ?? this.reasoningEffort,
        })),
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await safeResponseText(response);
        throw new LLMError(
          `CodexLLMClient: Codex Responses request failed with HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      return await readCodexResponsesStream(response.body, handlers, abortController.signal);
    } catch (err) {
      if (abortController.signal.aborted || options?.abortSignal?.aborted) {
        throw codexLLMError("CodexLLMClient: Codex Responses stream aborted", "ABORT_ERR", "model_request_aborted");
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      abortController.abort();
      options?.abortSignal?.removeEventListener("abort", abortFromParent);
    }
  }
}

function canonicalizeCodexResponsesBaseUrl(baseURL: string | undefined): string {
  const trimmed = baseURL?.trim();
  if (!trimmed) return DEFAULT_CODEX_RESPONSES_BASE_URL;
  const normalized = trimmed.replace(/\/+$/, "");
  if (/^https?:\/\/chatgpt\.com\/backend-api(?:\/codex)?(?:\/v1)?$/i.test(normalized)) {
    return DEFAULT_CODEX_RESPONSES_BASE_URL;
  }
  return normalized.endsWith("/responses") ? normalized.slice(0, -"/responses".length) : normalized;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function codexAccountHeader(token: string): Record<string, string> {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object"
    ? (auth as Record<string, unknown>)["chatgpt_account_id"]
    : undefined;
  return typeof accountId === "string" && accountId.trim()
    ? { "chatgpt-account-id": accountId.trim() }
    : {};
}

function buildCodexResponsesPayload(params: {
  model: string;
  messages: LLMMessage[];
  options: LLMRequestOptions | undefined;
  system?: string;
  reasoningEffort?: string;
}): Record<string, unknown> {
  const input = codexResponsesInput(params.messages);
  const tools = params.options?.tools?.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: null,
  }));
  const reasoningEffort = params.reasoningEffort ?? "low";
  return {
    model: params.model,
    store: false,
    stream: true,
    instructions: params.system?.trim() || "You are PulSeed's configured chat model. Follow the user request and answer concisely.",
    input: input.length > 0 ? input : [{ role: "user", content: [{ type: "input_text", text: " " }] }],
    text: { verbosity: "low" },
    reasoning: { effort: reasoningEffort, summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: `pulseed-${randomUUID()}`,
    ...(tools?.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
  };
}

function codexResponsesInput(messages: LLMMessage[]): Record<string, unknown>[] {
  return messages.flatMap((message, index): Record<string, unknown>[] => {
    const text = message.content || " ";
    if (message.role === "user") {
      return [{ role: "user", content: [{ type: "input_text", text }] }];
    }
    return [{
      type: "message",
      id: `msg_${index}`,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
      status: "completed",
    }];
  });
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return "";
  }
}

async function readCodexResponsesStream(
  body: ReadableStream<Uint8Array>,
  handlers: LLMStreamHandlers,
  abortSignal: AbortSignal,
): Promise<LLMResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finalResponse: Record<string, unknown> | undefined;
  const toolCalls = new Map<string, ToolCallResult>();
  const toolArgumentBuffers = new Map<string, string>();
  const toolCallIdsByItemId = new Map<string, string>();

  while (true) {
    if (abortSignal.aborted) {
      throw codexLLMError("CodexLLMClient: Codex Responses stream aborted", "ABORT_ERR", "model_request_aborted");
    }
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd >= 0) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      for (const event of parseSseFrame(frame)) {
        if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) {
            content += delta;
            handlers.onModelTextDeltaReceived?.(delta);
          }
        } else if (event.type === "response.output_item.added" && isRecord(event.item) && event.item["type"] === "function_call") {
          rememberResponseToolCall(toolCallIdsByItemId, event.item);
          upsertToolCall(toolCalls, event.item, toolArgumentBuffers.get(responseToolCallItemId(event.item)));
        } else if (event.type === "response.function_call_arguments.delta") {
          const callId = responseToolCallItemId(event);
          const delta = typeof event.delta === "string" ? event.delta : "";
          toolArgumentBuffers.set(callId, `${toolArgumentBuffers.get(callId) ?? ""}${delta}`);
        } else if (event.type === "response.function_call_arguments.done") {
          const itemId = responseToolCallItemId(event);
          if (typeof event.arguments === "string") {
            toolArgumentBuffers.set(itemId, event.arguments);
          }
          const callId = toolCallIdsByItemId.get(itemId);
          const existing = callId ? toolCalls.get(callId) : undefined;
          if (existing) {
            toolCalls.set(callId!, {
              ...existing,
              function: {
                ...existing.function,
                arguments: toolArgumentBuffers.get(itemId) ?? existing.function.arguments,
              },
            });
          }
        } else if (event.type === "response.output_item.done" && isRecord(event.item) && event.item["type"] === "function_call") {
          rememberResponseToolCall(toolCallIdsByItemId, event.item);
          upsertToolCall(toolCalls, event.item, toolArgumentBuffers.get(responseToolCallItemId(event.item)));
        } else if (event.type === "response.completed" || event.type === "response.done") {
          finalResponse = isRecord(event.response) ? event.response : {};
        } else if (event.type === "response.incomplete") {
          const response = isRecord(event.response) ? event.response : undefined;
          const details = isRecord(response?.["incomplete_details"]) ? response["incomplete_details"] : undefined;
          throw new LLMError(`CodexLLMClient: Codex Responses stream incomplete: ${String(details?.["reason"] ?? response?.["status"] ?? "unknown reason")}`);
        } else if (event.type === "response.failed") {
          const response = isRecord(event.response) ? event.response : undefined;
          const error = isRecord(response?.["error"]) ? response["error"] : undefined;
          throw new LLMError(`CodexLLMClient: Codex Responses stream failed: ${String(error?.["message"] ?? response?.["status"] ?? "unknown failure")}`);
        } else if (event.type === "error") {
          throw new LLMError(`CodexLLMClient: Codex Responses stream error: ${String(event.message ?? "unknown error")}`);
        }
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
  if (!finalResponse) {
    throw new LLMError("CodexLLMClient: Codex Responses stream ended without a terminal response");
  }
  if (content) {
    handlers.onTextDelta?.(content);
  }
  return responseFromCodexResponses(finalResponse, content, [...toolCalls.values()]);
}

function parseSseFrame(frame: string): Record<string, unknown>[] {
  return frame
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upsertToolCall(
  toolCalls: Map<string, ToolCallResult>,
  item: Record<string, unknown>,
  argumentBuffer?: string,
): void {
  const id = responseToolCallId(item);
  toolCalls.set(id, {
    id,
    type: "function",
    function: {
      name: typeof item["name"] === "string" ? item["name"] : toolCalls.get(id)?.function.name ?? "",
      arguments: typeof item["arguments"] === "string"
        ? item["arguments"]
        : argumentBuffer ?? toolCalls.get(id)?.function.arguments ?? "{}",
    },
  });
}

function rememberResponseToolCall(toolCallIdsByItemId: Map<string, string>, item: Record<string, unknown>): void {
  const itemId = responseToolCallItemId(item);
  const callId = responseToolCallId(item);
  toolCallIdsByItemId.set(itemId, callId);
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

function responseToolCallItemId(item: Record<string, unknown>): string {
  return typeof item["item_id"] === "string"
    ? item["item_id"]
    : typeof item["id"] === "string"
      ? item["id"]
      : typeof item["call_id"] === "string"
        ? item["call_id"]
        : randomUUID();
}

function responseFromCodexResponses(
  finalResponse: Record<string, unknown> | undefined,
  content: string,
  toolCalls: ToolCallResult[],
): LLMResponse {
  const usage = isRecord(finalResponse?.["usage"]) ? finalResponse["usage"] : {};
  return {
    content: typeof finalResponse?.["output_text"] === "string" && finalResponse["output_text"]
      ? finalResponse["output_text"]
      : content,
    usage: {
      input_tokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0,
      output_tokens: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0,
    },
    stop_reason: typeof finalResponse?.["status"] === "string" ? finalResponse["status"] : "completed",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function isRetryableCodexError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("CodexLLMClient: spawn error");
}

// ─── Helpers ───

async function _cleanupTmp(tmpDir: string, tmpFile: string): Promise<void> {
  try {
    await fsp.access(tmpFile);
    await fsp.unlink(tmpFile);
  } catch {
    // file may not exist — ignore
  }
  try {
    await fsp.rmdir(tmpDir);
  } catch {
    // best-effort cleanup
  }
}

function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return sleep(ms);
  if (abortSignal.aborted) {
    return Promise.reject(codexLLMError("CodexLLMClient: request aborted by operator stop", "ABORT_ERR", "model_request_aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(codexLLMError("CodexLLMClient: request aborted by operator stop", "ABORT_ERR", "model_request_aborted"));
    };
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
