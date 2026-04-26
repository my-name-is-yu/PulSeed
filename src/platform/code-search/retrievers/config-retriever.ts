import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";

export class ConfigRetriever implements Retriever {
  readonly name = "config";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    if (req.intent !== "config_fix" && req.intent !== "api_change" && !req.queryTerms.some((term) => /config|package|tsconfig|vitest|eslint/i.test(term))) {
      return [];
    }
    return indexes.configs.files.slice(0, req.budget.maxCandidatesPerRetriever).flatMap((file, index) => {
      const candidate = makeCandidate({
        req,
        indexes,
        file,
        retriever: this.name,
        rank: index + 1,
        preview: file,
        signals: { configAffinity: 1 },
        reasons: ["configuration file is relevant to request intent"],
      });
      return candidate ? [candidate] : [];
    });
  }
}
