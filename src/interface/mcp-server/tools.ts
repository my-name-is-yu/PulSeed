// ─── MCP Server Tool Implementations ───

import * as path from "node:path";
import { writeEventSpoolJson } from "../../base/utils/event-spool.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { Goal } from "../../base/types/goal.js";
import { loadSharedEntries } from "../../platform/knowledge/knowledge-search.js";
import {
  allocateDeterministicGoalId,
  recordExplicitCommandDecision,
  stableId,
  type PersonalAgentRuntimeStore,
} from "../../runtime/personal-agent/index.js";

export interface MCPServerDeps {
  stateManager: StateManager;
  baseDir: string;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
}

type MCPResult = { content: [{ type: "text"; text: string }] };

function ok(data: unknown): MCPResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function err(message: string): MCPResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

// ─── pulseed_goal_list ───

export async function toolGoalList(deps: MCPServerDeps): Promise<MCPResult> {
  try {
    const ids = await deps.stateManager.listGoalIds();
    const goals = await Promise.all(
      ids.map(async (id) => {
        const goal = await deps.stateManager.loadGoal(id);
        if (!goal) return null;
        return { id: goal.id, title: goal.title, status: goal.status, loop_status: goal.loop_status };
      })
    );
    return ok(goals.filter(Boolean));
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_goal_status ───

export async function toolGoalStatus(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const goal = await deps.stateManager.loadGoal(args.goal_id);
    if (!goal) return err(`Goal not found: ${args.goal_id}`);
    const gapHistory = await deps.stateManager.loadGapHistory(args.goal_id);
    const latestGap = gapHistory.length > 0 ? gapHistory[gapHistory.length - 1] : null;
    return ok({ goal, latest_gap: latestGap });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_goal_create ───

export async function toolGoalCreate(
  deps: MCPServerDeps,
  args: { title: string; description: string }
): Promise<MCPResult> {
  try {
    const now = new Date().toISOString();
    const goalId = await allocateDeterministicGoalId({
      command: "pulseed_goal_create",
      title: args.title,
      description: args.description,
    }, async (candidate) => (await deps.stateManager.loadGoal(candidate)) !== null);
    const goal: Goal = {
      id: goalId,
      parent_id: null,
      node_type: "goal",
      title: args.title,
      description: args.description,
      status: "active",
      dimensions: [],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: [],
      children_ids: [],
      target_date: null,
      origin: "manual",
      pace_snapshot: null,
      deadline: null,
      confidence_flag: null,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      decomposition_depth: 0,
      specificity_score: null,
      loop_status: "idle",
      created_at: now,
      updated_at: now,
    };
    await recordExplicitCommandDecision({
      baseDir: deps.baseDir,
      personalAgentRuntime: deps.personalAgentRuntime,
      surface: "mcp",
      command: "pulseed_goal_create",
      sourceId: `pulseed_goal_create:${goalId}`,
      sourceEpoch: goalId,
      target: {
        kind: "goal",
        ref: { kind: "goal", ref: goalId },
        effect: "create_goal",
        summary: `Create MCP goal "${args.title}".`,
      },
      decisionReason: "MCP goal creation was allowed by InterventionPolicy after Capability Registry evaluation.",
      capabilityRefs: [{ kind: "capability", ref: "mcp:pulseed_goal_create" }],
      currentRefs: [{ kind: "mcp_tool", ref: "pulseed_goal_create" }],
    });
    await deps.stateManager.saveGoal(goal);
    return ok({ goal_id: goalId, title: args.title, status: goal.status });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_observe ───

export async function toolObserve(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const log = await deps.stateManager.loadObservationLog(args.goal_id);
    if (!log) return ok({ goal_id: args.goal_id, observations: [] });
    const recent = log.entries.slice(-10);
    return ok({ goal_id: args.goal_id, observations: recent });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_task_list ───

export async function toolTaskList(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const tasks = await deps.stateManager.listTasks(args.goal_id);
    return ok({ goal_id: args.goal_id, tasks });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_knowledge_search ───

export async function toolKnowledgeSearch(deps: MCPServerDeps, args: { query: string }): Promise<MCPResult> {
  try {
    const entries = await loadSharedEntries(deps.stateManager);
    const q = args.query.toLowerCase();
    const matched = entries.filter((e) => {
      const text = `${e.question ?? ""} ${e.answer ?? ""} ${(e.tags ?? []).join(" ")}`.toLowerCase();
      return text.includes(q);
    });
    return ok({ query: args.query, results: matched.slice(0, 10) });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_trigger ───

export async function toolTrigger(
  deps: MCPServerDeps,
  args: { source: string; event_type: string; data: Record<string, unknown> }
): Promise<MCPResult> {
  try {
    const eventsDir = path.join(deps.baseDir, "events");
    const eventSeed = stableId(stableJson({
      source: args.source,
      event_type: args.event_type,
      data: args.data,
    }));
    const eventId = `mcp_trigger_${eventSeed}`;
    const event = {
      id: eventId,
      source: args.source,
      event_type: args.event_type,
      data: args.data,
      created_at: new Date().toISOString(),
    };
    await recordExplicitCommandDecision({
      baseDir: deps.baseDir,
      personalAgentRuntime: deps.personalAgentRuntime,
      surface: "mcp",
      command: "pulseed_trigger",
      sourceId: `pulseed_trigger:${eventId}`,
      sourceEpoch: eventId,
      replayKey: ["mcp_trigger", eventSeed].join(":"),
      target: {
        kind: "attention_only",
        ref: { kind: "event_spool", ref: eventId },
        effect: "continue_route",
        summary: `Queue MCP trigger "${args.event_type}" from "${args.source}".`,
      },
      decisionReason: "MCP trigger enqueue was allowed by InterventionPolicy after Capability Registry evaluation.",
      capabilityRefs: [{ kind: "capability", ref: "mcp:pulseed_trigger" }],
      currentRefs: [
        { kind: "mcp_tool", ref: "pulseed_trigger" },
        { kind: "external_event_source", ref: args.source },
        { kind: "external_event_type", ref: args.event_type },
      ],
      outcomeSummary: `MCP trigger ${eventId} was queued for runtime event processing.`,
    });
    await writeEventSpoolJson(eventsDir, event, { fileName: `${eventId}.json` });
    return ok({ event_id: eventId, status: "queued" });
  } catch (e) {
    return err(String(e));
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableJson(record[key])]),
    );
  }
  return value;
}
