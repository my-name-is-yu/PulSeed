import type { CodeCandidate, CodeSearchIndexes, Retriever, SearchRequest } from "../contracts.js";
import { makeCandidate } from "../candidate.js";

export class StacktraceRetriever implements Retriever {
  readonly name = "stacktrace";

  async search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
    const candidates: CodeCandidate[] = [];
    for (const frame of req.stackFrames) {
      if (candidates.length >= req.budget.maxCandidatesPerRetriever) break;
      const file = indexes.files.find((candidate) => candidate.path.endsWith(frame.file) || frame.file.endsWith(candidate.path));
      if (!file) continue;
      const candidate = makeCandidate({
        req,
        indexes,
        file: file.path,
        retriever: this.name,
        rank: candidates.length + 1,
        startLine: Math.max(1, (frame.line ?? 1) - 12),
        endLine: (frame.line ?? 1) + 28,
        preview: frame.symbol ? `${frame.symbol} at ${file.path}:${frame.line ?? "?"}` : `${file.path}:${frame.line ?? "?"}`,
        signals: { stacktraceMatch: 1 },
        reasons: ["matched runtime stacktrace frame"],
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
}
