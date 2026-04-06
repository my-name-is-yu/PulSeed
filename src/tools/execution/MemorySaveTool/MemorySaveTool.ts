import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL, TOOL_NAME, ALIASES } from "./constants.js";

export const MemorySaveInputSchema = z.object({
  key: z.string().min(1).describe("Unique key for the memory entry"),
  value: z.string().min(1).describe("Content to store"),
  category: z.string().optional().describe("Category for organising entries"),
  memory_type: z
    .enum(["fact", "procedure", "preference", "observation"])
    .optional()
    .default("fact")
    .describe("Type of memory entry"),
  tags: z.array(z.string()).optional().describe("Tags for filtering and search"),
});
export type MemorySaveInput = z.infer<typeof MemorySaveInputSchema>;

export class MemorySaveTool implements ITool<MemorySaveInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 2000,
    tags: [...TAGS],
  };

  readonly inputSchema = MemorySaveInputSchema;

  constructor(private readonly knowledgeManager: KnowledgeManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: MemorySaveInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const saved = await this.knowledgeManager.saveAgentMemory({
        key: input.key,
        value: input.value,
        category: input.category,
        memory_type: input.memory_type,
        tags: input.tags,
      });
      return {
        success: true,
        data: { id: saved.id, key: saved.key },
        summary: `Memory saved: ${input.key}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "MemorySaveTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: MemorySaveInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: MemorySaveInput): boolean {
    return false;
  }
}
