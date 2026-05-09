import type { CodeCandidate } from "./contracts.js";

function overlapsOrClose(a: CodeCandidate, b: CodeCandidate): boolean {
  if (a.file !== b.file) return false;
  const sameSymbol = a.symbol?.stableKey && a.symbol.stableKey === b.symbol?.stableKey;
  if (sameSymbol) return true;
  const overlaps = a.range.startLine <= b.range.endLine && b.range.startLine <= a.range.endLine;
  const distance = Math.min(Math.abs(a.range.startLine - b.range.endLine), Math.abs(b.range.startLine - a.range.endLine));
  return overlaps || distance <= 30;
}

function mergeCandidate(a: CodeCandidate, b: CodeCandidate): CodeCandidate {
  const startBytes = [a.range.startByte, b.range.startByte].filter((value): value is number => value !== undefined);
  const endBytes = [a.range.endByte, b.range.endByte].filter((value): value is number => value !== undefined);
  return {
    ...a,
    id: `${a.file}:${Math.min(a.range.startLine, b.range.startLine)}-${Math.max(a.range.endLine, b.range.endLine)}:${a.symbol?.stableKey ?? b.symbol?.stableKey ?? "merged"}`,
    range: {
      startLine: Math.min(a.range.startLine, b.range.startLine),
      endLine: Math.max(a.range.endLine, b.range.endLine),
      ...(startBytes.length > 0 ? { startByte: Math.min(...startBytes) } : {}),
      ...(endBytes.length > 0 ? { endByte: Math.max(...endBytes) } : {}),
    },
    preview: [a.preview, b.preview].filter(Boolean).join("\n").slice(0, 300),
    signals: {
      lexicalMatch: Math.max(a.signals.lexicalMatch, b.signals.lexicalMatch),
      exactSymbolMatch: Math.max(a.signals.exactSymbolMatch, b.signals.exactSymbolMatch),
      stacktraceMatch: Math.max(a.signals.stacktraceMatch, b.signals.stacktraceMatch),
      failingTestAffinity: Math.max(a.signals.failingTestAffinity, b.signals.failingTestAffinity),
      testRelation: Math.max(a.signals.testRelation, b.signals.testRelation),
      configAffinity: Math.max(a.signals.configAffinity, b.signals.configAffinity),
      packageBoundaryFit: Math.max(a.signals.packageBoundaryFit, b.signals.packageBoundaryFit),
      repoMapCentrality: Math.max(a.signals.repoMapCentrality, b.signals.repoMapCentrality),
      callgraphProximity: Math.max(a.signals.callgraphProximity, b.signals.callgraphProximity),
      pathPrior: Math.max(a.signals.pathPrior, b.signals.pathPrior),
      semanticSimilarity: Math.max(a.signals.semanticSimilarity, b.signals.semanticSimilarity),
    },
    ranks: { retrieverRanks: { ...a.ranks.retrieverRanks, ...b.ranks.retrieverRanks } },
    penalties: {
      generated: Math.max(a.penalties.generated, b.penalties.generated),
      vendor: Math.max(a.penalties.vendor, b.penalties.vendor),
      buildArtifact: Math.max(a.penalties.buildArtifact, b.penalties.buildArtifact),
      staleIndex: Math.max(a.penalties.staleIndex, b.penalties.staleIndex),
      wrongPackageBoundary: Math.max(a.penalties.wrongPackageBoundary, b.penalties.wrongPackageBoundary),
      largeFileWithoutSymbol: Math.max(a.penalties.largeFileWithoutSymbol, b.penalties.largeFileWithoutSymbol),
    },
    reasons: [...new Set([...a.reasons, ...b.reasons])],
    sourceRetrievers: [...new Set([...a.sourceRetrievers, ...b.sourceRetrievers])],
  };
}

export function normalizeCandidates(candidates: CodeCandidate[]): CodeCandidate[] {
  const normalized: CodeCandidate[] = [];
  for (const candidate of candidates) {
    const existingIndex = normalized.findIndex((entry) => overlapsOrClose(entry, candidate));
    if (existingIndex >= 0) {
      normalized[existingIndex] = mergeCandidate(normalized[existingIndex], candidate);
    } else {
      normalized.push(candidate);
    }
  }
  return normalized;
}
