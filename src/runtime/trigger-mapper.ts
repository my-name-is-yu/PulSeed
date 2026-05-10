import * as path from "node:path";
import { z } from "zod";
import type { TriggerEvent, TriggerMapping } from "../base/types/trigger.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { readTriggerMappingsConfig } from "./trigger-mappings-json.js";

export type TriggerAction = "observe" | "create_task" | "notify" | "wake" | "none";

const LlmTriggerResolutionSchema = z.object({
  goal_id: z.string().min(1),
  action: z.enum(["observe", "create_task", "notify", "wake"]),
}).strict();

type LlmTriggerResolution = z.infer<typeof LlmTriggerResolutionSchema>;

export interface ResolveResult {
  action: TriggerAction;
  goal_id: string | null;
  source: "mapping" | "llm" | "default";
}

export interface GoalSummary {
  id: string;
  title: string;
  status: string;
}

export class TriggerMapper {
  private mappings: TriggerMapping[] = [];
  private llmCache: Map<string, LlmTriggerResolution> = new Map();

  constructor(
    private baseDir: string,
    private llmClient?: ILLMClient,
  ) {}

  async loadMappings(): Promise<void> {
    const mappingsPath = path.join(this.baseDir, "trigger-mappings.json");
    try {
      const config = await readTriggerMappingsConfig(mappingsPath);
      this.mappings = config.mappings;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.mappings = [];
        return;
      }
      // Malformed file — treat as empty
      this.mappings = [];
    }
  }

  async resolve(
    trigger: TriggerEvent,
    goalSummaries: Array<GoalSummary>,
  ): Promise<ResolveResult> {
    // 1. Check explicit mappings
    const mapping = this.mappings.find(
      (m) => m.source === trigger.source && m.event_type === trigger.event_type,
    );
    if (mapping) {
      return {
        action: mapping.action,
        goal_id: mapping.goal_id ?? trigger.goal_id ?? null,
        source: "mapping",
      };
    }

    // 2. If trigger has goal_id, use it with default action "observe"
    if (trigger.goal_id) {
      return { action: "observe", goal_id: trigger.goal_id, source: "mapping" };
    }

    // 3. If llmClient available, try LLM resolution
    if (this.llmClient) {
      const goals = goalSummaries.map((g) => ({ id: g.id, title: g.title }));
      const llmResult = await this.llmResolve(trigger, goals);
      if (llmResult) {
        const action = llmResult.action;
        return { action, goal_id: llmResult.goal_id, source: "llm" };
      }
    }

    // 4. No match
    return { action: "none", goal_id: null, source: "default" };
  }

  private async llmResolve(
    trigger: TriggerEvent,
    goals: Array<{ id: string; title: string }>,
  ): Promise<LlmTriggerResolution | null> {
    const goalIds = new Set(goals.map((goal) => goal.id));
    if (goalIds.size === 0) return null;

    const cacheKey = buildLlmCacheKey(trigger, goals);
    const cached = this.llmCache.get(cacheKey);
    if (cached) {
      if (goalIds.has(cached.goal_id)) return cached;
      this.llmCache.delete(cacheKey);
    }

    try {
      const goalList = goals.map((g) => `- ${g.id}: ${g.title}`).join("\n");
      const prompt = [
        `Given event ${trigger.source}/${trigger.event_type} with data ${JSON.stringify(trigger.data)}, and goals:`,
        goalList,
        "Which goal is most relevant? What action should be taken?",
        "Respond with JSON only. Use an existing goal id, and set action to one of observe, create_task, notify, wake.",
        "{\"goal_id\":\"<existing goal id>\",\"action\":\"observe\"}",
      ].join("\n");

      const response = await this.llmClient!.sendMessage([
        { role: "user", content: prompt },
      ]);

      const parsed = this.llmClient!.parseJSON(response.content, LlmTriggerResolutionSchema);
      if (!goalIds.has(parsed.goal_id)) return null;

      this.llmCache.set(cacheKey, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  clearCache(): void {
    this.llmCache.clear();
  }

  getCacheSize(): number {
    return this.llmCache.size;
  }
}

function buildLlmCacheKey(trigger: TriggerEvent, goals: Array<{ id: string; title: string }>): string {
  const goalSignature = goals
    .map((goal) => `${goal.id}\u0000${goal.title}`)
    .sort()
    .join("\u0001");
  return [
    trigger.source,
    trigger.event_type,
    stableCacheString(trigger.data),
    goalSignature,
  ].join("\u0002");
}

function stableCacheString(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value)) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
