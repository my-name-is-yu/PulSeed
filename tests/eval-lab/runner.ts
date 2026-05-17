import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v3";

import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import {
  createExecutionAuthorityDecision,
  projectApprovalResumeAuthority,
  projectPeerInitiativeDeliveryAuthority,
} from "../../src/runtime/control/execution-authority-decision.js";
import { InteractionAuthorityStore } from "../../src/runtime/control/interaction-authority-store.js";
import { createProactivePolicyState, decideProactiveDelivery, reduceProactivePolicyState } from "../../src/runtime/attention/index.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  type InterventionDecisionKind,
  type InterventionTargetEffect,
  type PersonalAgentCallerPath,
  type PersonalAgentSourceKind,
  type RuntimeGraphRef,
  type TaskCandidateTargetKind,
} from "../../src/runtime/personal-agent/index.js";
import { recordScheduleJobDecision } from "../../src/runtime/schedule/personal-agent-trace.js";
import { PermissionWaitPlanStore, type PermissionWaitCanonicalPlan } from "../../src/runtime/store/permission-wait-plan-store.js";
import { RuntimeEventLogStore, type RuntimeEventEnvelope, type RuntimeEventProjectionRebuild } from "../../src/runtime/store/runtime-event-log.js";
import type { ProactivePolicyState } from "../../src/runtime/attention/proactive-policy.js";
import { createIsolatedStateRoot, type IsolatedStateRoot } from "../harness/isolated-state-root.js";
import { HarnessClock } from "../harness/fake-clock.js";
import { installNoNetworkGuard } from "../harness/network-guard.js";
import { ScriptedLlm } from "../harness/scripted-llm.js";
import { ScriptedToolRunner } from "../harness/scripted-tools.js";
import type { JsonObject } from "../harness/types.js";
import {
  EvalLabFailureSchema,
  EvalLabScenarioSchema,
  EvalLabStepSchema,
  EvalRunArtifactSchema,
  type EvalLabFailure,
  type EvalLabMetrics,
  type EvalLabScenario,
  type EvalLabStep,
  type EvalLabSuiteResult,
  type EvalRunArtifact,
} from "./types.js";

interface MemoryRecord {
  id: string;
  key: string;
  value: string;
}

interface MetricCounters {
  interventionCount: number;
  overreachCount: number;
  missedHelpOpportunities: number;
  missedHelpDetections: number;
  replayChecks: number;
  replayEquivalent: number;
  duplicateSideEffects: number;
  staleActionChecks: number;
  staleActionRejected: number;
  memoryExpected: number;
  memoryHit: number;
  correctedExpected: number;
  correctedHit: number;
  surfaceChecks: number;
  sensitiveLeaks: number;
  approvalAttempts: number;
  approvalBypass: number;
}

interface EvalLabRuntime {
  scenario: EvalLabScenario;
  stateRoot: IsolatedStateRoot;
  clock: HarnessClock;
  stateManager: StateManager;
  knowledgeManager: KnowledgeManager;
  personalAgentRuntime: PersonalAgentRuntimeStore;
  authorityStore: InteractionAuthorityStore;
  eventLogStore: RuntimeEventLogStore;
  scriptedLlm: ScriptedLlm;
  scriptedTools: ScriptedToolRunner;
  transcript: EvalRunArtifact["transcript"];
  surfaceProjections: Record<string, unknown>;
  operatorProjections: Record<string, unknown>;
  failures: EvalLabFailure[];
  counters: MetricCounters;
  memories: Map<string, MemoryRecord>;
  approvals: Map<string, PermissionWaitCanonicalPlan>;
  proactivePolicy: ProactivePolicyState | null;
}

const DEFAULT_METRICS: EvalLabMetrics = {
  overreach_rate: 0,
  missed_help_rate: 0,
  duplicate_side_effect_rate: 0,
  stale_action_rejection_rate: 1,
  memory_retrieval_hit_rate: 1,
  corrected_memory_reuse_rate: 1,
  sensitive_leak_rate: 0,
  approval_bypass_rate: 0,
  replay_equivalence_rate: 1,
  scenario_pass_rate: 1,
};

export async function runEvalLabScenario(input: EvalLabScenario): Promise<EvalRunArtifact> {
  const scenario = EvalLabScenarioSchema.parse(input);
  const stateRoot = await createIsolatedStateRoot(`eval-lab-${scenario.scenario_id}`);
  const guard = installNoNetworkGuard();
  const clock = new HarnessClock(scenario.started_at);
  const stateManager = new StateManager(stateRoot.controlDbBase, undefined, { walEnabled: false });
  await stateManager.init();
  const runtime: EvalLabRuntime = {
    scenario,
    stateRoot,
    clock,
    stateManager,
    knowledgeManager: new KnowledgeManager(stateManager, {} as ILLMClient),
    personalAgentRuntime: new PersonalAgentRuntimeStore(stateRoot.runtimeRoot, {
      controlBaseDir: stateRoot.controlDbBase,
    }),
    authorityStore: new InteractionAuthorityStore(stateRoot.runtimeRoot, {
      controlBaseDir: stateRoot.controlDbBase,
    }),
    eventLogStore: new RuntimeEventLogStore(stateRoot.runtimeRoot, {
      controlBaseDir: stateRoot.controlDbBase,
    }),
    scriptedLlm: new ScriptedLlm(scenario.model_script),
    scriptedTools: new ScriptedToolRunner(scenario.tool_script),
    transcript: [],
    surfaceProjections: {},
    operatorProjections: {},
    failures: [],
    counters: zeroCounters(),
    memories: new Map(),
    approvals: new Map(),
    proactivePolicy: null,
  };

  try {
    for (const step of scenario.steps) {
      await applyStep(runtime, EvalLabStepSchema.parse(step));
    }
    const artifact = await buildArtifact(runtime);
    await writeRunArtifact(artifact);
    const blockers = blockingFailures(runtime, artifact);
    if (blockers.length > 0) {
      await writeFailureArtifacts(artifact, blockers);
      throw new Error(`Eval lab scenario ${scenario.scenario_id} failed: ${blockers.map((failure) => failure.code).join(", ")}`);
    }
    return artifact;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Eval lab scenario ${scenario.scenario_id} failed:`)
    ) {
      throw error;
    }
    if (!runtime.failures.some((failure) => failure.code === "unexpected_runtime_error")) {
      runtime.failures.push({
        code: "unexpected_runtime_error",
        message: error instanceof Error ? error.message : String(error),
        refs: [],
      });
    }
    const artifact = await buildArtifact(runtime);
    await writeRunArtifact(artifact);
    await writeFailureArtifacts(artifact, runtime.failures);
    throw error;
  } finally {
    guard.restore();
    if (process.env["PULSEED_EVAL_LAB_KEEP_TMP"] !== "1") {
      await stateRoot.cleanup();
    }
  }
}

export async function runEvalLabSuite(scenarios: readonly EvalLabScenario[]): Promise<EvalLabSuiteResult> {
  const artifacts: EvalRunArtifact[] = [];
  for (const scenario of scenarios) {
    artifacts.push(await runEvalLabScenario(scenario));
  }
  return {
    artifacts,
    metrics: averageMetrics(artifacts),
    artifact_paths: artifacts.map((artifact) => runArtifactPath(artifact.scenario_id)),
  };
}

async function applyStep(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const at = typeof step.input["at"] === "string" ? step.input["at"] : step.at ?? runtime.clock.nowIso();
  if (step.at) runtime.clock.set(step.at);
  switch (step.kind) {
    case "fake_clock_advance":
      runtime.clock.advance(numberInput(step, "ms", 0));
      runtime.operatorProjections[step.id] = {
        fake_clock: runtime.clock.nowIso(),
        source: "HarnessClock",
      };
      return;
    case "fake_filesystem_workspace":
      await writeWorkspaceFile(runtime, stringInput(step, "path", "artifact.json"), objectInput(step, "value"));
      return;
    case "fake_network":
      await assertNetworkBlocked(runtime, step);
      return;
    case "fake_user_turn":
      runtime.transcript.push({
        at,
        role: "user",
        source: "fake_user_turn",
        text: stringInput(step, "text"),
        refs: stringArrayInput(step, "refs"),
      });
      await recordTrace(runtime, {
        callerPath: "chat_gateway_turn",
        sourceKind: "user_message",
        sourceId: step.id,
        summary: stringInput(step, "summary", `User turn ${step.id}`),
        targetKind: "attention_only",
        targetRef: { kind: "chat_turn", ref: step.id },
        targetEffect: "continue_route",
        targetSummary: "Continue the current companion conversation route.",
        decision: "allow",
        currentRefs: stringArrayInput(step, "refs").map((ref) => ({ kind: "scenario_ref", ref })),
      });
      return;
    case "fake_provider_model":
      await runScriptedModel(runtime, step);
      return;
    case "memory_seed":
      await seedMemory(runtime, step);
      return;
    case "memory_correction":
      await correctMemory(runtime, step);
      return;
    case "memory_recall":
      await recallMemory(runtime, step);
      return;
    case "schedule_wake":
      await recordScheduleWake(runtime, step);
      return;
    case "approval_request":
      await createApprovalRequest(runtime, step);
      return;
    case "approval_response":
    case "stale_action_binding":
      await resolveApproval(runtime, step);
      return;
    case "daemon_restart":
      restartRuntimeStores(runtime);
      return;
    case "fake_telegram_gateway":
      await recordTelegramDelivery(runtime, step);
      return;
    case "event_log_replay":
      await runEventLogReplay(runtime, step);
      return;
    case "fake_plugin_capability":
      runScriptedTool(runtime, step);
      return;
    case "quiet_proactivity_control":
      applyQuietControl(runtime, step);
      return;
    case "feedback":
      applyFeedback(runtime, step);
      return;
    case "proactivity_decision":
      recordProactivityDecision(runtime, step);
      return;
    case "missed_help_observation":
      recordMissedHelp(runtime, step);
      return;
    case "force_failure":
      throw new Error(stringInput(step, "message", "forced eval-lab failure"));
  }
}

async function buildArtifact(runtime: EvalLabRuntime): Promise<EvalRunArtifact> {
  const events = await runtime.eventLogStore.listEvents({ limit: null });
  const rebuild = await runtime.eventLogStore.rebuildProjections();
  const graph = await collectRuntimeGraph(runtime, events);
  const metrics = computeMetrics(runtime.counters);
  applyScenarioExpectations(runtime, events, graph.edgeKinds, metrics);
  return EvalRunArtifactSchema.parse({
    schema_version: "pulseed.eval-lab.run-artifact/v1",
    scenario_id: runtime.scenario.scenario_id,
    seed: runtime.scenario.seed,
    started_at: runtime.scenario.started_at,
    fake_clock: {
      started_at: runtime.scenario.started_at,
      current_at: runtime.clock.nowIso(),
    },
    runtime_event_refs: events.map((event) => ({
      event_id: event.event_id,
      event_type: event.event_type,
      trace_id: event.trace_id,
      idempotency_key: event.idempotency_key,
    })),
    runtime_graph_refs: {
      node_refs: graph.nodeRefs,
      edge_refs: graph.edgeRefs,
      edge_kinds: graph.edgeKinds,
    },
    surface_projections: runtime.surfaceProjections,
    operator_projections: runtime.operatorProjections,
    transcript: runtime.transcript,
    replay_summary: replaySummary(rebuild, graph.replayEquivalent),
    metrics,
    failures: runtime.failures,
    reproduction_command: `npm run test:eval-lab -- tests/eval-lab/eval-lab.test.ts -t "${runtime.scenario.scenario_id}"`,
  });
}

function applyScenarioExpectations(
  runtime: EvalLabRuntime,
  events: RuntimeEventEnvelope[],
  edgeKinds: Record<string, number>,
  metrics: EvalLabMetrics,
): void {
  for (const eventType of runtime.scenario.expectations.required_event_types) {
    if (!events.some((event) => event.event_type === eventType)) {
      addFailure(runtime, "missing_runtime_event", `Missing runtime event type ${eventType}.`, { actual: events.map((event) => event.event_type) });
    }
  }
  for (const edgeKind of runtime.scenario.expectations.required_runtime_graph_edge_kinds) {
    if (!edgeKinds[edgeKind]) {
      addFailure(runtime, "missing_runtime_graph_edge", `Missing RuntimeGraph edge kind ${edgeKind}.`, { actual: edgeKinds });
    }
  }
  for (const [metric, minimum] of Object.entries(runtime.scenario.expectations.metric_thresholds.minimums)) {
    if (minimum !== undefined && metrics[metric as keyof EvalLabMetrics] < minimum) {
      addFailure(runtime, "metric_below_threshold", `${metric} below threshold.`, {
        expected: minimum,
        actual: metrics[metric as keyof EvalLabMetrics],
      });
    }
  }
  for (const [metric, maximum] of Object.entries(runtime.scenario.expectations.metric_thresholds.maximums)) {
    if (maximum !== undefined && metrics[metric as keyof EvalLabMetrics] > maximum) {
      addFailure(runtime, "metric_above_threshold", `${metric} above threshold.`, {
        expected: maximum,
        actual: metrics[metric as keyof EvalLabMetrics],
      });
    }
  }
  for (const code of runtime.scenario.expectations.required_failure_codes) {
    if (!runtime.failures.some((failure) => failure.code === code)) {
      addFailure(runtime, "missing_expected_detection", `Missing expected eval detection ${code}.`);
    }
  }
}

async function collectRuntimeGraph(
  runtime: EvalLabRuntime,
  events: RuntimeEventEnvelope[],
): Promise<{ nodeRefs: string[]; edgeRefs: string[]; edgeKinds: Record<string, number>; replayEquivalent: boolean }> {
  const nodeRefs = new Set<string>();
  const edgeRefs = new Set<string>();
  const edgeKinds: Record<string, number> = {};
  for (const traceId of new Set(events.map((event) => event.trace_id))) {
    const explanation = await runtime.eventLogStore.explainTrace(traceId);
    for (const node of explanation.runtime_graph.nodes) {
      nodeRefs.add(node.node_id);
    }
    for (const edge of explanation.runtime_graph.edges) {
      edgeRefs.add(edge.edge_id);
      edgeKinds[edge.edge_kind] = (edgeKinds[edge.edge_kind] ?? 0) + 1;
    }
  }
  return {
    nodeRefs: [...nodeRefs].sort(),
    edgeRefs: [...edgeRefs].sort(),
    edgeKinds,
    replayEquivalent: events.length === 0 || nodeRefs.size > 0,
  };
}

function replaySummary(rebuild: RuntimeEventProjectionRebuild, replayEquivalent: boolean): EvalRunArtifact["replay_summary"] {
  return {
    source: "RuntimeEventLogStore.rebuildProjections",
    source_event_count: rebuild.source_event_count,
    projection_names: Object.keys(rebuild)
      .filter((key) => !["schema_version", "rebuilt_at", "trace_id", "source_event_count"].includes(key))
      .sort(),
    replay_equivalent: replayEquivalent,
  };
}

async function runScriptedModel(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const response = runtime.scriptedLlm.send({
    phase: stringInput(step, "phase", step.id),
    prompt: stringInput(step, "prompt", ""),
  });
  const text = typeof response["content"] === "string" ? response["content"] : JSON.stringify(response);
  runtime.transcript.push({
    at: runtime.clock.nowIso(),
    role: "assistant",
    source: "ScriptedLlm",
    text,
    refs: stringArrayInput(step, "refs"),
  });
  runtime.surfaceProjections[step.id] = {
    model: "scripted",
    content: text,
  };
}

async function seedMemory(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const label = stringInput(step, "label", step.id);
  const key = stringInput(step, "key", label);
  const value = stringInput(step, "value", "");
  const record = await runtime.knowledgeManager.saveAgentMemory({
    key,
    value,
    tags: stringArrayInput(step, "tags"),
    memory_type: stringInput(step, "memory_type", "preference"),
    ...(booleanInput(step, "sensitive", false)
      ? {
          governance: {
            sensitivity: "secret",
            consent: {
              scope_id: "private_review",
              allowed_contexts: ["private_review"],
            },
          },
        }
      : {}),
  });
  runtime.memories.set(label, { id: record.id, key, value });
  runtime.operatorProjections[step.id] = {
    memory_ref: `agent_memory:${record.id}`,
    key,
  };
}

async function correctMemory(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const target = memoryByLabel(runtime, stringInput(step, "target_label"));
  const operation = stringInput(step, "operation", "correct") as "correct" | "forget" | "retract";
  const replacementKey = stringInput(step, "replacement_key", `${target.key}.current`);
  const replacementValue = stringInput(step, "replacement_value", target.value);
  const result = await runUserMemoryOperation(runtime.stateManager, {
    operation,
    targetRef: { kind: "agent_memory", id: target.id },
    reason: stringInput(step, "reason", "Eval lab memory correction."),
    ...(operation === "correct" ? { replacementKey, replacementValue } : {}),
    now: runtime.clock.nowIso(),
  });
  if (operation === "correct") {
    runtime.memories.set(stringInput(step, "replacement_label", `${target.key}.current`), {
      id: result.correction?.replacement_memory_id ?? replacementKey,
      key: replacementKey,
      value: replacementValue,
    });
  }
  runtime.operatorProjections[step.id] = {
    correction_id: result.correction?.correction_id ?? null,
    history_count: result.history.length,
    operation,
  };
}

async function recallMemory(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const query = stringInput(step, "query");
  const recalled = await runtime.knowledgeManager.recallAgentMemory(query, {
    exact: booleanInput(step, "exact", false),
    max_sensitivity: "local",
    consent_scope: stringInput(step, "consent_scope", "local_planning"),
    limit: numberInput(step, "limit", 20),
  });
  const keys = recalled.map((entry) => entry.key);
  const expectedKeys = stringArrayInput(step, "expected_keys");
  const correctedKeys = stringArrayInput(step, "corrected_expected_keys");
  const staleKeys = stringArrayInput(step, "stale_keys");
  const sensitiveKeys = stringArrayInput(step, "sensitive_keys");
  runtime.counters.memoryExpected += expectedKeys.length;
  runtime.counters.memoryHit += expectedKeys.filter((key) => keys.includes(key)).length;
  runtime.counters.correctedExpected += correctedKeys.length;
  runtime.counters.correctedHit += correctedKeys.filter((key) => keys.includes(key)).length;
  runtime.counters.surfaceChecks += 1;
  runtime.counters.sensitiveLeaks += sensitiveKeys.filter((key) => keys.includes(key)).length;
  if (staleKeys.length > 0) {
    runtime.counters.staleActionChecks += staleKeys.length;
    runtime.counters.staleActionRejected += staleKeys.filter((key) => !keys.includes(key)).length;
  }
  runtime.surfaceProjections[step.id] = {
    retrieved_keys: keys,
    expected_keys: expectedKeys,
    stale_keys_rejected: staleKeys.filter((key) => !keys.includes(key)),
    raw_values_visible: false,
  };
}

async function recordScheduleWake(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const entryId = stringInput(step, "entry_id", `schedule:${step.id}`);
  await recordScheduleJobDecision({
    personalAgentRuntime: runtime.personalAgentRuntime,
    entry: {
      id: entryId,
      name: stringInput(step, "name", "Eval lab schedule wake"),
      layer: "cron",
    },
    firedAt: runtime.clock.nowIso(),
    scheduledFor: stringInput(step, "scheduled_for", runtime.clock.nowIso()),
    jobKind: "cron",
    actionKind: stringInput(step, "action_kind", "long_run_eval_wake"),
    decision: "allow",
    capabilityDecision: "available",
    decisionReason: "Eval lab schedule wake crossed the production schedule personal-agent trace path.",
    currentRefs: [{ kind: "eval_scenario", ref: runtime.scenario.scenario_id }],
  });
  runtime.transcript.push({
    at: runtime.clock.nowIso(),
    role: "runtime",
    source: "schedule_wake",
    text: `Schedule wake ${entryId} fired.`,
    refs: [entryId],
  });
}

async function createApprovalRequest(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const plan = canonicalPlan(runtime, step, stringInput(step, "value", "current"));
  const waitPlanId = stringInput(step, "wait_plan_id", `permission-wait:${step.id}`);
  const store = permissionWaitStore(runtime);
  await store.createWaiting({
    wait_plan_id: waitPlanId,
    approval_id: stringInput(step, "approval_id", waitPlanId),
    expires_at: numberInput(step, "expires_at", runtime.clock.nowMs() + 60_000),
    canonical_plan: plan,
    audit_refs: [`eval-lab:${runtime.scenario.scenario_id}`],
  });
  runtime.approvals.set(waitPlanId, plan);
  runtime.counters.approvalAttempts += 1;
  runtime.operatorProjections[step.id] = {
    wait_plan_id: waitPlanId,
    state: "waiting_for_permission",
  };
}

async function resolveApproval(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const waitPlanId = stringInput(step, "wait_plan_id");
  const expected = runtime.approvals.get(waitPlanId);
  if (!expected) throw new Error(`No eval approval request found for ${waitPlanId}.`);
  const store = permissionWaitStore(runtime);
  await store.markApproved(waitPlanId, {
    resolved_at: runtime.clock.nowMs(),
    response_channel: "eval-lab",
    audit_refs: [`eval-lab:${runtime.scenario.scenario_id}`],
  });
  const actual = booleanInput(step, "stale", false)
    ? {
        ...expected,
        input: { value: stringInput(step, "actual_value", "stale") },
        target: { ...expected.target, session_id: stringInput(step, "actual_session_id", "session:stale") },
      }
    : expected;
  const resumeResult = await store.resumeApproved(waitPlanId, {
    canonical_plan: actual,
    resumed_at: runtime.clock.nowMs(),
    audit_refs: [`eval-lab:${runtime.scenario.scenario_id}`],
  });
  const authority = await runtime.authorityStore.recordDecision(projectApprovalResumeAuthority({
    waitPlanId,
    resumeResult,
    expectedCanonicalPlan: expected,
    actualCanonicalPlan: actual,
    decidedAt: runtime.clock.nowIso(),
  }));
  if (booleanInput(step, "stale", false)) {
    runtime.counters.staleActionChecks += 1;
    if (resumeResult.status === "mismatch_rejected") runtime.counters.staleActionRejected += 1;
  }
  if (resumeResult.status !== "resumed" && !booleanInput(step, "stale", false)) {
    runtime.counters.approvalBypass += 1;
  }
  runtime.operatorProjections[step.id] = {
    resume_status: resumeResult.status,
    authority_decision_id: authority.decision_id,
  };
}

function restartRuntimeStores(runtime: EvalLabRuntime): void {
  runtime.personalAgentRuntime = new PersonalAgentRuntimeStore(runtime.stateRoot.runtimeRoot, {
    controlBaseDir: runtime.stateRoot.controlDbBase,
  });
  runtime.authorityStore = new InteractionAuthorityStore(runtime.stateRoot.runtimeRoot, {
    controlBaseDir: runtime.stateRoot.controlDbBase,
  });
  runtime.eventLogStore = new RuntimeEventLogStore(runtime.stateRoot.runtimeRoot, {
    controlBaseDir: runtime.stateRoot.controlDbBase,
  });
  runtime.operatorProjections.daemon_restart = {
    restarted_at: runtime.clock.nowIso(),
    stores_recreated: ["PersonalAgentRuntimeStore", "InteractionAuthorityStore", "RuntimeEventLogStore"],
  };
}

async function recordTelegramDelivery(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const deliveryId = stringInput(step, "delivery_id", `delivery:${step.id}`);
  const candidateId = stringInput(step, "candidate_id", `candidate:${step.id}`);
  const decision = await runtime.authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
    candidateId,
    deliveryId,
    surface: "telegram",
    reason: stringInput(step, "reason", "Eval lab Telegram delivery admitted by typed authority."),
    decidedAt: runtime.clock.nowIso(),
    canSend: booleanInput(step, "can_send", true),
    canNotify: booleanInput(step, "can_notify", true),
    targetBindingRef: stringInput(step, "target_binding_ref", "gateway:telegram:home_chat:eval"),
    channelPolicyRef: stringInput(step, "channel_policy_ref", "gateway:telegram:eval-policy"),
    transportMessageRef: stringInput(step, "transport_message_ref", `telegram:${deliveryId}`),
    normalSurfaceProjectionRef: `normal-surface:${runtime.scenario.scenario_id}:${step.id}`,
  }));
  if (booleanInput(step, "duplicate_probe", false) && decision.can_send) {
    runtime.counters.duplicateSideEffects += 1;
  }
  runtime.surfaceProjections[step.id] = {
    surface: "telegram",
    delivery_id: deliveryId,
    sent: decision.can_send,
    raw_policy_visible: false,
  };
}

async function runEventLogReplay(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  const before = await runtime.eventLogStore.rebuildProjections();
  restartRuntimeStores(runtime);
  const after = await runtime.eventLogStore.rebuildProjections();
  const beforeStable = stableReplaySummary(before);
  const afterStable = stableReplaySummary(after);
  const equivalent = JSON.stringify(beforeStable) === JSON.stringify(afterStable);
  runtime.counters.replayChecks += 1;
  runtime.counters.replayEquivalent += equivalent ? 1 : 0;
  runtime.operatorProjections[step.id] = {
    source: "RuntimeEventLogStore.rebuildProjections",
    before: beforeStable,
    after: afterStable,
    equivalent,
  };
}

function runScriptedTool(runtime: EvalLabRuntime, step: EvalLabStep): void {
  const name = stringInput(step, "name");
  const result = runtime.scriptedTools.run(name, objectInput(step, "args"));
  runtime.transcript.push({
    at: runtime.clock.nowIso(),
    role: "tool",
    source: "ScriptedToolRunner",
    text: JSON.stringify(result),
    refs: [name],
  });
  runtime.operatorProjections[step.id] = {
    tool: name,
    result,
    mutation_artifacts: runtime.scriptedTools.mutationArtifacts(),
  };
}

function applyQuietControl(runtime: EvalLabRuntime, step: EvalLabStep): void {
  runtime.proactivePolicy = reduceProactivePolicyState(runtime.proactivePolicy ?? createProactivePolicyState({
    policyId: `policy:${runtime.scenario.scenario_id}`,
    now: runtime.clock.nowIso(),
  }), {
    kind: stringInput(step, "mode", "quiet") === "active" ? "quiet_lifted" : "quiet_entered",
    control_ref: { kind: "runtime_control", ref: `quiet:${step.id}` },
    recorded_at: runtime.clock.nowIso(),
  });
  runtime.surfaceProjections[step.id] = {
    quiet_mode: runtime.proactivePolicy.mode,
    runtime_authority: runtime.proactivePolicy.runtime_authority,
  };
}

function applyFeedback(runtime: EvalLabRuntime, step: EvalLabStep): void {
  const feedbackKind = stringInput(step, "feedback_kind", "overreach") as "accepted" | "dismissed" | "overreach" | "correction" | "permission_revoked";
  runtime.proactivePolicy = reduceProactivePolicyState(runtime.proactivePolicy ?? createProactivePolicyState({
    policyId: `policy:${runtime.scenario.scenario_id}`,
    now: runtime.clock.nowIso(),
  }), {
    kind: "feedback",
    feedback_kind: feedbackKind,
    feedback_ref: { kind: "feedback", ref: `feedback:${step.id}` },
    recorded_at: runtime.clock.nowIso(),
  });
  runtime.counters.interventionCount += 1;
  if (feedbackKind === "overreach") runtime.counters.overreachCount += 1;
  runtime.operatorProjections[step.id] = {
    feedback_kind: feedbackKind,
    max_delivery_kind: runtime.proactivePolicy.max_delivery_kind,
  };
}

function recordProactivityDecision(runtime: EvalLabRuntime, step: EvalLabStep): void {
  const state = runtime.proactivePolicy ?? createProactivePolicyState({
    policyId: `policy:${runtime.scenario.scenario_id}`,
    now: runtime.clock.nowIso(),
  });
  const decision = decideProactiveDelivery({
    state,
    requestedDeliveryKind: stringInput(step, "requested_delivery_kind", "notify") as never,
    candidateCreatedAt: stringInput(step, "candidate_created_at", runtime.clock.nowIso()),
  });
  runtime.surfaceProjections[step.id] = {
    allowed_delivery_kind: decision.allowed_delivery_kind,
    reason: decision.reason,
    runtime_authority: decision.runtime_authority,
  };
}

function recordMissedHelp(runtime: EvalLabRuntime, step: EvalLabStep): void {
  runtime.counters.missedHelpOpportunities += 1;
  const detected = booleanInput(step, "detected", true);
  if (detected) {
    runtime.counters.missedHelpDetections += 1;
    addFailure(runtime, "missed_help_detected", stringInput(step, "message", "Eval lab detected a missed-help opportunity."), {
      refs: [`scenario:${runtime.scenario.scenario_id}`, step.id],
    });
  }
  runtime.operatorProjections[step.id] = {
    help_opportunity: true,
    intervention_present: false,
    detected,
  };
}

async function writeWorkspaceFile(runtime: EvalLabRuntime, relativePath: string, value: JsonObject): Promise<void> {
  const target = path.join(runtime.stateRoot.workspaceRoot, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  runtime.operatorProjections[`workspace:${relativePath}`] = {
    workspace_ref: `workspace:${relativePath}`,
    fake_filesystem: true,
  };
}

async function assertNetworkBlocked(runtime: EvalLabRuntime, step: EvalLabStep): Promise<void> {
  let blocked = false;
  try {
    await fetch(stringInput(step, "url", "https://example.com"));
  } catch {
    blocked = true;
  }
  if (!blocked) {
    addFailure(runtime, "network_not_blocked", "Eval lab network guard did not block a fetch call.");
  }
  runtime.operatorProjections[step.id] = {
    network_blocked: blocked,
    real_external_service_used: false,
  };
}

async function recordTrace(runtime: EvalLabRuntime, input: {
  callerPath: PersonalAgentCallerPath;
  sourceKind: PersonalAgentSourceKind;
  sourceId: string;
  summary: string;
  targetKind: TaskCandidateTargetKind;
  targetRef: RuntimeGraphRef;
  targetEffect: InterventionTargetEffect;
  targetSummary: string;
  decision: InterventionDecisionKind;
  currentRefs?: RuntimeGraphRef[];
  staleRefs?: RuntimeGraphRef[];
}): Promise<void> {
  await runtime.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: input.callerPath,
    source: {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      emittedAt: runtime.clock.nowIso(),
      sourceEpoch: runtime.clock.nowIso(),
      highWatermark: input.sourceId,
      replayKey: `${runtime.scenario.scenario_id}:${input.callerPath}:${input.sourceId}`,
      summary: input.summary,
      sourceRef: { kind: input.sourceKind, ref: input.sourceId },
    },
    target: {
      kind: input.targetKind,
      ref: input.targetRef,
      effect: input.targetEffect,
      summary: input.targetSummary,
    },
    decision: input.decision,
    decisionReason: input.summary,
    capabilityDecision: input.decision === "block" ? "blocked" : "available",
    currentRefs: input.currentRefs ?? [],
    staleRefs: input.staleRefs ?? [],
  }));
}

function canonicalPlan(runtime: EvalLabRuntime, step: EvalLabStep, value: string): PermissionWaitCanonicalPlan {
  return {
    schema_version: "permission-wait-canonical-plan-v1",
    tool_name: stringInput(step, "tool_name", "eval_lab_tool"),
    input: { value },
    cwd: runtime.stateRoot.workspaceRoot,
    target: {
      goal_id: "goal:eval-lab",
      session_id: stringInput(step, "session_id", "session:eval-lab"),
      tool_call_id: stringInput(step, "tool_call_id", `tool-call:${step.id}`),
    },
    permission: {
      permission_level: "write_local",
      is_destructive: false,
      reversibility: "reversible",
    },
    capability_facts: {
      tool_permission_level: "write_local",
      tool_is_read_only: false,
      tool_is_destructive: false,
      tool_requires_network: false,
      tool_activity_category: "file_modify",
      tool_tags: ["eval-lab"],
    },
  };
}

function permissionWaitStore(runtime: EvalLabRuntime): PermissionWaitPlanStore {
  return new PermissionWaitPlanStore(runtime.stateRoot.runtimeRoot, {
    controlBaseDir: runtime.stateRoot.controlDbBase,
    now: () => runtime.clock.nowMs(),
    createEventId: () => `permission-wait-event:${runtime.scenario.scenario_id}:${runtime.clock.nowMs()}`,
  });
}

function computeMetrics(counters: MetricCounters): EvalLabMetrics {
  return {
    overreach_rate: ratio(counters.overreachCount, counters.interventionCount),
    missed_help_rate: ratio(counters.missedHelpDetections, counters.missedHelpOpportunities),
    duplicate_side_effect_rate: ratio(counters.duplicateSideEffects, counters.replayChecks),
    stale_action_rejection_rate: ratio(counters.staleActionRejected, counters.staleActionChecks, DEFAULT_METRICS.stale_action_rejection_rate),
    memory_retrieval_hit_rate: ratio(counters.memoryHit, counters.memoryExpected, DEFAULT_METRICS.memory_retrieval_hit_rate),
    corrected_memory_reuse_rate: ratio(counters.correctedHit, counters.correctedExpected, DEFAULT_METRICS.corrected_memory_reuse_rate),
    sensitive_leak_rate: ratio(counters.sensitiveLeaks, counters.surfaceChecks),
    approval_bypass_rate: ratio(counters.approvalBypass, counters.approvalAttempts),
    replay_equivalence_rate: ratio(counters.replayEquivalent, counters.replayChecks, DEFAULT_METRICS.replay_equivalence_rate),
    scenario_pass_rate: 1,
  };
}

function averageMetrics(artifacts: readonly EvalRunArtifact[]): EvalLabMetrics {
  const keys = Object.keys(DEFAULT_METRICS) as Array<keyof EvalLabMetrics>;
  const result = { ...DEFAULT_METRICS };
  for (const key of keys) {
    result[key] = ratio(artifacts.reduce((sum, artifact) => sum + artifact.metrics[key], 0), artifacts.length, DEFAULT_METRICS[key]);
  }
  return result;
}

function ratio(numerator: number, denominator: number, emptyValue = 0): number {
  if (denominator <= 0) return emptyValue;
  return Number((numerator / denominator).toFixed(6));
}

function zeroCounters(): MetricCounters {
  return {
    interventionCount: 0,
    overreachCount: 0,
    missedHelpOpportunities: 0,
    missedHelpDetections: 0,
    replayChecks: 0,
    replayEquivalent: 0,
    duplicateSideEffects: 0,
    staleActionChecks: 0,
    staleActionRejected: 0,
    memoryExpected: 0,
    memoryHit: 0,
    correctedExpected: 0,
    correctedHit: 0,
    surfaceChecks: 0,
    sensitiveLeaks: 0,
    approvalAttempts: 0,
    approvalBypass: 0,
  };
}

function stableReplaySummary(rebuild: RuntimeEventProjectionRebuild): JsonObject {
  return {
    trace_id: rebuild.trace_id,
    source_event_count: rebuild.source_event_count,
    runtime_graph_evidence: rebuild.runtime_graph_evidence,
    interaction_authority_summary: rebuild.interaction_authority_summary,
    approval_resume_outcome_count: rebuild.approval_resume_outcomes.length,
    peer_delivery_count: rebuild.peer_delivery_state.length,
    memory_correction_count: rebuild.memory_correction_invalidation_summary.length,
    schedule_wake_count: rebuild.schedule_wake_execution_summary.length,
    tool_execution_count: rebuild.tool_execution_outcome_summary.length,
  };
}

function blockingFailures(runtime: EvalLabRuntime, artifact: EvalRunArtifact): EvalLabFailure[] {
  const expected = new Set(runtime.scenario.expectations.required_failure_codes);
  return artifact.failures.filter((failure) => !expected.has(failure.code));
}

async function writeRunArtifact(artifact: EvalRunArtifact): Promise<void> {
  const target = runArtifactPath(artifact.scenario_id);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function runArtifactPath(scenarioId: string): string {
  return path.resolve("tmp", "eval-lab", scenarioId, "run-artifact.json");
}

async function writeFailureArtifacts(artifact: EvalRunArtifact, failures: readonly EvalLabFailure[]): Promise<void> {
  const dir = path.resolve("tmp", "eval-failures", artifact.scenario_id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "normal-projection.json"), `${JSON.stringify(artifact.surface_projections, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "operator-projection.json"), `${JSON.stringify(artifact.operator_projections, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "event-log-replay-trace.json"), `${JSON.stringify({
    runtime_event_refs: artifact.runtime_event_refs,
    runtime_graph_refs: artifact.runtime_graph_refs,
    replay_summary: artifact.replay_summary,
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "transcript.json"), `${JSON.stringify(artifact.transcript, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "metrics.json"), `${JSON.stringify(artifact.metrics, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "failures.json"), `${JSON.stringify(failures, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "reproduction-command.txt"), `${artifact.reproduction_command}\n`, "utf8");
}

function addFailure(
  runtime: EvalLabRuntime,
  code: string,
  message: string,
  input: { refs?: string[]; expected?: unknown; actual?: unknown } = {},
): void {
  runtime.failures.push(EvalLabFailureSchema.parse({
    code,
    message,
    refs: input.refs ?? [],
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: input.actual } : {}),
  }));
}

function memoryByLabel(runtime: EvalLabRuntime, label: string): MemoryRecord {
  const memory = runtime.memories.get(label);
  if (!memory) throw new Error(`No eval memory found for label ${label}.`);
  return memory;
}

function stringInput(step: EvalLabStep, key: string, fallback = ""): string {
  const value = step.input[key];
  return typeof value === "string" ? value : fallback;
}

function stringArrayInput(step: EvalLabStep, key: string): string[] {
  const value = step.input[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberInput(step: EvalLabStep, key: string, fallback = 0): number {
  const value = step.input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanInput(step: EvalLabStep, key: string, fallback = false): boolean {
  const value = step.input[key];
  return typeof value === "boolean" ? value : fallback;
}

function objectInput(step: EvalLabStep, key: string): JsonObject {
  const value = step.input[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

// Exported for the contract test that verifies the failure artifact path.
export const evalLabFailureArtifactFiles = [
  "normal-projection.json",
  "operator-projection.json",
  "event-log-replay-trace.json",
  "transcript.json",
  "metrics.json",
  "failures.json",
  "reproduction-command.txt",
] as const;

// Keeps the imported zod runtime visible to Vitest transform checks for this lane.
export const EvalLabRunnerReadySchema = z.literal("eval-lab-runner-ready");
