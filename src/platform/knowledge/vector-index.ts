import * as path from "node:path";
import type { IEmbeddingClient } from "./embedding-client.js";
import type { EmbeddingEntry, VectorSearchResult } from "../../base/types/embedding.js";
import { EmbeddingEntrySchema } from "../../base/types/embedding.js";
import { cosineSimilarity } from "./embedding-client.js";
import type { RuntimeControlDbStoreOptions } from "../../runtime/store/control-db/index.js";
import { VectorIndexStateStore } from "./vector-index-state-store.js";

export interface VectorIndexOptions extends RuntimeControlDbStoreOptions {}

export class VectorIndex {
  private readonly entries: Map<string, EmbeddingEntry> = new Map();
  private readonly stateStore: VectorIndexStateStore;

  constructor(
    legacyFilePath: string,
    private readonly embeddingClient: IEmbeddingClient,
    options: VectorIndexOptions = {},
  ) {
    const baseDir = options.controlBaseDir ?? path.dirname(legacyFilePath);
    this.stateStore = new VectorIndexStateStore(baseDir, options);
  }

  /**
   * Factory method: constructs a VectorIndex and loads existing data from the typed store.
   * The path argument is retained for compatibility; normal runtime does not read or write it.
   */
  static async create(
    legacyFilePath: string,
    embeddingClient: IEmbeddingClient,
    options: VectorIndexOptions = {},
  ): Promise<VectorIndex> {
    const index = new VectorIndex(legacyFilePath, embeddingClient, options);
    await index._load();
    return index;
  }

  static async createForControlDb(
    baseDir: string,
    embeddingClient: IEmbeddingClient,
    options: VectorIndexOptions = {},
  ): Promise<VectorIndex> {
    const index = new VectorIndex(path.join(baseDir, "control.sqlite"), embeddingClient, {
      ...options,
      controlBaseDir: options.controlBaseDir ?? baseDir,
    });
    await index._load();
    return index;
  }

  /**
   * Embed text and add an entry to the index.
   */
  async add(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {}
  ): Promise<EmbeddingEntry> {
    const vector = await this.embeddingClient.embed(text);
    const entry: EmbeddingEntry = EmbeddingEntrySchema.parse({
      id,
      text,
      vector,
      model: "embedding",
      created_at: new Date().toISOString(),
      metadata,
    });
    this.entries.set(id, entry);
    await this.stateStore.save(entry);
    return entry;
  }

  /**
   * Embed a query string and search for the most similar entries.
   */
  async search(
    query: string,
    topK: number = 5,
    threshold: number = 0.0
  ): Promise<VectorSearchResult[]> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchByVector(queryVector, topK, threshold);
  }

  /**
   * Search using a pre-computed vector.
   */
  searchByVector(
    queryVector: number[],
    topK: number = 5,
    threshold: number = 0.0
  ): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      const similarity = cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        results.push({
          id: entry.id,
          text: entry.text,
          similarity,
          metadata: entry.metadata,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Remove an entry by id. Returns true if removed, false if not found.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this.entries.has(id);
    if (existed) {
      this.entries.delete(id);
      await this.stateStore.remove(id);
    }
    return existed;
  }

  /**
   * Return the number of entries in the index.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Retrieve a single entry by id.
   */
  getEntry(id: string): EmbeddingEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Alias for getEntry — returns a single entry by id.
   */
  getEntryById(id: string): EmbeddingEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Embed a query string and return id + similarity + metadata only (no text).
   * Useful for Progressive Disclosure: fetch metadata first, then load full text
   * only for selected candidates.
   */
  async searchMetadata(
    query: string,
    topK: number = 20,
    threshold: number = 0.0
  ): Promise<Array<{ id: string; similarity: number; metadata: Record<string, unknown> }>> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchMetadataByVector(queryVector, topK, threshold);
  }

  /**
   * Search using a pre-computed vector; returns id + similarity + metadata only.
   */
  searchMetadataByVector(
    queryVector: number[],
    topK: number = 20,
    threshold: number = 0.0
  ): Array<{ id: string; similarity: number; metadata: Record<string, unknown> }> {
    const results: Array<{ id: string; similarity: number; metadata: Record<string, unknown> }> = [];
    for (const entry of this.entries.values()) {
      const similarity = cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        results.push({ id: entry.id, similarity, metadata: entry.metadata ?? {} });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Remove all entries from the index and persist.
   */
  async clear(): Promise<void> {
    this.entries.clear();
    await this.stateStore.clear();
  }

  async close(): Promise<void> {
    await this.stateStore.close();
  }

  async _load(): Promise<void> {
    this.entries.clear();
    try {
      for (const entry of await this.stateStore.list()) {
        this.entries.set(entry.id, entry);
      }
    } catch {
      // Corrupt typed rows or unavailable store: keep semantic search disabled for this instance.
    }
  }
}
