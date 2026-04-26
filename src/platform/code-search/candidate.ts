import * as path from "node:path";
import type {
  CandidatePenalties,
  CandidateSignals,
  CodeCandidate,
  CodeSearchIndexes,
  IndexedFile,
  IndexedSymbol,
  SearchRequest,
  SymbolKind,
} from "./contracts.js";
import { DEFAULT_CANDIDATE_PENALTIES, DEFAULT_CANDIDATE_SIGNALS } from "./contracts.js";
import { generatedPenaltyFor } from "./generated-detector.js";

function shortPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function fileFor(indexes: CodeSearchIndexes, file: string): IndexedFile | undefined {
  return indexes.files.find((candidate) => candidate.path === file);
}

export function packageForFile(indexes: CodeSearchIndexes, file: string): CodeCandidate["package"] {
  const matched = indexes.packages.packages
    .filter((pkg) => pkg.root === "" || file === pkg.root || file.startsWith(`${pkg.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
  return matched ? { name: matched.name, root: matched.root } : undefined;
}

export function makeCandidate(input: {
  req: SearchRequest;
  indexes: CodeSearchIndexes;
  file: string;
  retriever: string;
  rank: number;
  startLine?: number;
  endLine?: number;
  symbol?: IndexedSymbol | { name: string; kind: SymbolKind; signature?: string; stableKey?: string; enclosing?: string[] };
  preview: string;
  signals?: Partial<CandidateSignals>;
  penalties?: Partial<CandidatePenalties>;
  reasons: string[];
}): CodeCandidate | null {
  const file = fileFor(input.indexes, input.file);
  if (!file) return null;
  const generated = generatedPenaltyFor(input.file);
  const symbol = input.symbol
    ? {
        name: input.symbol.name,
        kind: input.symbol.kind,
        signature: input.symbol.signature,
        stableKey: input.symbol.stableKey ?? `${input.file}#${input.symbol.kind}:${input.symbol.name}`,
        enclosing: input.symbol.enclosing ?? [],
      }
    : undefined;
  const startLine = input.startLine ?? ("startLine" in (input.symbol ?? {}) ? (input.symbol as IndexedSymbol).startLine : 1);
  const endLine = input.endLine ?? ("endLine" in (input.symbol ?? {}) ? (input.symbol as IndexedSymbol).endLine : startLine);
  const id = `${input.file}:${startLine}-${endLine}:${symbol?.stableKey ?? input.retriever}`;
  return {
    id,
    file: input.file,
    range: {
      startLine,
      endLine,
      startByte: "startByte" in (input.symbol ?? {}) ? (input.symbol as IndexedSymbol).startByte : undefined,
      endByte: "endByte" in (input.symbol ?? {}) ? (input.symbol as IndexedSymbol).endByte : undefined,
    },
    symbol,
    package: packageForFile(input.indexes, input.file),
    preview: shortPreview(input.preview),
    signals: { ...DEFAULT_CANDIDATE_SIGNALS, ...(input.signals ?? {}) },
    ranks: { retrieverRanks: { [input.retriever]: input.rank } },
    penalties: { ...DEFAULT_CANDIDATE_PENALTIES, ...generated, ...(input.penalties ?? {}) },
    reasons: [...input.reasons, ...generated.reasons],
    sourceRetrievers: [input.retriever],
    indexVersion: input.indexes.version,
    indexedAt: input.indexes.indexedAt,
    fileHashAtIndex: file.hash,
  };
}

export function pathAffinity(req: SearchRequest, file: string): number {
  if (req.likelyPaths.some((hint) => file.endsWith(hint) || hint.endsWith(file))) return 1;
  const basename = path.basename(file).toLowerCase();
  return req.queryTerms.some((term) => basename.includes(term.toLowerCase())) ? 0.6 : 0;
}
