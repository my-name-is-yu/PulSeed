import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../base/utils/json-io.js";

export interface GoalLeaseRecord {
  goal_id: string;
  owner_token: string;
  attempt_id: string;
  worker_id: string;
  lease_until: number;
  acquired_at: number;
  last_renewed_at: number;
}

export interface GoalLeaseAcquireOptions {
  workerId: string;
  ownerToken?: string;
  attemptId?: string;
  leaseMs?: number;
  now?: number;
}

export interface GoalLeaseRenewOptions {
  leaseMs?: number;
  now?: number;
}

const DEFAULT_LEASE_MS = 30_000;
const MUTEX_RETRY_DELAY_MS = 10;
const MUTEX_MAX_ATTEMPTS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function writeMutexPid(mutexDir: string): Promise<void> {
  await fsp.writeFile(path.join(mutexDir, "pid"), String(process.pid), "utf-8");
}

async function clearStaleMutex(mutexDir: string): Promise<boolean> {
  try {
    const pidText = await fsp.readFile(path.join(mutexDir, "pid"), "utf-8");
    const pid = Number.parseInt(pidText.trim(), 10);
    if (!Number.isFinite(pid) || !(await isProcessAlive(pid))) {
      await fsp.rm(mutexDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    await fsp.rm(mutexDir, { recursive: true, force: true });
    return true;
  }

  return false;
}

async function acquireMutex(mutexDir: string): Promise<void> {
  await ensureDir(path.dirname(mutexDir));

  for (let attempt = 0; attempt < MUTEX_MAX_ATTEMPTS; attempt++) {
    try {
      await fsp.mkdir(mutexDir);
      await writeMutexPid(mutexDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }

      if (!(await clearStaleMutex(mutexDir))) {
        await sleep(MUTEX_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Timed out waiting for mutex: ${mutexDir}`);
}

async function releaseMutex(mutexDir: string): Promise<void> {
  await fsp.rm(mutexDir, { recursive: true, force: true });
}

async function withMutex<T>(mutexDir: string, fn: () => Promise<T>): Promise<T> {
  await acquireMutex(mutexDir);
  try {
    return await fn();
  } finally {
    await releaseMutex(mutexDir);
  }
}

function safeGoalId(goalId: string): string {
  return encodeURIComponent(goalId);
}

function isGoalLeaseRecord(value: unknown): value is GoalLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GoalLeaseRecord>;
  return (
    typeof record.goal_id === "string" &&
    typeof record.owner_token === "string" &&
    typeof record.attempt_id === "string" &&
    typeof record.worker_id === "string" &&
    typeof record.lease_until === "number" &&
    typeof record.acquired_at === "number" &&
    typeof record.last_renewed_at === "number"
  );
}

export class GoalLeaseManager {
  private readonly leasesDir: string;
  private readonly defaultLeaseMs: number;

  constructor(runtimeRoot: string, defaultLeaseMs = DEFAULT_LEASE_MS) {
    runtimeRoot = path.resolve(runtimeRoot);
    this.leasesDir = path.join(runtimeRoot, "leases", "goal");
    this.defaultLeaseMs = defaultLeaseMs;
  }

  private recordPath(goalId: string): string {
    return path.join(this.leasesDir, `${safeGoalId(goalId)}.json`);
  }

  private mutexPath(goalId: string): string {
    return `${this.recordPath(goalId)}.lock`;
  }

  private buildRecord(goalId: string, opts: GoalLeaseAcquireOptions, now: number): GoalLeaseRecord {
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    return {
      goal_id: goalId,
      owner_token: opts.ownerToken ?? randomUUID(),
      attempt_id: opts.attemptId ?? randomUUID(),
      worker_id: opts.workerId,
      lease_until: now + leaseMs,
      acquired_at: now,
      last_renewed_at: now,
    };
  }

  private async readRaw(goalId: string): Promise<GoalLeaseRecord | null> {
    const raw = await readJsonFileOrNull<unknown>(this.recordPath(goalId));
    return isGoalLeaseRecord(raw) ? raw : null;
  }

  async acquire(goalId: string, opts: GoalLeaseAcquireOptions): Promise<GoalLeaseRecord | null> {
    const now = opts.now ?? Date.now();

    return withMutex(this.mutexPath(goalId), async () => {
      const current = await this.readRaw(goalId);
      if (current && current.lease_until > now) {
        return null;
      }

      const record = this.buildRecord(goalId, opts, now);
      await writeJsonFileAtomic(this.recordPath(goalId), record);
      return record;
    });
  }

  async renew(
    goalId: string,
    ownerToken: string,
    opts: GoalLeaseRenewOptions = {}
  ): Promise<GoalLeaseRecord | null> {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;

    return withMutex(this.mutexPath(goalId), async () => {
      const current = await this.readRaw(goalId);
      if (!current || current.owner_token !== ownerToken || current.lease_until <= now) {
        return null;
      }

      const renewed: GoalLeaseRecord = {
        ...current,
        lease_until: now + leaseMs,
        last_renewed_at: now,
      };
      await writeJsonFileAtomic(this.recordPath(goalId), renewed);
      return renewed;
    });
  }

  async release(goalId: string, ownerToken: string): Promise<boolean> {
    return withMutex(this.mutexPath(goalId), async () => {
      const current = await this.readRaw(goalId);
      if (!current || current.owner_token !== ownerToken) {
        return false;
      }

      await fsp.rm(this.recordPath(goalId), { force: true });
      return true;
    });
  }

  async read(goalId: string): Promise<GoalLeaseRecord | null> {
    return this.readRaw(goalId);
  }

  async reapStale(now = Date.now()): Promise<GoalLeaseRecord[]> {
    await ensureDir(this.leasesDir);
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.leasesDir);
    } catch {
      return [];
    }

    const removed: GoalLeaseRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      let goalId: string;
      try {
        goalId = decodeURIComponent(entry.slice(0, -5));
      } catch {
        continue;
      }
      await withMutex(this.mutexPath(goalId), async () => {
        const current = await this.readRaw(goalId);
        if (!current || current.lease_until > now) {
          return;
        }

        removed.push(current);
        await fsp.rm(this.recordPath(goalId), { force: true });
      });
    }

    return removed;
  }
}
