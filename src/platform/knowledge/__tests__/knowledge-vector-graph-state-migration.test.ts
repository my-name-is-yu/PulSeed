import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { MockEmbeddingClient } from "../embedding-client.js";
import { VectorIndex } from "../vector-index.js";
import { KnowledgeGraph } from "../knowledge-graph.js";
import { importLegacyVectorIndexState } from "../vector-index-state-migration.js";
import { importLegacyKnowledgeGraphState } from "../knowledge-graph-state-migration.js";

describe("knowledge vector and graph legacy state imports", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  function makeBaseDir(): string {
    const dir = makeTempDir();
    tempDirs.push(dir);
    return dir;
  }

  it("imports legacy vector-index.json through repair boundary", async () => {
    const baseDir = makeBaseDir();
    const vectorDir = path.join(baseDir, "memory");
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.writeFileSync(
      path.join(vectorDir, "vector-index.json"),
      JSON.stringify([
        {
          id: "entry-1",
          text: "legacy vector text",
          vector: [1, 0],
          model: "embedding",
          created_at: "2026-05-09T00:00:00.000Z",
          metadata: { source: "legacy" },
        },
      ]),
      "utf-8",
    );

    const report = await importLegacyVectorIndexState(baseDir);
    expect(report.importedEntries).toBe(1);
    expect(report.blockedSources).toEqual([]);

    const index = await VectorIndex.createForControlDb(baseDir, new MockEmbeddingClient(2));
    expect(index.getEntry("entry-1")?.text).toBe("legacy vector text");
  });

  it("retires legacy vector entries when typed state already exists", async () => {
    const baseDir = makeBaseDir();
    const index = await VectorIndex.createForControlDb(baseDir, new MockEmbeddingClient(2));
    await index.add("entry-1", "typed vector text");
    const vectorDir = path.join(baseDir, "memory");
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.writeFileSync(
      path.join(vectorDir, "vector-index.json"),
      JSON.stringify([
        {
          id: "entry-1",
          text: "stale legacy vector text",
          vector: [0, 1],
          model: "embedding",
          created_at: "2026-05-09T00:00:00.000Z",
          metadata: {},
        },
      ]),
      "utf-8",
    );

    const report = await importLegacyVectorIndexState(baseDir);
    expect(report.retiredExistingTypedState).toBe(1);
    const loaded = await VectorIndex.createForControlDb(baseDir, new MockEmbeddingClient(2));
    expect(loaded.getEntry("entry-1")?.text).toBe("typed vector text");
  });

  it("imports legacy knowledge graph JSON through repair boundary", async () => {
    const baseDir = makeBaseDir();
    const graphDir = path.join(baseDir, "knowledge");
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(
      path.join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { entry_id: "entry-1", goal_id: "goal-a", tags: ["a"], added_at: "2026-05-09T00:00:00.000Z" },
          { entry_id: "entry-2", goal_id: "goal-a", tags: ["b"], added_at: "2026-05-09T00:00:01.000Z" },
        ],
        edges: [
          {
            from_id: "entry-1",
            to_id: "entry-2",
            relation: "supports",
            confidence: 0.8,
            created_at: "2026-05-09T00:00:02.000Z",
          },
        ],
      }),
      "utf-8",
    );

    const report = await importLegacyKnowledgeGraphState(baseDir);
    expect(report.importedNodes).toBe(2);
    expect(report.importedEdges).toBe(1);
    expect(report.blockedSources).toEqual([]);

    const graph = await KnowledgeGraph.createForControlDb(baseDir);
    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(graph.getRelated("entry-1")[0]?.node.entry_id).toBe("entry-2");
  });

  it("retires legacy knowledge graph JSON when typed graph state already exists", async () => {
    const baseDir = makeBaseDir();
    const graph = await KnowledgeGraph.createForControlDb(baseDir);
    await graph.addNode("typed-entry", "goal-a", []);
    const graphDir = path.join(baseDir, "knowledge");
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(
      path.join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [{ entry_id: "legacy-entry", goal_id: "goal-a", tags: [], added_at: "2026-05-09T00:00:00.000Z" }],
        edges: [],
      }),
      "utf-8",
    );

    const report = await importLegacyKnowledgeGraphState(baseDir);
    expect(report.retiredExistingTypedState).toBe(1);
    const loaded = await KnowledgeGraph.createForControlDb(baseDir);
    expect(loaded.getNode("typed-entry")).toBeDefined();
    expect(loaded.getNode("legacy-entry")).toBeUndefined();
  });

  it("blocks invalid legacy knowledge graph JSON during repair import", async () => {
    const baseDir = makeBaseDir();
    const graphDir = path.join(baseDir, "knowledge");
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(
      path.join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [{ entry_id: "", goal_id: "goal-a", tags: [], added_at: "2026-05-09T00:00:00.000Z" }],
        edges: [],
      }),
      "utf-8",
    );

    const report = await importLegacyKnowledgeGraphState(baseDir);
    expect(report.blockedSources).toHaveLength(1);
    const graph = await KnowledgeGraph.createForControlDb(baseDir);
    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
  });
});
