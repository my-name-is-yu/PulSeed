import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import Database from "better-sqlite3";
import { StateManager } from "../../src/base/state/state-manager.js";
import { buildStandaloneIngressMessageFromContext } from "../../src/interface/chat/chat-runner-runtime.js";
import { ChatSessionCatalog } from "../../src/interface/chat/chat-session-store.js";
import { ChatSessionDataStore } from "../../src/interface/chat/chat-session-data-store.js";
import { ApprovalBroker } from "../../src/runtime/approval-broker.js";
import { createPendingPermissionTask, type PendingPermissionTask } from "../../src/runtime/permission-dialogue.js";
import { JournalBackedQueue, type JournalBackedQueueSnapshot } from "../../src/runtime/queue/journal-backed-queue.js";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import { RuntimeSessionRegistry } from "../../src/runtime/session-registry/index.js";
import { ApprovalStore, AttentionStateStore, BackgroundRunLedger } from "../../src/runtime/store/index.js";
import type { Envelope } from "../../src/runtime/types/envelope.js";
import { createIsolatedStateRoot, type IsolatedStateRoot } from "./isolated-state-root.js";
import { normalizeJson } from "./normalizers.js";
import { installNoNetworkGuard } from "./network-guard.js";
import type { JsonObject, ReplayFixture, TraceArtifactTreeEntry } from "./types.js";

export interface ReplayRunResult {
  fresh_state: JsonObject;
  restarted_state: JsonObject;
  audit: JsonObject[];
  artifact_tree: ReplayFixture["expected"]["artifact_tree"];
}

export async function runReplayFixture(fixture: ReplayFixture): Promise<ReplayRunResult> {
  if (fixture.input.allow_network === true) {
    throw new Error(`${fixture.contract_name} requested network in a replay lane.`);
  }
  if (fixture.input.allow_real_llm === true) {
    throw new Error(`${fixture.contract_name} requested real LLM in a replay lane.`);
  }
  const guard = installNoNetworkGuard();
  const stateRoot = await createIsolatedStateRoot(fixture.contract_name, fixture.initial_state);
  try {
    const result = await runProductionReplayFixture(fixture, stateRoot);
    return normalizeJson({
      fresh_state: result.fresh_state,
      restarted_state: result.restarted_state,
      audit: result.audit,
      artifact_tree: result.artifact_tree,
    }, fixture.normalizers) as unknown as ReplayRunResult;
  } finally {
    guard.restore();
    await stateRoot.cleanup();
  }
}

export function assertReplayResult(fixture: ReplayFixture, result: ReplayRunResult): void {
  const expected = normalizeJson(fixture.expected as unknown as JsonObject, fixture.normalizers);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(`Replay fixture mismatch for ${fixture.contract_name}`);
  }
  if (JSON.stringify(result.fresh_state) !== JSON.stringify(result.restarted_state)) {
    throw new Error(`Replay fixture ${fixture.contract_name} did not preserve fresh/restart state equivalence.`);
  }
}

async function runProductionReplayFixture(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  switch (fixture.contract_name) {
    case "state_attention_schema_ahead_fail_closed":
      return runStateAttentionSchemaReplay(fixture, stateRoot);
    case "approval_pending_restored_after_daemon_restart":
      return runApprovalRestoreReplay(fixture, stateRoot);
    case "schedule_side_effect_crash_replay_no_duplicate_execution":
      return runScheduleCrashReplay(fixture, stateRoot);
    case "queue_expired_claim_rejects_late_ack_and_reclaims":
      return runQueueExpiredClaimReplay(fixture, stateRoot);
    case "attention_observation_requires_visible_indicator_before_event":
      return runAttentionObservationReplay(fixture, stateRoot);
    case "session_registry_dead_process_not_running":
      return runSessionRegistryReplay(fixture, stateRoot);
    case "gateway_routed_ingress_preserves_reply_target_after_restart":
      return runGatewayReplyTargetReplay(fixture, stateRoot);
    default:
      return runPendingReplayFixture(fixture, stateRoot);
  }
}

async function runStateAttentionSchemaReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = await runAttentionSchemaAheadSequence(fixture, path.join(stateRoot.runtimeRoot, "fresh"), path.join(stateRoot.controlDbBase, "fresh"));
  const restarted = await runAttentionSchemaAheadSequence(fixture, path.join(stateRoot.runtimeRoot, "restarted"), path.join(stateRoot.controlDbBase, "restarted"));
  return buildRealReplayResult(fixture, stateRoot, "schema_ahead", fresh, restarted, {
    fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
    startup_replay_path: "AttentionStateStore.ensureReady() control DB migration guard",
  });
}

async function runApprovalRestoreReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = await runApprovalRestoreSequence(fixture, path.join(stateRoot.runtimeRoot, "fresh"), path.join(stateRoot.controlDbBase, "fresh"));
  const restarted = await runApprovalRestoreSequence(fixture, path.join(stateRoot.runtimeRoot, "restarted"), path.join(stateRoot.controlDbBase, "restarted"));
  return buildRealReplayResult(fixture, stateRoot, "approval_restore", fresh, restarted, {
    fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
    startup_replay_path: "ApprovalBroker.start() restores pending approval rows from ApprovalStore",
  });
}

async function runScheduleCrashReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = await runScheduleCrashSequence(fixture, path.join(stateRoot.controlDbBase, "fresh"));
  const restarted = await runScheduleCrashSequence(fixture, path.join(stateRoot.controlDbBase, "restarted"));
  return buildRealReplayResult(fixture, stateRoot, "schedule_crash_replay", fresh, restarted, {
    fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
    startup_replay_path: "ScheduleEngine.loadEntries() then tick() across persisted schedule history",
  });
}

async function runAttentionObservationReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = await runAttentionObservationSequence(fixture, path.join(stateRoot.runtimeRoot, "fresh"), path.join(stateRoot.controlDbBase, "fresh"));
  const restarted = await runAttentionObservationSequence(fixture, path.join(stateRoot.runtimeRoot, "restarted"), path.join(stateRoot.controlDbBase, "restarted"));
  return buildRealReplayResult(fixture, stateRoot, "attention_observation_gate", fresh, restarted, {
    fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
    startup_replay_path: "AttentionStateStore pending block persisted and reloaded before observation event",
  });
}

async function runSessionRegistryReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = await runSessionRegistrySequence(fixture, path.join(stateRoot.root, "session-registry-fresh"), stateRoot.workspaceRoot);
  const restarted = await runSessionRegistrySequence(fixture, path.join(stateRoot.root, "session-registry-restarted"), stateRoot.workspaceRoot);
  return buildRealReplayResult(fixture, stateRoot, "session_registry_liveness", fresh, restarted, {
    fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
    startup_replay_path: "RuntimeSessionRegistry.snapshot() joins process snapshot and ledger after restart",
  });
}

async function runGatewayReplyTargetReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = await runGatewayReplyTargetSequence(fixture, path.join(stateRoot.root, "gateway-fresh"), stateRoot.workspaceRoot);
  const restarted = await runGatewayReplyTargetSequence(fixture, path.join(stateRoot.root, "gateway-restarted"), stateRoot.workspaceRoot);
  return buildRealReplayResult(fixture, stateRoot, "gateway_reply_target_restore", fresh, restarted, {
    fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
    startup_replay_path: "chat session state reload plus buildStandaloneIngressMessageFromContext reply target projection",
  });
}

async function runQueueExpiredClaimReplay(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const fresh = runQueueExpiredClaimSequence(fixture, path.join(stateRoot.runtimeRoot, "fresh"), false);
  const restarted = runQueueExpiredClaimSequence(fixture, path.join(stateRoot.runtimeRoot, "restarted"), true);
  const replayState: JsonObject = {
    assertions: {
      fresh: fresh.assertions,
      restarted: restarted.assertions,
      restarted_path_exercised: true,
    },
    contract_name: fixture.contract_name,
    reason: "queue_claim",
    runner: runnerExport(fixture, "real_production_path", artifactPathFor(fixture)),
    status: "reclaimed",
  };
  const artifact = await writeEvidenceArtifact(stateRoot, artifactPathFor(fixture), {
    contract_name: fixture.contract_name,
    domain: fixture.domain,
    fresh_state: replayState,
    initial_state_paths: Object.keys(fixture.initial_state).sort(),
    p0_failure_mode: fixture.p0_failure_mode,
    restarted_state: replayState,
  });

  return {
    audit: [
      {
        assertions: {
          fresh_restarted_equal: JSON.stringify(fresh.assertions) === JSON.stringify(restarted.assertions),
          startup_replay_path: "JournalBackedQueue constructor reload from persisted control DB",
        },
        disposition: "reclaimed",
        production_boundary: fixture.production_boundary,
        reason: "queue_claim",
        runner_status: "real_production_path",
      },
    ],
    artifact_tree: [artifact],
    fresh_state: replayState,
    restarted_state: replayState,
  };
}

async function runPendingReplayFixture(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
): Promise<ReplayRunResult> {
  const reason = pendingRunnerReason(fixture);
  const runner = runnerExport(fixture, "pending_real_runner", artifactPathFor(fixture), reason);
  const replayState: JsonObject = {
    contract_name: fixture.contract_name,
    initial_state_paths: Object.keys(fixture.initial_state).sort(),
    reason,
    runner,
    status: "pending_real_runner",
  };
  const artifact = await writeEvidenceArtifact(stateRoot, artifactPathFor(fixture), {
    contract_name: fixture.contract_name,
    domain: fixture.domain,
    initial_state_paths: Object.keys(fixture.initial_state).sort(),
    p0_failure_mode: fixture.p0_failure_mode,
    runner,
    status: "pending_real_runner",
  });
  return {
    audit: [
      {
        disposition: "pending_real_runner",
        pending_reason: reason,
        production_boundary: fixture.production_boundary,
        reason: "not_connected_to_startup_replay_boundary",
        runner_status: "pending_real_runner",
      },
    ],
    artifact_tree: [artifact],
    fresh_state: replayState,
    restarted_state: replayState,
  };
}

function runQueueExpiredClaimSequence(
  fixture: ReplayFixture,
  runtimeRoot: string,
  restartBeforeReplay: boolean,
): { assertions: JsonObject } {
  let now = Date.parse(fixture.input.fake_now);
  const envelope = makeEnvelope(fixture);
  const queue = new JournalBackedQueue({
    runtimeRoot,
    maxAttempts: 2,
    now: () => now,
  });
  const accepted = queue.accept(envelope);
  const claim = queue.claim("worker-a", 100);
  if (!claim) throw new Error(`${fixture.contract_name} did not create an initial replay queue claim.`);

  now += 200;
  const replayQueue = restartBeforeReplay
    ? new JournalBackedQueue({ runtimeRoot, maxAttempts: 2, now: () => now })
    : queue;
  const lateAckAccepted = replayQueue.ack(claim.claimToken);
  const sweep = replayQueue.sweepExpiredClaims(now);
  const snapshot = stabilizeQueueSnapshot(replayQueue.snapshot());

  return {
    assertions: {
      accepted,
      late_ack_accepted: lateAckAccepted,
      post_replay_snapshot: snapshot,
      sweep_result: {
        deadlettered: sweep.deadlettered,
        expired_claim_token_count: sweep.expiredClaimTokens.length,
        reclaimed: sweep.reclaimed,
      },
    },
  };
}

async function runAttentionSchemaAheadSequence(
  fixture: ReplayFixture,
  runtimeRoot: string,
  controlBaseDir: string,
): Promise<{ assertions: JsonObject; status: string }> {
  const dbPath = path.join(controlBaseDir, "pulseed-control.sqlite");
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("user_version = 999");
  db.close();
  const store = new AttentionStateStore(runtimeRoot, { controlBaseDir });
  let blocked = false;
  let message = "";
  try {
    await store.ensureReady();
  } catch (error) {
    blocked = true;
    message = error instanceof Error ? error.message : String(error);
  }
  return {
    status: blocked ? "blocked" : "not_blocked",
    assertions: {
      fail_closed: blocked,
      message_contains_newer_schema: message.includes("newer than supported version"),
    },
  };
}

async function runApprovalRestoreSequence(
  fixture: ReplayFixture,
  runtimeRoot: string,
  controlBaseDir: string,
): Promise<{ assertions: JsonObject; status: string }> {
  const store = new ApprovalStore(runtimeRoot, { controlBaseDir });
  const origin = {
    channel: "telegram",
    conversation_id: "approval-chat",
    user_id: "operator",
    session_id: "session:approval",
    turn_id: "turn:approval",
  };
  const events: JsonObject[] = [];
  const broker = new ApprovalBroker({
    store,
    now: () => Date.parse(fixture.input.fake_now),
    broadcast: (eventType, data) => events.push({ event_type: eventType, data: sanitizeUnknown(data) }),
    deliverConversationalApproval: () => ({ delivered: true }),
  });
  const pending = broker.requestConversationalApproval("goal-approval", approvalTaskFor(fixture.contract_name), {
    approvalId: `approval-${fixture.contract_name}`,
    origin,
  });
  void pending.catch(() => undefined);
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
  await restarted.stop();
  return {
    status: resolved ? "restored" : "not_restored",
    assertions: {
      pending_restored_event_count: restoredEvents.filter((event) => event.event_type === "approval_required").length,
      resolved,
      resolved_state: (await store.loadResolved(`approval-${fixture.contract_name}`))?.state ?? null,
    },
  };
}

async function runScheduleCrashSequence(
  fixture: ReplayFixture,
  controlBaseDir: string,
): Promise<{ assertions: JsonObject; status: string }> {
  const engine = new ScheduleEngine({ baseDir: controlBaseDir });
  const entry = await engine.addEntry(makeWaitResumeScheduleInput(fixture.contract_name));
  const dueAt = "2026-05-12T00:00:00.000Z";
  engine.getEntries()[0]!.next_fire_at = dueAt;
  await engine.saveEntries();
  await engine.loadEntries();
  const firstResults = await engine.tick();
  await engine.loadEntries();
  const secondResults = await engine.tick();
  const history = await engine.getRecentHistory(10, entry.id);
  return {
    status: "idempotent",
    assertions: {
      first_result_count: firstResults.length,
      history_count: history.length,
      no_duplicate_execution: secondResults.length === 0 || history.length === 1,
      second_result_count: secondResults.length,
    },
  };
}

async function runAttentionObservationSequence(
  fixture: ReplayFixture,
  runtimeRoot: string,
  controlBaseDir: string,
): Promise<{ assertions: JsonObject; status: string }> {
  const store = new AttentionStateStore(runtimeRoot, { controlBaseDir });
  await store.ensureReady();
  await store.addPendingBlock({
    scope: attentionScopeFor(fixture.contract_name),
    triggerKind: "observation",
    reason: "visible indicator required before non-terminal observation event",
    createdAt: fixture.input.fake_now,
  });
  const restarted = new AttentionStateStore(runtimeRoot, { controlBaseDir });
  const pendingBlocks = await restarted.listPendingBlocks(attentionScopeFor(fixture.contract_name));
  return {
    status: pendingBlocks.length > 0 ? "blocked" : "not_blocked",
    assertions: {
      pending_block_count: pendingBlocks.length,
      visible_indicator_required: pendingBlocks.some((block) => block.trigger_kind === "observation"),
    },
  };
}

async function runSessionRegistrySequence(
  fixture: ReplayFixture,
  baseDir: string,
  workspaceRoot: string,
): Promise<{ assertions: JsonObject; status: string }> {
  const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
  await stateManager.writeRaw("runtime/process-sessions/proc-stale-ledger.json", {
    session_id: "proc-stale-ledger",
    label: "stale ledger process",
    command: "node",
    args: ["worker.js"],
    cwd: workspaceRoot,
    pid: 999_999,
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
    workspace: workspaceRoot,
    created_at: fixture.input.fake_now,
    started_at: fixture.input.fake_now,
    status: "running",
  });
  const snapshot = await new RuntimeSessionRegistry({ stateManager, isPidAlive: () => false }).snapshot();
  const run = snapshot.background_runs.find((candidate) => candidate.id === "run:process:proc-stale-ledger");
  return {
    status: run?.status === "lost" ? "blocked" : run?.status ?? "missing",
    assertions: {
      dead_process_warning: snapshot.warnings.some((warning) => warning.code === "dead_process_sidecar"),
      projected_status: run?.status ?? null,
      running_reported: run?.status === "running",
    },
  };
}

async function runGatewayReplyTargetSequence(
  fixture: ReplayFixture,
  baseDir: string,
  workspaceRoot: string,
): Promise<{ assertions: JsonObject; status: string }> {
  const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
  const replyTarget = {
    surface: "gateway" as const,
    channel: "plugin_gateway" as const,
    platform: "telegram",
    conversation_id: "conversation:gateway-restart",
    message_id: "msg-gateway-restart",
    identity_key: "operator",
    user_id: "operator",
  };
  await new ChatSessionDataStore(baseDir).save({
    id: "gateway-restart",
    cwd: workspaceRoot,
    createdAt: fixture.input.fake_now,
    updatedAt: fixture.input.fake_now,
    title: "Gateway restart",
    messages: [],
    notificationReplyTarget: {
      channel: "plugin_gateway",
      target_id: "conversation:gateway-restart",
      thread_id: "msg-gateway-restart",
      metadata: replyTarget,
    },
  });
  const restored = await new ChatSessionCatalog(stateManager).loadSession("gateway-restart");
  const ingress = buildStandaloneIngressMessageFromContext("continue", {
    replyTarget,
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
    runtimeReplyTarget: replyTarget,
  });
  return {
    status: ingress.replyTarget.conversation_id === "conversation:gateway-restart" ? "restored" : "missing",
    assertions: {
      ingress_conversation_id: ingress.replyTarget.conversation_id,
      reply_target_preserved: ingress.replyTarget.conversation_id === "conversation:gateway-restart",
      session_reloaded: restored?.id === "gateway-restart",
    },
  };
}

async function buildRealReplayResult(
  fixture: ReplayFixture,
  stateRoot: IsolatedStateRoot,
  reason: string,
  fresh: { assertions: JsonObject; status: string },
  restarted: { assertions: JsonObject; status: string },
  auditAssertions: JsonObject,
): Promise<ReplayRunResult> {
  const replayState: JsonObject = {
    assertions: fresh.assertions,
    contract_name: fixture.contract_name,
    initial_state_paths: Object.keys(fixture.initial_state).sort(),
    reason,
    runner: runnerExport(fixture, "real_production_path", artifactPathFor(fixture)),
    status: fresh.status,
  };
  const restartedState: JsonObject = {
    ...replayState,
    assertions: restarted.assertions,
    status: restarted.status,
  };
  const artifact = await writeEvidenceArtifact(stateRoot, artifactPathFor(fixture), {
    contract_name: fixture.contract_name,
    domain: fixture.domain,
    fresh_state: replayState,
    initial_state_paths: Object.keys(fixture.initial_state).sort(),
    p0_failure_mode: fixture.p0_failure_mode,
    restarted_state: restartedState,
  });
  return {
    audit: [
      {
        assertions: auditAssertions,
        disposition: fresh.status,
        production_boundary: fixture.production_boundary,
        reason,
        runner_status: "real_production_path",
      },
    ],
    artifact_tree: [artifact],
    fresh_state: replayState,
    restarted_state: restartedState,
  };
}

function runnerExport(
  fixture: ReplayFixture,
  status: "real_production_path" | "pending_real_runner",
  artifactPath: string,
  pendingReason?: string,
): JsonObject {
  return pruneUndefined({
    exported_state_artifact: artifactPath,
    pending_reason: pendingReason,
    production_entrypoint: fixture.production_boundary,
    same_checkout_pass_command: "npm run test:replay",
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

function artifactPathFor(fixture: ReplayFixture): string {
  return `state/${fixture.domain}/${fixture.contract_name}.json`;
}

function makeEnvelope(fixture: ReplayFixture): Envelope {
  return {
    created_at: Date.parse(fixture.input.fake_now),
    id: `${fixture.contract_name}:expired-claim`,
    name: "job",
    payload: { contract_name: fixture.contract_name },
    priority: "normal",
    source: "replay-runner",
    type: "command",
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

function approvalTaskFor(contractName: string): PendingPermissionTask {
  return createPendingPermissionTask({
    id: `task-${contractName}`,
    description: `Approval contract ${contractName}`,
    action: "continue",
    target: {
      tool_id: "file_write",
      tool_call_id: `call-${contractName}`,
    },
    stateEpoch: "1700.2",
    waitPlanId: `wait-${contractName}`,
    permissionLevel: "read_only",
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

function sanitizeUnknown(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: value === undefined ? null : String(value) };
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function pendingRunnerReason(fixture: ReplayFixture): string {
  return `No startup/replay/migration runner is wired to ${fixture.production_boundary}; this fixture is not deletion-gate evidence.`;
}

function pruneUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonObject;
}
