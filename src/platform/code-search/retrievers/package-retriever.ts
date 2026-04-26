import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";

export class PackageRetriever implements Retriever {
  readonly name = "package";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const terms = req.queryTerms.map((term) => term.toLowerCase());
    const candidates: CodeCandidate[] = [];
    for (const pkg of indexes.packages.packages) {
      const file = pkg.root ? `${pkg.root}/package.json` : "package.json";
      const haystack = [pkg.name, ...pkg.dependencies].join(" ").toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      if (hits === 0 && req.intent !== "config_fix") continue;
      const candidate = makeCandidate({
        req,
        indexes,
        file,
        retriever: this.name,
        rank: candidates.length + 1,
        preview: `${pkg.name}: ${pkg.dependencies.slice(0, 10).join(", ")}`,
        signals: { packageBoundaryFit: 1, configAffinity: req.intent === "config_fix" ? 0.8 : 0 },
        reasons: hits > 0 ? [`package graph matched ${hits} terms`] : ["package graph candidate for config fix"],
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
}
