import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { RuntimeJournal } from "./runtime-journal.js";
import {
  ApprovalRecordSchema,
  ApprovalStateSchema,
  type ApprovalRecord,
  type ApprovalState,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";

export interface ApprovalResolutionInput {
  state: Exclude<ApprovalState, "pending">;
  resolved_at?: number;
  response_channel?: string;
  payload?: unknown;
}

export class ApprovalStore {
  private readonly paths: RuntimeStorePaths;
  private readonly journal: RuntimeJournal;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.journal = new RuntimeJournal(this.paths);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private lockPath(approvalId: string): string {
    return path.join(this.paths.approvalsDir, "locks", `${approvalId}.lock`);
  }

  private async withApprovalLock<T>(approvalId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(approvalId);
    const staleAfterMs = 30_000;

    for (;;) {
      try {
        await fsp.mkdir(path.dirname(lockPath), { recursive: true });
        const handle = await fsp.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: Date.now() }));
        try {
          return await fn();
        } finally {
          await handle.close();
          await fsp.unlink(lockPath).catch(() => undefined);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        try {
          const stat = await fsp.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleAfterMs) {
            await fsp.unlink(lockPath);
            continue;
          }
        } catch (staleErr) {
          if ((staleErr as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw staleErr;
        }

        await this.sleep(10);
      }
    }
  }

  async ensureReady(): Promise<void> {
    await this.journal.ensureReady();
  }

  async load(approvalId: string): Promise<ApprovalRecord | null> {
    return (await this.loadResolved(approvalId)) ?? (await this.loadPending(approvalId));
  }

  async loadPending(approvalId: string): Promise<ApprovalRecord | null> {
    return this.journal.load(this.paths.approvalPendingPath(approvalId), ApprovalRecordSchema);
  }

  async loadResolved(approvalId: string): Promise<ApprovalRecord | null> {
    return this.journal.load(this.paths.approvalResolvedPath(approvalId), ApprovalRecordSchema);
  }

  async listPending(): Promise<ApprovalRecord[]> {
    const pending = await this.journal.list(this.paths.approvalsPendingDir, ApprovalRecordSchema);
    const filtered: ApprovalRecord[] = [];
    for (const record of pending) {
      const resolved = await this.loadResolved(record.approval_id);
      if (resolved === null) filtered.push(record);
    }
    return filtered;
  }

  async listResolved(): Promise<ApprovalRecord[]> {
    return this.journal.list(this.paths.approvalsResolvedDir, ApprovalRecordSchema);
  }

  async removePending(approvalId: string): Promise<void> {
    await this.journal.remove(this.paths.approvalPendingPath(approvalId));
  }

  async removeResolved(approvalId: string): Promise<void> {
    await this.journal.remove(this.paths.approvalResolvedPath(approvalId));
  }

  async savePending(record: ApprovalRecord): Promise<ApprovalRecord> {
    const parsed = ApprovalRecordSchema.parse({ ...record, state: "pending" });
    return this.withApprovalLock(parsed.approval_id, async () => {
      const resolved = await this.loadResolved(parsed.approval_id);
      if (resolved !== null) return resolved;
      await this.journal.save(this.paths.approvalPendingPath(parsed.approval_id), ApprovalRecordSchema, parsed);
      return parsed;
    });
  }

  async saveResolved(record: ApprovalRecord): Promise<ApprovalRecord> {
    const parsed = ApprovalRecordSchema.parse({
      ...record,
      state: ApprovalStateSchema.parse(record.state),
      resolved_at: record.resolved_at ?? Date.now(),
    });
    await this.journal.save(this.paths.approvalResolvedPath(parsed.approval_id), ApprovalRecordSchema, parsed);
    return parsed;
  }

  async resolvePending(approvalId: string, update: ApprovalResolutionInput): Promise<ApprovalRecord | null> {
    return this.withApprovalLock(approvalId, async () => {
      const current = await this.loadPending(approvalId);
      if (current === null) return this.loadResolved(approvalId);

      const resolved = ApprovalRecordSchema.parse({
        ...current,
        ...update,
        approval_id: current.approval_id,
        state: ApprovalStateSchema.parse(update.state),
        resolved_at: update.resolved_at ?? Date.now(),
      });
      await this.saveResolved(resolved);
      await this.removePending(approvalId);
      return resolved;
    });
  }

  async reconcile(now = Date.now()): Promise<{
    removedPending: number;
    expiredPending: number;
  }> {
    const pending = await this.journal.list(this.paths.approvalsPendingDir, ApprovalRecordSchema);
    let removedPending = 0;
    let expiredPending = 0;

    for (const record of pending) {
      const resolved = await this.loadResolved(record.approval_id);
      if (resolved !== null) {
        await this.removePending(record.approval_id);
        removedPending += 1;
        continue;
      }

      if (record.expires_at > now) {
        continue;
      }

      await this.resolvePending(record.approval_id, {
        state: "expired",
        resolved_at: now,
        response_channel: record.response_channel,
        payload: record.payload,
      });
      expiredPending += 1;
    }

    return { removedPending, expiredPending };
  }

  async pruneResolved(olderThanMs: number, now = Date.now()): Promise<number> {
    const threshold = now - olderThanMs;
    const resolved = await this.listResolved();
    let pruned = 0;

    for (const record of resolved) {
      const resolvedAt = record.resolved_at ?? record.created_at;
      if (resolvedAt >= threshold) {
        continue;
      }

      await this.removeResolved(record.approval_id);
      pruned += 1;
    }

    return pruned;
  }
}
