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
import type { KnowledgeEntry } from "../../../base/types/knowledge.js";

export const KnowledgeQueryInputSchema = z.object({
  query: z.string().min(1),
  goalId: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(5),
  type: z.enum(["semantic", "keyword"]).default("keyword"),
}).strict();
export type KnowledgeQueryInput = z.infer<typeof KnowledgeQueryInputSchema>;

export type KnowledgeQueryMode = "keyword" | "semantic" | "semantic_unavailable";
export type KnowledgeSemanticIndexStatus = "available" | "unavailable" | "not_requested";

export interface KnowledgeQueryResultItem {
  entryId: string;
  content: string;
  confidence: number;
  source: string;
  goalId: string | null;
  mode: "keyword" | "semantic";
  relevance?: number;
}

export interface KnowledgeQueryOutput {
  results: KnowledgeQueryResultItem[];
  totalFound: number;
  requestedMode: "keyword" | "semantic";
  mode: KnowledgeQueryMode;
  semanticIndexStatus: KnowledgeSemanticIndexStatus;
  lexicalFallbackUsed: boolean;
}

interface KnowledgeSearchResult {
  items: KnowledgeQueryResultItem[];
  mode: KnowledgeQueryMode;
  semanticIndexStatus: KnowledgeSemanticIndexStatus;
  lexicalFallbackUsed: boolean;
}

function entryToItem(
  entry: KnowledgeEntry,
  goalId: string | null,
  mode: "keyword" | "semantic",
  relevance?: number
): KnowledgeQueryResultItem {
  return {
    entryId: entry.entry_id,
    content: `Q: ${entry.question}\nA: ${entry.answer}`,
    confidence: entry.confidence,
    source:
      entry.sources.length > 0
        ? (entry.sources[0]?.reference ?? "unknown")
        : "unknown",
    goalId,
    mode,
    ...(relevance !== undefined ? { relevance } : {}),
  };
}

function keywordMatch(entry: KnowledgeEntry, query: string): boolean {
  const lower = query.toLowerCase();
  return (
    entry.question.toLowerCase().includes(lower) ||
    entry.answer.toLowerCase().includes(lower) ||
    entry.tags.some((t) => t.toLowerCase().includes(lower))
  );
}

export class KnowledgeQueryTool
  implements ITool<KnowledgeQueryInput, KnowledgeQueryOutput>
{
  readonly metadata: ToolMetadata = {
    name: "knowledge_query",
    aliases: ["query_knowledge", "search_knowledge"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
    activityCategory: "search",
  };

  readonly inputSchema = KnowledgeQueryInputSchema;

  constructor(private readonly knowledgeManager: KnowledgeManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: KnowledgeQueryInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const search = await this._search(input);
      const limited = search.items.slice(0, input.limit);
      const output: KnowledgeQueryOutput = {
        results: limited,
        totalFound: search.items.length,
        requestedMode: input.type,
        mode: search.mode,
        semanticIndexStatus: search.semanticIndexStatus,
        lexicalFallbackUsed: search.lexicalFallbackUsed,
      };

      return {
        success: true,
        data: output,
        summary: summaryForKnowledgeQuery(input, search),
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { results: [], totalFound: 0 },
        summary: `Knowledge query failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async _search(
    input: KnowledgeQueryInput
  ): Promise<KnowledgeSearchResult> {
    if (input.type === "semantic") {
      return this._semanticSearch(input);
    }
    return {
      items: await this._keywordSearch(input),
      mode: "keyword",
      semanticIndexStatus: "not_requested",
      lexicalFallbackUsed: false,
    };
  }

  private async _keywordSearch(
    input: KnowledgeQueryInput
  ): Promise<KnowledgeQueryResultItem[]> {
    if (input.goalId) {
      const entries = await this.knowledgeManager.loadKnowledge(input.goalId);
      return entries
        .filter((e) => keywordMatch(e, input.query))
        .map((e) => entryToItem(e, input.goalId ?? null, "keyword"));
    }

    // Cross-goal keyword search via shared KB
    const shared = await this.knowledgeManager.querySharedKnowledge([]);
    return shared
      .filter(
        (e) =>
          keywordMatch(e, input.query)
      )
      .map((e) =>
        entryToItem(e, e.source_goal_ids[0] ?? null, "keyword")
      );
  }

  private async _semanticSearch(
    input: KnowledgeQueryInput
  ): Promise<KnowledgeSearchResult> {
    if (!this._hasSemanticIndex()) {
      return {
        items: await this._keywordSearch(input),
        mode: "semantic_unavailable",
        semanticIndexStatus: "unavailable",
        lexicalFallbackUsed: true,
      };
    }

    if (input.goalId) {
      const entries = await this.knowledgeManager.searchKnowledge(
        input.query,
        input.limit
      );
      return {
        items: entries.map((e) => entryToItem(e, input.goalId ?? null, "semantic")),
        mode: "semantic",
        semanticIndexStatus: "available",
        lexicalFallbackUsed: false,
      };
    }

    // Cross-goal semantic search
    const results = await this.knowledgeManager.searchByEmbedding(
      input.query,
      input.limit
    );
    return {
      items: results.map(({ entry, similarity }) =>
        entryToItem(entry, entry.source_goal_ids[0] ?? null, "semantic", similarity)
      ),
      mode: "semantic",
      semanticIndexStatus: "available",
      lexicalFallbackUsed: false,
    };
  }

  private _hasSemanticIndex(): boolean {
    const manager = this.knowledgeManager as KnowledgeManager & {
      hasKnowledgeSemanticIndex?: () => boolean;
    };
    return manager.hasKnowledgeSemanticIndex?.() ?? true;
  }

  async checkPermissions(_input: KnowledgeQueryInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: KnowledgeQueryInput): boolean {
    return true;
  }
}

function summaryForKnowledgeQuery(input: KnowledgeQueryInput, search: KnowledgeSearchResult): string {
  const limitSuffix = search.items.length > input.limit ? ` (showing first ${input.limit})` : "";
  if (search.mode === "semantic_unavailable") {
    return `Semantic knowledge search unavailable; returned ${search.items.length} keyword fallback entries for query "${input.query}"${limitSuffix}`;
  }
  return `Found ${search.items.length} knowledge entries for query "${input.query}" using ${search.mode} mode${limitSuffix}`;
}
