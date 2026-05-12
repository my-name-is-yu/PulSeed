import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  runAttentionCycle,
  sourceRef,
} from "../index.js";
import { AttentionStateStore } from "../../store/attention-state-store.js";
import type { AttentionScope } from "../../types/companion-autonomy.js";

const NOW = "2026-05-12T01:00:00.000Z";

function scope(overrides: Partial<AttentionScope> = {}): AttentionScope {
  return {
    userId: "user-cycle",
    identityId: "identity-cycle",
    workspaceId: "workspace-cycle",
    conversationId: "conversation-cycle",
    sessionId: "session-cycle",
    surfaceClass: "daemon",
    surfaceRef: "surface:daemon",
    permissionScope: "local_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: "policy:cycle",
    ...overrides,
  };
}

describe("attention cycle persistence and concurrency", () => {
  it("uses projection revision CAS and idempotency to prevent duplicate admission candidates", async () => {
    const tmpDir = makeTempDir("pulseed-attention-cycle-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const baseCycle = {
        now: NOW,
        trigger: "maintenance" as const,
        scope: scope(),
        signalRefs: [sourceRef("runtime_event", "runtime:cycle")],
        sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "1" }],
        expectedProjectionRevision: 0,
        cycleIdempotencyKey: "cycle:maintenance:1",
        policyEpoch: "policy:cycle",
        mode: "live" as const,
      };

      const first = await runAttentionCycle({ store, cycle: baseCycle });
      const duplicate = await runAttentionCycle({ store, cycle: baseCycle });
      const stale = await runAttentionCycle({
        store,
        cycle: {
          ...baseCycle,
          cycleIdempotencyKey: "cycle:maintenance:stale",
          expectedProjectionRevision: 0,
        },
      });
      const state = await store.loadConcernState();

      expect(first.writeDisposition).toBe("written");
      expect(first.projectionRevision).toBe(1);
      expect(duplicate.writeDisposition).toBe("no_op_elided");
      expect(duplicate.admissionCandidates).toEqual([]);
      expect(stale.writeDisposition).toBe("stale_rejected");
      expect(stale.admissionCandidates).toEqual([]);
      expect(state.clusters).toHaveLength(1);
      expect(state.decompositions[0]?.children.length).toBeLessThanOrEqual(3);
      expect(first.admissionCandidates.length).toBeGreaterThan(0);
      const proposals = await store.listAdmissionProposals({ states: ["proposed"] });
      expect(proposals).toHaveLength(first.admissionCandidates.length);
      await store.markAdmissionProposalState({
        proposalId: proposals[0]!.proposal_id,
        state: "pending_handoff",
        runtimeOperationId: "runtime-operation:attention-test",
        updatedAt: "2026-05-12T01:01:00.000Z",
      });
      await expect(store.reconcileAdmissionProposals({
        orphanBefore: "2026-05-12T01:02:00.000Z",
        updatedAt: "2026-05-12T01:03:00.000Z",
      })).resolves.toMatchObject({
        orphaned_count: 1,
        proposal_ids: [proposals[0]!.proposal_id],
      });
      await expect(store.listAdmissionProposals({ states: ["orphaned_needs_reconcile"] })).resolves.toHaveLength(1);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("keeps one scoped cycle from rewriting or admitting another scope", async () => {
    const tmpDir = makeTempDir("pulseed-attention-cycle-scope-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const leftScope = scope({ sessionId: "session-left", surfaceRef: "surface:left" });
      const rightScope = scope({ sessionId: "session-right", surfaceRef: "surface:right" });
      const left = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: leftScope,
          signalRefs: [sourceRef("runtime_event", "runtime:left")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "left:1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:shared-idempotency:1",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });
      const right = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: rightScope,
          signalRefs: [sourceRef("runtime_event", "runtime:right")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "right:1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:shared-idempotency:1",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });
      const leftAgain = await runAttentionCycle({
        store,
        cycle: {
          now: "2026-05-12T01:05:00.000Z",
          trigger: "maintenance",
          scope: leftScope,
          signalRefs: [sourceRef("runtime_event", "runtime:left:2")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "left:2" }],
          expectedProjectionRevision: left.projectionRevision,
          cycleIdempotencyKey: "cycle:left:2",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });

      expect(left.writeDisposition).toBe("written");
      expect(right.writeDisposition).toBe("written");
      expect(leftAgain.writeDisposition).toBe("written");
      expect(leftAgain.clusterUpdates.every((update) =>
        update.clusterRef.includes("session-right")
      )).toBe(false);
      await expect(store.loadConcernState({ scope: leftScope })).resolves.toMatchObject({
        clusters: expect.arrayContaining([
          expect.objectContaining({ scope: expect.objectContaining({ sessionId: "session-left" }) }),
        ]),
      });
      await expect(store.loadConcernState({ scope: rightScope })).resolves.toMatchObject({
        clusters: [
          expect.objectContaining({ scope: expect.objectContaining({ sessionId: "session-right" }) }),
        ],
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("closes confirmed proposals and clears stale runtime operations on re-upsert", async () => {
    const tmpDir = makeTempDir("pulseed-attention-proposal-lifecycle-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const first = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: scope(),
          signalRefs: [sourceRef("runtime_event", "runtime:proposal")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "proposal:1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:proposal:1",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });
      const [proposal] = await store.listAdmissionProposals({ states: ["proposed"] });
      expect(proposal).toBeDefined();

      await store.markAdmissionProposalState({
        proposalId: proposal!.proposal_id,
        state: "pending_handoff",
        runtimeOperationId: "runtime-operation:stale",
        updatedAt: "2026-05-12T01:01:00.000Z",
      });
      await expect(store.listAdmissionProposals({ states: ["pending_handoff"] })).resolves.toEqual([
        expect.objectContaining({
          proposal_id: proposal!.proposal_id,
          proposal: expect.objectContaining({ proposalState: "pending_handoff" }),
          runtime_operation_id: "runtime-operation:stale",
        }),
      ]);
      await store.saveMetabolismCycle({
        cycle_id: "attention-cycle:proposal-reupsert",
        idempotency_key: "cycle:proposal-reupsert",
        trigger_kind: "maintenance",
        scope: scope(),
        expected_projection_revision: first.projectionRevision,
        source_high_watermarks: ["runtime_event:proposal:2"],
        clusters: [],
        agendaItems: [],
        decompositions: [],
        admissionProposals: [{ ...proposal!.proposal, proposalState: "proposed" }],
        events: [],
        result: { reprojected: true },
        created_at: "2026-05-12T01:02:00.000Z",
      });

      await expect(store.listAdmissionProposals({ states: ["proposed"] })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          proposal_id: proposal!.proposal_id,
          runtime_operation_id: null,
        }),
      ]));

      await store.markAdmissionProposalState({
        proposalId: proposal!.proposal_id,
        state: "confirmed",
        runtimeOperationId: "runtime-operation:confirmed",
        updatedAt: "2026-05-12T01:03:00.000Z",
      });
      await store.markAdmissionProposalState({
        proposalId: proposal!.proposal_id,
        state: "terminal",
        updatedAt: "2026-05-12T01:04:00.000Z",
      });
      await store.markAdmissionProposalState({
        proposalId: proposal!.proposal_id,
        state: "proposed",
        updatedAt: "2026-05-12T01:05:00.000Z",
      });

      await expect(store.listAdmissionProposals({ states: ["terminal"] })).resolves.toEqual([
        expect.objectContaining({
          proposal_id: proposal!.proposal_id,
          proposal: expect.objectContaining({ proposalState: "terminal" }),
          runtime_operation_id: "runtime-operation:confirmed",
        }),
      ]);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("partitions cycle idempotency by authority, sensitivity, and memory owner", async () => {
    const tmpDir = makeTempDir("pulseed-attention-cycle-scope-key-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const readOnlyScope = scope({
        permissionScope: "read_only",
        sensitivity: "medium",
        memoryOwner: "memory:shared",
      });
      const writeSensitiveScope = scope({
        permissionScope: "write_allowed",
        sensitivity: "high",
        memoryOwner: "memory:shared",
      });
      const otherOwnerScope = scope({
        permissionScope: "read_only",
        sensitivity: "medium",
        memoryOwner: "memory:other",
      });

      const readOnly = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: readOnlyScope,
          signalRefs: [sourceRef("runtime_event", "runtime:read")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "read:1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:shared-scope-fields",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });
      const writeSensitive = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: writeSensitiveScope,
          signalRefs: [sourceRef("runtime_event", "runtime:write")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "write:1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:shared-scope-fields",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });
      const otherOwner = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: otherOwnerScope,
          signalRefs: [sourceRef("runtime_event", "runtime:owner")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "owner:1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:shared-scope-fields",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });

      expect(readOnly.writeDisposition).toBe("written");
      expect(writeSensitive.writeDisposition).toBe("written");
      expect(otherOwner.writeDisposition).toBe("written");
      await expect(store.loadConcernState({ scope: readOnlyScope })).resolves.toMatchObject({
        clusters: [
          expect.objectContaining({
            scope: expect.objectContaining({ permissionScope: "read_only", memoryOwner: "memory:shared" }),
          }),
        ],
      });
      await expect(store.loadConcernState({ scope: writeSensitiveScope })).resolves.toMatchObject({
        clusters: [
          expect.objectContaining({
            scope: expect.objectContaining({ permissionScope: "write_allowed", sensitivity: "high" }),
          }),
        ],
      });
      await expect(store.loadConcernState({ scope: otherOwnerScope })).resolves.toMatchObject({
        clusters: [
          expect.objectContaining({
            scope: expect.objectContaining({ memoryOwner: "memory:other" }),
          }),
        ],
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("priority safety triggers persist a pending block before ordinary admission can continue", async () => {
    const tmpDir = makeTempDir("pulseed-attention-cycle-block-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const blocked = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "correction",
          safetyTrigger: "correction",
          scope: scope(),
          signalRefs: [sourceRef("correction", "correction:cycle")],
          sourceHighWatermarks: [{ source: "correction", highWatermark: "1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:correction:1",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });

      expect(blocked.writeDisposition).toBe("written");
      expect(blocked.admissionCandidates).toEqual([]);
      expect(blocked.silenceReasons[0]?.reason).toContain("pending block");
      await expect(store.listPendingBlocks(scope())).resolves.toHaveLength(1);
      await expect(store.listCycleResults()).resolves.toEqual([
        expect.objectContaining({
          result: expect.objectContaining({
            pendingBlockIds: expect.arrayContaining([expect.stringContaining("attention-block:")]),
            silenceReasons: expect.arrayContaining([
              expect.objectContaining({ reason: expect.stringContaining("pending block") }),
            ]),
          }),
        }),
      ]);

      const staleOutcome = await runAttentionCycle({
        store,
        cycle: {
          now: "2026-05-12T01:04:00.000Z",
          trigger: "runtime_outcome",
          scope: scope(),
          signalRefs: [sourceRef("runtime_event", "runtime:outcome:stale")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "stale" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:runtime-outcome:retry",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });

      expect(staleOutcome.writeDisposition).toBe("stale_rejected");
      await expect(store.listPendingBlocks(scope())).resolves.toHaveLength(1);

      const reconciled = await runAttentionCycle({
        store,
        cycle: {
          now: "2026-05-12T01:05:00.000Z",
          trigger: "runtime_outcome",
          scope: scope(),
          signalRefs: [sourceRef("runtime_event", "runtime:outcome")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "2" }],
          expectedProjectionRevision: blocked.projectionRevision,
          cycleIdempotencyKey: "cycle:runtime-outcome:retry",
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });

      expect(reconciled.writeDisposition).toBe("written");
      await expect(store.listPendingBlocks(scope())).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("reconciles pending blocks when a committed runtime outcome cycle is replayed", async () => {
    const tmpDir = makeTempDir("pulseed-attention-cycle-replay-pending-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const cycleScope = scope();
      const idempotencyKey = "cycle:runtime-outcome:committed-before-clear";
      await store.addPendingBlock({
        scope: cycleScope,
        triggerKind: "correction",
        reason: "simulate crash after runtime outcome write and before pending block clear",
        createdAt: NOW,
      });
      await store.saveMetabolismCycle({
        cycle_id: "attention-cycle:committed-before-clear",
        idempotency_key: idempotencyKey,
        trigger_kind: "runtime_outcome",
        scope: cycleScope,
        expected_projection_revision: 0,
        source_high_watermarks: ["runtime_event:1"],
        clusters: [],
        agendaItems: [],
        decompositions: [],
        admissionProposals: [],
        events: [],
        result: { cycleId: "attention-cycle:committed-before-clear", trigger: "runtime_outcome" },
        created_at: NOW,
        no_op_hash: "runtime-outcome-replay",
      });
      await expect(store.listPendingBlocks(cycleScope)).resolves.toHaveLength(1);

      const replayed = await runAttentionCycle({
        store,
        cycle: {
          now: "2026-05-12T01:06:00.000Z",
          trigger: "runtime_outcome",
          scope: cycleScope,
          signalRefs: [sourceRef("runtime_event", "runtime:outcome:replay")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "1" }],
          expectedProjectionRevision: 1,
          cycleIdempotencyKey: idempotencyKey,
          policyEpoch: "policy:cycle",
          mode: "live",
        },
      });

      expect(replayed.writeDisposition).toBe("no_op_elided");
      await expect(store.listPendingBlocks(cycleScope)).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("persists over-budget urges as deferred audit state instead of dropping them", async () => {
    const tmpDir = makeTempDir("pulseed-attention-cycle-deferred-");
    try {
      const store = new AttentionStateStore(`${tmpDir}/runtime`, { controlBaseDir: tmpDir });
      const result = await runAttentionCycle({
        store,
        cycle: {
          now: NOW,
          trigger: "maintenance",
          scope: scope(),
          signalRefs: [sourceRef("runtime_event", "runtime:deferred")],
          sourceHighWatermarks: [{ source: "runtime_event", highWatermark: "1" }],
          expectedProjectionRevision: 0,
          cycleIdempotencyKey: "cycle:deferred:1",
          policyEpoch: "policy:cycle",
          mode: "live",
          maxNewClustersPerCycle: 0,
        },
      });

      expect(result.writeDisposition).toBe("written");
      const deferredUrgeId = result.createdUrges[0]!.urge_id;
      expect(result.droppedWriteReasons[0]).toContain(`cluster budget deferred urge ${deferredUrgeId}`);
      await expect(store.listCycleResults()).resolves.toEqual([
        expect.objectContaining({
          result: expect.objectContaining({
            unmergedUrgeRefs: [deferredUrgeId],
            silenceReasons: expect.arrayContaining([
              expect.objectContaining({
                reason: "cluster budget deferred an urge for a later scoped cycle",
                refs: [deferredUrgeId],
              }),
            ]),
          }),
        }),
      ]);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
