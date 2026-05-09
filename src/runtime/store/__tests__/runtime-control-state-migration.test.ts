import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { GuardrailStore } from "../../guardrails/guardrail-store.js";
import { GoalLeaseManager } from "../../goal-lease-manager.js";
import { LeaderLockManager, LeaderLockRecordSchema } from "../../leader-lock-manager.js";
import {
  ApprovalStore,
  createRuntimeStorePaths,
  importLegacyRuntimeControlStateStores,
  openControlDatabase,
  OutboxStore,
  saveRuntimeJson,
} from "../index.js";
import {
  ApprovalRecordSchema,
  BackpressureSnapshotSchema,
  CircuitBreakerRecordSchema,
  GoalLeaseRecordSchema,
  OutboxRecordSchema,
  RuntimeSafePauseRecordSchema,
} from "../runtime-schemas.js";
import {
  PermissionGrantRecordSchema,
  PermissionGrantStore,
} from "../permission-grant-store.js";
import {
  PermissionWaitPlanRecordSchema,
  PermissionWaitPlanStore,
  type PermissionWaitCanonicalPlan,
} from "../permission-wait-plan-store.js";
import { RuntimeSafePauseStore } from "../safe-pause-store.js";

describe("importLegacyRuntimeControlStateStores", () => {
  let tmpDir: string;
  let runtimeRoot: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-runtime-state-store-migration-");
    runtimeRoot = path.join(tmpDir, "runtime");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("imports legacy runtime state JSON into SQLite without enabling normal fallback reads", async () => {
    const paths = createRuntimeStorePaths(runtimeRoot);
    const approval = ApprovalRecordSchema.parse({
      approval_id: "approval-legacy",
      goal_id: "goal-1",
      request_envelope_id: "msg-1",
      correlation_id: "corr-1",
      state: "pending",
      created_at: 1_000,
      expires_at: 2_000,
      payload: { prompt: "approve?" },
    });
    const grant = makePermissionGrant();
    const waitPlan = makePermissionWaitPlan();
    const outboxRecord = OutboxRecordSchema.parse({
      seq: 1,
      event_type: "goal_updated",
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: 1_001,
      payload: { state: "paused" },
    });
    const safePause = RuntimeSafePauseRecordSchema.parse({
      schema_version: "runtime-safe-pause-v1",
      goal_id: "goal-1",
      state: "paused",
      requested_at: "2026-05-09T00:00:00.000Z",
      paused_at: "2026-05-09T00:01:00.000Z",
      updated_at: "2026-05-09T00:01:00.000Z",
      checkpoint: {
        checkpoint_id: "checkpoint-legacy",
        checkpointed_at: "2026-05-09T00:01:00.000Z",
        active_goals: ["goal-1"],
        queued_goal_ids: ["goal-1"],
        current_mode: "running",
        candidate_evidence_refs: [],
        artifact_refs: [],
        next_action: "resume",
        supervisor_state_ref: null,
        background_run_ids: [],
      },
    });
    const breaker = CircuitBreakerRecordSchema.parse({
      key: "browser::example.com",
      provider_id: "browser",
      service_key: "example.com",
      state: "open",
      failure_count: 2,
      last_failure_code: "provider_unavailable",
      last_failure_message: null,
      last_failure_at: "2026-05-09T00:00:00.000Z",
      opened_at: "2026-05-09T00:00:00.000Z",
      cooldown_until: "2026-05-09T00:05:00.000Z",
      updated_at: "2026-05-09T00:00:00.000Z",
    });
    const backpressure = BackpressureSnapshotSchema.parse({
      updated_at: "2026-05-09T00:00:00.000Z",
      active: [{
        provider_id: "browser",
        service_key: "example.com",
        run_key: "run-1",
        acquired_at: "2026-05-09T00:00:00.000Z",
      }],
      throttled: [],
    });
    const leader = {
      owner_token: "leader-legacy",
      pid: process.pid,
      acquired_at: 1_000,
      last_renewed_at: 1_000,
      lease_until: 2_000,
    };
    const lease = GoalLeaseRecordSchema.parse({
      goal_id: "goal-1",
      owner_token: "lease-legacy",
      attempt_id: "attempt-1",
      worker_id: "worker-1",
      acquired_at: 1_000,
      last_renewed_at: 1_000,
      lease_until: 2_000,
    });

    await saveRuntimeJson(paths.approvalPendingPath(approval.approval_id), ApprovalRecordSchema, approval);
    await saveRuntimeJson(paths.permissionGrantPath(grant.grant_id), PermissionGrantRecordSchema, grant);
    await saveRuntimeJson(paths.permissionWaitPlanPath(waitPlan.wait_plan_id), PermissionWaitPlanRecordSchema, waitPlan);
    await saveRuntimeJson(paths.outboxRecordPath(outboxRecord.seq), OutboxRecordSchema, outboxRecord);
    await saveRuntimeJson(paths.safePausePath(safePause.goal_id), RuntimeSafePauseRecordSchema, safePause);
    await saveRuntimeJson(paths.guardrailBreakerPath(breaker.key), CircuitBreakerRecordSchema, breaker);
    await saveRuntimeJson(paths.backpressureSnapshotPath, BackpressureSnapshotSchema, backpressure);
    await saveRuntimeJson(paths.leaderPath, LeaderLockRecordSchema, leader);
    await saveRuntimeJson(paths.goalLeasePath(lease.goal_id), GoalLeaseRecordSchema, lease);

    await expect(new ApprovalStore(runtimeRoot).loadPending(approval.approval_id)).resolves.toBeNull();
    await expect(new PermissionGrantStore(runtimeRoot).load(grant.grant_id)).resolves.toBeNull();
    await expect(new PermissionWaitPlanStore(runtimeRoot).load(waitPlan.wait_plan_id)).resolves.toBeNull();
    await expect(new OutboxStore(runtimeRoot).load(outboxRecord.seq)).resolves.toBeNull();
    await expect(new RuntimeSafePauseStore(runtimeRoot).load(safePause.goal_id)).resolves.toBeNull();
    await expect(new GuardrailStore(runtimeRoot).loadBreaker(breaker.key)).resolves.toBeNull();
    await expect(new GuardrailStore(runtimeRoot).loadBackpressureSnapshot()).resolves.toBeNull();
    await expect(new LeaderLockManager(runtimeRoot).read()).resolves.toBeNull();
    await expect(new GoalLeaseManager(runtimeRoot).read(lease.goal_id)).resolves.toBeNull();

    const result = await importLegacyRuntimeControlStateStores({
      runtimeRootOrPaths: runtimeRoot,
      importedAt: "2026-05-09T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      approvals: { pending: 1, resolved: 0 },
      permissionGrants: 1,
      permissionWaitPlans: 1,
      outboxRecords: 1,
      safePauses: 1,
      guardrailBreakers: 1,
      backpressureSnapshots: 1,
      leaderLocks: 1,
      goalLeases: 1,
    });
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);

    await expect(new ApprovalStore(runtimeRoot).loadPending(approval.approval_id))
      .resolves.toMatchObject({ approval_id: approval.approval_id, state: "pending" });
    await expect(new PermissionGrantStore(runtimeRoot).load(grant.grant_id))
      .resolves.toMatchObject({ grant_id: grant.grant_id, state: "active" });
    await expect(new PermissionWaitPlanStore(runtimeRoot).load(waitPlan.wait_plan_id))
      .resolves.toMatchObject({ wait_plan_id: waitPlan.wait_plan_id, state: "waiting_for_permission" });
    await expect(new OutboxStore(runtimeRoot).load(outboxRecord.seq))
      .resolves.toMatchObject({ seq: outboxRecord.seq, event_type: outboxRecord.event_type });
    await expect(new RuntimeSafePauseStore(runtimeRoot).load(safePause.goal_id))
      .resolves.toMatchObject({ goal_id: safePause.goal_id, state: "paused" });
    await expect(new GuardrailStore(runtimeRoot).loadBreaker(breaker.key))
      .resolves.toMatchObject({ key: breaker.key, state: "open" });
    await expect(new GuardrailStore(runtimeRoot).loadBackpressureSnapshot())
      .resolves.toMatchObject({ active: [{ provider_id: "browser", service_key: "example.com" }] });
    await expect(new LeaderLockManager(runtimeRoot).read())
      .resolves.toMatchObject({ owner_token: leader.owner_token });
    await expect(new GoalLeaseManager(runtimeRoot).read(lease.goal_id))
      .resolves.toMatchObject({ goal_id: lease.goal_id, owner_token: lease.owner_token });

    expect(result.legacyImports.map((record) => record.source_kind)).toEqual([
      "approval-json",
      "approval-json",
      "permission-grant-json",
      "permission-wait-plan-json",
      "outbox-json",
      "safe-pause-json",
      "guardrail-breaker-json",
      "guardrail-backpressure-json",
      "leader-lock-json",
      "goal-lease-json",
    ]);
  });

  it("records idempotent import bookkeeping for runtime state sources", async () => {
    const paths = createRuntimeStorePaths(runtimeRoot);
    const approval = ApprovalRecordSchema.parse({
      approval_id: "approval-idempotent",
      request_envelope_id: "msg-1",
      correlation_id: "corr-1",
      state: "pending",
      created_at: 1_000,
      expires_at: 2_000,
      payload: { prompt: "approve?" },
    });

    await saveRuntimeJson(paths.approvalPendingPath(approval.approval_id), ApprovalRecordSchema, approval);

    await importLegacyRuntimeControlStateStores({ runtimeRootOrPaths: runtimeRoot });
    await importLegacyRuntimeControlStateStores({ runtimeRootOrPaths: runtimeRoot });

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      const imports = controlDb.listLegacyImports();
      expect(imports.map((record) => record.source_id).sort()).toEqual([
        "approvals:pending",
        "approvals:resolved",
        "permission-grants",
        "permission-wait-plans",
        "outbox",
        "safe-pauses",
        "guardrail-breakers",
        "guardrail-backpressure",
        "leader-lock",
        "goal-leases",
      ].sort());
      expect(imports.find((record) => record.source_id === "approvals:pending")?.details)
        .toEqual({ row_count: 1 });
    } finally {
      controlDb.close();
    }

    await expect(new ApprovalStore(runtimeRoot).listPending()).resolves.toHaveLength(1);
  });
});

function makeCanonicalPlan(): PermissionWaitCanonicalPlan {
  return {
    schema_version: "permission-wait-canonical-plan-v1",
    tool_name: "shell",
    input: { command: "npm test", cwd: "." },
    cwd: "/repo",
    command: "npm test",
    target: {
      goal_id: "goal-1",
      run_id: "run-1",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_call_id: "call-1",
    },
    permission: {
      permission_level: "execute",
      is_destructive: false,
      reversibility: "reversible",
    },
    state_epoch: "epoch-1",
    capability_facts: {
      tool_permission_level: "execute",
      tool_is_read_only: false,
      tool_is_destructive: false,
      tool_activity_category: "test",
      tool_tags: ["shell"],
      host_decision_status: "needs_permission",
      host_decision_reason: "Host policy requires permission.",
    },
  };
}

function makePermissionGrant() {
  return PermissionGrantRecordSchema.parse({
    schema_version: "permission-grant-v1",
    grant_id: "grant-legacy",
    subject: { kind: "user", id: "user-1" },
    origin: {
      channel: "chat",
      platform: "local",
      conversation_id: "conversation-1",
      user_id: "user-1",
      session_id: "session-1",
    },
    source: {
      kind: "redacted_text",
      redacted_text: "[redacted] approved local edits and tests",
    },
    scope: { kind: "run", run_id: "run-1", goal_id: "goal-1" },
    duration: { kind: "until_run_done" },
    capabilities: ["write_workspace", "run_tests"],
    state: "active",
    state_version: 0,
    state_epoch: 1_000,
    created_at: 1_000,
    updated_at: 1_000,
    activated_at: 1_000,
    usage_count: 0,
    audit_refs: ["audit:legacy"],
  });
}

function makePermissionWaitPlan() {
  return PermissionWaitPlanRecordSchema.parse({
    schema_version: "permission-wait-plan-v1",
    wait_plan_id: "wait-legacy",
    approval_id: "approval-legacy",
    goal_id: "goal-1",
    state: "waiting_for_permission",
    created_at: 1_000,
    updated_at: 1_000,
    canonical_plan: makeCanonicalPlan(),
    audit_refs: ["audit:legacy"],
    audit_events: [{
      event_id: "event-legacy",
      state: "waiting_for_permission",
      created_at: 1_000,
      reason: "approval_required",
    }],
  });
}
