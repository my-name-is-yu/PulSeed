import { z } from "zod";
import * as path from "node:path";
import { getCodeSearchIndexes } from "../../../platform/code-search/indexes/index-store.js";
import { ProgressiveReader } from "../../../platform/code-search/progressive-reader.js";
import { getCodeSearchSession, resolveCodeSearchCandidates } from "../../../platform/code-search/session-store.js";
import { validateFilePath } from "../../fs/FileValidationTool/FileValidationTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

const CandidateSchema = z.object({
  id: z.string(),
  file: z.string(),
  range: z.object({ startLine: z.number(), endLine: z.number(), startByte: z.number().optional(), endByte: z.number().optional() }),
  symbol: z.object({
    name: z.string(),
    kind: z.string(),
    signature: z.string().optional(),
    stableKey: z.string().optional(),
    enclosing: z.array(z.string()).optional(),
  }).optional(),
  package: z.object({ name: z.string(), root: z.string(), distanceFromTaskScope: z.number().optional() }).optional(),
  preview: z.string(),
  signals: z.record(z.number()),
  ranks: z.object({ retrieverRanks: z.record(z.number()), finalRank: z.number().optional() }),
  penalties: z.record(z.number()),
  reasons: z.array(z.string()),
  sourceRetrievers: z.array(z.string()),
  indexVersion: z.string(),
  indexedAt: z.number(),
  fileHashAtIndex: z.string(),
  currentFileHash: z.string().optional(),
  rrfScore: z.number(),
  rerankScore: z.number(),
  confidence: z.enum(["high", "medium", "low"]),
  readRecommendation: z.enum(["read_now", "read_if_needed", "reference_only", "avoid_edit"]),
}).passthrough();

export const CodeReadContextInputSchema = z.object({
  candidates: z.array(CandidateSchema).optional().default([]),
  candidateIds: z.array(z.string()).optional(),
  queryId: z.string().optional(),
  phase: z.enum(["locate", "understand", "plan_edit", "edit", "verify", "repair"]).optional(),
  maxReadRanges: z.number().int().positive().optional(),
  maxReadTokens: z.number().int().positive().optional(),
  path: z.string().optional(),
});
export type CodeReadContextInput = z.infer<typeof CodeReadContextInputSchema>;

function resolveReadRoot(input: CodeReadContextInput, context: ToolCallContext): { cwd: string; error?: string } {
  const stored = input.queryId ? getCodeSearchSession(input.queryId) : null;
  const sessionRoot = stored?.cwd;
  if (!sessionRoot) {
    return { cwd: input.path ? validateFilePath(input.path, context.cwd).resolved : context.cwd };
  }
  if (!input.path) return { cwd: sessionRoot };
  const requested = validateFilePath(input.path, context.cwd).resolved;
  const relative = path.relative(sessionRoot, requested);
  if (requested !== sessionRoot && (relative.startsWith("..") || path.isAbsolute(relative))) {
    return {
      cwd: sessionRoot,
      error: `Reading path ${requested} is outside code_search session root ${sessionRoot}`,
    };
  }
  return { cwd: requested };
}

export class CodeReadContextTool implements ITool<CodeReadContextInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "code_read_context",
    aliases: ["code-read-context", "read_code_context"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = CodeReadContextInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: CodeReadContextInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const resolvedRoot = resolveReadRoot(input, context);
    if (resolvedRoot.error) {
      return {
        success: false,
        data: null,
        summary: resolvedRoot.error,
        error: resolvedRoot.error,
        durationMs: Date.now() - startTime,
      };
    }
    const cwd = resolvedRoot.cwd;
    const indexes = await getCodeSearchIndexes(cwd);
    const reader = new ProgressiveReader(cwd, indexes);
    const candidates = input.queryId
      ? resolveCodeSearchCandidates(input.queryId, input.candidateIds)
      : input.candidates;
    if (input.queryId && candidates.length === 0) {
      return {
        success: false,
        data: null,
        summary: `No code_search candidates found for queryId ${input.queryId}`,
        error: `No code_search candidates found for queryId ${input.queryId}`,
        durationMs: Date.now() - startTime,
      };
    }
    const bundle = await reader.read(candidates as never, {
      queryId: input.queryId,
      candidateIds: input.candidateIds,
      phase: input.phase,
      maxReadRanges: input.maxReadRanges,
      maxReadTokens: input.maxReadTokens,
    });
    return {
      success: true,
      data: bundle,
      summary: `Read ${bundle.ranges.length} code ranges (${bundle.tokenEstimate} estimated tokens), omitted ${bundle.omittedCandidates.length}`,
      durationMs: Date.now() - startTime,
      artifacts: bundle.ranges.map((range) => range.file),
    };
  }

  async checkPermissions(input: CodeReadContextInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context) return { status: "allowed" };
    const resolvedRoot = resolveReadRoot(input, context);
    if (resolvedRoot.error) {
      return { status: "denied", reason: resolvedRoot.error };
    }
    const rootValidation = validateFilePath(resolvedRoot.cwd, context.cwd, context.executionPolicy?.protectedPaths);
    if (!rootValidation.valid) {
      return { status: "needs_approval", reason: `Reading outside the working directory: ${rootValidation.resolved}` };
    }
    const storedCandidates = input.queryId ? resolveCodeSearchCandidates(input.queryId, input.candidateIds) : [];
    const candidates = input.queryId ? storedCandidates : input.candidates;
    for (const candidate of candidates) {
      const validation = validateFilePath(candidate.file, rootValidation.resolved, context.executionPolicy?.protectedPaths);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Reading outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
