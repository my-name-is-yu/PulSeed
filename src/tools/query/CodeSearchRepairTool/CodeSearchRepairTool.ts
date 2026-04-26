import { z } from "zod";
import { SearchOrchestrator } from "../../../platform/code-search/orchestrator.js";
import { parseVerificationSignal } from "../../../platform/code-search/verification-retrieval.js";
import { validateFilePath } from "../../fs/FileValidationTool/FileValidationTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { resolveCodeSearchRoot } from "../code-search-root.js";
import { MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const CodeSearchRepairInputSchema = z.object({
  priorTask: z.object({
    task: z.string().min(1),
    intent: z.enum(["bugfix", "test_failure", "feature_addition", "refactor", "explain", "api_change", "config_fix", "security_review", "unknown"]).optional(),
    queryTerms: z.array(z.string()).optional(),
    stacktrace: z.string().optional(),
    fileGlobs: z.array(z.string()).optional(),
    packageScope: z.string().optional(),
  }),
  priorTraceId: z.string().optional(),
  verificationOutput: z.string().min(1),
  changedFiles: z.array(z.string()).optional(),
  failedCommand: z.string().optional(),
  path: z.string().optional(),
});
export type CodeSearchRepairInput = z.infer<typeof CodeSearchRepairInputSchema>;

export class CodeSearchRepairTool implements ITool<CodeSearchRepairInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "code_search_repair",
    aliases: ["code-search-repair", "repair_code_search"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = CodeSearchRepairInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: CodeSearchRepairInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    let cwd: string;
    try {
      cwd = resolveCodeSearchRoot(input, context, "code_search_repair");
    } catch (err) {
      return {
        success: false,
        data: { candidates: [], focusedTestSuggestions: [], warnings: [(err as Error).message] },
        summary: `Repair code search failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
    const signal = parseVerificationSignal(input.verificationOutput);
    const orchestrator = new SearchOrchestrator(cwd);
    const prior = {
      queryId: input.priorTraceId ?? "manual-repair",
      task: { ...input.priorTask, cwd },
      candidates: [],
      trace: {
        queryId: input.priorTraceId ?? "manual-repair",
        task: input.priorTask.task,
        intent: input.priorTask.intent ?? "unknown",
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
        verificationSignals: [signal],
        repairLinks: [],
      },
    };
    const candidates = await orchestrator.searchFromVerification(signal, prior);
    return {
      success: true,
      data: {
        signal,
        failedCommand: input.failedCommand,
        changedFiles: input.changedFiles ?? [],
        candidates,
        focusedTestSuggestions: candidates
          .filter((candidate) => candidate.file.includes("test") || candidate.symbol?.kind === "test")
          .slice(0, 5)
          .map((candidate) => candidate.file),
      },
      summary: `Repair code search parsed ${signal.kind} and returned ${candidates.length} candidates`,
      durationMs: Date.now() - startTime,
      artifacts: candidates.map((candidate) => candidate.file),
    };
  }

  async checkPermissions(input: CodeSearchRepairInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context) return { status: "allowed" };
    try {
      resolveCodeSearchRoot(input, context, "code_search_repair");
    } catch (err) {
      return { status: "denied", reason: (err as Error).message };
    }
    if (!input.path) return { status: "allowed" };
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
