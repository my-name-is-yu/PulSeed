import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { MockEmbeddingClient } from "../embedding-client.js";
import type { IEmbeddingClient } from "../embedding-client.js";
import { VectorIndex } from "../vector-index.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

describe("VectorIndex", () => {
  let tmpDir: string;
  let indexPath: string;
  let client: MockEmbeddingClient;

  beforeEach(() => {
    tmpDir = makeTempDir();
    indexPath = path.join(tmpDir, "index.json");
    client = new MockEmbeddingClient(32);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  it("add() creates entry and increases size", async () => {
    const idx = new VectorIndex(indexPath, client);
    expect(idx.size).toBe(0);

    const entry = await idx.add("id1", "hello world");
    expect(idx.size).toBe(1);
    expect(entry.id).toBe("id1");
    expect(entry.text).toBe("hello world");
    expect(entry.vector).toHaveLength(32);
  });

  it("add() persists to the typed control DB without writing the legacy JSON file", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "persist me", { tag: "test" });

    expect(fs.existsSync(indexPath)).toBe(false);
    const loaded = await VectorIndex.create(indexPath, client);
    expect(loaded.getEntry("id1")?.text).toBe("persist me");
  });

  it("search() returns results sorted by similarity descending", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("a", "apple fruit");
    await idx.add("b", "banana fruit");
    await idx.add("c", "car vehicle");

    const results = await idx.search("apple fruit");
    expect(results.length).toBeGreaterThan(0);
    // First result should be most similar (the exact match)
    expect(results[0].id).toBe("a");
    // Results must be sorted descending by similarity
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it("search() respects topK parameter", async () => {
    const idx = new VectorIndex(indexPath, client);
    for (let i = 0; i < 10; i++) {
      await idx.add(`id${i}`, `entry number ${i}`);
    }
    const results = await idx.search("entry number", 3);
    expect(results).toHaveLength(3);
  });

  it("search() respects threshold parameter", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("a", "completely different text alpha");
    await idx.add("b", "another unrelated topic beta");

    // Use a high threshold to filter out low-similarity results
    const results = await idx.search("completely different text alpha", 10, 0.99);
    // Only exact (or near-exact) matches should pass 0.99 threshold
    expect(results.every((r) => r.similarity >= 0.99)).toBe(true);
  });

  it("search() on empty index returns empty array", async () => {
    const idx = new VectorIndex(indexPath, client);
    const results = await idx.search("anything");
    expect(results).toEqual([]);
  });

  it("searchByVector() works synchronously", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "test entry");

    const queryVec = await client.embed("test entry");
    const results = idx.searchByVector(queryVec, 5, 0.0);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("id1");
    expect(results[0].similarity).toBeCloseTo(1.0);
  });

  it("remove() removes entry and decreases size", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "to remove");
    await idx.add("id2", "to keep");
    expect(idx.size).toBe(2);

    const removed = await idx.remove("id1");
    expect(removed).toBe(true);
    expect(idx.size).toBe(1);
    expect(idx.getEntry("id1")).toBeUndefined();
    expect(idx.getEntry("id2")).toBeDefined();
  });

  it("remove() returns false for non-existent id", async () => {
    const idx = new VectorIndex(indexPath, client);
    expect(await idx.remove("nonexistent")).toBe(false);
  });

  it("remove() persists after removal in the typed control DB", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "entry one");
    await idx.add("id2", "entry two");
    await idx.remove("id1");

    const loaded = await VectorIndex.create(indexPath, client);
    expect(loaded.size).toBe(1);
    expect(loaded.getEntry("id1")).toBeUndefined();
    expect(loaded.getEntry("id2")).toBeDefined();
  });

  it("getEntry() returns entry by id", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("myid", "my text", { foo: "bar" });

    const entry = idx.getEntry("myid");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("myid");
    expect(entry!.text).toBe("my text");
    expect(entry!.metadata).toEqual({ foo: "bar" });
  });

  it("getEntry() returns undefined for missing id", () => {
    const idx = new VectorIndex(indexPath, client);
    expect(idx.getEntry("missing")).toBeUndefined();
  });

  it("clear() removes all entries", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "one");
    await idx.add("id2", "two");
    expect(idx.size).toBe(2);

    await idx.clear();
    expect(idx.size).toBe(0);
  });

  it("clear() persists empty state to the typed control DB", async () => {
    const idx = new VectorIndex(indexPath, client);
    await idx.add("id1", "one");
    await idx.clear();

    const loaded = await VectorIndex.create(indexPath, client);
    expect(loaded.size).toBe(0);
  });

  it("persistence: new instance reads existing data from the typed control DB", async () => {
    const idx1 = new VectorIndex(indexPath, client);
    await idx1.add("p1", "persist across instances");

    const idx2 = await VectorIndex.create(indexPath, client);
    expect(idx2.size).toBe(1);
    const entry = idx2.getEntry("p1");
    expect(entry).toBeDefined();
    expect(entry!.text).toBe("persist across instances");
  });

  it("rejects non-finite embedding vectors before persistence", async () => {
    const badClient: IEmbeddingClient = {
      embed: async () => [Number.POSITIVE_INFINITY],
      batchEmbed: async () => [[Number.POSITIVE_INFINITY]],
      cosineSimilarity: () => Number.POSITIVE_INFINITY,
    };
    const idx = new VectorIndex(indexPath, badClient);

    await expect(idx.add("bad", "non-finite vector")).rejects.toThrow();

    expect(idx.size).toBe(0);
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it("does not use corrupt legacy JSON as runtime fallback", async () => {
    fs.writeFileSync(
      indexPath,
      `[{"id":"bad","text":"bad","vector":[1e999],"model":"embedding","created_at":"2026-05-09T00:00:00.000Z"}]`,
      "utf-8"
    );

    const idx = await VectorIndex.create(indexPath, client);

    expect(idx.size).toBe(0);
    expect(idx.getEntry("bad")).toBeUndefined();
  });

  it("ignores valid legacy JSON during normal runtime load", async () => {
    fs.writeFileSync(
      indexPath,
      `[
        {"id":"bad","text":"bad","vector":[1e999],"model":"embedding","created_at":"2026-05-09T00:00:00.000Z"},
        {"id":"good","text":"good","vector":[1,0],"model":"embedding","created_at":"2026-05-09T00:00:00.000Z"}
      ]`,
      "utf-8"
    );

    const idx = await VectorIndex.create(indexPath, client);

    expect(idx.size).toBe(0);
    expect(idx.getEntry("bad")).toBeUndefined();
    expect(idx.getEntry("good")).toBeUndefined();
  });

  it("does not create legacy parent directories for normal runtime writes", async () => {
    const nestedPath = path.join(tmpDir, "a", "b", "c", "index.json");
    const idx = new VectorIndex(nestedPath, client);
    await idx.add("id1", "nested dir test");

    expect(fs.existsSync(nestedPath)).toBe(false);
  });

  it("createForControlDb loads entries from the production base directory store", async () => {
    const idx = await VectorIndex.createForControlDb(tmpDir, client);
    await idx.add("id1", "control db entry");

    const loaded = await VectorIndex.createForControlDb(tmpDir, client);
    expect(loaded.getEntry("id1")?.text).toBe("control db entry");
  });
});
