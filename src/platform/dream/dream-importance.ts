import { randomUUID } from "node:crypto";
import { StrategyDreamStateStore } from "../../runtime/store/strategy-dream-state-store.js";
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
  private readonly stateStore: StrategyDreamStateStore;

  constructor(
    baseDir: string,
    config: Partial<DreamLogCollectionConfig> = {},
    private readonly collector?: DreamLogCollector
  ) {
    this.config = { ...DEFAULT_DREAM_CONFIG.logCollection, ...config };
    this.stateStore = new StrategyDreamStateStore(baseDir);
  }

  async append(entry: Omit<ImportanceEntry, "id" | "processed"> & { id?: string; processed?: boolean }): Promise<ImportanceEntry | null> {
    if (!this.config.enabled) return null;
    if (entry.importance < this.config.importanceThreshold) return null;
    const parsed = ImportanceEntrySchema.parse({
      ...entry,
      id: entry.id ?? randomUUID(),
      processed: entry.processed ?? false,
    });
    await this.stateStore.appendImportanceEntry(parsed);
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
    return this.stateStore.listImportanceEntries();
  }

  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const all = await this.readAll();
    const idSet = new Set(ids);
    const updated = all.map((entry) => (idSet.has(entry.id) ? { ...entry, processed: true } : entry));
    await this.stateStore.markImportanceEntriesProcessed(ids);
    if (this.collector && updated.length > 0) {
      await this.collector.updateImportanceWatermark(
        updated.filter((entry) => entry.processed).length,
        updated[updated.length - 1]?.timestamp
      );
    }
  }
}
