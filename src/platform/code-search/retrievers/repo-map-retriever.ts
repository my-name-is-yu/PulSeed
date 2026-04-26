import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";

export class RepoMapRetriever implements Retriever {
  readonly name = "repo_map";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const terms = req.queryTerms.map((term) => term.toLowerCase()).slice(0, 16);
    const candidates: CodeCandidate[] = [];
    for (const entry of indexes.repoMap.files) {
      if (candidates.length >= req.budget.maxCandidatesPerRetriever) break;
      const haystack = [entry.file, ...entry.imports, ...entry.exports].join(" ").toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      if (hits === 0 && req.intent !== "explain" && req.intent !== "feature_addition") continue;
      const candidate = makeCandidate({
        req,
        indexes,
        file: entry.file,
        retriever: this.name,
        rank: candidates.length + 1,
        preview: `imports: ${entry.imports.slice(0, 5).join(", ")} exports: ${entry.exports.slice(0, 5).join(", ")}`,
        signals: { repoMapCentrality: Math.min(1, (entry.imports.length + entry.exports.length) / 20), lexicalMatch: Math.min(1, hits / 4) },
        reasons: hits > 0 ? [`repo map matched ${hits} terms`] : ["repo map centrality for explanation/feature task"],
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
}
