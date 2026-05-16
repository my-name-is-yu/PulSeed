import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";

import { StateManager } from "../../src/base/state/state-manager.js";
import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import type { IAdapter } from "../../src/orchestrator/execution/adapter-layer.js";
import { ChatRunner } from "../../src/interface/chat/chat-runner.js";
import type { ChatRunnerDeps } from "../../src/interface/chat/chat-runner-contracts.js";
import type { SelectedChatRoute } from "../../src/interface/chat/ingress-router.js";
import { cmdRuntime } from "../../src/interface/cli/commands/runtime.js";
import {
  InteractionAuthorityStore,
  projectPeerInitiativeDeliveryAuthority,
} from "../../src/runtime/control/index.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  projectPersonalAgentNormalSurface,
} from "../../src/runtime/personal-agent/index.js";
import {
  RuntimeEventEnvelopeSchema,
  RuntimeEventLogStore,
} from "../../src/runtime/store/runtime-event-log.js";
import { GoalTaskStateStore } from "../../src/runtime/store/goal-task-state-store.js";
import { PermissionWaitPlanStore } from "../../src/runtime/store/permission-wait-plan-store.js";
import {
  ConcurrencyController,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
  type ITool,
} from "../../src/tools/index.js";
import { makeGoal, makeTask } from "../helpers/fixtures.js";

const NOW = "2026-05-16T00:00:00.000Z";

describe("runtime event log source-of-truth contract", () => {
  it("records typed runtime events, RuntimeGraph causality, rebuildable projections, and operator CLI explanations", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const runtime = new PersonalAgentRuntimeStore(runtimeRoot, { controlBaseDir: root });
      const trace = buildPersonalAgentDecisionTrace({
        callerPath: "task_execution",
        source: {
          sourceKind: "task_execution",
          sourceId: "tool-call:source-of-truth-contract",
          emittedAt: NOW,
          sourceEpoch: "tool-executor-contract",
          highWatermark: "tool-call:source-of-truth-contract",
          replayKey: "tool-executor:source-of-truth-contract",
          summary: "ToolExecutor admitted a production-shaped tool call.",
          sourceRef: { kind: "tool_call", ref: "tool-call:source-of-truth-contract" },
        },
        target: {
          kind: "tool_call",
          ref: { kind: "tool_call", ref: "tool-call:source-of-truth-contract" },
          effect: "execute_tool",
          summary: "Execute a contract-shaped tool call.",
        },
        decision: "allow",
        decisionReason: "Tool execution was admitted before side effects.",
        capabilityDecision: "available",
        capabilityRefs: [{ kind: "tool", ref: "contract-tool" }],
        policyRef: { kind: "intervention_policy", ref: "policy:tool-executor-contract" },
        outcomeEvent: {
          type: "action_outcome",
          summary: "ToolExecutor returned executed without duplicate side effects.",
        },
      });
      await runtime.recordTrace(trace);

      const authorityStore = new InteractionAuthorityStore(runtimeRoot, { controlBaseDir: root });
      const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
        candidateId: "peer-candidate:source-of-truth-contract",
        deliveryId: "peer-delivery:source-of-truth-contract",
        surface: "telegram",
        reason: "Peer initiative delivery was admitted before Telegram transport.",
        decidedAt: NOW,
        canSend: true,
        canNotify: true,
        targetBindingRef: "gateway:telegram:home_chat:12345",
        channelPolicyRef: "gateway:telegram:policy",
        transportMessageRef: "telegram-message:123",
        normalSurfaceProjectionRef: "normal-projection:peer-source-of-truth",
      }));
      const chat = await new ChatRunner({
        stateManager: new StateManager(root),
        adapter: mockAdapter(),
        llmClient: llm("gateway event-log reply"),
        personalAgentRuntime: runtime,
      } as unknown as ChatRunnerDeps).execute("ordinary gateway runtime action", root, 10_000, {
        selectedRoute: gatewayModelRoute(),
      });
      expect(chat.success).toBe(true);

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const events = await eventLog.listEvents({ limit: 20 });
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        "tool.call.recorded",
        "gateway.telegram.delivery.recorded",
        "gateway.chat.ingress.recorded",
      ]));
      expect(events.every((event) =>
        event.schema_version === "runtime-event-envelope/v1"
        && event.payload_schema !== "runtime-event-payload/unknown"
        && event.payload_version !== "runtime-event-payload/unknown"
        && event.trace_id.length > 0
        && event.correlation_id.length > 0
        && event.idempotency_key.length > 0
      )).toBe(true);

      const loosePayload = RuntimeEventEnvelopeSchema.safeParse({
        ...events[0],
        payload: { arbitrary_json: true },
      });
      expect(loosePayload.success).toBe(false);

      const toolEvent = events.find((event) => event.event_type === "tool.call.recorded");
      expect(toolEvent).toBeTruthy();
      const duplicateToolEvent = await eventLog.append({
        ...toolEvent!,
        event_id: `${toolEvent!.event_id}:duplicate-event-id`,
        occurred_at: "2026-05-16T00:00:01.000Z",
      });
      expect(duplicateToolEvent.event_id).toBe(toolEvent!.event_id);
      const distinctToolEvent = await eventLog.append({
        ...toolEvent!,
        event_id: `${toolEvent!.event_id}:distinct-idempotency`,
        trace_id: `${toolEvent!.trace_id}:distinct`,
        correlation_id: `${toolEvent!.correlation_id}:distinct`,
        idempotency_key: `${toolEvent!.idempotency_key}:distinct`,
        occurred_at: "2026-05-16T00:00:02.000Z",
      });
      expect(distinctToolEvent.event_id).not.toBe(toolEvent!.event_id);
      const eventsAfterDedupe = await eventLog.listEvents({ eventType: "tool.call.recorded", limit: 20 });
      expect(eventsAfterDedupe.filter((event) => event.idempotency_key === toolEvent!.idempotency_key)).toHaveLength(1);

      const traceExplanation = await eventLog.explainTrace(trace.trace_id);
      expect(traceExplanation.runtime_graph.nodes.some((node) => node.node_kind === "runtime_event")).toBe(true);
      expect(traceExplanation.runtime_graph.edges.map((edge) => edge.edge_kind)).toEqual(expect.arrayContaining([
        "caused_by",
        "decided_by",
        "executed_by",
      ]));
      expect(traceExplanation.operator_debug_evidence.rebuilt_projection_names).toEqual(expect.arrayContaining([
        "tool_execution_outcome_summary",
      ]));

      const rebuild = await eventLog.rebuildProjections();
      expect(rebuild.interaction_authority_summary.decision_count).toBeGreaterThan(0);
      expect(rebuild.runtime_graph_evidence.edge_count).toBeGreaterThan(0);
      expect(rebuild.runtime_graph_evidence.edge_kinds).toEqual(expect.objectContaining({
        caused_by: expect.any(Number),
      }));
      expect(rebuild.peer_delivery_state).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision_id: authorityDecision.decision_id,
          delivery_ref: "peer-delivery:source-of-truth-contract",
          transport_message_ref: "telegram-message:123",
        }),
      ]));
      expect(rebuild.tool_execution_outcome_summary).toEqual(expect.arrayContaining([
        expect.objectContaining({
          trace_id: trace.trace_id,
          tool_refs: ["tool-call:source-of-truth-contract"],
        }),
      ]));

      const snapshot = await runtime.loadTrace(trace.trace_id);
      expect(snapshot).toBeTruthy();
      const normalProjection = projectPersonalAgentNormalSurface(snapshot!);
      expect(JSON.stringify(normalProjection)).not.toContain("runtime-event:");
      expect(JSON.stringify(normalProjection)).not.toContain("runtime-graph");
      expect(normalProjection.raw_trace_visible).toBe(false);
      expect(normalProjection.raw_refs_visible).toBe(false);
      expect(normalProjection.raw_evidence_refs_visible).toBe(false);

      const graphExplain = await captureConsoleLog(() =>
        cmdRuntime(new StateManager(root), ["graph", "explain", trace.trace_id, "--json"])
      );
      expect(graphExplain.code).toBe(0);
      const graphExplainJson = JSON.parse(graphExplain.output);
      expect(graphExplainJson.events[0].trace_id).toBe(trace.trace_id);
      expect(graphExplainJson.operator_debug_evidence.rebuilt_projection_names).toContain("tool_execution_outcome_summary");

      const rebuildCommand = await captureConsoleLog(() =>
        cmdRuntime(new StateManager(root), ["event-log", "rebuild", "--dry-run", "--json"])
      );
      expect(rebuildCommand.code).toBe(0);
      expect(JSON.parse(rebuildCommand.output).source_event_count).toBeGreaterThanOrEqual(2);

      const replayCommand = await captureConsoleLog(() =>
        cmdRuntime(new StateManager(root), ["replay", "--trace", trace.trace_id, "--json"])
      );
      expect(replayCommand.code).toBe(0);
      expect(JSON.parse(replayCommand.output).projection_rebuild.tool_execution_outcome_summary).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends approval resume events before ToolExecutor wait-plan mutation without an injected authority store", async () => {
    const root = fixtureRoot();
    const runtimeRoot = path.join(root, "runtime");
    const order: string[] = [];
    let now = 1_000;
    let callCount = 0;
    const waitStore = new PermissionWaitPlanStore(runtimeRoot, {
      controlBaseDir: root,
      now: () => now,
      createEventId: () => `wait-event:${now}`,
    });
    const permissionWaitPlanStore = {
      createWaiting: waitStore.createWaiting.bind(waitStore),
      markApproved: async (...args: Parameters<PermissionWaitPlanStore["markApproved"]>) => {
        order.push("wait:markApproved");
        return waitStore.markApproved(...args);
      },
      markDenied: waitStore.markDenied.bind(waitStore),
      markExpired: waitStore.markExpired.bind(waitStore),
      resumeApproved: async (...args: Parameters<PermissionWaitPlanStore["resumeApproved"]>) => {
        order.push("wait:resumeApproved");
        return waitStore.resumeApproved(...args);
      },
    };
    const originalAppendAuthority = RuntimeEventLogStore.prototype.appendAuthorityDecisionWithDisposition;
    const appendSpy = vi.spyOn(RuntimeEventLogStore.prototype, "appendAuthorityDecisionWithDisposition")
      .mockImplementation(function (this: RuntimeEventLogStore, decision) {
        order.push(`event:${decision.decision_id}`);
        return originalAppendAuthority.call(this, decision);
      });
    try {
      const registry = new ToolRegistry();
      registry.register(approvalRequiredTool(() => {
        callCount += 1;
      }));
      const executor = new ToolExecutor({
        registry,
        permissionManager: new ToolPermissionManager({}),
        concurrency: new ConcurrencyController(),
        traceBaseDir: root,
      });
      const result = await executor.execute("approval_order_contract", { value: "send" }, {
        cwd: root,
        goalId: "approval-order-goal",
        trustBalance: -100,
        preApproved: false,
        providerConfigBaseDir: root,
        callId: "tool-call:approval-order",
        sessionId: "session:approval-order",
        permissionWaitPlanStore,
        approvalFn: async () => {
          now = 2_000;
          return true;
        },
      });

      expect(result.success).toBe(true);
      expect(callCount).toBe(1);
      const preMutationEventIndex = order.findIndex((entry) => entry.includes(":before-mutation"));
      const markApprovedIndex = order.indexOf("wait:markApproved");
      const resumeApprovedIndex = order.indexOf("wait:resumeApproved");
      const finalResumeEventIndex = order.findLastIndex((entry) =>
        entry.startsWith("event:execution-authority:approval:")
        && entry.endsWith(":resume")
      );
      expect(preMutationEventIndex).toBeGreaterThanOrEqual(0);
      expect(markApprovedIndex).toBeGreaterThan(preMutationEventIndex);
      expect(resumeApprovedIndex).toBeGreaterThan(markApprovedIndex);
      expect(finalResumeEventIndex).toBeGreaterThan(resumeApprovedIndex);

      const eventLog = new RuntimeEventLogStore(root, { controlBaseDir: root });
      const approvalEvents = await eventLog.listEvents({ eventType: "approval.resume.recorded" });
      expect(approvalEvents.map((event) => event.authority_decision_ref?.ref)).toEqual(expect.arrayContaining([
        expect.stringContaining(":before-mutation"),
        expect.stringMatching(/^execution-authority:approval:.*:resume$/),
      ]));
    } finally {
      appendSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends goal/task mutation events before projection writes and rebuilds with RuntimeGraph evidence", async () => {
    const root = fixtureRoot();
    const store = new GoalTaskStateStore(root, { controlBaseDir: root });
    const observer = new GoalTaskStateStore(root, { controlBaseDir: root });
    const observations: string[] = [];
    const originalAppendGoalTask = RuntimeEventLogStore.prototype.appendGoalTaskMutation;
    const appendSpy = vi.spyOn(RuntimeEventLogStore.prototype, "appendGoalTaskMutation")
      .mockImplementation(async function (this: RuntimeEventLogStore, input) {
        if (input.entityKind === "goal") {
          observations.push(`goal:${input.action}:${await observer.loadGoal(input.goal.id) ? "present" : "absent"}`);
        } else {
          observations.push(`task:${input.action}:${await observer.loadTask(input.goalId, input.taskId) ? "present" : "absent"}`);
        }
        return originalAppendGoalTask.call(this, input);
      });
    try {
      const goal = makeGoal({
        id: "event-log-goal",
        title: "Event log goal",
        updated_at: NOW,
      });
      const task = makeTask({
        id: "event-log-task",
        goal_id: goal.id,
        work_description: "Exercise goal/task mutation event append.",
        created_at: NOW,
      });

      await store.saveGoal(goal);
      await store.saveTask(task);
      await store.deleteTask(goal.id, task.id);
      await expect(store.deleteTask(goal.id, "event-log-missing-task")).resolves.toBe(false);
      const archiveGoal = makeGoal({
        id: "event-log-archive-goal",
        title: "Event log archive goal",
        updated_at: NOW,
      });
      await store.saveGoal(archiveGoal);
      await store.markGoalArchived(archiveGoal.id);
      const deleteGoal = makeGoal({
        id: "event-log-delete-goal",
        title: "Event log delete goal",
        updated_at: NOW,
      });
      const deleteTask = makeTask({
        id: "event-log-delete-task",
        goal_id: deleteGoal.id,
        work_description: "Exercise deleteGoal mutation event append.",
        created_at: NOW,
      });
      await store.saveGoal(deleteGoal);
      await store.saveTask(deleteTask);
      await store.deleteGoal(deleteGoal.id);

      expect(observations).toEqual([
        "goal:save:absent",
        "task:save:absent",
        "task:delete:present",
        "goal:save:absent",
        "goal:archive:present",
        "goal:save:absent",
        "task:save:absent",
        "goal:delete:present",
        "task:delete:present",
      ]);
      const eventLog = new RuntimeEventLogStore(root, { controlBaseDir: root });
      const events = await eventLog.listEvents({ limit: 50 });
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        "goal.mutation.recorded",
        "task.mutation.recorded",
      ]));
      expect(events.some((event) => event.task_id === "event-log-missing-task")).toBe(false);
      expect(events.filter((event) => event.payload_schema === "runtime-event-payload/goal-task-mutation/v1")).toHaveLength(9);
      const rebuild = await eventLog.rebuildProjections();
      expect(rebuild.runtime_graph_evidence.edge_kinds).toEqual(expect.objectContaining({
        caused_by: expect.any(Number),
        projected_to: expect.any(Number),
        executed_by: expect.any(Number),
      }));
      expect(rebuild.runtime_graph_evidence.source_event_refs.length).toBeGreaterThanOrEqual(3);
    } finally {
      appendSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuilds graph-backed projections from more than 1000 event-log rows", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const authorityStore = new InteractionAuthorityStore(runtimeRoot, { controlBaseDir: root });
      const eventCount = 1005;
      for (let index = 0; index < eventCount; index += 1) {
        await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
          candidateId: `peer-candidate:bulk-${index}`,
          deliveryId: `peer-delivery:bulk-${index}`,
          surface: "telegram",
          reason: "Bulk peer delivery projection rebuild coverage.",
          decidedAt: new Date(Date.parse(NOW) + index).toISOString(),
          canSend: true,
          canNotify: true,
          targetBindingRef: `gateway:telegram:bulk:${index}`,
          channelPolicyRef: "gateway:telegram:policy",
          transportMessageRef: `telegram-message:bulk-${index}`,
          normalSurfaceProjectionRef: `normal-projection:bulk-${index}`,
        }));
      }

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const defaultLimitedEvents = await eventLog.listEvents({
        eventType: "gateway.telegram.delivery.recorded",
      });
      expect(defaultLimitedEvents).toHaveLength(500);

      const rebuild = await eventLog.rebuildProjections();
      expect(rebuild.source_event_count).toBe(eventCount);
      expect(rebuild.peer_delivery_state).toHaveLength(eventCount);
      expect(rebuild.runtime_graph_evidence.source_event_refs).toHaveLength(eventCount);
      expect(rebuild.peer_delivery_state.at(-1)).toEqual(expect.objectContaining({
        delivery_ref: "peer-delivery:bulk-1004",
        transport_message_ref: "telegram-message:bulk-1004",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fixtureRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-event-contract-"));
}

async function captureConsoleLog(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  try {
    const code = await run();
    return { code, output: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

function gatewayModelRoute(): SelectedChatRoute {
  return {
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function llm(content: string): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn((raw: string, schema?: { parse(value: unknown): unknown }) => {
      const parsed = JSON.parse(raw) as unknown;
      return schema ? schema.parse(parsed) : parsed;
    }),
    supportsToolCalling: () => true,
  } as unknown as ILLMClient;
}

function mockAdapter(): IAdapter {
  return {
    adapterType: "mock-adapter",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
    }),
  } as unknown as IAdapter;
}

function approvalRequiredTool(onCall: () => void): ITool<{ value: string }> {
  return {
    metadata: {
      name: "approval_order_contract",
      aliases: [],
      permissionLevel: "write_remote",
      isReadOnly: false,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8_000,
      tags: ["contract"],
      requiresNetwork: true,
      activityCategory: "command",
    },
    inputSchema: z.object({ value: z.string() }),
    description: () => "Approval ordering contract test tool.",
    checkPermissions: async () => ({
      status: "needs_approval",
      reason: "Approval ordering test requires confirmation.",
    }),
    isConcurrencySafe: () => false,
    call: async (input) => {
      onCall();
      return {
        success: true,
        data: input,
        summary: "approval ordering tool executed",
        durationMs: 0,
        execution: { status: "executed" },
      };
    },
  };
}
