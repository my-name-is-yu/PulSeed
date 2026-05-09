import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseProcessPid, signalProcessPid } from "../utils/process-pid.js";

/**
 * Per-goal advisory locking using lockfiles.
 * Lock path: <baseDir>/locks/goals/<goalId>.lock/
 * Transition compatibility: also acquire <baseDir>/goals/<goalId>/.lock
 * when the legacy goal directory already exists.
 * Uses mkdir as atomic primitive (POSIX: EEXIST = lock held).
 */

export interface LockOptions {
  maxRetries?: number;     // default 5
  initialDelayMs?: number; // default 50
  maxTotalMs?: number;     // default 500
}

interface NormalizedLockOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxTotalMs: number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function lockPath(goalId: string, baseDir: string): string {
  return path.join(baseDir, "locks", "goals", `${goalId}.lock`);
}

function legacyLockPath(goalId: string, baseDir: string): string {
  return path.join(baseDir, "goals", goalId, ".lock");
}

function pidFilePath(lockDir: string): string {
  return path.join(lockDir, "pid");
}

async function pathExists(dir: string): Promise<boolean> {
  try {
    await fsp.access(dir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  return signalProcessPid(pid, 0).status === "sent";
}

function parseNonnegativeSafeInteger(
  opts: LockOptions | undefined,
  key: keyof LockOptions,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const value = opts?.[key];
  if (value === undefined) return fallback;

  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(
      `acquireLock: ${key} must be a nonnegative integer no greater than ${max}`
    );
  }

  return value;
}

function normalizeLockOptions(opts?: LockOptions): NormalizedLockOptions {
  return {
    maxRetries: parseNonnegativeSafeInteger(opts, "maxRetries", 5),
    initialDelayMs: parseNonnegativeSafeInteger(
      opts,
      "initialDelayMs",
      50,
      MAX_TIMER_DELAY_MS
    ),
    maxTotalMs: parseNonnegativeSafeInteger(opts, "maxTotalMs", 500, MAX_TIMER_DELAY_MS),
  };
}

async function tryAcquire(lockDir: string, checkStale = false): Promise<boolean> {
  try {
    await fsp.mkdir(lockDir, { recursive: false });
    await fsp.writeFile(pidFilePath(lockDir), String(process.pid), "utf-8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (checkStale) {
        await clearStaleLock(lockDir);
        // Retry once after clearing stale lock
        try {
          await fsp.mkdir(lockDir, { recursive: false });
          await fsp.writeFile(pidFilePath(lockDir), String(process.pid), "utf-8");
          return true;
        } catch (retryErr) {
          if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw retryErr;
        }
      }
      return false;
    }
    throw err;
  }
}

async function clearStaleLock(lockDir: string): Promise<void> {
  try {
    const pidStr = await fsp.readFile(pidFilePath(lockDir), "utf-8");
    const pid = parseProcessPid(pidStr);
    if (pid !== null && !(await isProcessAlive(pid))) {
      await fsp.rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // If we cannot read pid, leave the lock intact
  }
}

async function acquireLockDir(
  lockDir: string,
  label: string,
  opts: NormalizedLockOptions,
  createParent = true
): Promise<void> {
  const { maxRetries, initialDelayMs, maxTotalMs } = opts;

  if (createParent) {
    await fsp.mkdir(path.dirname(lockDir), { recursive: true });
  }

  const start = Date.now();
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (await tryAcquire(lockDir, true)) {
      return;
    }

    if (Date.now() - start >= maxTotalMs) {
      throw new Error(`acquireLock: timeout exceeded for "${label}" after ${maxTotalMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, maxTotalMs);
  }

  throw new Error(`acquireLock: max retries exceeded for "${label}"`);
}

async function releaseLockDir(lockDir: string): Promise<void> {
  try {
    await fsp.rm(lockDir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

async function shouldAcquireLegacyLock(goalId: string, baseDir: string): Promise<boolean> {
  return pathExists(path.join(baseDir, "goals", goalId));
}

/** Acquire an advisory lock for the given goalId. Throws if timeout exceeded. */
export async function acquireLock(
  goalId: string,
  baseDir: string,
  opts?: LockOptions
): Promise<void> {
  const normalizedOptions = normalizeLockOptions(opts);
  const legacyLockDir = legacyLockPath(goalId, baseDir);
  const needsLegacyLock = await shouldAcquireLegacyLock(goalId, baseDir);
  if (needsLegacyLock) {
    try {
      await acquireLockDir(legacyLockDir, `${goalId} legacy`, normalizedOptions, false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const stableLockDir = lockPath(goalId, baseDir);
  try {
    await acquireLockDir(stableLockDir, goalId, normalizedOptions);
  } catch (err) {
    if (needsLegacyLock) await releaseLockDir(legacyLockDir);
    throw err;
  }
}

/** Release the advisory lock for the given goalId. No-op if lock does not exist. */
export async function releaseLock(goalId: string, baseDir: string): Promise<void> {
  await releaseLockDir(lockPath(goalId, baseDir));
  await releaseLockDir(legacyLockPath(goalId, baseDir));
}
