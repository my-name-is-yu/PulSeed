import type { CodeCandidate } from "./contracts.js";

const DEFAULT_RRF_K = 60;

export interface FusedCandidate extends CodeCandidate {
  rrfScore: number;
}

export function fuseCandidates(candidates: CodeCandidate[], limit: number, k = DEFAULT_RRF_K): FusedCandidate[] {
  return candidates
    .map((candidate) => {
      const rrfScore = Object.values(candidate.ranks.retrieverRanks)
        .reduce((sum, rank) => sum + (1 / (k + rank)), 0);
      return { ...candidate, rrfScore };
    })
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);
}
