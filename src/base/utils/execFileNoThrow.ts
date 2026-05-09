// ─── execFileNoThrow ───
//
// Thin wrapper around Node's execFile that never throws.
// Returns { stdout, stderr, exitCode } on success/failure,
// and { stdout: "", stderr: <message>, exitCode: null } on spawn errors.

import { execFile, spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ExecFileOptions {
  /** Timeout in milliseconds. Default: 10000 */
  timeoutMs?: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment variables. Default: process.env */
  env?: NodeJS.ProcessEnv;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  /** Start a process group and terminate it on abort where the platform supports it. */
  killProcessGroup?: boolean;
}

/**
 * Run a command with execFile and return its result without throwing.
 * On any error (spawn failure, timeout, non-zero exit), the error is
 * captured in the returned object rather than thrown.
 */
export async function execFileNoThrow(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<ExecFileResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env, signal, killProcessGroup = false } = options;
  const timeoutError = validateTimeoutMs(timeoutMs);
  if (timeoutError) {
    return { stdout: "", stderr: timeoutError, exitCode: null };
  }

  if (killProcessGroup) {
    return spawnNoThrow(cmd, args, { timeoutMs, cwd, env, signal });
  }

  return new Promise<ExecFileResult>((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        cwd,
        env,
        signal,
        maxBuffer: 1024 * 1024, // 1 MB
      },
      (error, stdout, stderr) => {
        if (error) {
          // error.code is the exit code for non-zero exits; null for spawn errors
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? (error as NodeJS.ErrnoException & { code?: number }).code!
              : null;
          resolve({ stdout: stdout ?? "", stderr: stderr ?? error.message, exitCode });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

function validateTimeoutMs(timeoutMs: unknown): string | null {
  if (
    typeof timeoutMs === "number" &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return `Invalid timeoutMs: expected a safe integer from 1 to ${MAX_TIMEOUT_MS} milliseconds`;
}

function spawnNoThrow(
  cmd: string,
  args: string[],
  options: Required<Pick<ExecFileOptions, "timeoutMs">> & Pick<ExecFileOptions, "cwd" | "env" | "signal">
): Promise<ExecFileResult> {
  const detached = process.platform !== "win32";

  return new Promise<ExecFileResult>((resolve) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(
      cmd,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const groupTimeoutTimer = setTimeout(abortChild, options.timeoutMs);
    groupTimeoutTimer.unref?.();
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abortChild);
      clearTimeout(groupTimeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const finish = (result: ExecFileResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(0, 1024 * 1024);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(0, 1024 * 1024);
    });
    child.on("error", (error) => {
      finish({ stdout, stderr: stderr || error.message, exitCode: null });
    });
    child.on("close", (code, signalName) => {
      finish({
        stdout,
        stderr: stderr || (signalName ? `Process terminated by ${signalName}` : ""),
        exitCode: code,
      });
    });

    const killChild = (killSignal: NodeJS.Signals): void => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, killSignal);
          return;
        } catch {
          // Fall back to the immediate child below.
        }
      }
      child.kill(killSignal);
    };

    function abortChild(): void {
      killChild("SIGTERM");
      forceKillTimer = setTimeout(() => killChild("SIGKILL"), 1_000);
      forceKillTimer.unref?.();
    }

    if (options.signal?.aborted) {
      abortChild();
    } else {
      options.signal?.addEventListener("abort", abortChild, { once: true });
    }
  });
}
