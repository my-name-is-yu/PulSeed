// ─── BrowserUseCLIAdapter ───
//
// IAdapter implementation that spawns the `browser-use` CLI process.
// The task prompt is passed via stdin to avoid exposing it in the
// process argument list (visible via `ps aux`).
// Uses --headless for non-interactive browser automation and --json
// for structured output.
//
// Invocation pattern:
//   echo "<prompt>" | browser-use run --headless --json
//
// The CLI takes a natural language task, controls a browser with AI,
// and returns the result (JSON when --json is used).

import { spawn } from "node:child_process";
import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";

export interface BrowserUseCLIAdapterConfig {
  /** The executable name / path for the browser-use CLI. Default: "browser-use" */
  cliPath?: string;
  /** Whether to run the browser in headless mode. Default: true */
  headless?: boolean;
  /** Whether to request JSON-formatted output. Default: true */
  jsonOutput?: boolean;
}

export class BrowserUseCLIAdapter implements IAdapter {
  readonly adapterType = "browser_use_cli";
  readonly capabilities = ["browse_web", "web_scraping", "form_filling", "screenshot"] as const;

  private readonly cliPath: string;
  private readonly headless: boolean;
  private readonly jsonOutput: boolean;

  constructor(config: BrowserUseCLIAdapterConfig = {}) {
    this.cliPath = config.cliPath ?? "browser-use";
    this.headless = config.headless !== false;
    this.jsonOutput = config.jsonOutput !== false;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    return new Promise<AgentResult>((resolve) => {
      // Build argument list: run [--headless] [--json]
      // Prompt is written to stdin to avoid exposure in `ps aux`.
      const spawnArgs: string[] = ["run"];

      if (this.headless) {
        spawnArgs.push("--headless");
      }

      if (this.jsonOutput) {
        spawnArgs.push("--json");
      }

      const child = spawn(this.cliPath, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Guard against double-resolve: Node.js emits both `error` and `close`
      // on spawn failure (ENOENT). Only the first settle call takes effect.
      let settled = false;
      const settle = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(result);
      };

      // Timeout: send SIGTERM, then record timeout result.
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, task.timeout_ms);

      // Suppress EPIPE errors on stdin: the spawned process may exit and close
      // its stdin pipe before we finish writing (race condition in tests).
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") throw err;
        // EPIPE = process already closed stdin; safe to ignore
      });

      // Write the prompt to stdin and close it so the CLI knows input is done.
      child.stdin.write(task.prompt, "utf8");
      child.stdin.end();

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err: Error) => {
        settle({
          success: false,
          output: stdout,
          error: err.message,
          exit_code: null,
          elapsed_ms: Date.now() - startedAt,
          stopped_reason: "error",
        });
      });

      child.on("close", (code: number | null) => {
        const elapsed = Date.now() - startedAt;

        if (timedOut) {
          settle({
            success: false,
            output: stdout,
            error: `Timed out after ${task.timeout_ms}ms`,
            exit_code: code,
            elapsed_ms: elapsed,
            stopped_reason: "timeout",
          });
          return;
        }

        const success = code === 0;
        settle({
          success,
          output: stdout,
          error: success ? null : stderr || `Process exited with code ${code}`,
          exit_code: code,
          elapsed_ms: elapsed,
          stopped_reason: success ? "completed" : "error",
        });
      });
    });
  }
}
