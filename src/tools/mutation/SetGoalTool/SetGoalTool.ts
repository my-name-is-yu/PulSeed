import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type InterventionDecisionKind,
} from "../../../runtime/personal-agent/index.js";

export const SetGoalInputSchema = z.object({
  description: z.string().min(1, "description is required"),
}).strict();
export type SetGoalInput = z.infer<typeof SetGoalInputSchema>;

export class SetGoalTool implements ITool<SetGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "set_goal",
    aliases: ["create_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = SetGoalInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SetGoalInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const now = new Date().toISOString();
      const normalized = this.inputSchema.parse(input);
      const goalId = setGoalId(normalized, _context);
      if (!_context.preApproved) {
        await this.recordGoalDecision(normalized, _context, {
          goalId,
          now,
          decision: "confirm_required",
          reason: "Goal creation requires InterventionPolicy confirmation before durable state is mutated.",
        });
        return {
          success: false,
          data: null,
          summary: "Goal creation requires approval before execution.",
          execution: {
            status: "not_executed",
            reason: "permission_denied",
            message: "set_goal requires approval before creating a durable goal.",
          },
          durationMs: Date.now() - startTime,
        };
      }
      await this.recordGoalDecision(normalized, _context, {
        goalId,
        now,
        decision: "allow",
        reason: "Goal creation was allowed by InterventionPolicy after Capability Registry confirmed durable state write capability.",
      });
      const existing = typeof this.stateManager.loadGoal === "function"
        ? await this.stateManager.loadGoal(goalId).catch(() => null)
        : null;
      if (existing) {
        return {
          success: true,
          data: { goalId },
          summary: "Goal already exists: " + goalId,
          durationMs: Date.now() - startTime,
        };
      }
      const goal = {
        id: goalId,
        parent_id: null,
        node_type: "goal" as const,
        title: normalized.description.slice(0, 120),
        description: normalized.description,
        status: "active" as const,
        dimensions: [],
        gap_aggregation: "max" as const,
        dimension_mapping: null,
        constraints: [],
        children_ids: [],
        target_date: null,
        origin: "manual" as const,
        pace_snapshot: null,
        deadline: null,
        confidence_flag: null,
        user_override: false,
        feasibility_note: null,
        uncertainty_weight: 1.0,
        decomposition_depth: 0,
        specificity_score: null,
        loop_status: "idle" as const,
        created_at: now,
        updated_at: now,
      };
      await this.stateManager.saveGoal(goal);
      return {
        success: true,
        data: { goalId },
        summary: "Goal created: " + goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "SetGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: SetGoalInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return _context?.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "set_goal creates durable goal state" };
  }

  isConcurrencySafe(_input?: SetGoalInput): boolean {
    return false;
  }

  private async recordGoalDecision(
    input: SetGoalInput,
    context: ToolCallContext,
    decision: {
      goalId: string;
      now: string;
      decision: InterventionDecisionKind;
      reason: string;
    },
  ): Promise<void> {
    const baseDir = typeof this.stateManager.getBaseDir === "function" ? this.stateManager.getBaseDir() : null;
    const store = this.personalAgentRuntime
      ?? (baseDir ? new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir }) : null);
    if (!store) return;
    await store.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "explicit_user_command",
      source: {
        sourceKind: "explicit_command",
        sourceId: context.callId ?? context.turnId ?? decision.goalId,
        emittedAt: decision.now,
        sourceEpoch: context.turnId ?? context.callId ?? "tool-call",
        highWatermark: context.sessionId ?? context.conversationSessionId ?? "session:none",
        replayKey: setGoalReplayKey(input, context),
        summary: "set_goal requested durable goal creation.",
        sourceRef: { kind: "tool_call", ref: context.callId ?? "set_goal" },
      },
      target: {
        kind: "goal",
        ref: { kind: "goal", ref: decision.goalId },
        effect: "create_goal",
        summary: input.description,
      },
      decision: decision.decision,
      decisionReason: decision.reason,
      capabilityDecision: decision.decision === "allow" ? "available" : "permission_required",
      capabilityRefs: [{ kind: "capability", ref: "durable_goal_state_write" }],
      policyRef: { kind: "intervention_policy", ref: "policy:tool-materialization-v1" },
      permissionRequired: decision.decision !== "allow",
      currentRefs: [{ kind: "tool_call", ref: "set_goal" }],
      auditRefs: [
        { kind: "tool_call", ref: context.callId ?? "set_goal" },
        ...(context.turnId ? [{ kind: "turn", ref: context.turnId }] : []),
      ],
      ...(decision.decision === "allow"
        ? {
            outcomeEvent: {
              type: "action_outcome",
              summary: "set_goal materialized a durable goal.",
              targetRef: { kind: "goal", ref: decision.goalId },
            },
          }
        : {}),
    }));
  }
}

function setGoalId(input: SetGoalInput, context: ToolCallContext): string {
  return `goal:tool:set_goal:${stableId(setGoalReplayKey(input, context))}`;
}

function setGoalReplayKey(input: SetGoalInput, context: ToolCallContext): string {
  return [
    "tool:set_goal",
    input.description.trim(),
    context.conversationSessionId ?? context.sessionId ?? "session:none",
    context.turnId ?? context.callId ?? context.cwd,
  ].join(":");
}
