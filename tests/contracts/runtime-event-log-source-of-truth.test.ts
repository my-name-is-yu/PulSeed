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
  type RuntimeEventEnvelope,
  RuntimeEventEnvelopeSchema,
  RuntimeEventLogStore,
  runtimeEventFromRuntimeControlOperationTransition,
} from "../../src/runtime/store/runtime-event-log.js";
import { AttentionStateStore } from "../../src/runtime/store/attention-state-store.js";
import { GoalTaskStateStore } from "../../src/runtime/store/goal-task-state-store.js";
import { OutboxStore } from "../../src/runtime/store/outbox-store.js";
import { PermissionWaitPlanStore } from "../../src/runtime/store/permission-wait-plan-store.js";
import { RuntimeOperationStore } from "../../src/runtime/store/runtime-operation-store.js";
import { RuntimeControlOperationSchema } from "../../src/runtime/store/runtime-operation-schemas.js";
import {
  openRuntimeControlDatabase,
  type SqliteDatabase,
} from "../../src/runtime/store/control-db/index.js";
import {
  CommitmentCandidateExtractionSchema,
  createCommitmentCandidate,
  ref,
} from "../../src/runtime/attention/index.js";
import type { AttentionScope } from "../../src/runtime/types/companion-autonomy.js";
import {
  ConcurrencyController,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
  type ITool,
  type ToolCallContext,
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

  it("keeps pre-mutation approval resume evidence distinct from final mismatch outcomes", async () => {
    const root = fixtureRoot();
    const runtimeRoot = path.join(root, "runtime");
    let callCount = 0;
    const waitStore = new PermissionWaitPlanStore(runtimeRoot, {
      controlBaseDir: root,
      now: () => 1_000,
      createEventId: () => "wait-event:approval-mismatch",
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
      const context: ToolCallContext = {
        cwd: root,
        goalId: "approval-mismatch-goal",
        trustBalance: -100,
        preApproved: false,
        providerConfigBaseDir: root,
        callId: "tool-call:approval-mismatch",
        sessionId: "session:approval-mismatch",
        hostToolState: { currentEpoch: "epoch-before" },
        permissionWaitPlanStore: waitStore,
        approvalFn: async () => {
          context.hostToolState = { currentEpoch: "epoch-after" };
          return true;
        },
      };

      const result = await executor.execute("approval_order_contract", { value: "send" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("state_epoch_changed");
      expect(callCount).toBe(0);
      const eventLog = new RuntimeEventLogStore(root, { controlBaseDir: root });
      const approvalEvents = await eventLog.listEvents({ eventType: "approval.resume.recorded", limit: 20 });
      const approvalDecisions = approvalEvents.flatMap((event) =>
        event.payload.schema_version === "runtime-event-payload/authority-decision/v1"
          ? [event.payload.decision]
          : []
      );
      const beforeMutation = approvalDecisions.find((decision) =>
        decision.decision_id.endsWith(":resume:before-mutation")
      );
      const finalMismatch = approvalDecisions.find((decision) =>
        decision.metadata["resume_status"] === "mismatch_rejected"
      );
      expect(beforeMutation).toBeTruthy();
      expect(finalMismatch).toBeTruthy();
      expect(beforeMutation).toMatchObject({
        lifecycle: "evidence",
        outcome: "prepare_only",
        can_prepare: true,
        can_execute: false,
        fail_closed: false,
        source: { stage: "prepare" },
        metadata: { resume_phase: "before_mutation", resume_status: "not_approved" },
      });
      expect(finalMismatch).toMatchObject({
        lifecycle: "terminal",
        outcome: "fail_closed",
        can_execute: false,
        fail_closed: true,
        source: { stage: "execute" },
        metadata: {
          resume_phase: "outcome",
          resume_status: "mismatch_rejected",
          mismatch_reasons: expect.arrayContaining(["state_epoch_changed"]),
        },
      });
      const beforeMutationEvent = approvalEvents.find((event) =>
        event.authority_decision_ref?.ref === beforeMutation!.decision_id
      );
      const finalMismatchEvent = approvalEvents.find((event) =>
        event.authority_decision_ref?.ref === finalMismatch!.decision_id
      );
      expect(beforeMutationEvent?.idempotency_key).toBeTruthy();
      expect(finalMismatchEvent?.idempotency_key).toBeTruthy();
      expect(finalMismatchEvent?.idempotency_key).not.toBe(beforeMutationEvent?.idempotency_key);
    } finally {
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

  it("event-sources commitment candidate lifecycle before current projection writes and applies rebuild snapshots", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const attentionStore = new AttentionStateStore(runtimeRoot, { controlBaseDir: root });
      const firstCandidate = commitmentCandidate();

      await attentionStore.saveCommitmentCandidates([firstCandidate]);
      await attentionStore.saveCommitmentCandidates([firstCandidate]);
      const resolved = await attentionStore.applyCommitmentControl({
        commitmentId: firstCandidate.commitment_id,
        control: "already_done",
        now: "2026-05-16T00:05:00.000Z",
        feedbackRef: "feedback:commitment-done",
      });

      expect(resolved).toMatchObject({
        commitment_id: firstCandidate.commitment_id,
        materialization_state: "resolved",
        feedback_refs: ["feedback:commitment-done"],
      });

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const events = await eventLog.listEvents({
        eventType: "attention.commitment.recorded",
        limit: null,
      });
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.payload_schema)).toEqual([
        "runtime-event-payload/attention-commitment/v1",
        "runtime-event-payload/attention-commitment/v1",
      ]);
      expect(events.flatMap((event) =>
        event.payload.schema_version === "runtime-event-payload/attention-commitment/v1"
          ? [event.payload.operation]
          : []
      )).toEqual(["candidate_saved", "lifecycle_control_applied"]);

      const rebuild = await eventLog.rebuildProjections({ traceId: events[0]!.trace_id });
      expect(rebuild.attention_commitment_lifecycle_summary).toEqual([
        expect.objectContaining({
          operation: "candidate_saved",
          commitment_id: firstCandidate.commitment_id,
          materialization_state: "watching",
          replay_key: firstCandidate.replay_key,
        }),
        expect.objectContaining({
          operation: "lifecycle_control_applied",
          commitment_id: firstCandidate.commitment_id,
          previous_materialization_state: "watching",
          materialization_state: "resolved",
          feedback_ref: "feedback:commitment-done",
        }),
      ]);

      await clearProjectionTables(runtimeRoot, root, ["DELETE FROM attention_commitment_candidates"]);
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([]);

      const traceApplyCommand = await captureConsoleError(() =>
        cmdRuntime(new StateManager(root), ["event-log", "rebuild", "--trace", events[0]!.trace_id, "--json"])
      );
      expect(traceApplyCommand.code).toBe(1);
      expect(traceApplyCommand.output).toContain("trace-scoped projection apply is not supported");
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([]);
      await expect(eventLog.applyProjectionRebuild({ traceId: events[0]!.trace_id }))
        .rejects.toThrow("Trace-scoped projection apply is not supported");

      const applied = await eventLog.applyProjectionRebuild();
      expect(applied.snapshots).toEqual(expect.arrayContaining([
        expect.objectContaining({
          projection_name: "attention_commitment_lifecycle_summary",
          scope: { kind: "control_db", ref: "default" },
        }),
      ]));
      expect(applied.current_state_projection_rows.attention_commitment_candidates).toBe(1);
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([
        expect.objectContaining({
          commitment_id: firstCandidate.commitment_id,
          materialization_state: "resolved",
          feedback_refs: ["feedback:commitment-done"],
        }),
      ]);
      await expect(eventLog.listProjectionSnapshots()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          projection_name: "attention_commitment_lifecycle_summary",
          source_event_count: 2,
        }),
      ]));

      const firstRebuildEvents = await eventLog.listEvents({
        eventType: "projection.rebuild.recorded",
        limit: null,
      });
      expect(firstRebuildEvents).toHaveLength(1);
      const appliedAgain = await eventLog.applyProjectionRebuild();
      expect(appliedAgain.rebuild.source_event_count).toBe(2);
      expect(appliedAgain.rebuild.runtime_graph_evidence.source_event_refs).toEqual(
        events.map((event) => event.event_id).sort(),
      );
      expect(appliedAgain.event.event_id).toBe(applied.event.event_id);
      await expect(eventLog.listEvents({
        eventType: "projection.rebuild.recorded",
        limit: null,
      })).resolves.toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("event-sources runtime-control operation projection transitions", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const store = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: root });
      const operation = RuntimeControlOperationSchema.parse({
        operation_id: "runtime-operation:event-log-contract",
        kind: "inspect_run",
        state: "pending",
        requested_at: NOW,
        updated_at: NOW,
        requested_by: { surface: "cli" },
        reply_target: { channel: "cli" },
        reason: "Contract test runtime operation projection.",
        expected_health: {
          daemon_ping: false,
          gateway_acceptance: false,
        },
        target: {
          goal_id: "runtime-event-goal",
          session_id: "runtime-event-session",
        },
      });

      await store.save(operation);
      const verifiedOperation = RuntimeControlOperationSchema.parse({
        ...operation,
        state: "verified",
        updated_at: "2026-05-16T00:01:00.000Z",
        completed_at: "2026-05-16T00:01:00.000Z",
      });
      await store.save(verifiedOperation);
      await store.save(verifiedOperation);

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const events = await eventLog.listEvents({
        eventType: "runtime_control.operation.recorded",
        limit: null,
      });
      expect(events).toHaveLength(2);
      const rebuild = await eventLog.rebuildProjections();
      expect(rebuild.runtime_control_operation_summary).toEqual([
        expect.objectContaining({
          operation_id: operation.operation_id,
          previous_state: null,
          state: "pending",
          goal_id: "runtime-event-goal",
        }),
        expect.objectContaining({
          operation_id: operation.operation_id,
          previous_state: "pending",
          state: "verified",
          terminal: true,
          session_id: "runtime-event-session",
        }),
      ]);
      expect(rebuild.runtime_graph_evidence.edge_kinds).toEqual(expect.objectContaining({
        caused_by: expect.any(Number),
        projected_to: expect.any(Number),
      }));

      await clearProjectionTables(runtimeRoot, root, ["DELETE FROM runtime_operations"]);
      await expect(store.load(operation.operation_id)).resolves.toBeNull();
      const applied = await eventLog.applyProjectionRebuild();
      expect(applied.current_state_projection_rows.runtime_operations).toBe(1);
      await expect(store.load(operation.operation_id)).resolves.toMatchObject({
        operation_id: operation.operation_id,
        state: "verified",
        completed_at: "2026-05-16T00:01:00.000Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records same-timestamp runtime operation content revisions before suppressing true no-ops", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const store = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: root });
      const operation = RuntimeControlOperationSchema.parse({
        operation_id: "runtime-operation:same-timestamp-content",
        kind: "inspect_run",
        state: "pending",
        requested_at: NOW,
        updated_at: NOW,
        requested_by: { surface: "cli" },
        reply_target: { channel: "cli" },
        reason: "Initial same-timestamp runtime operation content.",
        expected_health: {
          daemon_ping: false,
          gateway_acceptance: false,
        },
        target: {
          session_id: "session:same-timestamp-initial",
        },
      });
      const revisedOperation = RuntimeControlOperationSchema.parse({
        ...operation,
        reason: "Revised same-timestamp runtime operation content.",
        target: {
          session_id: "session:same-timestamp-revised",
        },
      });
      const finalOperation = RuntimeControlOperationSchema.parse({
        ...operation,
        reason: "Final same-timestamp runtime operation content.",
        target: {
          session_id: "session:same-timestamp-final",
        },
      });

      await store.save(operation);
      await store.save(revisedOperation);
      await store.save(finalOperation);
      await store.save(finalOperation);

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const events = await eventLog.listEvents({
        eventType: "runtime_control.operation.recorded",
        limit: null,
      });
      expect(events).toHaveLength(3);
      expect(events.flatMap((event) =>
        event.payload.schema_version === "runtime-event-payload/runtime-control-operation/v1"
          ? [event.payload.operation.reason]
          : []
      )).toEqual([
        "Initial same-timestamp runtime operation content.",
        "Revised same-timestamp runtime operation content.",
        "Final same-timestamp runtime operation content.",
      ]);

      await clearProjectionTables(runtimeRoot, root, ["DELETE FROM runtime_operations"]);
      await eventLog.applyProjectionRebuild();
      await expect(store.load(operation.operation_id)).resolves.toMatchObject({
        operation_id: operation.operation_id,
        reason: "Final same-timestamp runtime operation content.",
        target: {
          session_id: "session:same-timestamp-final",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies same-timestamp projection source events in append order", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const operationStore = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: root });
      const staleOperation = RuntimeControlOperationSchema.parse({
        operation_id: "runtime-operation:append-order-collision",
        kind: "inspect_run",
        state: "pending",
        requested_at: NOW,
        updated_at: NOW,
        requested_by: { surface: "cli" },
        reply_target: { channel: "cli" },
        reason: "Stale same-timestamp append-order state.",
        expected_health: {
          daemon_ping: false,
          gateway_acceptance: false,
        },
        target: {
          session_id: "session:append-order-stale",
        },
      });
      const finalOperation = RuntimeControlOperationSchema.parse({
        ...staleOperation,
        state: "verified",
        completed_at: NOW,
        reason: "Final same-timestamp append-order state.",
        target: {
          session_id: "session:append-order-final",
        },
        result: {
          ok: true,
          message: "Final append order state should win.",
        },
      });
      const staleEvent = RuntimeEventEnvelopeSchema.parse({
        ...runtimeEventFromRuntimeControlOperationTransition(staleOperation, null),
        event_id: "runtime-event:z-stale-lexicographic-after",
        runtime_graph_node_ref: { kind: "runtime_event", ref: "runtime-event:z-stale-lexicographic-after" },
        idempotency_key: "append-order-collision:stale",
      });
      const finalEvent = RuntimeEventEnvelopeSchema.parse({
        ...runtimeEventFromRuntimeControlOperationTransition(finalOperation, staleOperation),
        event_id: "runtime-event:a-final-lexicographic-before",
        runtime_graph_node_ref: { kind: "runtime_event", ref: "runtime-event:a-final-lexicographic-before" },
        idempotency_key: "append-order-collision:final",
      });

      await mutateRuntimeControlDatabase(runtimeRoot, root, (sqlite) => {
        insertRuntimeEventRowForTest(sqlite, staleEvent);
        insertRuntimeEventRowForTest(sqlite, finalEvent);
      });

      await eventLog.applyProjectionRebuild();
      await expect(operationStore.load(staleOperation.operation_id)).resolves.toMatchObject({
        operation_id: staleOperation.operation_id,
        state: "verified",
        reason: "Final same-timestamp append-order state.",
        target: {
          session_id: "session:append-order-final",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes high-volume task projections without expression-depth-limited predicates", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const goal = makeGoal({
        id: "high-volume-task-prune-goal",
        title: "High-volume task prune goal",
        updated_at: NOW,
      });
      await eventLog.appendGoalTaskMutation({
        entityKind: "goal",
        action: "save",
        goal,
      });
      const taskCount = 1_005;
      for (let index = 0; index < taskCount; index += 1) {
        const taskId = `high-volume-task-${index}`;
        await eventLog.appendGoalTaskMutation({
          entityKind: "task",
          action: "save",
          goalId: goal.id,
          taskId,
          task: makeTask({
            id: taskId,
            goal_id: goal.id,
            work_description: `High-volume task ${index}`,
            created_at: NOW,
            updated_at: NOW,
          }),
        });
      }

      await clearProjectionTables(runtimeRoot, root, ["DELETE FROM task_records"]);
      const applied = await eventLog.applyProjectionRebuild();
      expect(applied.current_state_projection_rows.task_records).toBe(taskCount);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies broader event-backed current-state projections without replaying side effects", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const goalStore = new GoalTaskStateStore(root, { controlBaseDir: root });
      const authorityStore = new InteractionAuthorityStore(runtimeRoot, { controlBaseDir: root });
      const outboxStore = new OutboxStore(runtimeRoot, { controlBaseDir: root });
      const operationStore = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: root });
      const attentionStore = new AttentionStateStore(runtimeRoot, { controlBaseDir: root });

      const goal = makeGoal({
        id: "event-backed-apply-goal",
        title: "Event-backed apply goal",
        updated_at: NOW,
      });
      const task = makeTask({
        id: "event-backed-apply-task",
        goal_id: goal.id,
        work_description: "Restore this task from the runtime event log.",
        created_at: NOW,
      });
      const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
        candidateId: "peer-candidate:event-backed-apply",
        deliveryId: "peer-delivery:event-backed-apply",
        surface: "telegram",
        reason: "Authority decision current-state projection apply coverage.",
        decidedAt: NOW,
        canSend: true,
        canNotify: true,
        targetBindingRef: "gateway:telegram:event-backed-apply",
        channelPolicyRef: "gateway:telegram:policy",
        transportMessageRef: "telegram-message:event-backed-apply",
        normalSurfaceProjectionRef: "normal-projection:event-backed-apply",
      }));
      const operation = RuntimeControlOperationSchema.parse({
        operation_id: "runtime-operation:event-backed-apply",
        kind: "inspect_run",
        state: "verified",
        requested_at: NOW,
        updated_at: "2026-05-16T00:01:00.000Z",
        completed_at: "2026-05-16T00:01:00.000Z",
        requested_by: { surface: "cli" },
        reply_target: { channel: "cli" },
        reason: "Event-backed broader apply coverage.",
        expected_health: {
          daemon_ping: false,
          gateway_acceptance: false,
        },
        target: {
          goal_id: goal.id,
          session_id: "session:event-backed-apply",
        },
      });
      const candidate = commitmentCandidate();

      await goalStore.saveGoal(goal);
      await goalStore.saveTask(task);
      await outboxStore.append({
        event_type: "goal_activated",
        goal_id: goal.id,
        correlation_id: "outbox:event-backed-apply",
        created_at: Date.parse(NOW),
        payload: { kind: "event-backed-apply" },
      });
      await operationStore.save(operation);
      await attentionStore.saveCommitmentCandidates([candidate]);

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const sourceEvents = await eventLog.listEvents({ limit: null });
      const sourceEventCount = sourceEvents.length;
      expect(sourceEvents.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        "goal.mutation.recorded",
        "task.mutation.recorded",
        "outbox.enqueue.recorded",
        "gateway.telegram.delivery.recorded",
        "runtime_control.operation.recorded",
        "attention.commitment.recorded",
      ]));

      await clearProjectionTables(runtimeRoot, root, [
        "DELETE FROM goal_records",
        "DELETE FROM task_records",
        "DELETE FROM interaction_authority_decisions",
        "DELETE FROM outbox_records",
        "DELETE FROM runtime_operations",
        "DELETE FROM attention_commitment_candidates",
        "DELETE FROM personal_agent_runtime_graph_nodes WHERE node_kind IN ('goal', 'task', 'milestone')",
      ]);
      await expect(goalStore.loadGoal(goal.id)).resolves.toBeNull();
      await expect(goalStore.loadTask(goal.id, task.id)).resolves.toBeNull();
      await expect(authorityStore.getDecision(authorityDecision.decision_id)).resolves.toBeNull();
      await expect(outboxStore.list()).resolves.toEqual([]);
      await expect(operationStore.load(operation.operation_id)).resolves.toBeNull();
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([]);

      const applied = await eventLog.applyProjectionRebuild();
      expect(applied.current_state_projection_rows).toEqual(expect.objectContaining({
        goal_records: 1,
        task_records: 1,
        interaction_authority_decisions: 1,
        runtime_operations: 1,
        attention_commitment_candidates: 1,
      }));
      expect(applied.rebuild.notification_outbox_dedupe_state).toEqual(expect.arrayContaining([
        expect.objectContaining({
          correlation_id: expect.stringContaining("outbox:event-backed-apply"),
          replay_policy: expect.objectContaining({
            duplicate_side_effect_policy: "never_repeat",
          }),
        }),
      ]));
      await expect(goalStore.loadGoal(goal.id)).resolves.toMatchObject({
        id: goal.id,
        title: "Event-backed apply goal",
      });
      await expect(readRuntimeGraphNodeIds(runtimeRoot, root, [
        `runtime-graph:goal:${goal.id}`,
        `runtime-graph:task:${task.id}`,
      ])).resolves.toEqual([
        `runtime-graph:goal:${goal.id}`,
        `runtime-graph:task:${task.id}`,
      ]);
      await expect(goalStore.loadTask(goal.id, task.id)).resolves.toMatchObject({
        id: task.id,
        goal_id: goal.id,
        work_description: "Restore this task from the runtime event log.",
      });
      await expect(authorityStore.getDecision(authorityDecision.decision_id)).resolves.toMatchObject({
        decision_id: authorityDecision.decision_id,
        bindings: expect.objectContaining({
          delivery_ref: "peer-delivery:event-backed-apply",
        }),
      });
      await expect(operationStore.load(operation.operation_id)).resolves.toMatchObject({
        operation_id: operation.operation_id,
        state: "verified",
      });
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([
        expect.objectContaining({
          commitment_id: candidate.commitment_id,
          replay_key: candidate.replay_key,
        }),
      ]);
      await expect(outboxStore.list()).resolves.toEqual([]);

      const appliedAgain = await eventLog.applyProjectionRebuild();
      expect(appliedAgain.event.event_id).toBe(applied.event.event_id);
      await expect(eventLog.listEvents({ limit: null })).resolves.toHaveLength(sourceEventCount + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles goal parent RuntimeGraph edges from current event-backed goal state during apply", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const goalStore = new GoalTaskStateStore(runtimeRoot, { controlBaseDir: root });
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const parentA = makeGoal({
        id: "parent-goal-a",
        title: "Original parent",
        updated_at: "2026-05-16T00:00:00.000Z",
      });
      const parentB = makeGoal({
        id: "parent-goal-b",
        title: "Current parent",
        updated_at: "2026-05-16T00:00:01.000Z",
      });
      const childWithParentA = makeGoal({
        id: "child-goal",
        parent_id: parentA.id,
        title: "Child under original parent",
        updated_at: "2026-05-16T00:00:02.000Z",
      });
      const childWithParentB = {
        ...childWithParentA,
        parent_id: parentB.id,
        title: "Child under current parent",
        updated_at: "2026-05-16T00:00:03.000Z",
      };

      await goalStore.saveGoal(parentA);
      await goalStore.saveGoal(parentB);
      await goalStore.saveGoal(childWithParentA);
      await goalStore.saveGoal(childWithParentB);

      await expect(readGoalParentEdgeSourceNodeIds(runtimeRoot, root, childWithParentB.id)).resolves.toEqual([
        `runtime-graph:goal:${parentB.id}`,
      ]);
      await mutateRuntimeControlDatabase(runtimeRoot, root, (sqlite) => {
        const staleEdge = {
          schema_version: "runtime-graph-edge/v1",
          edge_id: `runtime-graph:edge:goal-parent:${parentA.id}:${childWithParentB.id}`,
          edge_kind: "parent_of",
          from_node_id: `runtime-graph:goal:${parentA.id}`,
          to_node_id: `runtime-graph:goal:${childWithParentB.id}`,
          created_at: "2026-05-16T00:00:02.000Z",
          provenance_refs: [{ kind: "goal", ref: childWithParentB.id }],
        };
        sqlite.prepare(`
          INSERT OR REPLACE INTO personal_agent_runtime_graph_edges (
            edge_id, edge_kind, from_node_id, to_node_id, created_at, edge_json
          )
          VALUES (@edge_id, @edge_kind, @from_node_id, @to_node_id, @created_at, json(@edge_json))
        `).run({
          ...staleEdge,
          edge_json: JSON.stringify(staleEdge),
        });
      });
      await expect(readGoalParentEdgeSourceNodeIds(runtimeRoot, root, childWithParentB.id)).resolves.toEqual([
        `runtime-graph:goal:${parentA.id}`,
        `runtime-graph:goal:${parentB.id}`,
      ]);

      const applied = await eventLog.applyProjectionRebuild();

      expect(applied.current_state_projection_rows.goal_records).toBe(3);
      await expect(goalStore.loadGoal(childWithParentB.id)).resolves.toMatchObject({
        id: childWithParentB.id,
        parent_id: parentB.id,
        title: "Child under current parent",
      });
      await expect(readGoalParentEdgeSourceNodeIds(runtimeRoot, root, childWithParentB.id)).resolves.toEqual([
        `runtime-graph:goal:${parentB.id}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects current-state apply rows by parsed timestamp instants", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const operationStore = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: root });
      const attentionStore = new AttentionStateStore(runtimeRoot, { controlBaseDir: root });

      const earlierOperation = RuntimeControlOperationSchema.parse({
        operation_id: "runtime-operation:offset-current-state",
        kind: "inspect_run",
        state: "running",
        requested_at: "2026-05-15T15:30:00.000Z",
        updated_at: "2026-05-16T01:00:00+09:00",
        requested_by: { surface: "cli" },
        reply_target: { channel: "cli" },
        reason: "Earlier instant with lexicographically larger offset timestamp.",
        expected_health: {
          daemon_ping: false,
          gateway_acceptance: false,
        },
        target: {
          session_id: "session:offset-current-state",
        },
      });
      const laterOperation = RuntimeControlOperationSchema.parse({
        ...earlierOperation,
        state: "verified",
        updated_at: "2026-05-15T17:00:00.000Z",
        completed_at: "2026-05-15T17:00:00.000Z",
        reason: "Later instant that must win apply even though the string sorts earlier.",
        result: {
          ok: true,
          message: "Later parsed timestamp selected.",
        },
      });
      const earlierCandidate = {
        ...commitmentCandidate(),
        commitment_id: "commitment:timestamp-current-state",
        replay_key: "commitment-replay:timestamp-current-state",
        updated_at: "2026-05-15T16:00:00.000Z",
        materialization_state: "watching" as const,
      };
      const laterCandidate = {
        ...earlierCandidate,
        updated_at: "2026-05-15T17:00:00.000Z",
        materialization_state: "active_care" as const,
      };

      await eventLog.appendRuntimeControlOperation({ operation: earlierOperation });
      await eventLog.appendRuntimeControlOperation({
        operation: laterOperation,
        previousOperation: earlierOperation,
      });
      await eventLog.appendAttentionCommitment({
        operation: "candidate_saved",
        candidate: earlierCandidate,
      });
      await eventLog.appendAttentionCommitment({
        operation: "candidate_saved",
        candidate: laterCandidate,
        previousCandidate: earlierCandidate,
      });

      await expect(operationStore.load(earlierOperation.operation_id)).resolves.toBeNull();
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([]);

      await eventLog.applyProjectionRebuild();

      await expect(operationStore.load(earlierOperation.operation_id)).resolves.toMatchObject({
        operation_id: earlierOperation.operation_id,
        state: "verified",
        updated_at: "2026-05-15T17:00:00.000Z",
      });
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([
        expect.objectContaining({
          commitment_id: laterCandidate.commitment_id,
          materialization_state: "active_care",
          updated_at: "2026-05-15T17:00:00.000Z",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not resurrect pre-delete tasks when a goal id is recreated", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const goalStore = new GoalTaskStateStore(root, { controlBaseDir: root });
      const goal = makeGoal({
        id: "goal:recreated-from-events",
        title: "Original goal",
        updated_at: "2026-05-15T16:00:00.000Z",
      });
      const task = makeTask({
        id: "task:pre-delete",
        goal_id: goal.id,
        work_description: "This task belongs to the deleted generation.",
        created_at: "2026-05-15T16:05:00.000Z",
      });
      const deletedGoal = makeGoal({
        ...goal,
        updated_at: "2026-06-01T00:00:00.000Z",
      });
      const recreatedGoal = makeGoal({
        ...goal,
        title: "Recreated goal",
        updated_at: "2026-06-01T01:00:00.000Z",
      });

      await eventLog.appendGoalTaskMutation({ entityKind: "goal", action: "save", goal });
      await eventLog.appendGoalTaskMutation({
        entityKind: "task",
        action: "save",
        goalId: goal.id,
        taskId: task.id,
        task,
      });
      await eventLog.appendGoalTaskMutation({ entityKind: "goal", action: "delete", goal: deletedGoal });
      await eventLog.appendGoalTaskMutation({ entityKind: "goal", action: "save", goal: recreatedGoal });

      await eventLog.applyProjectionRebuild();

      await expect(goalStore.loadGoal(goal.id)).resolves.toMatchObject({
        id: goal.id,
        title: "Recreated goal",
      });
      await expect(goalStore.loadTask(goal.id, task.id)).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes non-event-backed current-state projection rows during whole-control apply", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const operationStore = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: root });
      const attentionStore = new AttentionStateStore(runtimeRoot, { controlBaseDir: root });
      const phantomOperation = RuntimeControlOperationSchema.parse({
        operation_id: "runtime-operation:phantom",
        kind: "inspect_run",
        state: "verified",
        requested_at: NOW,
        updated_at: NOW,
        completed_at: NOW,
        requested_by: { surface: "cli" },
        reply_target: { channel: "cli" },
        reason: "This row has no runtime event backing.",
        expected_health: {
          daemon_ping: false,
          gateway_acceptance: false,
        },
        result: {
          ok: true,
          message: "phantom",
        },
      });
      const phantomCandidate = {
        ...commitmentCandidate(),
        commitment_id: "commitment:phantom",
        replay_key: "commitment-replay:phantom",
      };
      await mutateRuntimeControlDatabase(runtimeRoot, root, (sqlite) => {
        sqlite.prepare(`
          INSERT INTO runtime_operations (
            operation_id, kind, state, terminal, requested_at, updated_at, operation_json
          )
          VALUES (?, ?, ?, ?, ?, ?, json(?))
        `).run(
          phantomOperation.operation_id,
          phantomOperation.kind,
          phantomOperation.state,
          1,
          phantomOperation.requested_at,
          phantomOperation.updated_at,
          JSON.stringify(phantomOperation),
        );
        sqlite.prepare(`
          INSERT INTO attention_commitment_candidates (
            commitment_id,
            source_ref,
            target_ref,
            replay_key,
            source_epoch,
            source_high_watermark,
            policy_epoch,
            scope_key,
            lifecycle,
            nudge_policy,
            materialization_id,
            next_revisit_at,
            due_start,
            due_end,
            priority_score,
            suppression_ref_count,
            feedback_ref_count,
            created_at,
            updated_at,
            candidate_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
        `).run(
          phantomCandidate.commitment_id,
          JSON.stringify(phantomCandidate.source_ref),
          JSON.stringify(phantomCandidate.target_ref),
          phantomCandidate.replay_key,
          phantomCandidate.source_epoch,
          phantomCandidate.source_high_watermark,
          phantomCandidate.policy_epoch,
          "phantom-scope",
          phantomCandidate.materialization_state,
          phantomCandidate.nudge_policy,
          phantomCandidate.materialization_id,
          phantomCandidate.next_revisit_at,
          phantomCandidate.due.window_start,
          phantomCandidate.due.window_end,
          phantomCandidate.priority_evidence.total_score ?? null,
          phantomCandidate.suppression_refs.length,
          phantomCandidate.feedback_refs.length,
          phantomCandidate.created_at,
          phantomCandidate.updated_at,
          JSON.stringify(phantomCandidate),
        );
      });
      await expect(operationStore.load(phantomOperation.operation_id)).resolves.toMatchObject({
        operation_id: phantomOperation.operation_id,
      });
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([
        expect.objectContaining({ commitment_id: phantomCandidate.commitment_id }),
      ]);

      await eventLog.applyProjectionRebuild();

      await expect(operationStore.load(phantomOperation.operation_id)).resolves.toBeNull();
      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates commitment candidates by parsed timestamp instants before appending events", async () => {
    const root = fixtureRoot();
    try {
      const runtimeRoot = path.join(root, "runtime");
      const attentionStore = new AttentionStateStore(runtimeRoot, { controlBaseDir: root });
      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: root });
      const baseCandidate = {
        ...commitmentCandidate(),
        commitment_id: "commitment:fractional-update",
        replay_key: "commitment-replay:fractional-update",
        updated_at: "2026-05-15T17:00:00Z",
        materialization_state: "watching" as const,
      };
      const laterCandidate = {
        ...baseCandidate,
        updated_at: "2026-05-15T17:00:00.100Z",
        materialization_state: "active_care" as const,
      };

      await attentionStore.saveCommitmentCandidates([baseCandidate]);
      await attentionStore.saveCommitmentCandidates([laterCandidate]);

      await expect(attentionStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toEqual([
        expect.objectContaining({
          commitment_id: laterCandidate.commitment_id,
          materialization_state: "active_care",
          updated_at: "2026-05-15T17:00:00.100Z",
        }),
      ]);
      const events = await eventLog.listEvents({ eventType: "attention.commitment.recorded", limit: null });
      expect(events.filter((event) => event.correlation_id === laterCandidate.commitment_id)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fixtureRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-event-contract-"));
}

async function clearProjectionTables(
  runtimeRoot: string,
  controlBaseDir: string,
  statements: readonly string[],
): Promise<void> {
  const db = await openRuntimeControlDatabase({ rootDir: runtimeRoot }, { controlBaseDir });
  try {
    db.transaction((sqlite) => {
      for (const statement of statements) {
        sqlite.prepare(statement).run();
      }
    });
  } finally {
    db.close();
  }
}

async function mutateRuntimeControlDatabase(
  runtimeRoot: string,
  controlBaseDir: string,
  mutate: (sqlite: SqliteDatabase) => void,
): Promise<void> {
  const db = await openRuntimeControlDatabase({ rootDir: runtimeRoot }, { controlBaseDir });
  try {
    db.transaction(mutate);
  } finally {
    db.close();
  }
}

function insertRuntimeEventRowForTest(sqlite: SqliteDatabase, event: RuntimeEventEnvelope): void {
  sqlite.prepare(`
    INSERT INTO runtime_events (
      event_id,
      event_type,
      schema_version,
      occurred_at,
      trace_id,
      causation_id,
      correlation_id,
      idempotency_key,
      caller_path,
      surface,
      replay_policy,
      goal_id,
      task_id,
      run_id,
      session_id,
      source_ref,
      authority_decision_ref,
      side_effect_ref,
      event_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `).run(
    event.event_id,
    event.event_type,
    event.schema_version,
    event.occurred_at,
    event.trace_id,
    event.causation_id,
    event.correlation_id,
    event.idempotency_key,
    event.caller_path,
    event.surface,
    event.replay_policy.mode,
    event.goal_id,
    event.task_id,
    event.run_id,
    event.session_id,
    `${event.source_ref.kind}:${event.source_ref.ref}`,
    event.authority_decision_ref ? `${event.authority_decision_ref.kind}:${event.authority_decision_ref.ref}` : null,
    event.side_effect_ref ? `${event.side_effect_ref.kind}:${event.side_effect_ref.ref}` : null,
    JSON.stringify(event),
  );
}

async function readRuntimeGraphNodeIds(
  runtimeRoot: string,
  controlBaseDir: string,
  nodeIds: readonly string[],
): Promise<string[]> {
  const db = await openRuntimeControlDatabase({ rootDir: runtimeRoot }, { controlBaseDir });
  try {
    const placeholders = nodeIds.map(() => "?").join(", ");
    const rows = db.read((sqlite) => sqlite.prepare(`
        SELECT node_id
        FROM personal_agent_runtime_graph_nodes
        WHERE node_id IN (${placeholders})
        ORDER BY node_id ASC
      `).all(...nodeIds) as Array<{ node_id: string }>);
    return rows.map((row) => row.node_id);
  } finally {
    db.close();
  }
}

async function readGoalParentEdgeSourceNodeIds(
  runtimeRoot: string,
  controlBaseDir: string,
  goalId: string,
): Promise<string[]> {
  const db = await openRuntimeControlDatabase({ rootDir: runtimeRoot }, { controlBaseDir });
  try {
    const rows = db.read((sqlite) => sqlite.prepare(`
        SELECT from_node_id
        FROM personal_agent_runtime_graph_edges
        WHERE edge_kind = 'parent_of'
          AND to_node_id = ?
        ORDER BY from_node_id ASC
      `).all(`runtime-graph:goal:${goalId}`) as Array<{ from_node_id: string }>);
    return rows.map((row) => row.from_node_id);
  } finally {
    db.close();
  }
}

function commitmentScope(): AttentionScope {
  return {
    userId: "user-1",
    identityId: "identity-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    surfaceClass: "telegram",
    surfaceRef: "surface:telegram",
    permissionScope: "read_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: "policy:runtime-event-contract",
  };
}

function commitmentCandidate() {
  const created = createCommitmentCandidate({
    extraction: CommitmentCandidateExtractionSchema.parse({
      outcome: "candidate",
      summary: "Review the launch note before Monday.",
      owner: "user",
      confidence: 0.82,
      sensitivity: "internal",
      allowed_memory_use: "attention_only",
      nudge_policy: "allowed",
      watch_vector: ["related_conversation", "deadline"],
    }),
    scope: commitmentScope(),
    turnId: "turn-runtime-event",
    sessionId: "session-1",
    sourceId: "chat:session-1:turn-runtime-event:user",
    emittedAt: NOW,
    policyEpoch: "policy:runtime-event-contract",
    activeSurfaceRef: ref("surface", "surface:telegram"),
  });
  expect(created).not.toBeNull();
  return {
    ...created!,
    materialization_state: "watching" as const,
    next_revisit_at: NOW,
  };
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

async function captureConsoleError(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
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
