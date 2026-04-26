import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";

export class TestRetriever implements Retriever {
  readonly name = "test";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const terms = req.queryTerms.map((term) => term.toLowerCase()).slice(0, 16);
    const candidates: CodeCandidate[] = [];
    for (const test of indexes.tests.tests) {
      if (candidates.length >= req.budget.maxCandidatesPerRetriever) break;
      const haystack = [test.file, ...test.names, ...test.imports].join(" ").toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      if (hits === 0 && req.intent !== "test_failure" && req.intent !== "bugfix") continue;
      const candidate = makeCandidate({
        req,
        indexes,
        file: test.file,
        retriever: this.name,
        rank: candidates.length + 1,
        preview: test.names.slice(0, 8).join("; "),
        signals: { failingTestAffinity: req.intent === "test_failure" ? 1 : 0.4, testRelation: Math.min(1, hits / 3) },
        reasons: hits > 0 ? [`related test matched ${hits} terms`] : ["test candidate for bugfix/test failure task"],
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
}
