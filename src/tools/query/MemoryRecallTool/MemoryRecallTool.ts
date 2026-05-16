import { z } from "zod/v3";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { AgentMemoryEntry } from "../../../platform/knowledge/types/agent-memory.js";
import { MemorySensitivitySchema } from "../../../platform/corrections/memory-governance.js";

export const MemoryRecallInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Search query. Freeform recall uses semantic mode; exact/lexical modes are for explicit protocol lookups."
    ),
  exact: z
    .boolean()
    .optional()
    .describe(
      "Deprecated compatibility flag. Use mode='exact' for exact key lookup."
    ),
  category: z.string().optional().describe("Filter by category"),
  memory_type: z
    .enum(["fact", "procedure", "preference", "observation"])
    .optional()
    .describe("Filter by memory type"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Maximum results to return"),
  include_archived: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include archived entries in results"),
  mode: z
    .enum(["semantic", "exact", "lexical", "graph"])
    .optional()
    .default("semantic")
    .describe("Recall mode: semantic for freeform memory recall, exact for key lookup, lexical for explicit substring maintenance queries"),
  consent_scope: z
    .string()
    .optional()
    .default("local_planning")
    .describe("Typed consent context required for returned memories"),
  max_sensitivity: MemorySensitivitySchema
    .optional()
    .default("local")
    .describe("Maximum sensitivity allowed in returned memories"),
}).strict();
export type MemoryRecallInput = z.input<typeof MemoryRecallInputSchema>;

export interface MemoryRecallOutput {
  entries: AgentMemoryEntry[];
  totalFound: number;
  recall: {
    mode: "semantic" | "semantic_unavailable" | "exact" | "lexical" | "graph";
    semanticIndexStatus: "available" | "unavailable" | "not_requested";
    safeForNormalProjection: boolean;
    recallId?: string | null;
    resultClaims?: Array<{
      claim_id: string;
      mode: "semantic" | "semantic_unavailable" | "exact" | "lexical" | "graph";
      evidence_refs: string[];
      correction_status: string;
      invalidation_status: string;
      confidence: number | null;
      trust_state: string;
      safe_for_normal_projection: boolean;
    }>;
    withheldClaimIds?: string[];
  };
}

export class MemoryRecallTool
  implements ITool<MemoryRecallInput, MemoryRecallOutput>
{
  readonly metadata: ToolMetadata = {
    name: "memory_recall",
    aliases: ["recall_memory", "remember_query"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = MemoryRecallInputSchema;

  constructor(private readonly knowledgeManager: KnowledgeManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: MemoryRecallInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const hasExplicitMode = typeof input === "object"
      && input !== null
      && Object.prototype.hasOwnProperty.call(input, "mode");
    const parsedInput = this.inputSchema.parse(input);
    const mode = parsedInput.exact === true && !hasExplicitMode ? "exact" : parsedInput.mode;

    try {
      const detailed = typeof this.knowledgeManager.recallAgentMemoryWithProvenance === "function"
        ? await this.knowledgeManager.recallAgentMemoryWithProvenance(parsedInput.query, {
            mode,
            category: parsedInput.category,
            memory_type: parsedInput.memory_type,
            limit: parsedInput.limit,
            include_archived: parsedInput.include_archived,
            consent_scope: parsedInput.consent_scope,
            max_sensitivity: parsedInput.max_sensitivity,
          })
        : {
            entries: await this.knowledgeManager.recallAgentMemory(parsedInput.query, {
              mode,
              category: parsedInput.category,
              memory_type: parsedInput.memory_type,
              limit: parsedInput.limit,
              include_archived: parsedInput.include_archived,
              consent_scope: parsedInput.consent_scope,
              max_sensitivity: parsedInput.max_sensitivity,
            }),
            recall: {
              mode,
              semanticIndexStatus: mode === "semantic" ? "available" : "not_requested",
              safeForNormalProjection: true,
            } as const,
          };

      const output: MemoryRecallOutput = {
        entries: detailed.entries,
        totalFound: detailed.entries.length,
        recall: detailed.recall,
      };

      return {
        success: true,
        data: output,
        summary: detailed.recall.mode === "semantic_unavailable"
          ? `Semantic memory recall unavailable for query "${parsedInput.query}"`
          : `Found ${detailed.entries.length} memory entries for query "${parsedInput.query}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { entries: [], totalFound: 0 },
        summary: `Memory recall failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input?: MemoryRecallInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: MemoryRecallInput): boolean {
    return true;
  }
}
