import { describe, expect, it } from "vitest";
import { KnowledgeGraph } from "../../../platform/knowledge/knowledge-graph.js";
import {
  expandKnowledgeEntriesWithGraph,
  mergeWorkingMemorySelections,
} from "../context/context-builder.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

describe("context-builder phase 4 helpers", () => {
  it("merges tag and semantic working memory selections without duplicates", () => {
    const tagSelected = [{ id: "a" }, { id: "b" }];
    const semanticSelected = [{ id: "b" }, { id: "c" }];

    expect(mergeWorkingMemorySelections(tagSelected, semanticSelected, 3)).toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
  });

  it("expands supports/refines edges and surfaces contradiction warnings", async () => {
    const tmpDir = makeTempDir();
    const graph = new KnowledgeGraph(`${tmpDir}/graph.json`);
    await graph.addNode("k1", "goal-1", ["auth"]);
    await graph.addNode("k2", "goal-1", ["auth"]);
    await graph.addNode("k3", "goal-1", ["auth"]);
    await graph.addEdge({ from_id: "k1", to_id: "k2", relation: "supports", confidence: 0.9 });
    await graph.addEdge({ from_id: "k1", to_id: "k3", relation: "contradicts", confidence: 0.8 });

    const allEntries = [
      {
        entry_id: "k1",
        question: "Primary auth approach?",
        answer: "JWT",
        sources: [],
        confidence: 0.9,
        acquired_at: new Date().toISOString(),
        acquisition_task_id: "t1",
        superseded_by: null,
        tags: ["auth"],
        embedding_id: null,
      },
      {
        entry_id: "k2",
        question: "Supporting detail?",
        answer: "Refresh tokens",
        sources: [],
        confidence: 0.8,
        acquired_at: new Date().toISOString(),
        acquisition_task_id: "t2",
        superseded_by: null,
        tags: ["auth"],
        embedding_id: null,
      },
      {
        entry_id: "k3",
        question: "Contradicting detail?",
        answer: "Use opaque sessions",
        sources: [],
        confidence: 0.7,
        acquired_at: new Date().toISOString(),
        acquisition_task_id: "t3",
        superseded_by: null,
        tags: ["auth"],
        embedding_id: null,
      },
    ];

    const result = expandKnowledgeEntriesWithGraph([allEntries[0]!], allEntries, graph);
    expect(result.relatedEntries.map((entry) => entry.entry_id)).toEqual(["k2"]);
    expect(result.contradictionWarnings[0]).toContain("contradicts");
  });
});
