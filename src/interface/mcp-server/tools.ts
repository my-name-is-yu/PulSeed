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
  type RuntimeGraphRef,
  type PersonalAgentRuntimeStore,
} from "../../runtime/personal-agent/index.js";
import {
  admitCapabilityDescriptor,
  descriptorFromMcpServerTool,
  type CapabilityAdmissionDecision,
  type CapabilityDescriptor,
} from "../../runtime/capability-plane.js";
import type {
  CapabilityOperationKind,
  CapabilitySideEffectProfile,
} from "../../runtime/store/capability-verification-schemas.js";

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
    const blocked = await recordMcpServerReadAdmission(deps, {
      toolName: "pulseed_goal_list",
      args: {},
      targetSummary: "List PulSeed goals through the MCP server.",
    });
    if (blocked) return blocked;
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
    const blocked = await recordMcpServerReadAdmission(deps, {
      toolName: "pulseed_goal_status",
      args,
      targetSummary: `Read PulSeed goal status for ${args.goal_id}.`,
      currentRefs: [{ kind: "goal", ref: args.goal_id }],
    });
    if (blocked) return blocked;
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
    const argsFingerprint = stableId(stableJson(args));
    const capabilityAdmission = admitMcpServerToolCapability({
      toolName: "pulseed_goal_create",
      operationKind: "mutate",
      sideEffectProfile: "mutate",
      args,
      callId: `mcp:pulseed_goal_create:${argsFingerprint}`,
    });
    if (capabilityAdmission.admission.status !== "allowed") {
      await recordExplicitCommandDecision({
        baseDir: deps.baseDir,
        personalAgentRuntime: deps.personalAgentRuntime,
        surface: "mcp",
        command: "pulseed_goal_create",
        sourceId: `pulseed_goal_create:${argsFingerprint}`,
        sourceEpoch: argsFingerprint,
        target: {
          kind: "goal",
          ref: { kind: "goal", ref: `pending:${argsFingerprint}` },
          effect: "create_goal",
          summary: `Create MCP goal "${args.title}".`,
        },
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: capabilityAdmission.admission.reason,
        capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
        currentRefs: [{ kind: "mcp_tool", ref: "pulseed_goal_create" }],
      });
      return err(capabilityAdmission.admission.reason);
    }

    await recordExplicitCommandDecision({
      baseDir: deps.baseDir,
      personalAgentRuntime: deps.personalAgentRuntime,
      surface: "mcp",
      command: "pulseed_goal_create",
      sourceId: `pulseed_goal_create:${argsFingerprint}`,
      sourceEpoch: argsFingerprint,
      target: {
        kind: "goal",
        ref: { kind: "goal", ref: `pending:${argsFingerprint}` },
        effect: "create_goal",
        summary: `Create MCP goal "${args.title}".`,
      },
      decisionReason: "MCP goal creation was allowed after Capability Plane descriptor admission before local goal-id collision reads.",
      capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
      currentRefs: [{ kind: "mcp_tool", ref: "pulseed_goal_create" }],
    });

    const goalId = await allocateDeterministicGoalId({
      command: "pulseed_goal_create",
      title: args.title,
      description: args.description,
    }, async (candidate) => (await deps.stateManager.loadGoal(candidate)) !== null);
    const now = new Date().toISOString();
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
      decisionReason: "MCP goal creation was allowed after Capability Plane descriptor admission.",
      capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
      currentRefs: [{ kind: "mcp_tool", ref: "pulseed_goal_create" }],
    });
    await deps.stateManager.saveGoal(goal);
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
      decisionReason: "MCP goal creation completed after Capability Plane descriptor admission.",
      capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
      currentRefs: [
        { kind: "mcp_tool", ref: "pulseed_goal_create" },
        { kind: "goal", ref: goalId },
      ],
      outcomeSummary: `MCP goal ${goalId} was created after descriptor-backed admission.`,
    });
    return ok({ goal_id: goalId, title: args.title, status: goal.status });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_observe ───

export async function toolObserve(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const blocked = await recordMcpServerReadAdmission(deps, {
      toolName: "pulseed_observe",
      args,
      targetSummary: `Read PulSeed observations for ${args.goal_id}.`,
      currentRefs: [{ kind: "goal", ref: args.goal_id }],
    });
    if (blocked) return blocked;
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
    const blocked = await recordMcpServerReadAdmission(deps, {
      toolName: "pulseed_task_list",
      args,
      targetSummary: `Read PulSeed tasks for ${args.goal_id}.`,
      currentRefs: [{ kind: "goal", ref: args.goal_id }],
    });
    if (blocked) return blocked;
    const tasks = await deps.stateManager.listTasks(args.goal_id);
    return ok({ goal_id: args.goal_id, tasks });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_knowledge_search ───

export async function toolKnowledgeSearch(deps: MCPServerDeps, args: { query: string }): Promise<MCPResult> {
  try {
    const blocked = await recordMcpServerReadAdmission(deps, {
      toolName: "pulseed_knowledge_search",
      args,
      targetSummary: "Read PulSeed shared knowledge entries through the MCP server.",
      currentRefs: [{ kind: "knowledge_query", ref: stableId(args.query) }],
    });
    if (blocked) return blocked;
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
    const capabilityAdmission = admitMcpServerToolCapability({
      toolName: "pulseed_trigger",
      operationKind: "mutate",
      sideEffectProfile: "mutate",
      args,
      callId: `mcp:pulseed_trigger:${eventId}`,
    });
    if (capabilityAdmission.admission.status !== "allowed") {
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
        decision: "block",
        capabilityDecision: "blocked",
        decisionReason: capabilityAdmission.admission.reason,
        capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
        currentRefs: [
          { kind: "mcp_tool", ref: "pulseed_trigger" },
          { kind: "external_event_source", ref: args.source },
          { kind: "external_event_type", ref: args.event_type },
        ],
      });
      return err(capabilityAdmission.admission.reason);
    }

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
      decisionReason: "MCP trigger enqueue was allowed after Capability Plane descriptor admission.",
      capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
      currentRefs: [
        { kind: "mcp_tool", ref: "pulseed_trigger" },
        { kind: "external_event_source", ref: args.source },
        { kind: "external_event_type", ref: args.event_type },
      ],
    });
    await writeEventSpoolJson(eventsDir, event, { fileName: `${eventId}.json` });
    await recordExplicitCommandDecision({
      baseDir: deps.baseDir,
      personalAgentRuntime: deps.personalAgentRuntime,
      surface: "mcp",
      command: "pulseed_trigger",
      sourceId: `pulseed_trigger:${eventId}`,
      sourceEpoch: eventId,
      replayKey: ["mcp_trigger", eventSeed, "outcome"].join(":"),
      target: {
        kind: "attention_only",
        ref: { kind: "event_spool", ref: eventId },
        effect: "continue_route",
        summary: `Queue MCP trigger "${args.event_type}" from "${args.source}".`,
      },
      decisionReason: "MCP trigger enqueue completed after Capability Plane descriptor admission.",
      capabilityRefs: mcpServerCapabilityAdmissionRefs(capabilityAdmission),
      currentRefs: [
        { kind: "mcp_tool", ref: "pulseed_trigger" },
        { kind: "event_spool", ref: eventId },
        { kind: "external_event_source", ref: args.source },
        { kind: "external_event_type", ref: args.event_type },
      ],
      outcomeSummary: `MCP trigger ${eventId} was queued for runtime event processing.`,
    });
    return ok({ event_id: eventId, status: "queued" });
  } catch (e) {
    return err(String(e));
  }
}

type McpServerToolCapabilityAdmission = {
  descriptor: CapabilityDescriptor;
  admission: CapabilityAdmissionDecision;
};

async function recordMcpServerReadAdmission(
  deps: MCPServerDeps,
  input: {
    toolName: string;
    args: unknown;
    targetSummary: string;
    currentRefs?: RuntimeGraphRef[];
  },
): Promise<MCPResult | null> {
  const argsFingerprint = stableId(stableJson(input.args));
  const capabilityAdmission = admitMcpServerToolCapability({
    toolName: input.toolName,
    operationKind: "read",
    sideEffectProfile: "read",
    args: input.args,
    callId: `mcp:${input.toolName}:${argsFingerprint}`,
  });
  const capabilityRefs = mcpServerCapabilityAdmissionRefs(capabilityAdmission);
  if (capabilityAdmission.admission.status !== "allowed") {
    await recordExplicitCommandDecision({
      baseDir: deps.baseDir,
      personalAgentRuntime: deps.personalAgentRuntime,
      surface: "mcp",
      command: input.toolName,
      sourceId: `${input.toolName}:${argsFingerprint}`,
      sourceEpoch: argsFingerprint,
      target: {
        kind: "runtime_control",
        ref: { kind: "mcp_tool", ref: input.toolName },
        effect: "none",
        summary: input.targetSummary,
      },
      decision: "block",
      capabilityDecision: "blocked",
      decisionReason: capabilityAdmission.admission.reason,
      capabilityRefs,
      currentRefs: [
        { kind: "mcp_tool", ref: input.toolName },
        ...(input.currentRefs ?? []),
      ],
    });
    return err(capabilityAdmission.admission.reason);
  }

  await recordExplicitCommandDecision({
    baseDir: deps.baseDir,
    personalAgentRuntime: deps.personalAgentRuntime,
    surface: "mcp",
    command: input.toolName,
    sourceId: `${input.toolName}:${argsFingerprint}`,
    sourceEpoch: argsFingerprint,
    target: {
      kind: "runtime_control",
      ref: { kind: "mcp_tool", ref: input.toolName },
      effect: "none",
      summary: input.targetSummary,
    },
    decisionReason: `MCP read tool ${input.toolName} was allowed after Capability Plane descriptor admission before local state access.`,
    capabilityRefs,
    currentRefs: [
      { kind: "mcp_tool", ref: input.toolName },
      ...(input.currentRefs ?? []),
    ],
  });
  return null;
}

function admitMcpServerToolCapability(input: {
  toolName: string;
  operationKind: CapabilityOperationKind;
  sideEffectProfile: CapabilitySideEffectProfile;
  args: unknown;
  callId: string;
}): McpServerToolCapabilityAdmission {
  const descriptor = descriptorFromMcpServerTool({
    toolName: input.toolName,
    operationKind: input.operationKind,
    sideEffectProfile: input.sideEffectProfile,
    readinessState: "executable_verified",
  });
  const admission = admitCapabilityDescriptor({
    descriptor,
    rawInput: {
      tool_name: input.toolName,
      arguments: input.args,
    },
    context: {
      preApproved: true,
      authorityRefs: descriptor.authority_requirements.required_refs,
      callId: input.callId,
    },
  });
  return { descriptor, admission };
}

function mcpServerCapabilityAdmissionRefs(input: McpServerToolCapabilityAdmission): RuntimeGraphRef[] {
  return [
    { kind: "capability", ref: input.descriptor.capability_id },
    { kind: "capability_provider", ref: input.descriptor.provider_ref },
    { kind: "capability_operation", ref: input.descriptor.runtime_graph_refs.operation_ref },
    { kind: "capability_admission", ref: input.admission.admission_id },
    ...(input.admission.capability_fingerprint
      ? [{ kind: "capability_fingerprint", ref: input.admission.capability_fingerprint }]
      : []),
  ];
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
