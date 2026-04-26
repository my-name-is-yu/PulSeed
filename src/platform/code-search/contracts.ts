export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "interface"
  | "route"
  | "schema"
  | "test"
  | "config"
  | "module"
  | "unknown";

export type Intent =
  | "bugfix"
  | "test_failure"
  | "feature_addition"
  | "refactor"
  | "explain"
  | "api_change"
  | "config_fix"
  | "security_review"
  | "unknown";

export type ReadPhase = "locate" | "understand" | "plan_edit" | "edit" | "verify" | "repair";

export interface CodeSearchTask {
  task: string;
  intent?: Intent;
  queryTerms?: string[];
  stacktrace?: string;
  fileGlobs?: string[];
  packageScope?: string;
  cwd?: string;
  budget?: Partial<SearchBudget>;
}

export interface SearchBudget {
  maxFiles: number;
  maxCandidatesPerRetriever: number;
  maxFusionCandidates: number;
  maxRerankCandidates: number;
}

export interface SearchRequest extends Required<Omit<CodeSearchTask, "intent" | "budget" | "cwd">> {
  cwd: string;
  intent: Intent;
  likelySymbols: string[];
  likelyPaths: string[];
  stackFrames: StackFrame[];
  budget: SearchBudget;
}

export interface StackFrame {
  file: string;
  line?: number;
  column?: number;
  symbol?: string;
}

export interface CandidateSignals {
  lexicalMatch: number;
  exactSymbolMatch: number;
  stacktraceMatch: number;
  failingTestAffinity: number;
  testRelation: number;
  configAffinity: number;
  packageBoundaryFit: number;
  repoMapCentrality: number;
  callgraphProximity: number;
  pathPrior: number;
  semanticSimilarity: number;
}

export interface CandidateRanks {
  retrieverRanks: Record<string, number>;
  finalRank?: number;
}

export interface CandidatePenalties {
  generated: number;
  vendor: number;
  buildArtifact: number;
  staleIndex: number;
  wrongPackageBoundary: number;
  largeFileWithoutSymbol: number;
}

export interface CodeCandidate {
  id: string;
  file: string;
  range: {
    startLine: number;
    endLine: number;
    startByte?: number;
    endByte?: number;
  };
  symbol?: {
    name: string;
    kind: SymbolKind;
    signature?: string;
    stableKey?: string;
    enclosing?: string[];
  };
  package?: {
    name: string;
    root: string;
    distanceFromTaskScope?: number;
  };
  preview: string;
  signals: CandidateSignals;
  ranks: CandidateRanks;
  penalties: CandidatePenalties;
  reasons: string[];
  sourceRetrievers: string[];
  indexVersion: string;
  indexedAt: number;
  fileHashAtIndex: string;
  currentFileHash?: string;
}

export type ReadRecommendation = "read_now" | "read_if_needed" | "reference_only" | "avoid_edit";

export interface RankedCandidate extends CodeCandidate {
  rrfScore: number;
  rerankScore: number;
  confidence: "high" | "medium" | "low";
  readRecommendation: ReadRecommendation;
}

export interface ReadRequest {
  queryId?: string;
  candidateIds?: string[];
  phase?: ReadPhase;
  maxReadRanges?: number;
  maxReadTokens?: number;
  expansionPolicy?: "minimal" | "symbol" | "imports_exports" | "tests" | "repair";
}

export interface ReadRangeKey {
  file: string;
  startLine: number;
  endLine: number;
}

export interface ReadRangeResult extends ReadRangeKey {
  candidateId: string;
  reason: string;
  content: string;
  tokenEstimate: number;
}

export interface ReadSessionState {
  queryId: string;
  readRanges: ReadRangeKey[];
  rejectedRanges: Array<{ key: ReadRangeKey; reason: string }>;
  budget: {
    maxReadRanges: number;
    maxReadTokens: number;
    usedReadRanges: number;
    estimatedTokens: number;
  };
  phase: ReadPhase;
}

export interface RepoMapSlice {
  files: Array<{ file: string; imports: string[]; exports: string[] }>;
}

export interface PackageContext {
  packages: Array<{ name: string; root: string; dependencies: string[] }>;
}

export interface TestContext {
  tests: Array<{ file: string; names: string[]; imports: string[] }>;
}

export interface ConfigContext {
  files: string[];
}

export interface ContextBundle {
  queryId: string;
  state: ReadSessionState;
  ranges: ReadRangeResult[];
  repoMap?: RepoMapSlice;
  packageContext?: PackageContext;
  testContext?: TestContext;
  configContext?: ConfigContext;
  omittedCandidates: Array<{
    candidateId: string;
    reason: string;
  }>;
  warnings: string[];
  tokenEstimate: number;
  trace: RetrievalTrace;
}

export type VerificationSignal =
  | { kind: "undefined_symbol"; symbol: string; file?: string; raw: string }
  | { kind: "type_error"; file?: string; line?: number; typeName?: string; raw: string }
  | { kind: "failing_test"; testFile?: string; testName?: string; assertion?: string; raw: string }
  | { kind: "runtime_stacktrace"; stacktrace: string; raw: string }
  | { kind: "lint_error"; file?: string; rule?: string; raw: string }
  | { kind: "package_import_error"; specifier?: string; packageName?: string; raw: string }
  | { kind: "generated_file_selected"; file: string; raw: string };

export interface RetrievalTrace {
  queryId: string;
  task: string;
  intent: Intent;
  retrieversUsed: string[];
  candidatesReturnedByRetriever: Record<string, number>;
  fusedCandidates: string[];
  rerankedCandidates: string[];
  readCandidates: string[];
  omittedCandidates: Array<{ candidateId: string; reason: string }>;
  reasons: string[];
  warnings: string[];
  indexVersions: string[];
  fileHashes: Record<string, string>;
  verificationSignals: VerificationSignal[];
  repairLinks: string[];
}

export interface SearchSessionState {
  queryId: string;
  task: CodeSearchTask;
  candidates: RankedCandidate[];
  trace: RetrievalTrace;
}

export interface Retriever {
  name: string;
  search(req: SearchRequest, indexes: CodeSearchIndexes): Promise<CodeCandidate[]>;
}

export interface IndexedFile {
  path: string;
  absolutePath: string;
  hash: string;
  mtimeMs: number;
  size: number;
  language: string;
  packageRoot?: string;
  generated: boolean;
  vendor: boolean;
  buildArtifact: boolean;
  editable: boolean;
}

export interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  signature?: string;
  file: string;
  startLine: number;
  endLine: number;
  startByte?: number;
  endByte?: number;
  stableKey: string;
  enclosing: string[];
}

export interface CodeSearchIndexes {
  version: string;
  indexedAt: number;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  repoMap: RepoMapSlice;
  tests: TestContext;
  configs: ConfigContext;
  packages: PackageContext;
}

export const DEFAULT_CANDIDATE_SIGNALS: CandidateSignals = {
  lexicalMatch: 0,
  exactSymbolMatch: 0,
  stacktraceMatch: 0,
  failingTestAffinity: 0,
  testRelation: 0,
  configAffinity: 0,
  packageBoundaryFit: 0,
  repoMapCentrality: 0,
  callgraphProximity: 0,
  pathPrior: 0,
  semanticSimilarity: 0,
};

export const DEFAULT_CANDIDATE_PENALTIES: CandidatePenalties = {
  generated: 0,
  vendor: 0,
  buildArtifact: 0,
  staleIndex: 0,
  wrongPackageBoundary: 0,
  largeFileWithoutSymbol: 0,
};
