import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { BaseLLMClient } from "./base-llm-client.js";
import {
  type ILLMClient,
  type LLMMessage,
  type LLMRequestOptions,
  type LLMResponse,
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

  /** CodexLLMClient does not support native provider function/tool calling. */
  supportsToolCalling(): boolean { return false; }
  usesExternalAgentRuntime(): boolean { return true; }

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
