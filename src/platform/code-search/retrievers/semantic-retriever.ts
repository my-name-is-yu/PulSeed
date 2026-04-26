import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { semanticCandidates } from "../indexes/semantic-index.js";

export class SemanticRetriever implements Retriever {
  readonly name = "semantic";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const candidates = await semanticCandidates(req, indexes);
    return candidates.map((candidate, index) => ({
      ...candidate,
      sourceRetrievers: [...new Set([...candidate.sourceRetrievers, this.name])],
      ranks: {
        ...candidate.ranks,
        retrieverRanks: { ...candidate.ranks.retrieverRanks, [this.name]: index + 1 },
      },
      signals: { ...candidate.signals, semanticSimilarity: Math.max(candidate.signals.semanticSimilarity, 0.1) },
      reasons: [...candidate.reasons, "semantic retriever available but currently fallback-only"],
    }));
  }
}
