import { z } from "zod";
import { SearchOrchestrator } from "../../../platform/code-search/orchestrator.js";
import type { RankedCandidate } from "../../../platform/code-search/contracts.js";
import { saveCodeSearchSession } from "../../../platform/code-search/session-store.js";
import { validateFilePath } from "../../fs/FileValidationTool/FileValidationTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const CodeSearchInputSchema = z.object({
  task: z.string().min(1),
  intent: z.enum(["bugfix", "test_failure", "feature_addition", "refactor", "explain", "api_change", "config_fix", "security_review", "unknown"]).optional(),
  queryTerms: z.array(z.string()).optional(),
  stacktrace: z.string().optional(),
  fileGlobs: z.array(z.string()).optional(),
  packageScope: z.string().optional(),
  path: z.string().optional(),
  budget: z.object({
    maxFiles: z.number().int().positive().optional(),
    maxCandidatesPerRetriever: z.number().int().positive().optional(),
    maxFusionCandidates: z.number().int().positive().optional(),
    maxRerankCandidates: z.number().int().positive().optional(),
  }).optional(),
  outputLimit: z.number().int().positive().max(40).optional(),
});
export type CodeSearchInput = z.infer<typeof CodeSearchInputSchema>;

function compactCandidate(candidate: RankedCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    file: candidate.file,
    range: candidate.range,
    symbol: candidate.symbol ? {
      name: candidate.symbol.name,
      kind: candidate.symbol.kind,
      stableKey: candidate.symbol.stableKey,
    } : undefined,
    confidence: candidate.confidence,
    readRecommendation: candidate.readRecommendation,
    rerankScore: Number(candidate.rerankScore.toFixed(3)),
    retrievers: candidate.sourceRetrievers.slice(0, 3),
    reason: candidate.reasons[0],
  };
}

export class CodeSearchTool implements ITool<CodeSearchInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "code_search",
    aliases: ["code-search", "structured_code_search"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = CodeSearchInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: CodeSearchInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwd = input.path ? validateFilePath(input.path, context.cwd).resolved : context.cwd;
    const orchestrator = new SearchOrchestrator(cwd);
    const session = await orchestrator.searchWithState({ ...input, cwd });
    saveCodeSearchSession(session, cwd);
    const visibleCandidates = session.candidates.slice(0, input.outputLimit ?? 20);
    return {
      success: true,
      data: {
        queryId: session.queryId,
        candidates: visibleCandidates.map(compactCandidate),
        candidateIds: visibleCandidates.map((candidate) => candidate.id),
        totalCandidates: session.candidates.length,
        trace: {
          queryId: session.trace.queryId,
          retrieversUsed: session.trace.retrieversUsed,
        },
        warnings: session.trace.warnings.slice(0, 5),
      },
      summary: `Code search returned ${session.candidates.length} ranked candidates for ${input.intent ?? "inferred"} intent`,
      durationMs: Date.now() - startTime,
      artifacts: visibleCandidates.map((candidate) => candidate.file),
    };
  }

  async checkPermissions(input: CodeSearchInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context || !input.path) return { status: "allowed" };
    const validation = validateFilePath(input.path, context.cwd, context.executionPolicy?.protectedPaths);
    if (!validation.valid) {
      return { status: "needs_approval", reason: `Searching outside the working directory: ${validation.resolved}` };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
