import type { CodeCandidate, CodeSearchIndexes, SearchRequest } from "../contracts.js";

export async function semanticCandidates(_req: SearchRequest, _indexes: CodeSearchIndexes): Promise<CodeCandidate[]> {
  return [];
}
