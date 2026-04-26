import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";

export class SymbolRetriever implements Retriever {
  readonly name = "symbol";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const terms = new Set([...req.likelySymbols, ...req.queryTerms].map((term) => term.toLowerCase()));
    const candidates: CodeCandidate[] = [];
    for (const symbol of indexes.symbols) {
      if (candidates.length >= req.budget.maxCandidatesPerRetriever) break;
      const name = symbol.name.toLowerCase();
      const exact = terms.has(name);
      const fuzzy = [...terms].some((term) => term.length >= 4 && (name.includes(term) || term.includes(name)));
      if (!exact && !fuzzy) continue;
      const candidate = makeCandidate({
        req,
        indexes,
        file: symbol.file,
        retriever: this.name,
        rank: candidates.length + 1,
        symbol,
        preview: symbol.signature ?? symbol.name,
        signals: { exactSymbolMatch: exact ? 1 : 0.6, lexicalMatch: fuzzy ? 0.5 : 0 },
        reasons: [exact ? `exact symbol match: ${symbol.name}` : `fuzzy symbol match: ${symbol.name}`],
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
}
