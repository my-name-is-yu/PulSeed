import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RuntimeJournal } from "./runtime-journal.js";
import { OutboxRecordSchema, type OutboxRecord } from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";

interface AppendLock {
  release(): Promise<void>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class OutboxStore {
  private readonly paths: RuntimeStorePaths;
  private readonly journal: RuntimeJournal;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.journal = new RuntimeJournal(this.paths);
  }

  async ensureReady(): Promise<void> {
    await this.journal.ensureReady();
  }

  async load(seq: number): Promise<OutboxRecord | null> {
    return this.journal.load(this.paths.outboxRecordPath(seq), OutboxRecordSchema);
  }

  async loadLatest(): Promise<OutboxRecord | null> {
    const records = await this.list();
    return records.at(-1) ?? null;
  }

  async list(afterSeq = 0): Promise<OutboxRecord[]> {
    const records = await this.journal.list(this.paths.outboxDir, OutboxRecordSchema);
    if (afterSeq <= 0) return records;
    return records.filter((record) => record.seq > afterSeq);
  }

  async nextSeq(): Promise<number> {
    const latest = await this.loadLatest();
    return latest === null ? 1 : latest.seq + 1;
  }

  async save(record: OutboxRecord): Promise<OutboxRecord> {
    const parsed = OutboxRecordSchema.parse(record);
    await this.journal.save(this.paths.outboxRecordPath(parsed.seq), OutboxRecordSchema, parsed);
    return parsed;
  }

  async remove(seq: number): Promise<void> {
    await this.journal.remove(this.paths.outboxRecordPath(seq));
  }

  private async acquireAppendLock(): Promise<AppendLock> {
    const lockPath = path.join(this.paths.outboxDir, ".append.lock");
    const staleAfterMs = 30_000;

    for (;;) {
      try {
        await fs.mkdir(this.paths.outboxDir, { recursive: true });
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            acquired_at: Date.now(),
          })
        );
        return {
          release: async () => {
            await handle.close();
            await fs.unlink(lockPath).catch(() => undefined);
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleAfterMs) {
            await fs.unlink(lockPath);
            continue;
          }
        } catch (staleErr) {
          if ((staleErr as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw staleErr;
        }

        await sleep(10);
      }
    }
  }

  async append(record: Omit<OutboxRecord, "seq">): Promise<OutboxRecord> {
    const lock = await this.acquireAppendLock();
    try {
      const seq = await this.nextSeq();
      return await this.save({ ...record, seq });
    } finally {
      await lock.release();
    }
  }

  async prune(options: {
    olderThanMs?: number;
    maxRecords?: number;
    now?: number;
  } = {}): Promise<{ pruned: number; retained: number }> {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? 30 * 24 * 60 * 60 * 1000;
    const maxRecords = options.maxRecords ?? 5_000;
    const threshold = now - olderThanMs;
    const records = await this.list();
    const protectedSeq = records.length > maxRecords
      ? records[records.length - maxRecords]?.seq ?? null
      : null;

    let pruned = 0;
    for (const record of records) {
      const overAge = record.created_at < threshold;
      const overCount = protectedSeq !== null && record.seq < protectedSeq;
      if (!overAge && !overCount) {
        continue;
      }

      await this.remove(record.seq);
      pruned += 1;
    }

    return { pruned, retained: Math.max(records.length - pruned, 0) };
  }
}
