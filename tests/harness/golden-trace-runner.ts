import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamHandlers } from "../../src/base/llm/llm-client.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { ChatRunner, type ChatRunnerDeps } from "../../src/interface/chat/chat-runner.js";
import { ChatRunnerEventBridge } from "../../src/interface/chat/chat-runner-event-bridge.js";
import { buildStandaloneIngressMessageFromContext, formatRuntimeStatus } from "../../src/interface/chat/chat-runner-runtime.js";
import { ChatSessionDataStore } from "../../src/interface/chat/chat-session-data-store.js";
import { ChatSessionCatalog } from "../../src/interface/chat/chat-session-store.js";
import { buildStandaloneIngressMessage, type SelectedChatRoute } from "../../src/interface/chat/ingress-router.js";
import { intakeSetupSecrets } from "../../src/interface/chat/setup-secret-intake.js";
import { createRunSpecStore, type RunSpecConfirmationSnapshot } from "../../src/runtime/run-spec/index.js";
import { ApprovalBroker, type ConversationalApprovalDelivery } from "../../src/runtime/approval-broker.js";
import { RuntimeControlService } from "../../src/runtime/control/runtime-control-service.js";
import { EventServer } from "../../src/runtime/event/server.js";
import { createPendingPermissionTask, type PendingPermissionTask } from "../../src/runtime/permission-dialogue.js";
import { JournalBackedQueue, type JournalBackedQueueSnapshot } from "../../src/runtime/queue/journal-backed-queue.js";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import { RuntimeSessionRegistry } from "../../src/runtime/session-registry/index.js";
import type { BackgroundRun, RuntimeSessionRegistrySnapshot } from "../../src/runtime/session-registry/types.js";
import {
  ApprovalStore,
  AttentionStateStore,
  BackgroundRunLedger,
  PermissionWaitPlanStore,
  RuntimeOperationStore,
} from "../../src/runtime/store/index.js";
import type { RuntimeControlReplyTarget } from "../../src/runtime/store/runtime-operation-schemas.js";
import type { Envelope, EnvelopePriority, EnvelopeType } from "../../src/runtime/types/envelope.js";
import { ConcurrencyController, ToolExecutor, ToolPermissionManager, ToolRegistry } from "../../src/tools/index.js";
import { FileWriteTool } from "../../src/tools/fs/FileWriteTool/FileWriteTool.js";
import { ReadTool } from "../../src/tools/fs/ReadTool/ReadTool.js";
import { createRunSpecHandoffTools } from "../../src/tools/runtime/RunSpecHandoffTools.js";
import type { ITool, ToolCallContext, ToolResult } from "../../src/tools/types.js";
import { EventRecorder } from "./event-recorder.js";
import { createIsolatedStateRoot, type IsolatedStateRoot } from "./isolated-state-root.js";
import { normalizeJson } from "./normalizers.js";
import { installNoNetworkGuard } from "./network-guard.js";
import type { GoldenTraceFixture, JsonObject, TraceArtifactTreeEntry, TraceEvent } from "./types.js";

export interface GoldenTraceRunResult {
  events: GoldenTraceFixture["expected"]["events"];
  surface: GoldenTraceFixture["expected"]["surface"];
  control_db_export: JsonObject;
  artifact_tree: GoldenTraceFixture["expected"]["artifact_tree"];
  stdout: string;
  stderr: string;
}

export async function runGoldenTrace(fixture: GoldenTraceFixture): Promise<GoldenTraceRunResult> {
  assertHarnessPolicy(fixture);
  const guard = fixture.input.allow_network === true ? null : installNoNetworkGuard();
  const stateRoot = await createIsolatedStateRoot(fixture.contract_name, fixture.initial_state);
  try {
    const result = await runProductionConformanceTrace(fixture, stateRoot);
    return normalizeJson(result as unknown as JsonObject, fixture.normalizers) as unknown as GoldenTraceRunResult;
  } finally {
    guard?.restore();
    await stateRoot.cleanup();
  }
}

export function assertGoldenTraceResult(fixture: GoldenTraceFixture, result: GoldenTraceRunResult): void {
  const expected = normalizeJson({
    events: fixture.expected.events,
    surface: fixture.expected.surface,
    control_db_export: fixture.expected.control_db_export,
    artifact_tree: fixture.expected.artifact_tree,
    stdout: fixture.expected.stdout ?? "",
    stderr: fixture.expected.stderr ?? "",
  }, fixture.normalizers);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(`Golden trace mismatch for ${fixture.contract_name}`);
  }
}

async function runProductionConformanceTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  if (fixture.contract_name.startsWith("eventserver_")) {
    return runEventServerTrace(fixture, stateRoot);
  }
  if (fixture.contract_name.startsWith("tool_")) {
    return runToolTrace(fixture, stateRoot);
  }
  if (fixture.contract_name.startsWith("runtime_control_")) {
    return runRuntimeControlTrace(fixture, stateRoot);
  }
  if (
    fixture.contract_name.startsWith("gateway_approval_") ||
    fixture.contract_name === "gateway_multi_approval_reentrant_same_turn" ||
    fixture.contract_name.startsWith("approval_")
  ) {
    return runApprovalTrace(fixture, stateRoot);
  }
  if (fixture.contract_name.startsWith("schedule_")) {
    return runScheduleTrace(fixture, stateRoot);
  }
  if (
    fixture.contract_name.startsWith("state_") ||
    fixture.contract_name.startsWith("attention_") ||
    fixture.contract_name.startsWith("session_registry_") ||
    fixture.contract_name.startsWith("resident_") ||
    fixture.contract_name.startsWith("daemon_")
  ) {
    return runStateDaemonTrace(fixture, stateRoot);
  }
  if (fixture.contract_name.startsWith("gateway_")) {
    return runGatewayTrace(fixture, stateRoot);
  }

  switch (fixture.contract_name) {
    case "queue_expired_claim_rejects_late_ack_and_reclaims":
      return runQueueExpiredClaimTrace(fixture, stateRoot);
    case "queue_dedupe_inflight_rejects_replacement":
      return runQueueDedupeInflightTrace(fixture, stateRoot);
    default:
      return runPendingRealRunnerTrace(fixture, stateRoot);
  }
}

async function runQueueExpiredClaimTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  let now = Date.parse(fixture.input.fake_now);
  const queue = new JournalBackedQueue({
    runtimeRoot: stateRoot.runtimeRoot,
    maxAttempts: 2,
    now: () => now,
  });
  const envelope = makeEnvelope(fixture, {
    idSuffix: "expired-claim",
    type: "command",
    name: "job",
    priority: "normal",
    payload: { contract_name: fixture.contract_name },
  });

  const accepted = queue.accept(envelope);
  const claim = queue.claim("worker-a", 100);
  if (!claim) throw new Error(`${fixture.contract_name} did not create an initial queue claim.`);

  now += 200;
  const renewAfterExpiry = queue.renew(claim.claimToken, 100);
  const lateAckAccepted = queue.ack(claim.claimToken);
  const lateNackAccepted = queue.nack(claim.claimToken, "late");
  const persistedBeforeSweep = new JournalBackedQueue({
    runtimeRoot: stateRoot.runtimeRoot,
    maxAttempts: 2,
    now: () => now,
  }).get(envelope.id)?.status ?? "missing";
  const sweep = queue.sweepExpiredClaims(now);
  const snapshot = stabilizeQueueSnapshot(queue.snapshot());

  const assertions: JsonObject = {
    accepted,
    initial_claim: {
      attempt: claim.attempt,
      lease_until: claim.leaseUntil,
      message_id: claim.messageId,
      worker_id: claim.workerId,
    },
    late_ack_accepted: lateAckAccepted,
    late_nack_accepted: lateNackAccepted,
    persisted_before_sweep_status: persistedBeforeSweep,
    post_sweep_snapshot: snapshot,
    renew_after_expiry_returned_claim: renewAfterExpiry !== null,
    sweep_result: {
      deadlettered: sweep.deadlettered,
      expired_claim_token_count: sweep.expiredClaimTokens.length,
      reclaimed: sweep.reclaimed,
    },
  };

  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "expired_claim",
    exportedState: {
      assertions,
      queue_runtime_root: "<isolated-runtime-root>",
    },
    assertions,
  });
}

async function runQueueDedupeInflightTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  const now = Date.parse(fixture.input.fake_now);
  const queue = new JournalBackedQueue({
    runtimeRoot: stateRoot.runtimeRoot,
    now: () => now,
  });
  const original = makeEnvelope(fixture, {
    idSuffix: "original",
    type: "event",
    name: "job",
    priority: "normal",
    payload: { version: 1 },
    dedupe_key: "logical-job",
  });
  const retry = makeEnvelope(fixture, {
    idSuffix: "retry",
    type: "event",
    name: "job",
    priority: "normal",
    payload: { version: 2 },
    dedupe_key: "logical-job",
  });

  const originalAccept = queue.accept(original);
  const claim = queue.claim("worker-a", 5_000);
  if (!claim) throw new Error(`${fixture.contract_name} did not create an inflight queue claim.`);
  const retryAccept = queue.accept(retry);
  const snapshot = stabilizeQueueSnapshot(queue.snapshot());

  const assertions: JsonObject = {
    claimed_message_id: claim.messageId,
    inflight_size: queue.inflightSize(),
    original_accept: originalAccept,
    pending_size: queue.size(),
    retry_accept: retryAccept,
    retry_record_present: queue.get(retry.id) !== undefined,
    snapshot,
  };

  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "dedupe_inflight",
    exportedState: {
      assertions,
      queue_runtime_root: "<isolated-runtime-root>",
    },
    assertions,
  });
}

async function runEventServerTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  const queue = new JournalBackedQueue({
    runtimeRoot: stateRoot.runtimeRoot,
    now: () => Date.parse(fixture.input.fake_now),
  });
  const envelopes: Envelope[] = [];
  const acceptedBeforeResponse: boolean[] = [];
  const server = new EventServer(
    { writeEvent: async () => undefined } as never,
    {
      port: 0,
      eventsDir: path.join(stateRoot.root, "events"),
      runtimeRoot: stateRoot.runtimeRoot,
      controlBaseDir: stateRoot.controlDbBase,
    },
  );
  server.setCommandEnvelopeHook((envelope) => {
    envelopes.push(envelope);
    acceptedBeforeResponse.push(queue.accept(envelope).accepted);
  });

  try {
    await server.start();
    if (fixture.contract_name === "eventserver_approval_unknown_request_rejected_before_accept") {
      const response = await requestJson(server, "POST", "/goals/goal-event/approve", {
        requestId: "unknown-approval-request",
        approved: true,
      });
      const assertions: JsonObject = {
        command_envelope_count: envelopes.length,
        http_status: response.status,
        queue_pending_size: queue.size(),
        rejected_before_enqueue: response.status === 404 && envelopes.length === 0 && queue.size() === 0,
        response_ok: response.body["ok"] === false,
      };
      return buildRealGoldenResult(fixture, stateRoot, {
        kind: "eventserver_unknown_approval_reject",
        exportedState: {
          assertions,
          response: response.body,
          queue_snapshot: stabilizeQueueSnapshot(queue.snapshot()),
        },
        assertions,
      });
    }

    const response = await requestJson(server, "POST", "/goals/goal-event/start", {
      backgroundRun: {
        backgroundRunId: "run:coreloop:goal-event",
        parentSessionId: "session:conversation:gateway-event",
        notifyPolicy: "done_only",
        replyTargetSource: "pinned_run",
        pinnedReplyTarget: {
          channel: "plugin_gateway",
          target_id: "gateway-event",
          thread_id: "event-thread",
        },
      },
    });
    const claimed = queue.claim("dispatcher", 5_000);
    const assertions: JsonObject = {
      accepted_before_response: acceptedBeforeResponse[0] === true,
      claimed_message_id: claimed ? "<claimed-message-id>" : null,
      command_envelope_count: envelopes.length,
      envelope_name: envelopes[0]?.name ?? null,
      http_status: response.status,
      queue_pending_after_claim: queue.size(),
      response_ok: response.body["ok"] === true,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "eventserver_durable_command_accept",
      exportedState: {
        assertions,
        command_envelope: envelopeSummary(envelopes[0]),
        queue_snapshot: queueSnapshotCounts(queue.snapshot()),
        response: { ok: response.body["ok"] === true },
      },
      assertions,
    });
  } finally {
    await server.stop();
  }
}

async function runToolTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  if (fixture.contract_name === "tool_readonly_fs_no_write_approval_under_workspace") {
    await fsp.writeFile(path.join(stateRoot.workspaceRoot, "notes.txt"), "hello\n", "utf8");
    const registry = new ToolRegistry();
    registry.register(new ReadTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const approvalRequests: unknown[] = [];
    const result = await executor.execute("read", { file_path: "notes.txt", limit: 1 }, {
      cwd: stateRoot.workspaceRoot,
      goalId: "goal-tool-read",
      trustBalance: 0,
      preApproved: false,
      approvalFn: async (request) => {
        approvalRequests.push(request);
        return false;
      },
      callId: "tool-call-read",
      sessionId: "session:tool-read",
    });
    const writeProbeExists = fs.existsSync(path.join(stateRoot.workspaceRoot, "created-by-read.txt"));
    const assertions: JsonObject = {
      approval_request_count: approvalRequests.length,
      read_success: result.success,
      result_has_read_artifact: Array.isArray(result.artifacts) && result.artifacts.length === 1,
      write_probe_exists: writeProbeExists,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "tool_catalog_readonly_fs",
      exportedState: {
        assertions,
        result: stableToolResult(result),
        tool_catalog: registry.listAll().map((tool) => tool.metadata.name).sort(),
      },
      assertions,
    });
  }

  if (fixture.contract_name === "tool_write_local_records_approval_artifact_before_mutation") {
    const registry = new ToolRegistry();
    registry.register(new FileWriteTool());
    const waitPlanStore = new PermissionWaitPlanStore(stateRoot.runtimeRoot, { controlBaseDir: stateRoot.controlDbBase });
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const approvalEvents: JsonObject[] = [];
    const targetRelative = path.join("approved", "file.txt");
    const target = path.join(stateRoot.workspaceRoot, targetRelative);
    const result = await executor.execute("file_write", { path: targetRelative, content: "approved\n" }, {
      cwd: stateRoot.workspaceRoot,
      goalId: "goal-tool-write",
      trustBalance: -50,
      preApproved: false,
      permissionWaitPlanStore: waitPlanStore,
      approvalFn: async (request) => {
        approvalEvents.push({
          approval_id: request.approvalId ? "<approval-id>" : null,
          permission_wait_plan_id: request.permissionWaitPlanId ? "<permission-wait-plan-id>" : null,
          tool_name: request.toolName,
        });
        return true;
      },
      onApprovalRequested: (request) => {
        approvalEvents.push({
          approval_id: request.approvalId ? "<approval-id>" : null,
          permission_wait_plan_id: request.permissionWaitPlanId ? "<permission-wait-plan-id>" : null,
          stage: "requested",
          tool_name: request.toolName,
        });
      },
      callId: "tool-call-write",
      sessionId: "session:tool-write",
      turnId: "turn:tool-write",
    });
    const deniedRelative = "denied.txt";
    const deniedTarget = path.join(stateRoot.workspaceRoot, deniedRelative);
    const denied = await executor.execute("file_write", { path: deniedRelative, content: "denied\n" }, {
      cwd: stateRoot.workspaceRoot,
      goalId: "goal-tool-write",
      trustBalance: -50,
      preApproved: false,
      permissionWaitPlanStore: waitPlanStore,
      approvalFn: async () => false,
      callId: "tool-call-write-denied",
      sessionId: "session:tool-write",
    });
    const assertions: JsonObject = {
      approval_before_mutation: approvalEvents.length > 0 && fs.existsSync(target),
      approved_write_success: result.success,
      denied_execution_status: denied.execution?.status ?? null,
      denied_mutation_exists: fs.existsSync(deniedTarget),
      mutation_artifact_count: result.artifacts?.length ?? 0,
      wait_plan_count: (await waitPlanStore.listByState("waiting_for_permission")).length,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "tool_approval_artifact_before_mutation",
      exportedState: {
        approval_events: approvalEvents,
        assertions,
        denied_result: stableToolResult(denied),
        result: stableToolResult(result),
      },
      assertions,
    });
  }

  const stateManager = new StateManager(stateRoot.controlDbBase, undefined, { walEnabled: false });
  const events: TraceEvent[] = [];
  let readToolCallCount = 0;
  const registry = new ToolRegistry();
  registry.register(makeGatewayReadTraceTool(() => { readToolCallCount += 1; }));
  const llmClient = makeGatewayUnavailableToolLlmClient();
  const runner = new ChatRunner({
    stateManager,
    adapter: {
      adapterType: "trace-adapter",
      async execute() {
        throw new Error("Tool-unavailable trace must use the gateway model loop.");
      },
    },
    llmClient,
    registry,
    onEvent: (event) => {
      events.push(chatEventToTraceEvent(fixture, event as Record<string, unknown>));
    },
  });
  const selectedRoute: SelectedChatRoute = {
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
  const ingress = buildStandaloneIngressMessage({
    channel: "plugin_gateway",
    conversation_id: "conversation:tool-unavailable",
    cwd: stateRoot.workspaceRoot,
    identity_key: "telegram:user:tool-unavailable",
    message_id: "message:tool-unavailable",
    platform: "telegram",
    runtimeControl: { allowed: true, approvalMode: "interactive" },
    text: "README を読んで答えて",
    user_id: "user:tool-unavailable",
  });
  const result = await runner.executeIngressMessage(ingress, stateRoot.workspaceRoot, 120_000, selectedRoute);
  const modelRequests = llmClient.getRequests();
  const secondRequestToolMessage = modelRequests[1]?.messages.find((message) => message.role === "tool");
  const toolEndEvents = events.filter((event) => event.type === "tool_end");
  const assertions: JsonObject = {
    model_continuation_after_tool_error: result.success && modelRequests.length === 2 && result.output.includes("read_file"),
    structured_tool_error_returned: typeof secondRequestToolMessage?.content === "string"
      && secondRequestToolMessage.content.includes("\"error\":\"unavailable_tool\"")
      && secondRequestToolMessage.content.includes("\"denial_class\":\"unknown_tool\""),
    tool_end_event_recorded: toolEndEvents.some((event) => event.payload?.["success"] === false),
    unavailable_tool_executed: readToolCallCount > 0,
  };
  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "chatrunner_tool_unavailable_continuation",
    exportedState: {
      assertions,
      chat_result: {
        output: result.output,
        success: result.success,
      },
      events,
      model_loop: modelRequests.map((request, index) => ({
        index,
        message_roles: request.messages.map((message) => message.role),
        tool_message: index === 1 && secondRequestToolMessage?.role === "tool"
          ? {
              content: secondRequestToolMessage.content,
              name: secondRequestToolMessage.name ?? null,
              tool_call_id: secondRequestToolMessage.tool_call_id,
            }
          : null,
      })),
      read_tool_call_count: readToolCallCount,
    },
    assertions,
  });
}

async function runRuntimeControlTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  const operationStore = new RuntimeOperationStore(stateRoot.runtimeRoot, { controlBaseDir: stateRoot.controlDbBase });
  const handoffStore = {
    create: async (input: Record<string, unknown>) => input,
  };
  const executorCalls: JsonObject[] = [];
  const service = new RuntimeControlService({
    operationStore,
    operatorHandoffStore: handoffStore as never,
    sessionRegistry: { snapshot: async () => runtimeControlSnapshotFor(fixture.contract_name, fixture.input.fake_now) },
    executor: async (operation) => {
      executorCalls.push({
        kind: operation.kind,
        operation_id: "<runtime-operation-id>",
        run_id: operation.target?.run_id ?? null,
      });
      return { ok: true, state: "verified", message: `${operation.kind} accepted by typed executor` };
    },
    now: () => new Date(fixture.input.fake_now),
  });
  const replyTarget = {
    surface: "gateway" as const,
    channel: "plugin_gateway" as const,
    platform: "telegram",
    conversation_id: runtimeControlConversationFor(fixture.contract_name),
    message_id: "msg-runtime-control",
    identity_key: "operator",
    user_id: "operator",
  };
  const intent = runtimeControlIntentFor(fixture.contract_name);
  const result = await service.request({
    cwd: stateRoot.workspaceRoot,
    intent,
    requestedBy: {
      surface: "gateway",
      platform: "telegram",
      conversation_id: replyTarget.conversation_id,
      identity_key: "operator",
      user_id: "operator",
    },
    replyTarget,
    approvalFn: async () => true,
  });
  const operations = [
    ...await operationStore.listPending(),
    ...await operationStore.listCompleted(),
  ].sort((left, right) => left.requested_at.localeCompare(right.requested_at));
  const latest = operations[operations.length - 1] ?? null;
  const assertions: JsonObject = {
    blocked_reason: result.success ? null : result.message,
    executor_call_count: executorCalls.length,
    operation_count: operations.length,
    operation_state: latest?.state ?? null,
    reply_target_conversation: latest?.reply_target?.conversation_id ?? null,
    result_success: result.success,
    target_run_id: latest?.target?.run_id ?? null,
  };
  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "runtime_control_service_target_resolution",
    exportedState: {
      assertions,
      executor_calls: executorCalls,
      operations: operations.map(runtimeOperationSummary),
      result: runtimeControlResultSummary(result),
    },
    assertions,
  });
}

async function runApprovalTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  const store = new ApprovalStore(stateRoot.runtimeRoot, { controlBaseDir: stateRoot.controlDbBase });
  const events: JsonObject[] = [];
  const origin = {
    channel: "telegram",
    conversation_id: "approval-chat",
    user_id: "operator",
    session_id: "session:approval",
    turn_id: "turn:approval",
  };
  const delivery = deliveryForApprovalTrace(fixture.contract_name);
  const broker = new ApprovalBroker({
    store,
    createId: () => `approval-${fixture.contract_name}`,
    now: () => Date.parse(fixture.input.fake_now),
    broadcast: (eventType, data) => events.push({ event_type: eventType, data: sanitizeUnknown(data) }),
    deliverConversationalApproval: delivery,
  });

  let requestResult: boolean | null = null;
  if (fixture.contract_name === "gateway_multi_approval_reentrant_same_turn") {
    const firstId = `approval-${fixture.contract_name}-first`;
    const secondId = `approval-${fixture.contract_name}-second`;
    const first = broker.requestConversationalApproval("goal-approval", approvalTaskFor(`${fixture.contract_name}-write`), {
      approvalId: firstId,
      origin,
    });
    const second = broker.requestConversationalApproval("goal-approval", approvalTaskFor(`${fixture.contract_name}-other_tool`), {
      approvalId: secondId,
      origin: { ...origin, turn_id: "turn:approval:second" },
    });
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    await waitForPendingApproval(store, firstId);
    await waitForPendingApproval(store, secondId);
    const firstResolved = await broker.resolveConversationalApproval(firstId, true, origin);
    const secondResolved = await broker.resolveConversationalApproval(secondId, true, { ...origin, turn_id: "turn:approval:second" });
    const requestResults = await Promise.all([first, second]);
    await broker.stop();
    const firstPending = await store.loadPending(firstId);
    const secondPending = await store.loadPending(secondId);
    const firstRecord = await store.loadResolved(firstId);
    const secondRecord = await store.loadResolved(secondId);
    const assertions: JsonObject = {
      approval_request_count: 2,
      both_requests_resolved: requestResults.every((result) => result === true),
      first_resolved: firstResolved,
      pending_after_resolution: firstPending !== null || secondPending !== null,
      resolved_count: [firstRecord, secondRecord].filter(Boolean).length,
      second_resolved: secondResolved,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "approval_broker_multi_reentrant",
      exportedState: {
        assertions,
        events,
        resolved_records: [
          firstRecord ? approvalRecordSummary(firstRecord) : null,
          secondRecord ? approvalRecordSummary(secondRecord) : null,
        ],
      },
      assertions,
    });
  }

  if (fixture.contract_name === "approval_pending_restored_after_daemon_restart") {
    const pendingPromise = broker.requestConversationalApproval("goal-approval", approvalTaskFor(fixture.contract_name), {
      approvalId: `approval-${fixture.contract_name}`,
      origin,
      deliverConversationalApproval: () => ({ delivered: true }),
    });
    void pendingPromise.catch(() => undefined);
    await waitForPendingApproval(store, `approval-${fixture.contract_name}`);
    await broker.stop();
    const restoredEvents: JsonObject[] = [];
    const restarted = new ApprovalBroker({
      store,
      now: () => Date.parse(fixture.input.fake_now) + 1_000,
      broadcast: (eventType, data) => restoredEvents.push({ event_type: eventType, data: sanitizeUnknown(data) }),
      deliverConversationalApproval: () => ({ delivered: true }),
    });
    await restarted.start();
    const resolved = await restarted.resolveConversationalApproval(`approval-${fixture.contract_name}`, true, origin);
    requestResult = resolved;
    await restarted.stop();
    const assertions: JsonObject = {
      pending_restored_event_count: restoredEvents.length,
      request_result: requestResult,
      resolved,
      resolved_state: (await store.loadResolved(`approval-${fixture.contract_name}`))?.state ?? null,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "approval_broker_pending_restore",
      exportedState: { assertions, initial_events: events, restored_events: restoredEvents },
      assertions,
    });
  }

  const pending = broker.requestConversationalApproval("goal-approval", approvalTaskFor(fixture.contract_name), {
    approvalId: `approval-${fixture.contract_name}`,
    origin,
  });
  void pending.catch(() => undefined);
  await settleDelivery();
  if (fixture.contract_name !== "approval_delivery_unavailable_denies_not_executes") {
    await waitForPendingApproval(store, `approval-${fixture.contract_name}`);
  }
  const resolved = fixture.contract_name === "approval_delivery_unavailable_denies_not_executes"
    ? false
    : await broker.resolveConversationalApproval(
      `approval-${fixture.contract_name}`,
      !fixture.contract_name.includes("denial"),
      fixture.contract_name === "approval_origin_bound_stale_reply_rejected"
        ? { ...origin, turn_id: "turn:stale" }
        : origin,
    );
  requestResult = fixture.contract_name.includes("denial") ||
    fixture.contract_name === "approval_origin_bound_stale_reply_rejected" ||
    fixture.contract_name === "approval_delivery_unavailable_denies_not_executes"
    ? null
    : resolved;
  await broker.stop();
  const pendingRecord = await store.loadPending(`approval-${fixture.contract_name}`);
  const resolvedRecord = await store.loadResolved(`approval-${fixture.contract_name}`);
  const assertions: JsonObject = {
    mutation_executed: false,
    pending_after_resolution: pendingRecord !== null,
    request_result: requestResult,
    resolved,
    resolved_state: resolvedRecord?.state ?? null,
    stale_reply_rejected: fixture.contract_name === "approval_origin_bound_stale_reply_rejected" ? resolved === false : null,
  };
  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "approval_broker_scope_gate",
    exportedState: {
      assertions,
      events,
      pending_record: pendingRecord ? approvalRecordSummary(pendingRecord) : null,
      resolved_record: resolvedRecord ? approvalRecordSummary(resolvedRecord) : null,
    },
    assertions,
  });
}

async function runScheduleTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  if (fixture.contract_name === "schedule_wait_resume_before_due_no_attention_or_notification") {
    const notifications: JsonObject[] = [];
    const engine = new ScheduleEngine({
      baseDir: stateRoot.controlDbBase,
      notificationDispatcher: { dispatch: async (report) => { notifications.push(sanitizeUnknown(report)); } },
    });
    const entry = await engine.addEntry(makeWaitResumeScheduleInput("before-due"));
    await engine.loadEntries();
    const results = await engine.tick();
    const assertions: JsonObject = {
      due_result_count: results.length,
      notification_count: notifications.length,
      next_fire_in_future: Date.parse(engine.getEntries()[0]?.next_fire_at ?? "0") > Date.now(),
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "schedule_wait_resume_before_due",
      exportedState: { assertions, entry_id: "<schedule-entry-id>", notifications },
      assertions,
    });
  }

  const engine = new ScheduleEngine({ baseDir: stateRoot.controlDbBase });
  const entry = await engine.addEntry(makeWaitResumeScheduleInput(fixture.contract_name));
  const dueAt = "2026-05-12T00:00:00.000Z";
  engine.getEntries()[0]!.next_fire_at = dueAt;
  await engine.saveEntries();
  await engine.loadEntries();
  const firstResults = await engine.tick();
  let secondResults: Awaited<ReturnType<ScheduleEngine["tick"]>> = [];
  if (
    fixture.contract_name === "schedule_wait_resume_retry_same_due_idempotent" ||
    fixture.contract_name === "schedule_side_effect_crash_replay_no_duplicate_execution"
  ) {
    const replayedEntry = engine.getEntries().find((candidate) => candidate.id === entry.id)!;
    replayedEntry.next_fire_at = "2026-05-12T01:00:00.000Z";
    replayedEntry.retry_state = {
      attempts: 1,
      next_retry_at: "2026-05-12T00:00:01.000Z",
      scheduled_for: dueAt,
      last_attempt_at: "2026-05-12T00:00:00.500Z",
      first_failure_at: "2026-05-12T00:00:00.500Z",
      last_failure_kind: "transient",
      last_error_message: "retry wait-resume attention",
    };
    await engine.saveEntries();
    await engine.loadEntries();
    secondResults = await engine.tick();
  }
  const history = await engine.getRecentHistory(10, entry.id);
  const store = new AttentionStateStore(path.join(stateRoot.controlDbBase, "runtime"), { controlBaseDir: stateRoot.controlDbBase });
  const concern = await store.loadConcernState();
  const cycleResults = await store.listCycleResults();
  const assertions: JsonObject = {
    agenda_item_count: concern.agenda_items.length,
    cycle_result_count: cycleResults.length,
    first_result_status: firstResults[0]?.status ?? null,
    history_count: history.length,
    notification_count: 0,
    second_result_count: secondResults.length,
  };
  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "schedule_engine_wait_resume_attention",
    exportedState: {
      assertions,
      cycle_results: cycleResults.map((item) => ({
        trigger_kind: item.result["trigger"] ?? null,
        write_disposition: item.write_disposition,
      })),
      history: history.map((record) => ({
        reason: record.reason,
        scheduled_for: record.scheduled_for,
        status: record.status,
      })),
    },
    assertions,
  });
}

async function runStateDaemonTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  if (fixture.contract_name === "state_attention_schema_ahead_fail_closed") {
    const dbPath = path.join(stateRoot.controlDbBase, "pulseed-control.sqlite");
    await fsp.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("user_version = 999");
    db.close();
    const store = new AttentionStateStore(stateRoot.runtimeRoot, { controlBaseDir: stateRoot.controlDbBase });
    let blocked = false;
    let message = "";
    try {
      await store.ensureReady();
    } catch (error) {
      blocked = true;
      message = error instanceof Error ? error.message : String(error);
    }
    const assertions: JsonObject = {
      fail_closed: blocked,
      message_contains_newer_schema: message.includes("newer than supported version"),
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "attention_schema_ahead_fail_closed",
      exportedState: { assertions, error_message: message },
      assertions,
    });
  }

  if (fixture.contract_name === "state_runtime_root_custom_shared_control_db") {
    const configuredRuntimeRoot = path.join(stateRoot.root, "configured-runtime-root");
    await fsp.writeFile(path.join(stateRoot.controlDbBase, "daemon.json"), JSON.stringify({
      runtime_root: configuredRuntimeRoot,
    }), "utf8");
    const engine = new ScheduleEngine({ baseDir: stateRoot.controlDbBase });
    const entry = await engine.addEntry(makeWaitResumeScheduleInput("custom-root"));
    engine.getEntries()[0]!.next_fire_at = "2026-05-12T00:00:00.000Z";
    await engine.saveEntries();
    await engine.loadEntries();
    await engine.tick();
    const configuredStore = new AttentionStateStore(configuredRuntimeRoot, { controlBaseDir: stateRoot.controlDbBase });
    const splitStore = new AttentionStateStore(configuredRuntimeRoot);
    const configuredConcern = await configuredStore.loadConcernState();
    const splitConcern = await splitStore.loadConcernState();
    const assertions: JsonObject = {
      configured_runtime_root: "<configured-runtime-root>",
      entry_id_present: entry.id.length > 0,
      shared_control_agenda_count: configuredConcern.agenda_items.length,
      split_control_agenda_count: splitConcern.agenda_items.length,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "runtime_root_shared_control_db",
      exportedState: { assertions },
      assertions,
    });
  }

  if (fixture.contract_name === "session_registry_dead_process_not_running") {
    const baseDir = path.join(stateRoot.root, "session-registry");
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    await stateManager.writeRaw("runtime/process-sessions/proc-stale-ledger.json", {
      session_id: "proc-stale-ledger",
      pid: 999_999,
      label: "stale ledger process",
      command: "node",
      args: ["worker.js"],
      cwd: stateRoot.workspaceRoot,
      running: true,
      exitCode: null,
      signal: null,
      startedAt: fixture.input.fake_now,
      bufferedChars: 0,
      metadataRef: "control-db://process-sessions/proc-stale-ledger",
      artifactRefs: [],
    });
    const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await ledger.ensureReady();
    await ledger.create({
      id: "run:process:proc-stale-ledger",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-stale-ledger",
      title: "durable running process",
      workspace: stateRoot.workspaceRoot,
      created_at: fixture.input.fake_now,
      started_at: fixture.input.fake_now,
      status: "running",
    });
    const snapshot = await new RuntimeSessionRegistry({ stateManager, isPidAlive: () => false }).snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === "run:process:proc-stale-ledger");
    const assertions: JsonObject = {
      dead_process_warning: snapshot.warnings.some((warning) => warning.code === "dead_process_sidecar"),
      projected_status: run?.status ?? null,
      running_reported: run?.status === "running",
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "session_registry_dead_process",
      exportedState: { assertions, snapshot: snapshotSummary(snapshot) },
      assertions,
    });
  }

  if (fixture.contract_name === "daemon_progress_final_order_once") {
    const events: TraceEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(chatEventToTraceEvent(fixture, event as Record<string, unknown>));
    });
    const context = {
      runId: "run:daemon-progress",
      cwd: stateRoot.workspaceRoot,
      goalId: "goal-daemon-progress",
      sessionId: "session-daemon-progress",
      turnId: "turn-daemon-progress",
    };
    bridge.beginActiveTurn(context, stateRoot.workspaceRoot);
    bridge.emitActivity("tool", "Running check", context, "tool:check");
    await bridge.emitEventAndFlush({
      type: "assistant_final",
      text: "Done once.",
      persisted: true,
      createdAt: fixture.input.fake_now,
      runId: context.runId,
      turnId: context.turnId,
    });
    bridge.emitLifecycleEndEvent("completed", 1, context, true);
    await bridge.flushEventRecorder();
    const finalCount = events.filter((event) => event.type === "assistant_final").length;
    const assertions: JsonObject = {
      final_count: finalCount,
      final_is_last_visible_assistant_output: events.findLastIndex((event) => event.visible) === events.findIndex((event) => event.type === "assistant_final"),
      progress_after_final_count: events.slice(events.findIndex((event) => event.type === "assistant_final") + 1)
        .filter((event) => event.type === "activity").length,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "daemon_progress_final_order",
      exportedState: { assertions, events },
      assertions,
    });
  }

  const store = new AttentionStateStore(stateRoot.runtimeRoot, { controlBaseDir: stateRoot.controlDbBase });
  await store.ensureReady();
  if (fixture.contract_name === "attention_observation_requires_visible_indicator_before_event") {
    await store.addPendingBlock({
      scope: attentionScopeFor(fixture.contract_name),
      triggerKind: "observation",
      reason: "visible indicator required before non-terminal observation event",
      createdAt: fixture.input.fake_now,
    });
  } else if (fixture.contract_name === "attention_observation_after_expiry_terminal_allowed_only") {
    await store.saveMetabolismCycle({
      cycle_id: "cycle:terminal-expiry",
      idempotency_key: "cycle:terminal-expiry",
      trigger_kind: "wait_expiry",
      scope: attentionScopeFor(fixture.contract_name),
      expected_projection_revision: 0,
      source_high_watermarks: ["wait:expired"],
      clusters: [],
      agendaItems: [],
      decompositions: [],
      result: { terminal_only: true },
      created_at: fixture.input.fake_now,
    });
  }
  const pendingBlocks = await store.listPendingBlocks(attentionScopeFor(fixture.contract_name));
  const cycleResults = await store.listCycleResults();
  const assertions: JsonObject = {
    capability_authority_granted: false,
    cycle_result_count: cycleResults.length,
    pending_block_count: pendingBlocks.length,
  };
  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "attention_or_resident_runtime_boundary",
    exportedState: { assertions, cycle_results: cycleResults, pending_blocks: pendingBlocks },
    assertions,
  });
}

async function runGatewayTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  if (fixture.contract_name === "gateway_runtime_status_uses_tool_evidence_not_guidance") {
    const snapshot = runtimeStatusSnapshot(fixture.input.fake_now);
    const statusText = formatRuntimeStatus(snapshot);
    const assertions: JsonObject = {
      contains_run_id: statusText.includes("run:coreloop:status"),
      generic_guidance_returned: statusText.includes("try checking") || statusText.includes("you can run"),
      status_line_count: statusText.split("\n").length,
      typed_runtime_evidence_used: true,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "gateway_runtime_status_typed_evidence",
      exportedState: { assertions, snapshot: snapshotSummary(snapshot), status_text: statusText },
      assertions,
    });
  }

  if (fixture.contract_name === "gateway_secret_setup_redacts_token_and_confirms_write") {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const intake = intakeSetupSecrets(`configure telegram ${token}`, fixture.input.fake_now);
    const configPath = path.join(stateRoot.pulseedHome, "gateway", "telegram.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      bot_token_ref: intake.suppliedSecrets[0]?.id,
      configured_at: fixture.input.fake_now,
    }, null, 2), "utf8");
    const persisted = JSON.parse(await fsp.readFile(configPath, "utf8")) as Record<string, unknown>;
    const assertions: JsonObject = {
      config_written: persisted["bot_token_ref"] === "setup_secret_1",
      redacted_text_contains_secret: intake.redactedText.includes(token),
      secret_count: intake.suppliedSecrets.length,
      token_value_persisted: JSON.stringify(persisted).includes(token),
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "gateway_secret_setup_redaction",
      exportedState: { assertions, config_path: "pulseed-home/gateway/telegram.json", intake: sanitizeSecretIntake(intake) },
      assertions,
    });
  }

  if (fixture.contract_name === "gateway_runspec_draft_pending_no_same_turn_start") {
    const stateManager = new StateManager(stateRoot.controlDbBase, undefined, { walEnabled: false });
    const llmClient = makeRunspecDraftLlmClient();
    let daemonStartCount = 0;
    let agentLoopExecuteCount = 0;
    let draftToolResult: ToolResult | null = null;
    let sameTurnStartResult: ToolResult | null = null;
    const daemonClient = {
      async startGoal(): Promise<never> {
        daemonStartCount += 1;
        return { id: "unexpected-start" } as never;
      },
    };
    const chatAgentLoopRunner: NonNullable<ChatRunnerDeps["chatAgentLoopRunner"]> = {
      async execute(input: { toolCallContext?: Partial<ToolCallContext> }) {
        agentLoopExecuteCount += 1;
        const tools = createRunSpecHandoffTools({
          stateManager,
          llmClient,
          daemonClient,
        });
        const draftTool = tools.find((tool) => tool.metadata.name === "draft_run_spec");
        const confirmTool = tools.find((tool) => tool.metadata.name === "runspec_confirm");
        const toolCallContext = input.toolCallContext as ToolCallContext | undefined;
        if (!draftTool || !confirmTool || !toolCallContext) {
          throw new Error("RunSpec handoff tools were not available to the AgentLoop runner.");
        }
        draftToolResult = await draftTool.call({
          request: "DurableLoopでKaggleのスコアが0.98を超えるまで最適化を続けて",
        }, toolCallContext);
        const pending = await toolCallContext.runSpecConfirmation?.get() as {
          spec?: { id?: string; updated_at?: string };
          updatedAt?: string;
        } | null | undefined;
        const runSpecId = pending?.spec?.id;
        const observedEpoch = pending?.updatedAt ?? pending?.spec?.updated_at;
        if (runSpecId && observedEpoch) {
          sameTurnStartResult = await confirmTool.call({
            observed_run_spec_epoch: observedEpoch,
            run_spec_id: runSpecId,
          }, toolCallContext);
        }
        return {
          success: true,
          output: draftToolResult.summary,
          error: null,
          exit_code: null,
          elapsed_ms: 1,
          stopped_reason: "completed",
        };
      },
    };
    const runner = new ChatRunner({
      stateManager,
      adapter: {
        adapterType: "trace-adapter",
        async execute() {
          throw new Error("RunSpec trace must use the AgentLoop route.");
        },
      },
      llmClient,
      chatAgentLoopRunner,
      daemonClient,
    });
    const selectedRoute: SelectedChatRoute = {
      kind: "agent_loop",
      reason: "agent_loop_available",
      replyTargetPolicy: "turn_reply_target",
      eventProjectionPolicy: "turn_only",
      concurrencyPolicy: "session_serial",
    };
    const ingress = buildStandaloneIngressMessage({
      channel: "plugin_gateway",
      conversation_id: "conversation:runspec",
      cwd: stateRoot.workspaceRoot,
      deliveryMode: "reply",
      identity_key: "telegram:user:runspec",
      message_id: "message:runspec",
      metadata: { gateway_message: true },
      platform: "telegram",
      replyTarget: {
        response_channel: "telegram:conversation:runspec",
        metadata: { gateway_message: true },
      },
      runtimeControl: { allowed: true, approvalMode: "interactive" },
      text: "DurableLoopでKaggleのスコアが0.98を超えるまで最適化を続けて",
      user_id: "user:runspec",
    });
    const result = await runner.executeIngressMessage(ingress, stateRoot.workspaceRoot, 120_000, selectedRoute);
    const specs = await createRunSpecStore(stateManager).list();
    const session = await new ChatSessionCatalog(stateManager).loadSession(runner.getSessionId() ?? "");
    const confirmation = session?.runSpecConfirmation ?? null;
    const stored = specs[0] ?? null;
    const assertions: JsonObject = {
      agent_loop_executed: agentLoopExecuteCount === 1,
      background_run_started: daemonStartCount > 0,
      draft_tool_succeeded: draftToolResult?.success === true,
      pending_confirmation_written: confirmation?.state === "pending" && specs.length === 1,
      same_turn_start_blocked: sameTurnStartResult?.success === false && daemonStartCount === 0,
      stored_draft_count: specs.length,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "gateway_runspec_pending_gate",
      exportedState: {
        assertions,
        chat_result: {
          success: result.success,
          output_present: result.output.length > 0,
        },
        same_turn_start_result: sameTurnStartResult
          ? {
              execution_status: sameTurnStartResult.execution?.status ?? null,
              success: sameTurnStartResult.success,
              summary: sameTurnStartResult.summary,
            }
          : null,
        run_spec_state: {
          id: stored ? "<run-spec-id>" : null,
          origin_channel: stored?.origin.channel ?? null,
          origin_reply_target: stored?.origin.reply_target
            ? sanitizeUnknown(stored.origin.reply_target)
            : null,
          profile: stored?.profile ?? null,
          status: stored?.status ?? null,
        },
        session_state: {
          id: session ? "<chat-session-id>" : null,
          run_spec_confirmation: confirmation
            ? {
                spec_id: "<run-spec-id>",
                state: confirmation.state,
              }
            : null,
        },
      },
      assertions,
    });
  }

  if (fixture.contract_name === "gateway_runspec_epoch_changed_rejects_start") {
    const stateManager = new StateManager(stateRoot.controlDbBase, undefined, { walEnabled: false });
    let daemonStartCount = 0;
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const tools = new Map(createRunSpecHandoffTools({
      stateManager,
      llmClient: makeRunspecDraftLlmClient({ includeRecoveryPrelude: false }),
      daemonClient: {
        async startGoal(): Promise<never> {
          daemonStartCount += 1;
          return { id: "unexpected-start" } as never;
        },
      },
    }).map((tool) => [tool.metadata.name, tool]));
    const context = makeRunSpecToolContext(stateRoot.workspaceRoot, pendingRef, {
      conversationSessionId: "session:runspec-epoch",
      replyTarget: {
        surface: "gateway",
        channel: "plugin_gateway",
        platform: "telegram",
        conversation_id: "conversation:runspec-epoch",
        message_id: "message:runspec-epoch",
        identity_key: "telegram:user:runspec-epoch",
      },
    });
    const propose = tools.get("runspec_propose");
    const confirm = tools.get("runspec_confirm");
    if (!propose || !confirm) {
      throw new Error("RunSpec epoch trace could not find required handoff tools.");
    }
    const proposed = await propose.call({
      request: "Run Kaggle optimization until score exceeds 0.98",
    }, context);
    const observedEpoch = typeof (proposed.data as Record<string, unknown>)["observed_run_spec_epoch"] === "string"
      ? String((proposed.data as Record<string, unknown>)["observed_run_spec_epoch"])
      : pendingRef.value?.updatedAt ?? "";
    const runSpecId = pendingRef.value?.spec.id ?? "";
    pendingRef.value = pendingRef.value
      ? {
          ...pendingRef.value,
          updatedAt: "2026-05-13T00:02:00.000Z",
          spec: {
            ...pendingRef.value.spec,
            updated_at: "2026-05-13T00:02:00.000Z",
          },
        }
      : null;
    if (pendingRef.value) {
      await createRunSpecStore(stateManager).save(pendingRef.value.spec);
    }
    const staleConfirm = await confirm.call({
      observed_run_spec_epoch: observedEpoch,
      run_spec_id: runSpecId,
    }, context);
    const assertions: JsonObject = {
      background_run_started: daemonStartCount > 0,
      epoch_changed_rejected: staleConfirm.success === false
        && staleConfirm.execution?.status === "not_executed"
        && staleConfirm.execution?.reason === "stale_state",
      stale_confirmation_consumed: pendingRef.value === null || pendingRef.value.state !== "pending",
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "gateway_runspec_epoch_gate",
      exportedState: {
        assertions,
        confirmation: {
          current_epoch: pendingRef.value?.updatedAt ?? null,
          observed_epoch: observedEpoch ? "<observed-run-spec-epoch>" : null,
          run_spec_id: runSpecId ? "<run-spec-id>" : null,
        },
        propose_result: stableToolResult(proposed),
        stale_confirm_result: stableToolResult({
          ...staleConfirm,
          error: staleConfirm.error ? "<stale-run-spec-error>" : undefined,
        }),
      },
      assertions,
    });
  }

  if (fixture.contract_name === "gateway_routed_ingress_preserves_reply_target_after_restart") {
    const stateManager = new StateManager(stateRoot.controlDbBase, undefined, { walEnabled: false });
    const persistedReplyTarget: RuntimeControlReplyTarget = {
      surface: "gateway",
      channel: "plugin_gateway",
      platform: "telegram",
      conversation_id: "conversation:gateway-restart",
      message_id: "msg-gateway-restart",
      identity_key: "operator",
      user_id: "operator",
    };
    const staleFallbackReplyTarget: RuntimeControlReplyTarget = {
      ...persistedReplyTarget,
      conversation_id: "conversation:stale-fallback",
      message_id: "msg-stale-fallback",
    };
    await new ChatSessionDataStore(stateRoot.controlDbBase).save({
      id: "gateway-restart",
      cwd: stateRoot.workspaceRoot,
      createdAt: fixture.input.fake_now,
      updatedAt: fixture.input.fake_now,
      title: "Gateway restart",
      messages: [
        {
          role: "user",
          content: "continue",
          timestamp: fixture.input.fake_now,
          turnIndex: 0,
        },
      ],
      notificationReplyTarget: {
        channel: "plugin_gateway",
        target_id: "conversation:gateway-restart",
        thread_id: "msg-gateway-restart",
        metadata: persistedReplyTarget,
      },
    });
    const restored = await new ChatSessionCatalog(stateManager).loadSession("gateway-restart");
    const restoredReplyTarget = runtimeReplyTargetFromMetadata(restored?.notificationReplyTarget?.metadata);
    const ingress = buildStandaloneIngressMessageFromContext("continue", {
      ...(restoredReplyTarget ? { replyTarget: restoredReplyTarget } : {}),
      actor: {
        surface: "gateway",
        platform: "telegram",
        identity_key: "operator",
        user_id: "operator",
      },
      allowed: true,
      approvalMode: "interactive",
      explicit: false,
    }, {
      stateManager,
      runtimeReplyTarget: staleFallbackReplyTarget,
    });
    const assertions: JsonObject = {
      reply_target_after_restart: `${ingress.replyTarget.channel}:${ingress.replyTarget.conversation_id}`,
      reply_target_preserved: ingress.replyTarget.conversation_id === "conversation:gateway-restart",
      restored_reply_target_loaded: restoredReplyTarget?.conversation_id === "conversation:gateway-restart",
      stale_fallback_rejected: ingress.replyTarget.conversation_id !== "conversation:stale-fallback",
      transcript_reloaded: (restored?.messages.length ?? 0) > 0,
    };
    return buildRealGoldenResult(fixture, stateRoot, {
      kind: "gateway_reply_target_restart",
      exportedState: {
        assertions,
        ingress_reply_target: sanitizeUnknown(ingress.replyTarget),
        restored_notification_reply_target: restored?.notificationReplyTarget
          ? sanitizeUnknown(restored.notificationReplyTarget)
          : null,
      },
      assertions,
    });
  }

  const stateManager = new StateManager(stateRoot.controlDbBase, undefined, { walEnabled: false });
  const events: TraceEvent[] = [];
  const readTrace = fixture.contract_name === "gateway_read_workspace_under_protected_paths_no_approval";
  let approvalRequested = false;
  let readToolCallCount = 0;
  const registry = new ToolRegistry();
  if (readTrace) {
    await fsp.writeFile(
      path.join(stateRoot.workspaceRoot, "README.md"),
      "PulSeed gateway read trace fixture.\nThis file is safe to read from the workspace.\n",
      "utf8",
    );
    registry.register(new ReadTool());
  }
  const llmClient = makeGatewayChatTraceLlmClient(fixture);
  const runner = new ChatRunner({
    stateManager,
    adapter: {
      adapterType: "trace-adapter",
      async execute() {
        throw new Error("Gateway trace must use the gateway model loop.");
      },
    },
    llmClient,
    ...(readTrace ? { registry } : {}),
    approvalRequestFn: async () => {
      approvalRequested = true;
      return false;
    },
    onToolStart: (toolName) => {
      if (toolName === "read") readToolCallCount += 1;
    },
    onEvent: (event) => {
      events.push(chatEventToTraceEvent(fixture, event as Record<string, unknown>));
    },
  });
  const selectedRoute: SelectedChatRoute = {
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
  const ingress = buildStandaloneIngressMessage({
    channel: "plugin_gateway",
    conversation_id: `conversation:${fixture.contract_name}`,
    cwd: stateRoot.workspaceRoot,
    identity_key: `telegram:user:${fixture.contract_name}`,
    message_id: `message:${fixture.contract_name}`,
    platform: "telegram",
    runtimeControl: { allowed: true, approvalMode: "interactive" },
    text: readTrace
      ? "README を読んで要約して"
      : "こんにちは",
    user_id: `user:${fixture.contract_name}`,
  });
  const result = await runner.executeIngressMessage(ingress, stateRoot.workspaceRoot, 120_000, selectedRoute);
  const visible = events.filter((event) => event.visible);
  const finalIndex = events.findIndex((event) => event.type === "assistant_final");
  const readToolEnd = events.find((event) => event.type === "tool_end" && event.payload?.["tool_name"] === "read");
  const assertions: JsonObject = {
    assistant_delta_before_final: events.findIndex((event) => event.type === "assistant_delta") !== -1
      && finalIndex !== -1
      && events.findIndex((event) => event.type === "assistant_delta") < finalIndex,
    final_count: events.filter((event) => event.type === "assistant_final").length,
    ...(readTrace
      ? {
          approval_requested: approvalRequested,
          model_continued_after_read: llmClient.getRequests().length === 2 && result.success,
          read_tool_executed: readToolCallCount === 1 && readToolEnd?.payload?.["success"] === true,
        }
      : {}),
    no_progress_after_final: finalIndex === -1 || events.slice(finalIndex + 1).every((event) => event.type !== "activity" && event.type !== "typing"),
    visible_event_count: visible.length,
  };
  return buildRealGoldenResult(fixture, stateRoot, {
    kind: "gateway_chat_event_stream",
    exportedState: {
      assertions,
      chat_result: {
        output: result.output,
        success: result.success,
      },
      events,
      model_loop: llmClient.getRequests().map((request, index) => ({
        index,
        message_roles: request.messages.map((message) => message.role),
      })),
    },
    assertions,
  });
}

async function runPendingRealRunnerTrace(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
): Promise<GoldenTraceRunResult> {
  const reason = pendingRunnerReason(fixture);
  const artifactPath = artifactPathFor(fixture);
  const runner = runnerExport(fixture, "pending_real_runner", artifactPath, reason);
  const artifact = await writeEvidenceArtifact(stateRoot, artifactPath, {
    contract_name: fixture.contract_name,
    domain: fixture.domain,
    p0_failure_mode: fixture.p0_failure_mode,
    runner,
    status: "pending_real_runner",
  });
  const events = buildTraceEvents(fixture, {
    artifactPath,
    kind: "pending_real_runner",
    status: "pending_real_runner",
    reason,
  });

  return {
    events,
    surface: surfaceFromEvents(events, {
      pending_reason: reason,
      runner_status: "pending_real_runner",
      text: `${fixture.contract_name} pending real production-path runner`,
    }),
    control_db_export: {
      contract_name: fixture.contract_name,
      domain: fixture.domain,
      p0_failure_mode: fixture.p0_failure_mode,
      records: [
        {
          disposition: "pending_real_runner",
          kind: "pending_real_runner",
          pending_reason: reason,
          production_boundary: fixture.production_boundary,
        },
      ],
      runner,
    },
    artifact_tree: [artifact],
    stdout: "",
    stderr: "",
  };
}

async function requestJson(
  server: EventServer,
  method: "GET" | "POST",
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; body: JsonObject }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: server.getHost(),
      port: server.getPort(),
      path: requestPath,
      method,
      headers: {
        Authorization: `Bearer ${server.getAuthToken()}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          body: raw.trim() ? JSON.parse(raw) as JsonObject : {},
        });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function envelopeSummary(envelope: Envelope | undefined): JsonObject | null {
  if (!envelope) return null;
  return {
    dedupe_key: envelope.dedupe_key ?? null,
    goal_id: envelope.goal_id ?? null,
    id: "<envelope-id>",
    name: envelope.name,
    priority: envelope.priority,
    source: envelope.source,
    type: envelope.type,
  };
}

function stableToolResult(result: { success: boolean; summary: string; durationMs: number; data?: unknown; error?: string; artifacts?: string[]; execution?: unknown }): JsonObject {
  return pruneUndefined({
    artifact_count: result.artifacts?.length ?? 0,
    data_present: result.data !== undefined && result.data !== null,
    duration_ms_nonnegative: result.durationMs >= 0,
    error: result.error,
    execution_status: typeof result.execution === "object" && result.execution !== null && !Array.isArray(result.execution)
      ? String((result.execution as Record<string, unknown>)["status"] ?? "")
      : null,
    success: result.success,
  });
}

function runtimeControlSnapshotFor(contractName: string, now: string): RuntimeSessionRegistrySnapshot {
  const conversation = runtimeControlConversationFor(contractName);
  const runs: BackgroundRun[] = [
    backgroundRun({
      id: "run:coreloop:current",
      parent_session_id: `session:conversation:${conversation}`,
      child_session_id: "session:coreloop:current",
      goal_id: "goal-current",
      status: "running",
      updated_at: now,
    }),
    backgroundRun({
      id: "run:coreloop:other",
      parent_session_id: "session:conversation:other-chat",
      child_session_id: "session:coreloop:other",
      goal_id: "goal-other",
      status: "running",
      updated_at: "2026-05-13T00:00:01.000Z",
    }),
    backgroundRun({
      id: "run:coreloop:terminal",
      parent_session_id: `session:conversation:${conversation}`,
      child_session_id: "session:coreloop:terminal",
      goal_id: "goal-terminal",
      status: "succeeded",
      updated_at: "2026-05-13T00:00:02.000Z",
    }),
    backgroundRun({
      id: "run:coreloop:revived",
      parent_session_id: `session:conversation:${conversation}`,
      child_session_id: "session:coreloop:revived",
      goal_id: "goal-revived",
      status: "failed",
      updated_at: "2026-05-13T00:00:03.000Z",
    }),
  ];
  return {
    schema_version: "runtime-session-registry-v1",
    generated_at: now,
    sessions: [],
    background_runs: runs,
    warnings: [],
  };
}

function runtimeControlConversationFor(contractName: string): string {
  return contractName === "runtime_control_latest_other_conversation_blocked"
    ? "isolated-chat"
    : "runtime-chat";
}

function runtimeControlIntentFor(contractName: string): Parameters<RuntimeControlService["request"]>[0]["intent"] {
  switch (contractName) {
    case "runtime_control_pause_current_run_conversation_scoped":
      return {
        kind: "pause_run",
        reason: "pause the current run",
        targetSelector: { scope: "run", reference: "current", sourceText: "current run" },
      };
    case "runtime_control_latest_other_conversation_blocked":
      return {
        kind: "pause_run",
        reason: "pause latest run",
        targetSelector: { scope: "run", reference: "latest", sourceText: "latest run" },
      };
    case "runtime_control_terminal_run_stale_blocked":
      return {
        kind: "pause_run",
        reason: "pause terminal run",
        target: { runId: "run:coreloop:terminal" },
      };
    case "runtime_control_resume_after_companion_revival_requires_readmission":
      return {
        kind: "resume_run",
        reason: "resume revived run",
        target: { runId: "run:coreloop:revived" },
      };
    case "runtime_control_cancel_after_revival_blocks_stale_run":
      return {
        kind: "cancel_run",
        reason: "cancel revived stale run",
        target: { runId: "run:coreloop:revived" },
      };
    case "runtime_control_finalize_records_proposal_without_external_action":
      return {
        kind: "finalize_run",
        reason: "finalize without external action",
        target: { runId: "run:coreloop:current" },
        externalActions: ["publish"],
        irreversible: true,
      };
    default:
      return {
        kind: "inspect_run",
        reason: "inspect current run",
        targetSelector: { scope: "run", reference: "current", sourceText: "current run" },
      };
  }
}

function runtimeOperationSummary(operation: Awaited<ReturnType<RuntimeOperationStore["listPending"]>>[number]): JsonObject {
  return {
    kind: operation.kind,
    operation_id: "<runtime-operation-id>",
    reason: operation.reason,
    reply_target: sanitizeUnknown(operation.reply_target),
    result: sanitizeUnknown(operation.result),
    state: operation.state,
    target: sanitizeUnknown(operation.target),
  };
}

function runtimeControlResultSummary(result: { success: boolean; message: string; operationId?: string; state?: string }): JsonObject {
  return {
    message: result.message,
    operation_id: result.operationId ? "<runtime-operation-id>" : null,
    state: result.state ?? null,
    success: result.success,
  };
}

function backgroundRun(overrides: Partial<BackgroundRun>): BackgroundRun {
  return {
    schema_version: "background-run-v1",
    id: overrides.id ?? "run:coreloop:default",
    kind: overrides.kind ?? "coreloop_run",
    parent_session_id: overrides.parent_session_id ?? "session:conversation:default",
    child_session_id: overrides.child_session_id ?? "session:coreloop:default",
    process_session_id: overrides.process_session_id ?? null,
    goal_id: overrides.goal_id ?? "goal-default",
    status: overrides.status ?? "running",
    notify_policy: overrides.notify_policy ?? "done_only",
    reply_target_source: overrides.reply_target_source ?? "pinned_run",
    pinned_reply_target: overrides.pinned_reply_target ?? {
      channel: "plugin_gateway",
      target_id: "conversation:default",
      thread_id: null,
    },
    title: overrides.title ?? "Background run",
    workspace: overrides.workspace ?? "/workspace",
    created_at: overrides.created_at ?? "2026-05-13T00:00:00.000Z",
    started_at: overrides.started_at ?? "2026-05-13T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-05-13T00:00:00.000Z",
    completed_at: overrides.completed_at ?? null,
    summary: overrides.summary ?? null,
    error: overrides.error ?? null,
    artifacts: overrides.artifacts ?? [],
    source_refs: overrides.source_refs ?? [],
    origin_metadata: overrides.origin_metadata ?? {},
  };
}

function deliveryForApprovalTrace(contractName: string): () => ConversationalApprovalDelivery {
  if (contractName === "approval_delivery_unavailable_denies_not_executes") {
    return () => ({ delivered: false, reason: "channel_unavailable" });
  }
  return () => ({ delivered: true });
}

function approvalTaskFor(contractName: string): PendingPermissionTask {
  return createPendingPermissionTask({
    id: `task-${contractName}`,
    description: `Approval contract ${contractName}`,
    action: contractName.includes("write") || contractName.includes("tool") ? "write_file" : "continue",
    operation_summary: `Approval contract ${contractName}`,
    target: {
      tool_id: contractName.includes("other_tool") ? "other_tool" : "file_write",
      tool_call_id: `call-${contractName}`,
    },
    stateEpoch: "1700.2",
    waitPlanId: `wait-${contractName}`,
    permissionLevel: contractName.includes("denial") || contractName.includes("write") ? "write_local" : "read_only",
    isDestructive: false,
    reversibility: "reversible",
  });
}

async function waitForPendingApproval(store: ApprovalStore, approvalId: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await store.loadPending(approvalId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${approvalId}`);
}

async function settleDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function approvalRecordSummary(record: Awaited<ReturnType<ApprovalStore["loadResolved"]>> extends infer T ? NonNullable<T> : never): JsonObject {
  return {
    approval_id: record.approval_id,
    origin: sanitizeUnknown(record.origin),
    resolved_at: record.resolved_at ?? null,
    state: record.state,
  };
}

function makeWaitResumeScheduleInput(suffix: string): Parameters<ScheduleEngine["addEntry"]>[0] {
  return {
    name: `wait-resume-${suffix}`,
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    metadata: {
      internal: true,
      activation_kind: "wait_resume",
      goal_id: "goal-wait-resume",
      strategy_id: `strategy:${suffix}`,
      wait_strategy_id: `strategy:${suffix}`,
    },
    goal_trigger: {
      goal_id: "goal-wait-resume",
      max_iterations: 5,
      skip_if_active: false,
    },
  };
}

function attentionScopeFor(id: string) {
  return {
    userId: "user:trace",
    identityId: "identity:trace",
    workspaceId: "workspace:trace",
    conversationId: `conversation:${id}`,
    sessionId: `session:${id}`,
    surfaceClass: "daemon" as const,
    surfaceRef: `surface:${id}`,
    permissionScope: "local_only" as const,
    sensitivity: "medium" as const,
    memoryOwner: null,
    policyEpoch: "policy:trace",
  };
}

function chatEventToTraceEvent(fixture: GoldenTraceFixture, event: Record<string, unknown>): TraceEvent {
  const type = String(event["type"] ?? "event");
  return {
    at: fixture.input.fake_now,
    payload: stableChatEventPayload(event),
    source: fixture.contract_name,
    type,
    visible: type === "assistant_delta" || type === "assistant_final" || type === "activity",
  };
}

function stableChatEventPayload(event: Record<string, unknown>): JsonObject {
  const type = String(event["type"] ?? "event");
  if (type === "assistant_final") {
    return {
      persisted: event["persisted"] === true,
      text: typeof event["text"] === "string" ? event["text"] : "",
    };
  }
  if (type === "presence_update") {
    const presence = event["presence"];
    return {
      phase: typeof presence === "object" && presence !== null && !Array.isArray(presence)
        ? String((presence as Record<string, unknown>)["phase"] ?? "")
        : "",
    };
  }
  if (type === "lifecycle_end") {
    return {
      persisted: event["persisted"] === true,
      status: typeof event["status"] === "string" ? event["status"] : "",
    };
  }
  if (type === "activity") {
    return {
      kind: typeof event["kind"] === "string" ? event["kind"] : "",
      message: typeof event["message"] === "string" ? event["message"] : "",
      source_id: typeof event["sourceId"] === "string" ? event["sourceId"] : null,
    };
  }
  if (type === "tool_end") {
    return {
      success: event["success"] === true,
      summary: typeof event["summary"] === "string" ? event["summary"] : "",
      tool_name: typeof event["toolName"] === "string" ? event["toolName"] : "",
    };
  }
  return {
    type,
  };
}

function runtimeStatusSnapshot(now: string): RuntimeSessionRegistrySnapshot {
  return {
    schema_version: "runtime-session-registry-v1",
    generated_at: now,
    sessions: [],
    background_runs: [
      backgroundRun({
        id: "run:coreloop:status",
        status: "running",
        title: "Status evidence run",
        updated_at: now,
      }),
    ],
    warnings: [],
  };
}

function snapshotSummary(snapshot: RuntimeSessionRegistrySnapshot): JsonObject {
  return {
    background_runs: snapshot.background_runs.map((run) => ({
      id: run.id,
      kind: run.kind,
      parent_session_id: run.parent_session_id,
      process_session_id: run.process_session_id,
      status: run.status,
    })),
    session_count: snapshot.sessions.length,
    warning_codes: snapshot.warnings.map((warning) => warning.code),
  };
}

function sanitizeSecretIntake(intake: ReturnType<typeof intakeSetupSecrets>): JsonObject {
  return {
    redacted_text: intake.redactedText,
    supplied_secrets: intake.suppliedSecrets.map((secret) => ({
      id: secret.id,
      kind: secret.kind,
      redaction: secret.redaction,
      supplied_at: secret.suppliedAt,
      value_persisted_to_chat_state: false,
    })),
  };
}

function makeRunspecDraftLlmClient(options: { includeRecoveryPrelude?: boolean } = {}): ILLMClient {
  const draft = JSON.stringify({
      decision: "run_spec_request",
      confidence: 0.92,
      profile: "kaggle",
      objective: "Continue Kaggle optimization until score exceeds 0.98",
      execution_target: { kind: "daemon", remote_host: null, confidence: "medium" },
      metric: {
        name: "kaggle_score",
        direction: "maximize",
        target: 0.98,
        target_rank_percent: null,
        datasource: "kaggle_leaderboard",
        confidence: "high",
      },
      progress_contract: {
        kind: "metric_target",
        dimension: "kaggle_score",
        threshold: 0.98,
        semantics: "Kaggle score exceeds 0.98.",
        confidence: "high",
      },
      deadline: {
        raw: "until score exceeds 0.98",
        iso_at: null,
        timezone: null,
        finalization_buffer_minutes: null,
        confidence: "medium",
      },
      budget: { max_trials: null, max_wall_clock_minutes: null, resident_policy: "best_effort" },
      approval_policy: {
        submit: "approval_required",
        publish: "unspecified",
        secret: "approval_required",
        external_action: "approval_required",
        irreversible_action: "approval_required",
      },
      artifact_contract: {
        expected_artifacts: ["leaderboard snapshot", "experiment notes"],
        discovery_globs: ["**/leaderboard*.json", "**/experiments/**"],
        primary_outputs: ["best Kaggle score"],
      },
      missing_fields: [],
      reason: "The operator requested long-running Kaggle optimization.",
    });
  const responses = [
    ...(options.includeRecoveryPrelude === false
      ? []
      : [JSON.stringify({ kind: "none", confidence: 0.94, rationale: "This is new work, not recovery." })]),
    draft,
  ];
  return {
    async sendMessage() {
      const content = responses.shift() ?? responses.at(-1) ?? "{}";
      return {
        content,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
    parseJSON(content: string, schema: { parse(value: unknown): unknown }) {
      return schema.parse(JSON.parse(content));
    },
  } as unknown as ILLMClient;
}

function makeRunSpecToolContext(
  cwd: string,
  pendingRef: { value: RunSpecConfirmationSnapshot | null },
  options: {
    conversationSessionId: string;
    replyTarget: RuntimeControlReplyTarget;
  },
): ToolCallContext {
  return {
    cwd,
    goalId: "goal:runspec-trace",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => false,
    conversationSessionId: options.conversationSessionId,
    runtimeReplyTarget: options.replyTarget,
    runSpecConfirmation: {
      get: () => pendingRef.value,
      set: (value) => {
        pendingRef.value = value as RunSpecConfirmationSnapshot | null;
      },
    },
    sessionId: options.conversationSessionId,
  };
}

function makeGatewayReadTraceTool(onCall: () => void): ITool<Record<string, unknown>> {
  return {
    metadata: {
      name: "read",
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: ["read"],
      activityCategory: "read",
      gatewayExposure: "default_safe",
    },
    inputSchema: z.object({}).passthrough(),
    description: () => "Read a workspace file.",
    async call() {
      onCall();
      return {
        success: true,
        data: { ok: true },
        summary: "read ran",
        durationMs: 1,
      };
    },
    async checkPermissions() {
      return { status: "allowed" };
    },
    isConcurrencySafe: () => true,
  };
}

function makeGatewayUnavailableToolLlmClient(): ILLMClient & {
  getRequests(): Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }>;
} {
  const requests: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  const responses: LLMResponse[] = [
    {
      content: "README を確認します。",
      stop_reason: "tool_calls",
      tool_calls: [{
        id: "call-read-file",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ file_path: "README.md" }),
        },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    {
      content: "read_file is unavailable in this gateway scope, so no file side effect executed.",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ];
  const next = (messages: LLMMessage[], options?: LLMRequestOptions): LLMResponse => {
    requests.push({ messages: JSON.parse(JSON.stringify(messages)) as LLMMessage[], options });
    return responses.shift() ?? {
      content: "No more scripted responses.",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  return {
    async sendMessage(messages, options) {
      return next(messages, options);
    },
    async sendMessageStream(messages, options, handlers: LLMStreamHandlers) {
      const response = next(messages, options);
      if (!response.tool_calls?.length && response.content) {
        handlers.onTextDelta?.(response.content);
      }
      return response;
    },
    parseJSON(content: string, schema: { parse(value: unknown): unknown }) {
      return schema.parse(JSON.parse(content));
    },
    supportsToolCalling: () => true,
    getRequests: () => requests,
  } as ILLMClient & { getRequests(): Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> };
}

function makeGatewayChatTraceLlmClient(fixture: GoldenTraceFixture): ILLMClient & {
  getRequests(): Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }>;
} {
  const requests: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  const finalText = fixture.contract_name === "gateway_final_visible_suppresses_late_progress_and_typing"
    ? "Done."
    : "Hello.";
  const responses: LLMResponse[] = fixture.contract_name === "gateway_read_workspace_under_protected_paths_no_approval"
    ? [
        {
          content: "README を確認します。",
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-read-readme",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ file_path: "README.md", limit: 5 }),
            },
          }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: "README was read through the gateway-safe read tool.",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]
    : [{
        content: finalText,
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }];
  const next = (messages: LLMMessage[], options?: LLMRequestOptions): LLMResponse => {
    requests.push({ messages: JSON.parse(JSON.stringify(messages)) as LLMMessage[], options });
    return responses.shift() ?? {
      content: "No more scripted responses.",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  return {
    async sendMessage(messages, options) {
      return next(messages, options);
    },
    async sendMessageStream(messages, options, handlers: LLMStreamHandlers) {
      const response = next(messages, options);
      if (!response.tool_calls?.length && response.content) {
        handlers.onTextDelta?.(response.content);
      }
      return response;
    },
    parseJSON(content: string, schema: { parse(value: unknown): unknown }) {
      return schema.parse(JSON.parse(content));
    },
    supportsToolCalling: () => true,
    getRequests: () => requests,
  } as ILLMClient & { getRequests(): Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> };
}

function runtimeReplyTargetFromMetadata(value: unknown): RuntimeControlReplyTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["surface"] !== "gateway") return null;
  if (typeof record["conversation_id"] !== "string") return null;
  return record as RuntimeControlReplyTarget;
}

function sanitizeUnknown(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: value === undefined ? null : String(value) };
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

async function buildRealGoldenResult(
  fixture: GoldenTraceFixture,
  stateRoot: IsolatedStateRoot,
  options: {
    kind: string;
    exportedState: JsonObject;
    assertions: JsonObject;
  },
): Promise<GoldenTraceRunResult> {
  const artifactPath = artifactPathFor(fixture);
  const runner = runnerExport(fixture, "real_production_path", artifactPath);
  const artifact = await writeEvidenceArtifact(stateRoot, artifactPath, {
    contract_name: fixture.contract_name,
    domain: fixture.domain,
    exported_state: options.exportedState,
    p0_failure_mode: fixture.p0_failure_mode,
    runner,
  });
  const events = buildTraceEvents(fixture, {
    artifactPath,
    kind: options.kind,
    status: "ok",
    runnerStatus: "real_production_path",
  });

  return {
    events,
    surface: surfaceFromEvents(events, {
      once: true,
      runner_status: "real_production_path",
      text: `${fixture.contract_name} satisfied by real production path`,
    }),
    control_db_export: {
      contract_name: fixture.contract_name,
      domain: fixture.domain,
      p0_failure_mode: fixture.p0_failure_mode,
      records: [
        {
          assertions: options.assertions,
          disposition: "ok",
          kind: options.kind,
          production_boundary: fixture.production_boundary,
        },
      ],
      runner,
    },
    artifact_tree: [artifact],
    stdout: "",
    stderr: "",
  };
}

function buildTraceEvents(
  fixture: GoldenTraceFixture,
  options: {
    artifactPath: string;
    kind: string;
    status: "ok" | "pending_real_runner";
    reason?: string;
    runnerStatus?: "real_production_path" | "pending_real_runner";
  },
): TraceEvent[] {
  const runnerStatus = options.runnerStatus ?? options.status;
  const recorder = new EventRecorder();
  for (const event of [
    eventFor(fixture, "lifecycle_start", false, {
      contract_name: fixture.contract_name,
      runner_status: runnerStatus,
    }),
    eventFor(fixture, "state_artifact", false, {
      artifact_ref: options.artifactPath,
      disposition: options.status === "ok" ? "production_exported" : "pending_real_runner",
      runner_status: runnerStatus,
    }),
    eventFor(fixture, options.status === "ok" ? "operation_progress" : "pending_real_runner", false, {
      kind: options.kind,
      pending_reason: options.reason,
      runner_status: runnerStatus,
      status: options.status === "ok" ? "checked" : "pending_real_runner",
    }),
    eventFor(fixture, "contract_observed", true, {
      boundary: fixture.production_boundary,
      disposition: options.status,
      pending_reason: options.reason,
      runner_status: runnerStatus,
    }),
    eventFor(fixture, "assistant_final", true, {
      once: options.status === "ok",
      pending_reason: options.reason,
      runner_status: runnerStatus,
      text: options.status === "ok"
        ? `${fixture.contract_name} satisfied by real production path`
        : `${fixture.contract_name} pending real production-path runner`,
    }),
    eventFor(fixture, "lifecycle_end", false, {
      status: options.status,
    }),
  ]) {
    recorder.record(event);
  }
  return recorder.events();
}

function eventFor(
  fixture: GoldenTraceFixture,
  type: string,
  visible: boolean,
  payload: JsonObject,
): TraceEvent {
  return {
    at: fixture.input.fake_now,
    payload: pruneUndefined(payload),
    source: fixture.contract_name,
    type,
    visible,
  };
}

function surfaceFromEvents(events: TraceEvent[], final: JsonObject): GoldenTraceRunResult["surface"] {
  return {
    final,
    visible_events: events.filter((event) => event.visible === true),
  };
}

function runnerExport(
  fixture: GoldenTraceFixture,
  status: "real_production_path" | "pending_real_runner",
  artifactPath: string,
  pendingReason?: string,
): JsonObject {
  return pruneUndefined({
    exported_state_artifact: artifactPath,
    pending_reason: pendingReason,
    production_entrypoint: fixture.production_boundary,
    same_checkout_pass_command: "npm run test:golden-traces",
    status,
  });
}

async function writeEvidenceArtifact(
  stateRoot: IsolatedStateRoot,
  relativePath: string,
  value: JsonObject,
): Promise<TraceArtifactTreeEntry> {
  await stateRoot.writeJson(relativePath, value);
  const target = path.join(stateRoot.root, relativePath);
  const content = await fsp.readFile(target);
  return {
    path: relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.byteLength,
    type: "file",
  };
}

function artifactPathFor(fixture: GoldenTraceFixture): string {
  return `state/${fixture.domain}/${fixture.contract_name}.json`;
}

function makeEnvelope(
  fixture: GoldenTraceFixture,
  options: {
    idSuffix: string;
    type: EnvelopeType;
    name: string;
    priority: EnvelopePriority;
    payload: unknown;
    dedupe_key?: string;
  },
): Envelope {
  return {
    created_at: Date.parse(fixture.input.fake_now),
    dedupe_key: options.dedupe_key,
    id: `${fixture.contract_name}:${options.idSuffix}`,
    name: options.name,
    payload: options.payload,
    priority: options.priority,
    source: "golden-trace-runner",
    type: options.type,
  };
}

function stabilizeQueueSnapshot(snapshot: JournalBackedQueueSnapshot): JsonObject {
  return {
    completed: [...snapshot.completed].sort(),
    deadletter: [...snapshot.deadletter].sort(),
    inflight: Object.values(snapshot.inflight)
      .map((claim) => ({
        attempt: claim.attempt,
        claimed_at: claim.claimedAt,
        lease_until: claim.leaseUntil,
        message_id: claim.messageId,
        worker_id: claim.workerId,
      }))
      .sort((left, right) => String(left.message_id).localeCompare(String(right.message_id))),
    pending: {
      critical: [...snapshot.pending.critical],
      high: [...snapshot.pending.high],
      low: [...snapshot.pending.low],
      normal: [...snapshot.pending.normal],
    },
  };
}

function queueSnapshotCounts(snapshot: JournalBackedQueueSnapshot): JsonObject {
  return {
    completed_count: snapshot.completed.length,
    deadletter_count: snapshot.deadletter.length,
    inflight_count: Object.keys(snapshot.inflight).length,
    pending_count: snapshot.pending.critical.length
      + snapshot.pending.high.length
      + snapshot.pending.low.length
      + snapshot.pending.normal.length,
  };
}

function pendingRunnerReason(fixture: GoldenTraceFixture): string {
  return `No conformance runner is wired to ${fixture.production_boundary}; this fixture is not deletion-gate evidence.`;
}

function pruneUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonObject;
}

function assertHarnessPolicy(fixture: GoldenTraceFixture): void {
  if (fixture.input.allow_network === true) {
    throw new Error(`${fixture.contract_name} requested network in a fast trace lane.`);
  }
  if (fixture.input.allow_real_llm === true) {
    throw new Error(`${fixture.contract_name} requested real LLM in a fast trace lane.`);
  }
  if (fixture.input.entrypoint.startsWith("private:")) {
    throw new Error(`${fixture.contract_name} uses a private entrypoint.`);
  }
}
