import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";
import { directImportNeighbors } from "../indexes/call-graph.js";

export class CallgraphRetriever implements Retriever {
  readonly name = "callgraph";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    if (req.intent !== "refactor" && req.intent !== "bugfix" && req.intent !== "explain") return [];
    const seedFiles = indexes.files
      .filter((file) => req.likelyPaths.some((hint) => file.path.endsWith(hint) || hint.endsWith(file.path)))
      .map((file) => file.path)
      .slice(0, 5);
    const neighbors = [...new Set(seedFiles.flatMap((file) => directImportNeighbors(file, indexes)))].slice(0, req.budget.maxCandidatesPerRetriever);
    return neighbors.flatMap((file, index) => {
      const matched = indexes.files.find((candidate) => candidate.path === file || candidate.path.endsWith(file));
      if (!matched) return [];
      const candidate = makeCandidate({
        req,
        indexes,
        file: matched.path,
        retriever: this.name,
        rank: index + 1,
        preview: matched.path,
        signals: { callgraphProximity: 0.7 },
        reasons: ["direct import/reference neighbor"],
      });
      return candidate ? [candidate] : [];
    });
  }
}
