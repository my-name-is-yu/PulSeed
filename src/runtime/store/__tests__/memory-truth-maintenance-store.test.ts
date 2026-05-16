import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryTruthMaintenanceStore,
  type ConflictSetInput,
  type CorrectionRefInput,
  type EvidenceRefInput,
  type ForgetTombstoneInput,
  type MemoryClaimInput,
  type ProjectionRecordInput,
  type RecallRecordInput,
} from "../memory-truth-maintenance-store.js";
import { openControlDatabase } from "../control-db/index.js";
import { RuntimeEventLogStore } from "../runtime-event-log.js";

const tmpDirs: string[] = [];
const NOW = "2026-05-16T00:00:00.000Z";

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-truth-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MemoryTruthMaintenanceStore", () => {
  it("rolls back multi-store correction transactions on injected failure", async () => {
    const baseDir = makeTmpDir();
    const store = new MemoryTruthMaintenanceStore(baseDir, { appendRuntimeEvents: false });
    await seedClaim(store);

    await expect(store.applyCorrectionTransaction({
      correction: correctionInput("correction:rollback", "idem:rollback"),
      replacementClaim: replacementClaimInput("claim:new"),
      replacementEvidenceRefs: [evidenceInput("evidence:new", "claim:new")],
      tombstone: tombstoneInput("tombstone:rollback", "claim:old", "idem:rollback"),
      conflictSets: [conflictInput("conflict:rollback", ["claim:old", "claim:new"])],
      recallRecords: [recallInput("recall:rollback", ["claim:new"])],
      projectionRecords: [projectionInput("projection:new", "claim:new")],
      failureAfterStep: "tombstone",
    })).rejects.toThrow("injected memory truth transaction failure after tombstone");

    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "active",
      invalidated_by: null,
      superseded_by: null,
      visible_to_normal_surface: true,
    });
    await expect(store.getClaim("claim:new")).resolves.toBeNull();
    await expect(store.listCorrections()).resolves.toEqual([]);
    await expect(store.listTombstones()).resolves.toEqual([]);
    await expect(store.listConflictSets()).resolves.toEqual([]);
    await expect(store.listRecallRecords()).resolves.toEqual([]);
    await expect(store.listProjectionRecords({ claimId: "claim:new" })).resolves.toEqual([]);
  });

  it("commits correction, replacement, tombstone, conflict, recall, projection, and event-log graph refs atomically", async () => {
    const baseDir = makeTmpDir();
    const store = new MemoryTruthMaintenanceStore(baseDir, {
      runtimeRoot: path.join(baseDir, "runtime"),
      appendRuntimeEvents: true,
    });
    await seedClaim(store);

    const first = await store.applyCorrectionTransaction({
      correction: correctionInput("correction:first", "idem:correction:first"),
      replacementClaim: replacementClaimInput("claim:new"),
      replacementEvidenceRefs: [evidenceInput("evidence:new", "claim:new")],
      tombstone: tombstoneInput("tombstone:first", "claim:old", "idem:correction:first"),
      conflictSets: [conflictInput("conflict:first", ["claim:old", "claim:new"])],
      recallRecords: [recallInput("recall:first", ["claim:new"])],
      projectionRecords: [projectionInput("projection:new", "claim:new")],
    });
    const duplicate = await store.applyCorrectionTransaction({
      correction: correctionInput("correction:first-replay", "idem:correction:first"),
      replacementClaim: replacementClaimInput("claim:new-replay"),
    });
    const distinct = await store.applyCorrectionTransaction({
      correction: {
        ...correctionInput("correction:second", "idem:correction:second"),
        correction_kind: "retracted",
        replacement_claim_id: null,
      },
    });

    expect(first.disposition).toBe("inserted");
    expect(duplicate.disposition).toBe("deduplicated_by_idempotency");
    expect(duplicate.correction.correction_id).toBe("correction:first");
    expect(distinct.disposition).toBe("inserted");
    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "retracted",
      invalidated_by: "correction:second",
      visible_to_normal_surface: false,
    });
    await expect(store.getClaim("claim:new")).resolves.toMatchObject({
      lifecycle: "conflicted",
      visible_to_normal_surface: false,
      source_evidence_refs: ["evidence:new"],
    });
    await expect(store.getClaim("claim:new-replay")).resolves.toBeNull();
    await expect(store.listCorrections()).resolves.toHaveLength(2);
    await expect(store.listTombstones()).resolves.toHaveLength(1);
    await expect(store.listConflictSets()).resolves.toEqual([
      expect.objectContaining({ conflict_set_id: "conflict:first", status: "held" }),
    ]);
    await expect(store.listRecallRecords()).resolves.toEqual([
      expect.objectContaining({
        recall_id: "recall:first",
        mode: "semantic",
        result_claims: [expect.objectContaining({ claim_id: "claim:new" })],
      }),
    ]);
    await expect(store.listProjectionRecords()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        projection_id: "projection:new",
        projection_kind: "normal_surface",
      }),
    ]));

    const eventLog = new RuntimeEventLogStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const events = await eventLog.listEvents({ limit: 20 });
    const rebuild = await eventLog.rebuildProjections();
    expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      "memory.truth_maintenance.recorded",
    ]));
    expect(rebuild.memory_truth_maintenance_summary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "correction",
        claim_ids: expect.arrayContaining(["claim:old", "claim:new"]),
        correction_id: "correction:first",
      }),
    ]));
  });

  it("rolls back truth rows when runtime event integration fails inside the transaction", async () => {
    const baseDir = makeTmpDir();
    const store = new MemoryTruthMaintenanceStore(baseDir, {
      runtimeRoot: path.join(baseDir, "runtime"),
      appendRuntimeEvents: true,
    });
    await seedClaim(store);

    await expect(store.applyCorrectionTransaction({
      correction: {
        ...correctionInput("correction:event-rollback", "idem:event-rollback"),
        replacement_claim_id: "claim:event-rollback",
      },
      replacementClaim: replacementClaimInput("claim:event-rollback"),
      replacementEvidenceRefs: [evidenceInput("evidence:event-rollback", "claim:event-rollback")],
      tombstone: tombstoneInput("tombstone:event-rollback", "claim:old", "idem:event-rollback"),
      projectionRecords: [projectionInput("projection:event-rollback", "claim:event-rollback")],
      failureAfterStep: "runtime_event",
    })).rejects.toThrow("injected memory truth transaction failure after runtime_event");

    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "active",
      invalidated_by: null,
      visible_to_normal_surface: true,
    });
    await expect(store.getClaim("claim:event-rollback")).resolves.toBeNull();
    await expect(store.listCorrections()).resolves.toEqual([]);
    await expect(store.listTombstones()).resolves.toEqual([]);
    await expect(store.listProjectionRecords({ claimId: "claim:event-rollback" })).resolves.toEqual([]);

    const eventLog = new RuntimeEventLogStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await expect(eventLog.listEvents({ limit: 20 })).resolves.toEqual([]);
  });

  it("includes snapshot-generated forgets in runtime event payloads", async () => {
    const baseDir = makeTmpDir();
    const store = new MemoryTruthMaintenanceStore(baseDir, {
      runtimeRoot: path.join(baseDir, "runtime"),
      appendRuntimeEvents: true,
    });
    await seedClaim(store);

    await store.saveOwnerSnapshot({
      ownerKind: "agent_memory",
      ownerScope: "default",
      claims: [],
      evidenceRefs: [],
      tombstoneReason: "Snapshot delete must be visible to replay consumers.",
    });

    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "forgotten",
      visible_to_normal_surface: false,
    });
    await expect(store.listTombstones("claim:old")).resolves.toEqual([
      expect.objectContaining({
        claim_id: "claim:old",
        reason: "Snapshot delete must be visible to replay consumers.",
      }),
    ]);

    const eventLog = new RuntimeEventLogStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const events = await eventLog.listEvents({ limit: 20 });
    expect(events).toEqual([
      expect.objectContaining({
        event_type: "memory.truth_maintenance.recorded",
        target_refs: [expect.objectContaining({ kind: "memory_claim", ref: "claim:old" })],
        payload: expect.objectContaining({
          operation: "snapshot",
          claim_ids: ["claim:old"],
          tombstone_ids: [expect.stringMatching(/^tombstone-memory-truth-snapshot-forget-/)],
        }),
      }),
    ]);
  });

  it("clears conflicted lifecycle when resolving a conflict set", async () => {
    const baseDir = makeTmpDir();
    const store = new MemoryTruthMaintenanceStore(baseDir, { appendRuntimeEvents: false });
    await store.saveOwnerSnapshot({
      ownerKind: "agent_memory",
      ownerScope: "default",
      claims: [
        claimInput("claim:old", "favorite-editor", "The user prefers Atom."),
        replacementClaimInput("claim:new"),
      ],
      evidenceRefs: [
        evidenceInput("evidence:old", "claim:old"),
        evidenceInput("evidence:new", "claim:new"),
      ],
      conflictSets: [conflictInput("conflict:editor", ["claim:old", "claim:new"])],
      emitRuntimeEvent: false,
    });

    await expect(store.listClaims({ includeInactive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        claim_id: "claim:old",
        lifecycle: "conflicted",
        visible_to_normal_surface: false,
      }),
      expect.objectContaining({
        claim_id: "claim:new",
        lifecycle: "conflicted",
        visible_to_normal_surface: false,
      }),
    ]));

    const conflictedClaims = await store.listClaims({ includeInactive: true });
    await store.saveOwnerSnapshot({
      ownerKind: "agent_memory",
      ownerScope: "default",
      claims: conflictedClaims,
      conflictSets: [{
        ...conflictInput("conflict:editor", ["claim:old", "claim:new"]),
        status: "resolved",
        resolution_claim_id: "claim:new",
        updated_at: "2026-05-16T00:02:00.000Z",
      }],
      emitRuntimeEvent: false,
    });

    await expect(store.getClaim("claim:new")).resolves.toMatchObject({
      lifecycle: "active",
      visible_to_normal_surface: true,
      invalidated_by: null,
    });
    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "archived",
      visible_to_normal_surface: false,
      invalidated_by: "conflict:editor",
    });
  });

  it("allows claim reactivation after an operator restores the blocking tombstone", async () => {
    const baseDir = makeTmpDir();
    const store = new MemoryTruthMaintenanceStore(baseDir, { appendRuntimeEvents: false });
    await seedClaim(store);

    await store.applyCorrectionTransaction({
      correction: {
        ...correctionInput("correction:forget", "idem:forget"),
        correction_kind: "forgotten",
        replacement_claim_id: null,
      },
      tombstone: tombstoneInput("tombstone:forget", "claim:old", "idem:forget"),
    });
    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "forgotten",
      visible_to_normal_surface: false,
    });

    const restoredAt = "2026-05-16T00:03:00.000Z";
    const db = await openControlDatabase({ baseDir });
    try {
      db.transaction((sqlite) => {
        sqlite.prepare(`
          UPDATE memory_forget_tombstones
          SET operator_restored_at = ?,
              tombstone_json = json_set(tombstone_json, '$.operator_restored_at', ?)
          WHERE tombstone_id = ?
        `).run(restoredAt, restoredAt, "tombstone:forget");
      });
    } finally {
      db.close();
    }

    await store.saveOwnerSnapshot({
      ownerKind: "agent_memory",
      ownerScope: "default",
      claims: [claimInput("claim:old", "favorite-editor", "The user prefers VS Code.")],
      evidenceRefs: [evidenceInput("evidence:old-restored", "claim:old")],
      emitRuntimeEvent: false,
    });

    await expect(store.getClaim("claim:old")).resolves.toMatchObject({
      lifecycle: "active",
      visible_to_normal_surface: true,
      invalidated_by: null,
    });
  });
});

async function seedClaim(store: MemoryTruthMaintenanceStore): Promise<void> {
  await store.saveOwnerSnapshot({
    ownerKind: "agent_memory",
    ownerScope: "default",
    claims: [claimInput("claim:old", "favorite-editor", "The user prefers Atom.")],
    evidenceRefs: [evidenceInput("evidence:old", "claim:old")],
    projections: [projectionInput("projection:old", "claim:old")],
    emitRuntimeEvent: false,
  });
}

function claimInput(claimId: string, subject: string, value: string): MemoryClaimInput {
  return {
    claim_id: claimId,
    owner_kind: "agent_memory",
    owner_scope: "default",
    claim_type: "preference",
    subject,
    predicate: "has_value",
    object: { value },
    source_evidence_refs: [`evidence:${claimId}`],
    confidence: 0.8,
    trust_state: "verified",
    sensitivity: "local",
    consent_scope: "local_planning",
    lifecycle: "active",
    created_at: NOW,
    updated_at: NOW,
    visible_to_normal_surface: true,
  };
}

function replacementClaimInput(claimId: string): MemoryClaimInput {
  return {
    ...claimInput(claimId, "favorite-editor-current", "The user prefers VS Code."),
    source_evidence_refs: ["evidence:new"],
  };
}

function evidenceInput(evidenceId: string, claimId: string): EvidenceRefInput {
  return {
    evidence_id: evidenceId,
    claim_id: claimId,
    owner_kind: "agent_memory",
    owner_scope: "default",
    source_kind: "user",
    source_ref: "memory-command",
    raw_refs: ["chat:turn:1"],
    reliability: 1,
    verification_status: "verified",
    created_at: NOW,
  };
}

function correctionInput(correctionId: string, idempotencyKey: string): CorrectionRefInput {
  return {
    correction_id: correctionId,
    target_claim_id: "claim:old",
    correction_kind: "corrected",
    replacement_claim_id: "claim:new",
    idempotency_key: idempotencyKey,
    actor: "user",
    reason: "User corrected stale memory.",
    created_at: "2026-05-16T00:01:00.000Z",
    evidence_refs: ["evidence:new"],
  };
}

function tombstoneInput(tombstoneId: string, claimId: string, idempotencyKey: string): ForgetTombstoneInput {
  return {
    tombstone_id: tombstoneId,
    claim_id: claimId,
    idempotency_key: idempotencyKey,
    source_evidence_ref: "evidence:old",
    reason: "Forgotten stale claim must not be resurrected.",
    prevents_reimport: true,
    created_at: "2026-05-16T00:01:00.000Z",
  };
}

function conflictInput(conflictId: string, claimIds: string[]): ConflictSetInput {
  return {
    conflict_set_id: conflictId,
    claim_ids: claimIds,
    status: "held",
    resolution_claim_id: null,
    reason: "Replacement conflicts with old evidence until correction resolves it.",
    created_at: "2026-05-16T00:01:00.000Z",
    updated_at: "2026-05-16T00:01:00.000Z",
    operator_explanation_refs: ["correction:first"],
  };
}

function recallInput(recallId: string, claimIds: string[]): RecallRecordInput {
  return {
    recall_id: recallId,
    mode: "semantic",
    query: "editor preference",
    query_hash: "query-hash:editor-preference",
    result_claims: claimIds.map((claimId) => ({
      claim_id: claimId,
      mode: "semantic",
      evidence_refs: ["evidence:new"],
      correction_status: "active",
      invalidation_status: "valid",
      confidence: 0.8,
      trust_state: "verified",
      safe_for_normal_projection: true,
    })),
    withheld_claim_ids: ["claim:old"],
    semantic_index_status: "available",
    safe_for_normal_projection: true,
    created_at: "2026-05-16T00:01:00.000Z",
  };
}

function projectionInput(projectionId: string, claimId: string): ProjectionRecordInput {
  return {
    projection_id: projectionId,
    claim_id: claimId,
    owner_kind: "agent_memory",
    owner_scope: "default",
    projection_kind: "normal_surface",
    surface: "memory_recall",
    safe_for_normal_surface: true,
    explanation_refs: [],
    payload: { claim_id: claimId, summary: "The user prefers VS Code." },
    created_at: "2026-05-16T00:01:00.000Z",
  };
}
