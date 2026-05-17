import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v3";
import type { IAdapter } from "../../src/orchestrator/execution/adapter-layer.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamHandlers,
} from "../../src/base/llm/llm-client.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { ChatRunner, type ChatRunnerDeps } from "../../src/interface/chat/chat-runner.js";
import type { SelectedChatRoute } from "../../src/interface/chat/ingress-router.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import {
  InteractionAuthorityStore,
  projectPeerInitiativeDeliveryAuthority,
  projectTelegramCallbackAuthority,
} from "../../src/runtime/control/index.js";
import { ApprovalBroker } from "../../src/runtime/approval-broker.js";
import { createPendingPermissionTask, type PendingPermissionTask } from "../../src/runtime/permission-dialogue.js";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import { OutboxStore } from "../../src/runtime/store/outbox-store.js";
import { ApprovalStore } from "../../src/runtime/store/approval-store.js";
import { RuntimeEventLogStore } from "../../src/runtime/store/runtime-event-log.js";
import { PersonalAgentRuntimeStore } from "../../src/runtime/personal-agent/index.js";
import { ToolExecutor, ToolPermissionManager, ToolRegistry, ConcurrencyController } from "../../src/tools/index.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolResult } from "../../src/tools/types.js";
import { HarnessClock } from "../harness/fake-clock.js";
import { createIsolatedStateRoot, type IsolatedStateRoot } from "../harness/isolated-state-root.js";
import { installNoNetworkGuard } from "../harness/network-guard.js";
import { stableJson } from "../harness/normalizers.js";
import { ScriptedLlm } from "../harness/scripted-llm.js";
import { ScriptedToolRunner } from "../harness/scripted-tools.js";
import type { JsonObject, JsonValue, ScriptedLlmTurn } from "../harness/types.js";
import { computeEvalMetrics, createMetricAccumulator, thresholdFailures, type EvalMetricAccumulator } from "./metrics.js";
import {
  EvalRunArtifactSchema,
  type EvalMetrics,
  type EvalRunArtifact,
  type EvalScenario,
  type EvalStep,
} from "./types.js";

export interface EvalScenarioRunResult {
  artifact: EvalRunArtifact;
  artifactPath: string;
  metricAccumulator: EvalMetricAccumulator;
}

interface RunContext {
  scenario: EvalScenario;
  root: IsolatedStateRoot;
  clock: HarnessClock;
  stateManager: StateManager;
  memory: KnowledgeManager;
  scriptedLlm: ScriptedLlm;
  eventLog: RuntimeEventLogStore;
  authorityStore: InteractionAuthorityStore;
  personalAgentRuntime: PersonalAgentRuntimeStore;
  transcript: JsonObject[];
  surfaceProjections: JsonObject[];
  operatorProjections: JsonObject[];
  productionCallerPaths: Set<string>;
  metrics: EvalMetricAccumulator;
  memoryByKey: Map<string, string>;
  sensitiveMemoryValues: string[];
}

export async function runEvalScenario(scenario: EvalScenario): Promise<EvalScenarioRunResult> {
  const guard = installNoNetworkGuard();
  const root = await createIsolatedStateRoot(`eval-lab-${scenario.scenario_id}`);
  try {
    const stateManager = new StateManager(root.root, undefined, { walEnabled: false });
    await stateManager.init();
    const clock = new HarnessClock(scenario.fake_controls.clock_start);
    const personalAgentRuntime = new PersonalAgentRuntimeStore(root.runtimeRoot, { controlBaseDir: root.root });
    const scriptedLlm = new ScriptedLlm(scriptedTurnsFor(scenario));
    const context: RunContext = {
      scenario,
      root,
      clock,
      stateManager,
      memory: new KnowledgeManager(stateManager, scriptedLlmClient(scriptedLlm)),
      scriptedLlm,
      eventLog: new RuntimeEventLogStore(root.runtimeRoot, { controlBaseDir: root.root }),
      authorityStore: new InteractionAuthorityStore(root.runtimeRoot, { controlBaseDir: root.root }),
      personalAgentRuntime,
      transcript: [],
      surfaceProjections: [],
      operatorProjections: [],
      productionCallerPaths: new Set(),
      metrics: createMetricAccumulator(),
      memoryByKey: new Map(),
      sensitiveMemoryValues: [],
    };

    await recordScenarioAdmission(context);
    for (const step of scenario.steps) {
      await runStep(context, step);
    }

    const replaySummary = await buildReplaySummary(context);
    context.metrics.replayChecks += 1;
    if (replaySummary.replay_equivalent === true) context.metrics.replayEquivalentCount += 1;
    context.metrics.scenarioCount += 1;
    context.metrics.scenarioPasses += 1;

    const metrics = computeEvalMetrics(context.metrics);
    const failures = thresholdFailures(metrics, scenario.metric_thresholds)
      .map((message) => ({ kind: "metric_threshold", message }));
    const artifact = await buildEvalRunArtifact(context, metrics, replaySummary, failures);
    const artifactPath = await persistEvalRunArtifact(artifact);
    return {
      artifact,
      artifactPath,
      metricAccumulator: context.metrics,
    };
  } finally {
    guard.restore();
    await root.cleanup();
  }
}

export async function writeEvalFailureArtifacts(
  artifact: EvalRunArtifact,
  outputRoot = path.resolve("tmp", "eval-failures"),
): Promise<string> {
  const dir = path.join(outputRoot, artifact.scenario_id);
  await fsp.mkdir(dir, { recursive: true });
  await writeJson(dir, "scenario.json", {
    scenario_id: artifact.scenario_id,
    seed: artifact.seed,
    reproduction_command: artifact.reproduction_command,
  });
  await writeJson(dir, "normal-projection.json", artifact.surface_projections.at(-1) ?? null);
  await writeJson(dir, "operator-projection.json", artifact.operator_projections.at(-1) ?? null);
  await writeJson(dir, "event-log-replay-trace.json", artifact.replay_summary);
  await writeJson(dir, "transcript.json", artifact.transcript);
  await writeJson(dir, "metrics.json", artifact.metrics);
  await fsp.writeFile(path.join(dir, "reproduction-command.txt"), `${artifact.reproduction_command}\n`, "utf8");
  return dir;
}

async function runStep(context: RunContext, step: EvalStep): Promise<void> {
  switch (step.kind) {
    case "memory_seed":
      return runMemorySeed(context, step);
    case "memory_correction":
      return runMemoryCorrection(context, step);
    case "user_turn":
      return runUserTurn(context, step);
    case "schedule_wake":
      return runScheduleWake(context, step);
    case "approval_response":
      return runApprovalResponse(context, step);
    case "delivery_replay":
      return runDeliveryReplay(context, step);
    case "tool_capability":
      return runToolCapability(context, step);
    case "quiet_mode":
      return runQuietMode(context, step);
    case "feedback":
      return runFeedback(context, step);
    case "stale_action_binding":
      return runStaleActionBinding(context, step);
    case "telegram_projection":
      return runTelegramProjection(context, step);
    case "event_log_replay":
      context.productionCallerPaths.add("RuntimeEventLogStore.rebuildProjections");
      return;
  }
}

async function runMemorySeed(context: RunContext, step: Extract<EvalStep, { kind: "memory_seed" }>): Promise<void> {
  const saved = await context.memory.saveAgentMemory({
    key: step.key,
    value: step.value,
    memory_type: step.memory_type,
    governance: { sensitivity: step.sensitivity },
  });
  context.memoryByKey.set(step.key, saved.id);
  if (step.sensitivity === "private" || step.sensitivity === "secret") {
    context.sensitiveMemoryValues.push(step.value);
  }
  context.operatorProjections.push({
    kind: "memory_seed",
    key: step.key,
    memory_id: saved.id,
    sensitivity: step.sensitivity,
  });
  context.productionCallerPaths.add("KnowledgeManager.saveAgentMemory");
}

async function runMemoryCorrection(context: RunContext, step: Extract<EvalStep, { kind: "memory_correction" }>): Promise<void> {
  const targetId = context.memoryByKey.get(step.target_key);
  if (!targetId) throw new Error(`No seeded memory for ${step.target_key}`);
  const result = await runUserMemoryOperation(context.stateManager, {
    operation: "correct",
    targetRef: { kind: "agent_memory", id: targetId },
    reason: `Eval scenario ${context.scenario.scenario_id} corrected memory.`,
    replacementKey: step.replacement_key,
    replacementValue: step.replacement_value,
    now: context.clock.nowIso(),
  });
  const replacementId = result.replacement?.ref.id;
  if (!replacementId) throw new Error(`Correction ${step.replacement_key} did not create a replacement memory.`);
  context.memoryByKey.set(step.replacement_key, replacementId);
  context.metrics.correctedMemoryAttempts += 1;
  context.operatorProjections.push({
    kind: "memory_correction",
    correction_id: result.correction?.correction_id ?? null,
    replacement_key: step.replacement_key,
    target_key: step.target_key,
  });
  context.productionCallerPaths.add("runUserMemoryOperation");
}

async function runUserTurn(context: RunContext, step: Extract<EvalStep, { kind: "user_turn" }>): Promise<void> {
  const recalled = [];
  for (const ref of step.memory_refs) {
    context.metrics.memoryRetrievalAttempts += 1;
    const hit = await context.memory.recallAgentMemory(ref, { exact: true });
    if (hit.length > 0) {
      context.metrics.memoryRetrievalHits += 1;
      recalled.push({ key: ref, memory_id: hit[0]!.id });
      if (ref.includes("current")) context.metrics.correctedMemoryReuses += 1;
    }
  }

  const runner = new ChatRunner({
    stateManager: context.stateManager,
    adapter: mockAdapter(),
    llmClient: scriptedLlmClient(context.scriptedLlm),
    personalAgentRuntime: context.personalAgentRuntime,
  } as unknown as ChatRunnerDeps);
  const result = await runner.execute(step.input, context.root.workspaceRoot, 10_000, {
    selectedRoute: gatewayModelRoute(),
  });
  context.productionCallerPaths.add("ChatRunner.execute");
  context.transcript.push({
    kind: "chat_turn",
    input: step.input,
    output: result.output,
    recalled,
    success: result.success,
  });
  context.surfaceProjections.push({
    kind: "chat_surface",
    output: result.output,
    memory_keys_used: step.memory_refs,
    raw_refs_visible: false,
  });
  for (const value of context.sensitiveMemoryValues) {
    context.metrics.sensitiveLeakChecks += 1;
    if (result.output.includes(value)) context.metrics.sensitiveLeaks += 1;
  }
  if (!result.success || !result.output.includes(step.expected_assistant)) {
    throw new Error(`Scenario ${context.scenario.scenario_id} chat output did not include ${step.expected_assistant}: ${result.output}`);
  }
}

async function runScheduleWake(context: RunContext, step: Extract<EvalStep, { kind: "schedule_wake" }>): Promise<void> {
  context.clock.advance(step.advance_ms);
  const engine = new ScheduleEngine({
    baseDir: context.root.root,
    stateManager: context.stateManager,
    personalAgentRuntime: context.personalAgentRuntime,
  });
  const entry = await engine.addEntry({
    name: `eval-lab-${context.scenario.scenario_id}`,
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    metadata: {
      internal: true,
      activation_kind: "wait_resume",
      goal_id: `goal:${context.scenario.scenario_id}`,
      strategy_id: `strategy:${context.scenario.scenario_id}`,
      wait_strategy_id: `strategy:${context.scenario.scenario_id}`,
    },
    goal_trigger: {
      goal_id: `goal:${context.scenario.scenario_id}`,
      max_iterations: 1,
      skip_if_active: false,
    },
  });
  engine.getEntries()[0]!.next_fire_at = "2026-05-16T00:00:00.000Z";
  await engine.saveEntries();
  await engine.loadEntries();
  const results = await engine.tick();
  context.operatorProjections.push({
    kind: "schedule_wake",
    entry_id: entry.id,
    result_count: results.length,
  });
  context.surfaceProjections.push({
    kind: "schedule_surface",
    wake_recorded: results.length > 0,
  });
  context.productionCallerPaths.add("ScheduleEngine.tick");
  if (results.length === 0) throw new Error(`Schedule wake did not fire for ${context.scenario.scenario_id}`);
}

async function runApprovalResponse(context: RunContext, step: Extract<EvalStep, { kind: "approval_response" }>): Promise<void> {
  const approvalId = `approval:${context.scenario.scenario_id}`;
  const store = new ApprovalStore(context.root.runtimeRoot, { controlBaseDir: context.root.root });
  const delivered: JsonObject[] = [];
  const broker = new ApprovalBroker({
    store,
    now: () => context.clock.nowMs(),
    broadcast: (eventType, data) => delivered.push({ event_type: eventType, data: sanitize(data) }),
    deliverConversationalApproval: () => ({ delivered: true }),
  });
  const pending = broker.requestConversationalApproval(`goal:${context.scenario.scenario_id}`, approvalTaskFor(context.scenario.scenario_id), {
    approvalId,
    origin: approvalOrigin(context.scenario.scenario_id),
  });
  void pending.catch(() => undefined);
  await waitForPendingApproval(store, approvalId);
  await broker.stop();
  const restarted = step.restart_daemon_before_response
    ? new ApprovalBroker({
      store,
      now: () => context.clock.nowMs() + 1_000,
      broadcast: (eventType, data) => delivered.push({ event_type: eventType, data: sanitize(data) }),
      deliverConversationalApproval: () => ({ delivered: true }),
    })
    : broker;
  if (step.restart_daemon_before_response) await restarted.start();
  const resolved = await restarted.resolveConversationalApproval(approvalId, step.approved, approvalOrigin(context.scenario.scenario_id));
  await restarted.stop();
  context.metrics.approvalChecks += 1;
  if (!resolved) context.metrics.approvalBypasses += 1;
  context.operatorProjections.push({
    kind: "approval_response",
    approval_id: approvalId,
    delivered_count: delivered.length,
    resolved,
    restart_before_response: step.restart_daemon_before_response,
  });
  context.surfaceProjections.push({
    kind: "approval_surface",
    approval_resolved: resolved,
  });
  context.productionCallerPaths.add("ApprovalBroker.start");
  context.productionCallerPaths.add("ApprovalBroker.resolveConversationalApproval");
  if (!resolved) throw new Error(`Approval response was not resolved for ${context.scenario.scenario_id}`);
}

async function runDeliveryReplay(context: RunContext, step: Extract<EvalStep, { kind: "delivery_replay" }>): Promise<void> {
  const outbox = new OutboxStore(context.root.runtimeRoot, { controlBaseDir: context.root.root });
  const first = await outbox.append({
    event_type: "eval_lab_peer_delivery",
    goal_id: `goal:${context.scenario.scenario_id}`,
    correlation_id: step.delivery_id,
    created_at: context.clock.nowMs(),
    payload: { delivery_id: step.delivery_id },
  });
  let duplicateCount = 0;
  for (let index = 0; index < step.duplicate_attempts; index += 1) {
    const replay = await outbox.append({
      event_type: "eval_lab_peer_delivery",
      goal_id: `goal:${context.scenario.scenario_id}`,
      correlation_id: step.delivery_id,
      created_at: context.clock.nowMs() + index + 1,
      payload: { delivery_id: step.delivery_id },
    });
    if (replay.seq !== first.seq) duplicateCount += 1;
  }
  await recordPeerDelivery(context, step.delivery_id, {
    canSend: true,
    transportMessageRef: `telegram-message:${step.delivery_id}`,
  });
  context.metrics.duplicateSideEffectOpportunities += step.duplicate_attempts;
  context.metrics.duplicateSideEffectCount += duplicateCount;
  context.operatorProjections.push({
    kind: "delivery_replay",
    delivery_id: step.delivery_id,
    duplicate_count: duplicateCount,
    first_seq: first.seq,
  });
  context.surfaceProjections.push({
    kind: "delivery_surface",
    delivered_once: duplicateCount === 0,
  });
  context.productionCallerPaths.add("OutboxStore.append");
  if (duplicateCount !== 0) throw new Error(`Duplicate delivery was not suppressed for ${context.scenario.scenario_id}`);
}

async function runToolCapability(context: RunContext, step: Extract<EvalStep, { kind: "tool_capability" }>): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(evalCapabilityTool(step.tool_name, step.fail_first));
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    personalAgentRuntime: context.personalAgentRuntime,
    interactionAuthorityStore: context.authorityStore,
    traceBaseDir: context.root.root,
  });
  const first = await executor.execute(step.tool_name, { phase: "first" }, toolContext(context, `${step.tool_name}:first`));
  const second = await executor.execute(step.tool_name, { phase: "recover" }, toolContext(context, `${step.tool_name}:recover`));
  const scripted = new ScriptedToolRunner([
    {
      name: step.tool_name,
      args: { phase: "first" },
      result: { success: first.success, summary: first.summary },
    },
    {
      name: step.tool_name,
      args: { phase: "recover" },
      result: { success: second.success, summary: second.summary },
      side_effect_artifact: { path: "workspace/recovery.txt" },
    },
  ]);
  scripted.run(step.tool_name, { phase: "first" });
  scripted.run(step.tool_name, { phase: "recover" });
  context.operatorProjections.push({
    kind: "tool_capability",
    first_success: first.success,
    second_success: second.success,
    mutation_artifacts: scripted.mutationArtifacts(),
  });
  context.surfaceProjections.push({
    kind: "tool_surface",
    recovered: !first.success && second.success,
  });
  context.productionCallerPaths.add("ToolExecutor.execute");
  if (step.fail_first && (first.success || !second.success)) {
    throw new Error(`Tool capability did not fail then recover for ${context.scenario.scenario_id}`);
  }
}

async function runQuietMode(context: RunContext, step: Extract<EvalStep, { kind: "quiet_mode" }>): Promise<void> {
  await recordPeerDelivery(context, `quiet:${context.scenario.scenario_id}`, {
    outcome: "held",
    canHold: true,
    quietingRef: step.quieting_ref,
  });
  context.operatorProjections.push({
    kind: "quiet_mode",
    quieting_ref: step.quieting_ref,
    requested_delivery_kind: step.requested_delivery_kind,
    outcome: "held",
  });
  context.surfaceProjections.push({
    kind: "quiet_surface",
    proactive_delivery: "held",
  });
  context.productionCallerPaths.add("projectPeerInitiativeDeliveryAuthority");
}

async function runFeedback(context: RunContext, step: Extract<EvalStep, { kind: "feedback" }>): Promise<void> {
  if (step.feedback_kind === "overreach") {
    context.metrics.overreachOpportunities += 1;
    await recordPeerDelivery(context, `feedback:${context.scenario.scenario_id}`, {
      outcome: "suppressed",
      canSuppress: true,
    });
  } else {
    context.metrics.missedHelpOpportunities += 1;
    await recordPeerDelivery(context, `missed-help:${context.scenario.scenario_id}`, {
      outcome: "held",
      canHold: true,
    });
  }
  context.operatorProjections.push({
    kind: "feedback",
    feedback_kind: step.feedback_kind,
    lowers_future_intervention: step.lowers_future_intervention,
  });
  context.surfaceProjections.push({
    kind: "feedback_surface",
    next_intervention: step.feedback_kind === "overreach" ? "lowered" : "reviewed",
  });
  context.productionCallerPaths.add("InteractionAuthorityStore.recordDecision");
}

async function runStaleActionBinding(context: RunContext, step: Extract<EvalStep, { kind: "stale_action_binding" }>): Promise<void> {
  const decision = await context.authorityStore.recordDecision(projectTelegramCallbackAuthority({
    callbackId: step.callback_id,
    candidateId: `candidate:${context.scenario.scenario_id}`,
    action: "approve",
    deliveryId: step.stale_delivery_id,
    targetBindingRef: `target:${step.current_delivery_id}`,
    channelPolicyRef: "telegram:policy",
    transportMessageRef: step.stale_delivery_id,
    callbackTargetBindingRef: `target:${step.stale_delivery_id}`,
    callbackTransportMessageRef: step.stale_delivery_id,
    deliveryMatches: false,
    actionMatches: true,
    decidedAt: context.clock.nowIso(),
  }));
  context.metrics.staleActionAttempts += 1;
  if (decision.stale_target_rejected) context.metrics.staleActionRejections += 1;
  context.operatorProjections.push({
    kind: "stale_action_binding",
    decision_id: decision.decision_id,
    stale_target_rejected: decision.stale_target_rejected,
  });
  context.surfaceProjections.push({
    kind: "stale_action_surface",
    action_rejected: decision.stale_target_rejected,
  });
  context.productionCallerPaths.add("projectTelegramCallbackAuthority");
  if (!decision.stale_target_rejected) throw new Error(`Stale action binding was not rejected for ${context.scenario.scenario_id}`);
}

async function runTelegramProjection(context: RunContext, step: Extract<EvalStep, { kind: "telegram_projection" }>): Promise<void> {
  const decision = await recordPeerDelivery(context, step.delivery_id, {
    canSend: true,
    transportMessageRef: step.transport_message_ref,
  });
  const normalProjection = {
    kind: "telegram_normal_projection",
    conversation_id: step.conversation_id,
    delivery_status: decision.can_send ? "sent" : "held",
    raw_refs_visible: false,
  };
  const operatorProjection = {
    kind: "telegram_operator_projection",
    conversation_id: step.conversation_id,
    delivery_id: step.delivery_id,
    transport_message_ref: step.transport_message_ref,
    authority_decision_ref: decision.decision_id,
  };
  context.surfaceProjections.push(normalProjection);
  context.operatorProjections.push(operatorProjection);
  context.productionCallerPaths.add("projectPeerInitiativeDeliveryAuthority");
  if (normalProjection.delivery_status !== "sent") {
    throw new Error(`Telegram normal projection did not match operator delivery for ${context.scenario.scenario_id}`);
  }
}

async function recordScenarioAdmission(context: RunContext): Promise<void> {
  await recordPeerDelivery(context, `admission:${context.scenario.scenario_id}`, {
    outcome: "held",
    canHold: true,
  });
}

async function recordPeerDelivery(
  context: RunContext,
  deliveryId: string,
  options: {
    outcome?: "allowed" | "held" | "suppressed" | "fail_closed" | "approval_required";
    canSend?: boolean;
    canNotify?: boolean;
    canHold?: boolean;
    canSuppress?: boolean;
    quietingRef?: string;
    transportMessageRef?: string;
  },
) {
  context.productionCallerPaths.add("InteractionAuthorityStore.recordDecision");
  return context.authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
    candidateId: `candidate:${context.scenario.scenario_id}`,
    deliveryId,
    surface: "telegram",
    reason: `Eval lab scenario ${context.scenario.scenario_id} projected peer delivery.`,
    decidedAt: context.clock.nowIso(),
    outcome: options.outcome,
    canSend: options.canSend,
    canNotify: options.canNotify ?? options.canSend,
    canHold: options.canHold,
    canSuppress: options.canSuppress,
    targetBindingRef: `telegram:${context.scenario.fake_controls.telegram_gateway.conversation_id}`,
    channelPolicyRef: "telegram:policy:eval-lab",
    transportMessageRef: options.transportMessageRef,
    quietingRef: options.quietingRef,
    normalSurfaceProjectionRef: `normal:${context.scenario.scenario_id}:${deliveryId}`,
  }));
}

async function buildReplaySummary(context: RunContext): Promise<JsonObject> {
  const before = await context.eventLog.rebuildProjections();
  const after = await new RuntimeEventLogStore(context.root.runtimeRoot, { controlBaseDir: context.root.root }).rebuildProjections();
  const events = await context.eventLog.listEvents({ limit: null });
  const firstTraceId = events[0]?.trace_id ?? null;
  const explanation = firstTraceId ? await context.eventLog.explainTrace(firstTraceId) : null;
  return {
    schema_version: "pulseed.eval-lab.replay-summary/v1",
    event_log_rebuild_path: "RuntimeEventLogStore.rebuildProjections",
    explain_trace_path: firstTraceId ? "RuntimeEventLogStore.explainTrace" : null,
    replay_equivalent: stableComparable(before) === stableComparable(after),
    source_event_count: before.source_event_count,
    runtime_graph_edge_count: before.runtime_graph_evidence.edge_count,
    first_trace_id: firstTraceId,
    explained_event_count: explanation?.events.length ?? 0,
    rebuilt_projection_names: projectionNames(before),
  };
}

async function buildEvalRunArtifact(
  context: RunContext,
  metrics: EvalMetrics,
  replaySummary: JsonObject,
  failures: JsonObject[],
): Promise<EvalRunArtifact> {
  const events = await context.eventLog.listEvents({ limit: null });
  const runtimeGraphRefs = Array.from(new Set(events.flatMap((event) => [
    event.runtime_graph_node_ref?.ref,
    ...event.runtime_graph_edge_refs.map((ref) => ref.ref),
  ].filter((value): value is string => Boolean(value))))).sort();
  const artifact = EvalRunArtifactSchema.parse({
    schema_version: "pulseed.eval-lab.run-artifact/v1",
    scenario_id: context.scenario.scenario_id,
    seed: context.scenario.seed,
    started_at: context.scenario.fake_controls.clock_start,
    fake_clock: {
      started_at: context.scenario.fake_controls.clock_start,
      ended_at: context.clock.nowIso(),
    },
    runtime_event_refs: events.map((event) => event.event_id).sort(),
    runtime_graph_refs: runtimeGraphRefs,
    surface_projections: context.surfaceProjections,
    operator_projections: context.operatorProjections,
    transcript: [
      ...context.transcript,
      ...context.scriptedLlm.recordedTranscript().map((entry) => ({
        kind: "scripted_llm",
        request: entry.request,
        response: entry.response,
      })),
    ],
    replay_summary: replaySummary,
    metrics,
    failures,
    reproduction_command: `npm run test:eval-lab -- --run tests/eval-lab/eval-lab.test.ts -t ${context.scenario.scenario_id}`,
    production_caller_paths: Array.from(context.productionCallerPaths).sort(),
  });
  if (failures.length > 0) {
    await writeEvalFailureArtifacts(artifact);
  }
  return artifact;
}

async function persistEvalRunArtifact(artifact: EvalRunArtifact): Promise<string> {
  const dir = path.resolve("tmp", "eval-lab", artifact.scenario_id);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "run-artifact.json");
  await fsp.writeFile(filePath, stableJson(artifact as unknown as JsonValue), "utf8");
  return filePath;
}

async function writeJson(dir: string, fileName: string, value: unknown): Promise<void> {
  await fsp.writeFile(path.join(dir, fileName), stableJson(sanitize(value) as JsonValue), "utf8");
}

function scriptedTurnsFor(scenario: EvalScenario): ScriptedLlmTurn[] {
  return scenario.provider_script.map((turn) => ({
    request_phase: turn.request_phase,
    response: { content: turn.response_text },
  }));
}

function scriptedLlmClient(scripted: ScriptedLlm): ILLMClient {
  return {
    supportsToolCalling: () => true,
    sendMessage: async (messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> => {
      const response = scripted.send({
        messages: messages.map((message) => sanitize(message)),
        options: sanitize(options ?? {}),
      });
      return {
        content: typeof response["content"] === "string" ? response["content"] : JSON.stringify(response),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        tool_calls: [],
      };
    },
    sendMessageStream: async (
      messages: LLMMessage[],
      options: LLMRequestOptions | undefined,
      handlers: LLMStreamHandlers,
    ): Promise<LLMResponse> => {
      const response = await scriptedLlmClient(scripted).sendMessage(messages, options);
      handlers.onTextDelta?.(response.content);
      return response;
    },
    parseJSON: ((content: string, schema?: { parse(value: unknown): unknown }) => {
      const parsed = JSON.parse(content) as unknown;
      return schema ? schema.parse(parsed) : parsed;
    }) as ILLMClient["parseJSON"],
  };
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

function mockAdapter(): IAdapter {
  return {
    adapterType: "eval-lab-mock-adapter",
    execute: async () => ({
      success: true,
      output: "eval-lab adapter output",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
    }),
  } as unknown as IAdapter;
}

function evalCapabilityTool(toolName: string, failFirst: boolean): ITool<{ phase: string }> {
  let calls = 0;
  return {
    metadata: {
      name: toolName,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8_000,
      tags: ["eval-lab"],
      requiresNetwork: false,
      activityCategory: "read",
    },
    inputSchema: z.object({ phase: z.string() }),
    description: () => "Eval lab capability tool.",
    checkPermissions: async (): Promise<PermissionCheckResult> => ({ status: "allowed" }),
    isConcurrencySafe: () => true,
    call: async (input: { phase: string }, _context: ToolCallContext): Promise<ToolResult> => {
      calls += 1;
      if (failFirst && calls === 1) {
        return {
          success: false,
          data: { phase: input.phase },
          summary: "Capability unavailable on first attempt.",
          error: "capability_unavailable",
          execution: { status: "executed", reason: "tool_error" },
          durationMs: 1,
        };
      }
      return {
        success: true,
        data: { phase: input.phase, recovered: true },
        summary: "Capability recovered.",
        execution: { status: "executed" },
        durationMs: 1,
      };
    },
  };
}

function toolContext(context: RunContext, callId: string): ToolCallContext {
  return {
    cwd: context.root.workspaceRoot,
    goalId: `goal:${context.scenario.scenario_id}`,
    trustBalance: 100,
    preApproved: true,
    providerConfigBaseDir: context.root.root,
    callId,
    sessionId: `session:${context.scenario.scenario_id}`,
    personalAgentRuntime: context.personalAgentRuntime,
  };
}

function approvalTaskFor(scenarioId: string): PendingPermissionTask {
  return createPendingPermissionTask({
    id: `task:${scenarioId}`,
    description: `Eval lab approval for ${scenarioId}`,
    action: "continue",
    target: {
      tool_id: "eval_lab_tool",
      tool_call_id: `call:${scenarioId}`,
    },
    stateEpoch: "1",
    waitPlanId: `wait:${scenarioId}`,
    permissionLevel: "read_only",
    isDestructive: false,
    reversibility: "reversible",
  });
}

function approvalOrigin(scenarioId: string) {
  return {
    channel: "telegram",
    conversation_id: `conversation:${scenarioId}`,
    user_id: "operator",
    session_id: `session:${scenarioId}`,
    turn_id: `turn:${scenarioId}`,
  };
}

async function waitForPendingApproval(store: ApprovalStore, approvalId: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await store.loadPending(approvalId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for pending approval ${approvalId}`);
}

function projectionNames(rebuild: { [key: string]: unknown }): string[] {
  return [
    "interaction_authority_summary",
    "approval_resume_outcomes",
    "notification_outbox_dedupe_state",
    "peer_delivery_state",
    "memory_correction_invalidation_summary",
    "memory_truth_maintenance_summary",
    "schedule_wake_execution_summary",
    "tool_execution_outcome_summary",
    "runtime_control_operation_summary",
    "attention_commitment_lifecycle_summary",
  ].filter((name) => Array.isArray(rebuild[name]));
}

function stableComparable(value: unknown): string {
  const sanitized = sanitize(value) as Record<string, unknown>;
  delete sanitized["rebuilt_at"];
  return stableJson(sanitized as JsonValue);
}

function sanitize(value: unknown): JsonObject {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
