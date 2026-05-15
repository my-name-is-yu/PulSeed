import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { ApprovalStore, OutboxStore, RuntimeHealthStore, ProactiveInterventionStore, createRuntimeStorePaths } from "../store/index.js";
import { ApprovalRecordSchema, OutboxRecordSchema } from "../store/runtime-schemas.js";
import { runRuntimeStoreMaintenanceCycle } from "../daemon/maintenance.js";

describe("runRuntimeStoreMaintenanceCycle", () => {
  let runtimeRoot: string;
  let paths = createRuntimeStorePaths();
  let approvalStore: ApprovalStore;
  let outboxStore: OutboxStore;
  let healthStore: RuntimeHealthStore;

  beforeEach(() => {
    runtimeRoot = makeTempDir("pulseed-runtime-maintenance-");
    paths = createRuntimeStorePaths(runtimeRoot);
    approvalStore = new ApprovalStore(paths);
    outboxStore = new OutboxStore(paths);
    healthStore = new RuntimeHealthStore(paths);
  });

  afterEach(() => {
    cleanupTempDir(runtimeRoot);
  });

  function logger() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("reconciles expired approvals, preserves DB uniqueness, and prunes old resolved approvals", async () => {
    const expiredPending = ApprovalRecordSchema.parse({
      approval_id: "approval-expired",
      goal_id: "goal-1",
      request_envelope_id: "msg-1",
      correlation_id: "corr-1",
      state: "pending",
      created_at: 1,
      expires_at: 2,
      payload: { note: "expired" },
    });
    const duplicatePending = ApprovalRecordSchema.parse({
      approval_id: "approval-duplicate",
      goal_id: "goal-2",
      request_envelope_id: "msg-2",
      correlation_id: "corr-2",
      state: "pending",
      created_at: 3,
      expires_at: 10_000,
      payload: { note: "duplicate" },
    });
    const oldResolved = ApprovalRecordSchema.parse({
      approval_id: "approval-old",
      goal_id: "goal-3",
      request_envelope_id: "msg-3",
      correlation_id: "corr-3",
      state: "approved",
      created_at: 4,
      expires_at: 5,
      resolved_at: 6,
      payload: { note: "old" },
    });

    await approvalStore.savePending(expiredPending);
    await approvalStore.savePending(duplicatePending);
    await approvalStore.saveResolved({ ...duplicatePending, state: "approved", resolved_at: 9_900 });
    await approvalStore.saveResolved(oldResolved);

    const report = await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore,
      outboxStore,
      runtimeHealthStore: healthStore,
      logger: logger(),
      now: 10_000,
      options: {
        approvalRetentionMs: 500,
      },
    });

    expect(report.approvals.removedPending).toBe(0);
    expect(report.approvals.expiredPending).toBe(1);
    expect(report.approvals.prunedResolved).toBe(1);
    expect(await approvalStore.loadPending("approval-expired")).toBeNull();
    expect(await approvalStore.loadResolved("approval-expired")).toMatchObject({ state: "expired" });
    expect(await approvalStore.loadPending("approval-duplicate")).toBeNull();
    expect(await approvalStore.loadResolved("approval-duplicate")).toMatchObject({ state: "approved" });
    expect(await approvalStore.loadResolved("approval-old")).toBeNull();
  });

  it("prunes outbox history by age and count", async () => {
    for (let seq = 1; seq <= 6; seq += 1) {
      await outboxStore.save(OutboxRecordSchema.parse({
        seq,
        event_type: `event-${seq}`,
        goal_id: "goal-1",
        correlation_id: `corr-${seq}`,
        created_at: seq,
        payload: { seq },
      }), { boundary: "test_seed" });
    }

    const report = await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore,
      outboxStore,
      runtimeHealthStore: healthStore,
      logger: logger(),
      now: 10_000,
      options: {
        outboxRetentionMs: 24 * 60 * 60 * 1000,
        outboxMaxRecords: 3,
      },
    });

    expect(report.outbox.pruned).toBe(3);
    expect((await outboxStore.list()).map((record) => record.seq)).toEqual([4, 5, 6]);
  });

  it("repairs partial health snapshots into a loadable pair", async () => {
    await healthStore.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: 1,
      details: { phase: "startup" },
    });

    const report = await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore,
      outboxStore,
      runtimeHealthStore: healthStore,
      logger: logger(),
      now: 10_000,
    });

    expect(report.health.repaired).toBe(true);
    expect(await healthStore.loadSnapshot()).not.toBeNull();
    expect(await healthStore.loadComponentsHealth()).not.toBeNull();
  });

  it("includes proactive intervention quality in runtime health details", async () => {
    const interventionStore = new ProactiveInterventionStore(paths);
    await interventionStore.appendIntervention({
      activity: {
        intervention_id: "health-proactive-1",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Suggested a goal.",
        recorded_at: "2026-05-02T00:00:00.000Z",
      },
    });
    await interventionStore.appendFeedback({
      interventionId: "health-proactive-1",
      outcome: "corrected",
      recordedAt: "2026-05-02T00:01:00.000Z",
    });

    await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore,
      outboxStore,
      runtimeHealthStore: healthStore,
      logger: logger(),
      now: 10_000,
    });

    const snapshot = await healthStore.loadSnapshot();
    expect(snapshot?.details?.proactive_interventions).toMatchObject({
      total_interventions: 1,
      corrected_count: 1,
    });
  });

  it("prunes stale claim artifacts from the runtime claims directory", async () => {
    await fs.promises.mkdir(paths.claimsDir, { recursive: true });
    const stalePath = path.join(paths.claimsDir, "stale-claim.json");
    const freshPath = path.join(paths.claimsDir, "fresh-claim.json");
    await fs.promises.writeFile(stalePath, "{}");
    await fs.promises.writeFile(freshPath, "{}");
    const staleTime = new Date("2020-01-01T00:00:00.000Z");
    const freshTime = new Date("2026-04-10T00:00:00.000Z");
    await fs.promises.utimes(stalePath, staleTime, staleTime);
    await fs.promises.utimes(freshPath, freshTime, freshTime);

    const report = await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore,
      outboxStore,
      runtimeHealthStore: healthStore,
      logger: logger(),
      now: new Date("2026-04-10T12:00:00.000Z").getTime(),
      options: {
        claimRetentionMs: 24 * 60 * 60 * 1000,
      },
    });

    expect(report.claims.pruned).toBe(1);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(freshPath)).toBe(true);
  });
});
