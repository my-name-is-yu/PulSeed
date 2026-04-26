import type { Intent, RankedCandidate, ReadRecommendation } from "./contracts.js";
import type { FusedCandidate } from "./fusion.js";

function signalScore(candidate: FusedCandidate, intent: Intent): number {
  const s = candidate.signals;
  const intentBoost =
    intent === "test_failure" ? s.failingTestAffinity + s.stacktraceMatch + s.testRelation
    : intent === "config_fix" ? s.configAffinity + s.packageBoundaryFit
    : intent === "refactor" ? s.exactSymbolMatch + s.callgraphProximity + s.packageBoundaryFit
    : intent === "explain" ? s.repoMapCentrality + s.semanticSimilarity + s.exactSymbolMatch
    : intent === "security_review" ? s.lexicalMatch + s.configAffinity + s.callgraphProximity
    : s.lexicalMatch + s.exactSymbolMatch + s.pathPrior;
  return (
    candidate.rrfScore * 40
    + s.lexicalMatch * 2.2
    + s.exactSymbolMatch * 2.8
    + s.stacktraceMatch * 3.5
    + s.failingTestAffinity * 1.8
    + s.testRelation * 1.4
    + s.configAffinity * 1.4
    + s.packageBoundaryFit * 1.1
    + s.repoMapCentrality * 0.8
    + s.callgraphProximity * 1.2
    + s.pathPrior * 2
    + s.semanticSimilarity * 0.7
    + intentBoost
  );
}

function penaltyScore(candidate: FusedCandidate): number {
  const p = candidate.penalties;
  return p.generated + p.vendor + p.buildArtifact + p.staleIndex + p.wrongPackageBoundary + p.largeFileWithoutSymbol;
}

function recommendation(candidate: FusedCandidate, score: number): ReadRecommendation {
  if (candidate.penalties.vendor || candidate.penalties.buildArtifact) return "avoid_edit";
  if (candidate.penalties.generated) return "reference_only";
  if (score >= 3.5) return "read_now";
  if (score >= 1.4) return "read_if_needed";
  return "reference_only";
}

export function rerankCandidates(candidates: FusedCandidate[], intent: Intent, limit: number): RankedCandidate[] {
  return candidates
    .map((candidate) => {
      const rerankScore = signalScore(candidate, intent) - penaltyScore(candidate);
      const ranked: RankedCandidate = {
        ...candidate,
        rerankScore,
        confidence: rerankScore >= 4 ? "high" : rerankScore >= 1.5 ? "medium" : "low",
        readRecommendation: recommendation(candidate, rerankScore),
      };
      return ranked;
    })
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .map((candidate, index) => ({
      ...candidate,
      ranks: { ...candidate.ranks, finalRank: index + 1 },
    }))
    .slice(0, limit);
}
