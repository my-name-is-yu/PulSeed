import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../../base/state/state-persistence.js";
import { DEFAULT_DREAM_CONFIG } from "./dream-config.js";
import {
  ImportanceEntrySchema,
  type DreamLogCollectionConfig,
  type ImportanceEntry,
  type ImportanceSource,
} from "./dream-types.js";
import type { DreamLogCollector } from "./dream-log-collector.js";

export class ImportanceBuffer {
  private readonly config: DreamLogCollectionConfig;

  constructor(
    private readonly baseDir: string,
    config: Partial<DreamLogCollectionConfig> = {},
    private readonly collector?: DreamLogCollector
  ) {
    this.config = { ...DEFAULT_DREAM_CONFIG.logCollection, ...config };
  }

  async append(entry: Omit<ImportanceEntry, "id" | "processed"> & { id?: string; processed?: boolean }): Promise<ImportanceEntry | null> {
    if (!this.config.enabled) return null;
    if (entry.importance < this.config.importanceThreshold) return null;
    const parsed = ImportanceEntrySchema.parse({
      ...entry,
      id: entry.id ?? randomUUID(),
      processed: entry.processed ?? false,
    });
    const filePath = this.bufferPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(parsed) + "\n", "utf-8");
    return parsed;
  }

  async tag(params: {
    goalId: string;
    source: ImportanceSource;
    importance: number;
    reason: string;
    data_ref: string;
    tags?: string[];
  }): Promise<ImportanceEntry | null> {
    return this.append({
      timestamp: new Date().toISOString(),
      goalId: params.goalId,
      source: params.source,
      importance: params.importance,
      reason: params.reason,
      data_ref: params.data_ref,
      tags: params.tags ?? [],
    });
  }

  async readAll(): Promise<ImportanceEntry[]> {
    try {
      const raw = await fs.readFile(this.bufferPath(), "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => ImportanceEntrySchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const all = await this.readAll();
    const idSet = new Set(ids);
    const updated = all.map((entry) => (idSet.has(entry.id) ? { ...entry, processed: true } : entry));
    const filePath = this.bufferPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWrite(filePath, updated.map((entry) => JSON.stringify(entry)).join("\n") + (updated.length > 0 ? "\n" : ""));
    if (this.collector && updated.length > 0) {
      await this.collector.updateImportanceWatermark(
        updated.filter((entry) => entry.processed).length,
        updated[updated.length - 1]?.timestamp
      );
    }
  }

  private bufferPath(): string {
    return path.join(this.baseDir, "dream", "importance-buffer.jsonl");
  }
}
