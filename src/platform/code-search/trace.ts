import type { Intent, RetrievalTrace, VerificationSignal } from "./contracts.js";

let sequence = 0;

export function createQueryId(prefix = "code-search"): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function createRetrievalTrace(input: {
  queryId?: string;
  task: string;
  intent: Intent;
  verificationSignals?: VerificationSignal[];
}): RetrievalTrace {
  return {
    queryId: input.queryId ?? createQueryId(),
    task: input.task,
    intent: input.intent,
    retrieversUsed: [],
    candidatesReturnedByRetriever: {},
    fusedCandidates: [],
    rerankedCandidates: [],
    readCandidates: [],
    omittedCandidates: [],
    reasons: [],
    warnings: [],
    indexVersions: [],
    fileHashes: {},
    verificationSignals: input.verificationSignals ?? [],
    repairLinks: [],
  };
}
