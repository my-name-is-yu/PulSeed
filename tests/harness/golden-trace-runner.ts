import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { JournalBackedQueue, type JournalBackedQueueSnapshot } from "../../src/runtime/queue/journal-backed-queue.js";
import type { Envelope, EnvelopePriority, EnvelopeType } from "../../src/runtime/types/envelope.js";
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
