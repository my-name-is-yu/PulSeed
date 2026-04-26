import * as path from "node:path";
import type { CodeSearchTask, RankedCandidate, SearchSessionState, VerificationSignal } from "./contracts.js";
import { normalizeCandidates } from "./candidate-normalizer.js";
import { fuseCandidates } from "./fusion.js";
import { getCodeSearchIndexes } from "./indexes/index-store.js";
import { planCodeSearchTask, taskFromVerificationSignal } from "./query-planner.js";
import { rerankCandidates } from "./reranker.js";
import { CallgraphRetriever } from "./retrievers/callgraph-retriever.js";
import { ConfigRetriever } from "./retrievers/config-retriever.js";
import { LexicalRetriever } from "./retrievers/lexical-retriever.js";
import { PackageRetriever } from "./retrievers/package-retriever.js";
import { RepoMapRetriever } from "./retrievers/repo-map-retriever.js";
import { SemanticRetriever } from "./retrievers/semantic-retriever.js";
import { StacktraceRetriever } from "./retrievers/stacktrace-retriever.js";
import { SymbolRetriever } from "./retrievers/symbol-retriever.js";
import { TestRetriever } from "./retrievers/test-retriever.js";
import { createRetrievalTrace } from "./trace.js";

const DEFAULT_RETRIEVERS = [
  new StacktraceRetriever(),
  new SymbolRetriever(),
  new LexicalRetriever(),
  new TestRetriever(),
  new ConfigRetriever(),
  new PackageRetriever(),
  new RepoMapRetriever(),
  new CallgraphRetriever(),
  new SemanticRetriever(),
];

export class SearchOrchestrator {
  constructor(private readonly root = process.cwd()) {}

  async search(task: CodeSearchTask): Promise<RankedCandidate[]> {
    return (await this.searchWithState(task)).candidates;
  }

  async searchWithState(task: CodeSearchTask): Promise<SearchSessionState> {
    const req = planCodeSearchTask({ ...task, cwd: task.cwd ?? this.root });
    const indexes = await getCodeSearchIndexes(req.cwd, { maxFiles: req.budget.maxFiles });
    const trace = createRetrievalTrace({ task: req.task, intent: req.intent });
    trace.indexVersions.push(indexes.version);

    const all = [];
    for (const retriever of DEFAULT_RETRIEVERS) {
      trace.retrieversUsed.push(retriever.name);
      try {
        const candidates = await retriever.search(req, indexes);
        trace.candidatesReturnedByRetriever[retriever.name] = candidates.length;
        all.push(...candidates);
      } catch (error) {
        trace.warnings.push(`${retriever.name} retriever failed: ${(error as Error).message}`);
      }
    }

    const normalized = normalizeCandidates(all);
    const fused = fuseCandidates(normalized, req.budget.maxFusionCandidates);
    const ranked = rerankCandidates(fused, req.intent, req.budget.maxRerankCandidates);
    trace.fusedCandidates = fused.map((candidate) => candidate.id);
    trace.rerankedCandidates = ranked.map((candidate) => candidate.id);
    for (const candidate of ranked) {
      trace.fileHashes[candidate.file] = candidate.fileHashAtIndex;
      candidate.currentFileHash = candidate.fileHashAtIndex;
    }
    for (const candidate of ranked) {
      candidate.reasons = [...new Set([...candidate.reasons, `trace:${trace.queryId}`])];
    }
    return {
      queryId: trace.queryId,
      task: { ...task, cwd: task.cwd ?? path.resolve(this.root) },
      candidates: ranked,
      trace,
    };
  }

  async searchFromVerification(error: VerificationSignal, prior: SearchSessionState): Promise<RankedCandidate[]> {
    const repairTask = taskFromVerificationSignal(error, prior.task);
    const candidates = await this.search(repairTask);
    return candidates.map((candidate) => ({
      ...candidate,
      reasons: [...new Set([...candidate.reasons, `repair from ${prior.queryId}`, `verification:${error.kind}`])],
    }));
  }
}
