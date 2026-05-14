import { z } from "zod";
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
    .enum(["semantic", "exact", "lexical"])
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
      const entries = await this.knowledgeManager.recallAgentMemory(
        parsedInput.query,
        {
          mode,
          category: parsedInput.category,
          memory_type: parsedInput.memory_type,
          limit: parsedInput.limit,
          include_archived: parsedInput.include_archived,
          consent_scope: parsedInput.consent_scope,
          max_sensitivity: parsedInput.max_sensitivity,
        }
      );

      const output: MemoryRecallOutput = {
        entries,
        totalFound: entries.length,
      };

      return {
        success: true,
        data: output,
        summary: `Found ${entries.length} memory entries for query "${parsedInput.query}"`,
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
