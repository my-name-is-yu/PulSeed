import * as fsp from "node:fs/promises";
import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate, pathAffinity } from "../candidate.js";

function matchStrength(content: string, terms: string[]): number {
  const lower = content.toLowerCase();
  const matches = terms.filter((term) => lower.includes(term.toLowerCase())).length;
  return terms.length === 0 ? 0 : Math.min(1, matches / Math.min(terms.length, 5));
}

export class LexicalRetriever implements Retriever {
  readonly name = "lexical";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const terms = req.queryTerms.slice(0, 12);
    const candidates: CodeCandidate[] = [];
    for (const file of indexes.files) {
      if (candidates.length >= req.budget.maxCandidatesPerRetriever) break;
      if (file.size > 300_000 || file.vendor || file.buildArtifact) continue;
      let content = "";
      try {
        content = await fsp.readFile(file.absolutePath, "utf8");
      } catch {
        continue;
      }
      const strength = matchStrength(content, terms);
      const pathPrior = pathAffinity(req, file.path);
      if (strength <= 0 && pathPrior <= 0) continue;
      const lines = content.split("\n");
      const firstHit = Math.max(0, lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))));
      const candidate = makeCandidate({
        req,
        indexes,
        file: file.path,
        retriever: this.name,
        rank: candidates.length + 1,
        startLine: firstHit + 1,
        endLine: Math.min(lines.length, firstHit + 40),
        preview: lines.slice(firstHit, firstHit + 5).join("\n"),
        signals: { lexicalMatch: strength, pathPrior },
        reasons: [`matched ${Math.round(strength * terms.length)} query terms`],
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
}
