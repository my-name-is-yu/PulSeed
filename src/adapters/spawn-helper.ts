// ─── spawnWithTimeout ───
//
// Shared helper for adapter files that spawn a child process, accumulate
// stdout/stderr, and enforce a timeout.
//
// The `settle()` double-resolve guard (adapted from browser-use-cli.ts) is
// used internally so callers never receive two results even when Node.js emits
// both `error` and `close` on a spawn failure (ENOENT).

import { spawn } from "node:child_process";

export interface SpawnOptions {
  /** Environment variables. Default: process.env */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * Prompt text to write to stdin after spawn.
   * When undefined, stdin is opened as "ignore" (no pipe created).
   */
  stdinData?: string;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn a child process, collect output, and enforce a timeout.
 *
 * @param command  - Executable path or name.
 * @param args     - Argument list.
 * @param options  - env, cwd, stdinData (optional).
 * @param timeoutMs - Kill the process with SIGTERM after this many ms.
 * @returns SpawnResult with stdout, stderr, exitCode, and timedOut flag.
 */
export function spawnWithTimeout(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const useStdin = options.stdinData !== undefined;

    const child = spawn(command, args, {
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Double-resolve guard: Node.js can emit both `error` and `close` on
    // spawn failure (e.g. ENOENT). Only the first settle call takes effect.
    let settled = false;
    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    if (useStdin) {
      // Suppress EPIPE: the spawned process may exit and close its stdin pipe
      // before we finish writing (race condition in tests).
      child.stdin!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") throw err;
        // EPIPE = process already closed stdin; safe to ignore
      });
      child.stdin!.write(options.stdinData!, "utf8");
      child.stdin!.end();
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      settle({
        stdout,
        stderr: err.message,
        exitCode: null,
        timedOut: false,
      });
    });

    child.on("close", (code: number | null) => {
      settle({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}
