import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import { describe, expect, it, vi } from "vitest";

import { StateManager } from "../../src/base/state/state-manager.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import {
  InteractionAuthorityStore,
  projectApprovalResumeAuthority,
  projectPeerInitiativeDeliveryAuthority,
} from "../../src/runtime/control/index.js";
import { PersonalAgentRuntimeStore } from "../../src/runtime/personal-agent/index.js";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import {
  CommitmentCandidateExtractionSchema,
  createCommitmentCandidate,
  ref,
} from "../../src/runtime/attention/index.js";
import { runResidentCommitmentAttentionCycle } from "../../src/runtime/daemon/runner-resident-proactive.js";
import type { AttentionScope } from "../../src/runtime/types/companion-autonomy.js";
import { PeerInitiativeStore } from "../../src/runtime/peer-initiative/index.js";
import { AttentionStateStore } from "../../src/runtime/store/attention-state-store.js";
import { FeedbackIngestionStore } from "../../src/runtime/store/feedback-ingestion-store.js";
import { OutboxStore } from "../../src/runtime/store/outbox-store.js";
import {
  PermissionWaitPlanStore,
  type PermissionWaitCanonicalPlan,
} from "../../src/runtime/store/permission-wait-plan-store.js";
import { RuntimeEventLogStore } from "../../src/runtime/store/runtime-event-log.js";
import type { ScheduleEntryInput } from "../../src/runtime/types/schedule.js";
import {
  ConcurrencyController,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
  type ITool,
} from "../../src/tools/index.js";

const NOW = "2026-05-16T00:00:00.000Z";

describe("runtime event log restart/replay invariants", () => {
  it("recreates stores and prevents duplicate side effects while preserving distinct idempotency semantics", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-event-replay-"));
    const runtimeRoot = path.join(root, "runtime");
    const controlBaseDir = root;
    try {
      const sideEffects = {
        approval_resume: 0,
        telegram_send: 0,
        outbox_notify: 0,
        schedule_run: 0,
        commitment_operation: 0,
        denied_tool_call: 0,
      };

      const firstApproval = await resumeApprovalWithRestartableStores({
        root,
        runtimeRoot,
        controlBaseDir,
        waitPlanId: "wait-plan:runtime-event:first",
        callId: "approval-call:first",
      });
      const approvalAuthority = new InteractionAuthorityStore(runtimeRoot, { controlBaseDir });
      await approvalAuthority.recordDecision(projectApprovalResumeAuthority(firstApproval));
      if (firstApproval.resumeResult.status === "resumed") sideEffects.approval_resume += 1;

      const replayApproval = await resumeExistingApprovalAfterRestart({
        runtimeRoot,
        controlBaseDir,
        waitPlanId: "wait-plan:runtime-event:first",
        callId: "approval-call:first",
      });
      await new InteractionAuthorityStore(runtimeRoot, { controlBaseDir })
        .recordDecision(projectApprovalResumeAuthority(replayApproval));
      if (replayApproval.resumeResult.status === "resumed") sideEffects.approval_resume += 1;

      const distinctApproval = await resumeApprovalWithRestartableStores({
        root,
        runtimeRoot,
        controlBaseDir,
        waitPlanId: "wait-plan:runtime-event:distinct",
        callId: "approval-call:distinct",
      });
      await new InteractionAuthorityStore(runtimeRoot, { controlBaseDir })
        .recordDecision(projectApprovalResumeAuthority(distinctApproval));
      if (distinctApproval.resumeResult.status === "resumed") sideEffects.approval_resume += 1;

      const firstDelivery = await deliverPeerMessage({
        runtimeRoot,
        controlBaseDir,
        candidateId: "peer-candidate:runtime-event:first",
        deliveryId: "peer-delivery:runtime-event:first",
        transportMessageRef: "telegram-message:first",
      });
      if (firstDelivery.sent) sideEffects.telegram_send += 1;
      const replayDelivery = await deliverPeerMessage({
        runtimeRoot,
        controlBaseDir,
        candidateId: "peer-candidate:runtime-event:first",
        deliveryId: "peer-delivery:runtime-event:first",
        transportMessageRef: "telegram-message:first",
      });
      if (replayDelivery.sent) sideEffects.telegram_send += 1;
      const distinctDelivery = await deliverPeerMessage({
        runtimeRoot,
        controlBaseDir,
        candidateId: "peer-candidate:runtime-event:distinct",
        deliveryId: "peer-delivery:runtime-event:distinct",
        transportMessageRef: "telegram-message:distinct",
      });
      if (distinctDelivery.sent) sideEffects.telegram_send += 1;

      const outboxFirst = await new OutboxStore(runtimeRoot, { controlBaseDir }).append({
        event_type: "runtime_event_replay_notification",
        goal_id: "goal:runtime-event-replay",
        correlation_id: "correlation:runtime-event:first",
        created_at: Date.parse(NOW),
        payload: { message: "notify once" },
      });
      sideEffects.outbox_notify += 1;
      const outboxReplay = await new OutboxStore(runtimeRoot, { controlBaseDir }).append({
        event_type: "runtime_event_replay_notification",
        goal_id: "goal:runtime-event-replay",
        correlation_id: "correlation:runtime-event:first",
        created_at: Date.parse(NOW) + 1,
        payload: { message: "notify once" },
      });
      if (outboxReplay.seq !== outboxFirst.seq) sideEffects.outbox_notify += 1;
      const outboxDistinct = await new OutboxStore(runtimeRoot, { controlBaseDir }).append({
        event_type: "runtime_event_replay_notification",
        goal_id: "goal:runtime-event-replay",
        correlation_id: "correlation:runtime-event:distinct",
        created_at: Date.parse(NOW) + 2,
        payload: { message: "notify once" },
      });
      if (outboxDistinct.seq !== outboxFirst.seq) sideEffects.outbox_notify += 1;

      const state = new StateManager(root, undefined, { walEnabled: false });
      await state.init();
      const memory = await new KnowledgeManager(state, {} as never).saveAgentMemory({
        key: "runtime.event.replay.memory",
        value: "This replay memory should be corrected once.",
        tags: ["runtime-event-replay"],
        memory_type: "preference",
      });
      const firstCorrection = await runUserMemoryOperation(state, {
        operation: "forget",
        targetRef: { kind: "agent_memory", id: memory.id },
        reason: "Runtime event log replay should not duplicate this correction.",
        now: "2026-05-16T00:10:00.000Z",
      });
      const restartedState = new StateManager(root, undefined, { walEnabled: false });
      await restartedState.init();
      const replayCorrection = await runUserMemoryOperation(restartedState, {
        operation: "forget",
        targetRef: { kind: "agent_memory", id: memory.id },
        reason: "Runtime event log replay should not duplicate this correction.",
        now: "2026-05-16T00:10:00.000Z",
      });

      const scheduleFirst = await runDueSchedule({ root, runtimeRoot, controlBaseDir, label: "first" });
      sideEffects.schedule_run += scheduleFirst.runCount;
      const scheduleReplay = await rerunScheduleAfterRestart({ root, runtimeRoot, controlBaseDir });
      sideEffects.schedule_run += scheduleReplay.runCount;
      const scheduleDistinct = await runDueSchedule({ root, runtimeRoot, controlBaseDir, label: "distinct" });
      sideEffects.schedule_run += scheduleDistinct.runCount;

      const commitmentFirst = await runCommitmentOperationCycle({ root, runtimeRoot, controlBaseDir, label: "first" });
      sideEffects.commitment_operation += commitmentFirst.preparedCount;
      const commitmentReplay = await runCommitmentOperationCycle({ root, runtimeRoot, controlBaseDir, label: "first" });
      sideEffects.commitment_operation += commitmentReplay.preparedCount;
      const commitmentDistinct = await runCommitmentOperationCycle({ root, runtimeRoot, controlBaseDir, label: "distinct" });
      sideEffects.commitment_operation += commitmentDistinct.preparedCount;

      await runDeniedToolAfterRestart({
        root,
        runtimeRoot,
        controlBaseDir,
        callId: "tool-call:runtime-event-denied",
        onCall: () => {
          sideEffects.denied_tool_call += 1;
        },
      });
      await runDeniedToolAfterRestart({
        root,
        runtimeRoot,
        controlBaseDir,
        callId: "tool-call:runtime-event-denied",
        onCall: () => {
          sideEffects.denied_tool_call += 1;
        },
      });

      const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir });
      const events = await eventLog.listEvents({ limit: 500 });
      const rebuild = await eventLog.rebuildProjections();
      const explanation = await eventLog.explainTrace(events.find((event) => event.event_type === "approval.resume.recorded")!.trace_id);

      expect(firstApproval.resumeResult.status).toBe("resumed");
      expect(replayApproval.resumeResult.status).toBe("not_approved");
      expect(distinctApproval.resumeResult.status).toBe("resumed");
      expect(firstDelivery.sent).toBe(true);
      expect(replayDelivery.sent).toBe(false);
      expect(distinctDelivery.sent).toBe(true);
      expect(outboxReplay.seq).toBe(outboxFirst.seq);
      expect(outboxDistinct.seq).not.toBe(outboxFirst.seq);
      expect(replayCorrection.correction?.correction_id).toBe(firstCorrection.correction?.correction_id);
      expect(replayCorrection.history).toHaveLength(1);
      expect(scheduleReplay.runCount).toBe(0);
      expect(scheduleDistinct.runCount).toBe(1);
      expect(sideEffects).toEqual({
        approval_resume: 2,
        telegram_send: 2,
        outbox_notify: 2,
        schedule_run: 2,
        commitment_operation: 2,
        denied_tool_call: 0,
      });
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        "approval.resume.recorded",
        "gateway.telegram.delivery.recorded",
        "outbox.enqueue.recorded",
        "memory.correction.recorded",
        "schedule.wake.recorded",
        "tool.call.recorded",
        "attention.commitment.recorded",
      ]));
      expect(events
        .filter((event) => event.event_type === "attention.commitment.recorded")
        .map((event) => event.caller_path)
      ).toEqual(expect.arrayContaining(["resident_proactive"]));
      expect(events.every((event) =>
        event.trace_id.length > 0
        && event.correlation_id.length > 0
        && event.idempotency_key.length > 0
      )).toBe(true);
      expect(new Set(events.map((event) => event.idempotency_key)).size).toBeGreaterThan(1);
      expect(rebuild.approval_resume_outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "resumed" }),
        expect.objectContaining({ status: "not_approved" }),
      ]));
      expect(rebuild.peer_delivery_state.length).toBeGreaterThanOrEqual(2);
      expect(rebuild.notification_outbox_dedupe_state.length).toBeGreaterThan(0);
      expect(rebuild.memory_correction_invalidation_summary.length).toBeGreaterThan(0);
      expect(rebuild.schedule_wake_execution_summary.length).toBeGreaterThan(0);
      expect(rebuild.tool_execution_outcome_summary.length).toBeGreaterThan(0);
      expect(rebuild.attention_commitment_lifecycle_summary.length).toBeGreaterThan(0);
      expect(explanation.runtime_graph.edges.map((edge) => edge.edge_kind)).toEqual(expect.arrayContaining([
        "caused_by",
        "approved_by",
        "executed_by",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function commitmentScope(label: string): AttentionScope {
  return {
    userId: "user-1",
    identityId: "identity-1",
    workspaceId: "workspace-1",
    conversationId: `conversation-${label}`,
    sessionId: `session-${label}`,
    surfaceClass: "telegram",
    surfaceRef: "surface:telegram",
    permissionScope: "read_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: "policy:runtime-event-replay",
  };
}

function replayCommitmentCandidate(label: string) {
  const candidate = createCommitmentCandidate({
    extraction: CommitmentCandidateExtractionSchema.parse({
      outcome: "candidate",
      summary: `Review the ${label} launch note tomorrow.`,
      due: {
        window_start: NOW,
        window_end: "2026-05-16T01:00:00.000Z",
        uncertainty: "medium",
        reason: "replay test due window",
      },
      owner: "user",
      confidence: 0.86,
      sensitivity: "internal",
      allowed_memory_use: "attention_only",
      nudge_policy: "allowed",
      watch_vector: ["deadline", "related_conversation"],
    }),
    scope: commitmentScope(label),
    turnId: `turn-${label}`,
    sessionId: `session-${label}`,
    sourceId: `chat:session-${label}:turn-${label}:user`,
    emittedAt: "2026-05-15T23:50:00.000Z",
    policyEpoch: "policy:runtime-event-replay",
    activeSurfaceRef: ref("surface", "surface:telegram"),
  });
  expect(candidate).not.toBeNull();
  return {
    ...candidate!,
    materialization_state: "watching" as const,
    next_revisit_at: NOW,
  };
}

async function runCommitmentOperationCycle(input: {
  root: string;
  runtimeRoot: string;
  controlBaseDir: string;
  label: string;
}): Promise<{ preparedCount: number }> {
  const store = new AttentionStateStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir });
  const peerStore = new PeerInitiativeStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir });
  const before = await peerStore.listRecentCandidates();
  await store.saveCommitmentCandidates([replayCommitmentCandidate(input.label)]);
  await runResidentCommitmentAttentionCycle({
    baseDir: input.root,
    config: { runtime_root: "runtime" },
    state: {
      started_at: NOW,
      loop_count: 1,
    },
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    saveDaemonState: vi.fn(async () => {}),
    attentionStateStore: store,
    feedbackIngestionStore: new FeedbackIngestionStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir }),
  } as never, NOW);
  const after = await peerStore.listRecentCandidates();
  return { preparedCount: Math.max(0, after.length - before.length) };
}

function canonicalPlan(input: { root: string; callId: string }): PermissionWaitCanonicalPlan {
  return {
    schema_version: "permission-wait-canonical-plan-v1",
    tool_name: "runtime_event_replay_tool",
    input: { value: input.callId },
    cwd: input.root,
    target: {
      goal_id: "goal:runtime-event-replay",
      session_id: "session:runtime-event-replay",
      tool_call_id: input.callId,
    },
    permission: {
      permission_level: "write_remote",
      is_destructive: false,
      reversibility: "unknown",
    },
    capability_facts: {
      tool_permission_level: "write_remote",
      tool_is_read_only: false,
      tool_is_destructive: false,
      tool_requires_network: true,
      tool_activity_category: "command",
      tool_tags: ["runtime-event-replay"],
    },
  };
}

async function resumeApprovalWithRestartableStores(input: {
  root: string;
  runtimeRoot: string;
  controlBaseDir: string;
  waitPlanId: string;
  callId: string;
}): Promise<Parameters<typeof projectApprovalResumeAuthority>[0]> {
  const plan = canonicalPlan({ root: input.root, callId: input.callId });
  const waitStore = new PermissionWaitPlanStore(input.runtimeRoot, {
    controlBaseDir: input.controlBaseDir,
    now: () => 1_000,
    createEventId: () => `permission-event:${input.waitPlanId}`,
  });
  await waitStore.createWaiting({
    wait_plan_id: input.waitPlanId,
    approval_id: `approval:${input.waitPlanId}`,
    goal_id: "goal:runtime-event-replay",
    canonical_plan: plan,
  });
  await waitStore.markApproved(input.waitPlanId, { resolved_at: 2_000 });
  const resumed = await new PermissionWaitPlanStore(input.runtimeRoot, {
    controlBaseDir: input.controlBaseDir,
    now: () => 3_000,
    createEventId: () => `permission-event:${input.waitPlanId}:resume`,
  }).resumeApproved(input.waitPlanId, {
    canonical_plan: plan,
    resumed_at: 3_000,
  });
  return {
    waitPlanId: input.waitPlanId,
    resumeResult: resumed,
    actualCanonicalPlan: plan,
    decidedAt: NOW,
  };
}

async function resumeExistingApprovalAfterRestart(input: {
  runtimeRoot: string;
  controlBaseDir: string;
  waitPlanId: string;
  callId: string;
}): Promise<Parameters<typeof projectApprovalResumeAuthority>[0]> {
  const plan = canonicalPlan({ root: input.controlBaseDir, callId: input.callId });
  const replay = await new PermissionWaitPlanStore(input.runtimeRoot, {
    controlBaseDir: input.controlBaseDir,
    now: () => 4_000,
    createEventId: () => `permission-event:${input.waitPlanId}:replay`,
  }).resumeApproved(input.waitPlanId, {
    canonical_plan: plan,
    resumed_at: 4_000,
  });
  return {
    waitPlanId: input.waitPlanId,
    resumeResult: replay,
    actualCanonicalPlan: plan,
    decidedAt: NOW,
  };
}

async function deliverPeerMessage(input: {
  runtimeRoot: string;
  controlBaseDir: string;
  candidateId: string;
  deliveryId: string;
  transportMessageRef: string;
}): Promise<{ sent: boolean }> {
  const peerStore = new PeerInitiativeStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir });
  await peerStore.upsertCandidate({
    selectedState: "notified",
    candidate: {
      candidate_id: input.candidateId,
      idempotency_key: `peer-idempotency:${input.candidateId}`,
      created_at: NOW,
      source: "pulseed_initiated",
      kind: "care_presence",
      grounding: ["ambient_care"],
      stance_ref: "peer-friend-low-pressure-v1",
      attention_signal_refs: ["attention:runtime-event-replay"],
      message_intent: "Send a low-pressure replay test message.",
      draft_message: "Replay-safe peer delivery.",
      reply_required: false,
      action_plan: {
        mode: "care_only",
        permission_required: false,
      },
      worthiness: {
        can_be_valuable_without_reply: true,
        user_cognitive_load: "low",
        reply_pressure: "none",
        care_value: "high",
        attention_fit: "strong",
        concrete_helpfulness: "medium",
        self_serving_risk: "none",
        tutorial_risk: "none",
      },
      max_delivery_kind: "notify",
      external_action_authority: false,
      task_creation_authority: false,
      confidence: 0.8,
    },
  });
  const claimed = await peerStore.claimDelivery({
    delivery_id: input.deliveryId,
    candidate_id: input.candidateId,
    surface: "telegram",
    status: "pending_send",
    message_id: `message:${input.candidateId}`,
    target_binding_ref: "gateway:telegram:home_chat:12345",
    expression_decision_ref: "expression:runtime-event-replay",
    visibility_policy_ref: "visibility:runtime-event-replay",
  }, { now: NOW });
  if (claimed.status !== "claimed") {
    await new InteractionAuthorityStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir })
      .recordDecision(projectPeerInitiativeDeliveryAuthority({
        candidateId: input.candidateId,
        deliveryId: input.deliveryId,
        surface: "telegram",
        reason: "Replay found an already delivered peer message and did not send again.",
        decidedAt: NOW,
        outcome: "held",
        canHold: true,
        targetBindingRef: "gateway:telegram:home_chat:12345",
        channelPolicyRef: "gateway:telegram:policy",
        deliveryRef: input.deliveryId,
      }));
    return { sent: false };
  }
  await new InteractionAuthorityStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir })
    .recordDecision(projectPeerInitiativeDeliveryAuthority({
      candidateId: input.candidateId,
      deliveryId: input.deliveryId,
      surface: "telegram",
      reason: "Peer delivery was admitted before Telegram transport send.",
      decidedAt: NOW,
      canSend: true,
      canNotify: true,
      targetBindingRef: "gateway:telegram:home_chat:12345",
      channelPolicyRef: "gateway:telegram:policy",
      deliveryRef: input.deliveryId,
      transportMessageRef: input.transportMessageRef,
    }));
  await peerStore.recordDelivery({
    ...claimed.record,
    status: "delivered",
    delivered_at: NOW,
    transport_message_ref: input.transportMessageRef,
  });
  return { sent: true };
}

async function runDueSchedule(input: {
  root: string;
  runtimeRoot: string;
  controlBaseDir: string;
  label: string;
}): Promise<{ runCount: number }> {
  let runCount = 0;
  const engine = new ScheduleEngine({
    baseDir: input.controlBaseDir,
    personalAgentRuntime: new PersonalAgentRuntimeStore(input.runtimeRoot, {
      controlBaseDir: input.controlBaseDir,
    }),
    coreLoop: {
      run: vi.fn(async () => {
        runCount += 1;
        return { finalStatus: "completed", totalIterations: 1, tokensUsed: 1 };
      }),
    },
  });
  await engine.loadEntries();
  const entry = await engine.addEntry(goalTriggerEntry(input.label));
  engine.getEntries().find((candidate) => candidate.id === entry.id)!.next_fire_at =
    new Date(Date.now() - 1_000).toISOString();
  await engine.saveEntries();
  await engine.loadEntries();
  await engine.tick();
  return { runCount };
}

async function rerunScheduleAfterRestart(input: {
  root: string;
  runtimeRoot: string;
  controlBaseDir: string;
}): Promise<{ runCount: number }> {
  let runCount = 0;
  const engine = new ScheduleEngine({
    baseDir: input.controlBaseDir,
    personalAgentRuntime: new PersonalAgentRuntimeStore(input.runtimeRoot, {
      controlBaseDir: input.controlBaseDir,
    }),
    coreLoop: {
      run: vi.fn(async () => {
        runCount += 1;
        return { finalStatus: "completed", totalIterations: 1, tokensUsed: 1 };
      }),
    },
  });
  await engine.loadEntries();
  await engine.tick();
  return { runCount };
}

function goalTriggerEntry(label: string): Omit<
  ScheduleEntryInput,
  | "id"
  | "created_at"
  | "updated_at"
  | "last_fired_at"
  | "next_fire_at"
  | "consecutive_failures"
  | "last_escalation_at"
  | "baseline_results"
  | "total_executions"
  | "total_tokens_used"
  | "max_tokens_per_day"
  | "tokens_used_today"
  | "budget_reset_at"
  | "escalation_timestamps"
> {
  return {
    name: `runtime-event-replay-${label}`,
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    metadata: {
      source: "manual",
      goal_id: `goal:runtime-event-replay:${label}`,
      personal_agent_replay_key: `schedule-runtime-event-replay:${label}`,
    },
    goal_trigger: {
      goal_id: `goal:runtime-event-replay:${label}`,
      max_iterations: 1,
      skip_if_active: false,
    },
  };
}

async function runDeniedToolAfterRestart(input: {
  root: string;
  runtimeRoot: string;
  controlBaseDir: string;
  callId: string;
  onCall: () => void;
}): Promise<void> {
  const registry = new ToolRegistry();
  registry.register({
    metadata: {
      name: "runtime_event_denied_tool",
      aliases: [],
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8_000,
      tags: ["runtime-event-replay"],
      requiresNetwork: false,
      activityCategory: "command",
    },
    inputSchema: z.object({ value: z.string() }),
    description: () => "Denied replay tool.",
    checkPermissions: async () => ({
      status: "denied",
      reason: "Replay denial blocks the tool before call().",
    }),
    isConcurrencySafe: () => false,
    call: async () => {
      input.onCall();
      return {
        success: true,
        data: {},
        summary: "should not execute",
        durationMs: 0,
        execution: { status: "executed" },
      };
    },
  } satisfies ITool<{ value: string }>);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    personalAgentRuntime: new PersonalAgentRuntimeStore(input.runtimeRoot, {
      controlBaseDir: input.controlBaseDir,
    }),
    traceBaseDir: input.controlBaseDir,
  });
  const result = await executor.execute("runtime_event_denied_tool", { value: input.callId }, {
    cwd: input.root,
    callId: input.callId,
    sessionId: "session:runtime-event-replay",
    goalId: "goal:runtime-event-replay",
  } as never);
  expect(result.execution).toMatchObject({ status: "not_executed" });
}
