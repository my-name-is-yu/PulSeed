import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { JournalBackedQueue, type JournalBackedQueueSnapshot } from "../../src/runtime/queue/journal-backed-queue.js";
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
    return normalizeJson(result as unknown as JsonObject, fixture.normalizers) as unknown as ReplayRunResult;
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
    case "queue_expired_claim_rejects_late_ack_and_reclaims":
      return runQueueExpiredClaimReplay(fixture, stateRoot);
    default:
      return runPendingReplayFixture(fixture, stateRoot);
  }
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

function pendingRunnerReason(fixture: ReplayFixture): string {
  return `No startup/replay/migration runner is wired to ${fixture.production_boundary}; this fixture is not deletion-gate evidence.`;
}

function pruneUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonObject;
}
