import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapabilityVerificationRefSchema,
  CapabilityVerificationStore,
  readinessEvidenceEffect,
  type CapabilityVerificationRef,
} from "../store/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-capability-verification-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function verification(
  overrides: Partial<CapabilityVerificationRef> = {}
): CapabilityVerificationRef {
  return CapabilityVerificationRefSchema.parse({
    schema_version: "capability-verification-ref/v1",
    verification_id: "verify:read-smoke",
    provider_ref: "mcp:filesystem",
    asset_ref: "asset:mcp/filesystem",
    capability_id: "capability:mcp:filesystem:read_file",
    operation_kind: "read",
    tool_name: "read_file",
    payload_class: "path",
    risk_class: "low",
    side_effect_profile: "read",
    verification_class: "smoke_execution",
    result: "passed",
    evidence_stage: "smoke_verified",
    evidence_ref: "audit:read-smoke",
    created_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  });
}

describe("CapabilityVerificationStore", () => {
  it("keeps read-only smoke, side-effecting smoke, production success, and operator review distinct", async () => {
    const store = new CapabilityVerificationStore(tmpDir);
    await store.saveVerification(verification({
      verification_id: "verify:read-smoke",
      operation_kind: "read",
      side_effect_profile: "read",
      verification_class: "smoke_execution",
      evidence_stage: "smoke_verified",
      created_at: "2026-05-09T00:00:00.000Z",
    }));
    await store.saveVerification(verification({
      verification_id: "verify:send-smoke",
      operation_kind: "send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      verification_class: "smoke_execution",
      evidence_stage: "smoke_verified",
      created_at: "2026-05-09T00:00:01.000Z",
    }));
    await store.saveVerification(verification({
      verification_id: "verify:send-production",
      operation_kind: "send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      verification_class: "production_caller_path",
      evidence_stage: "production_succeeded",
      created_at: "2026-05-09T00:00:02.000Z",
    }));
    await store.saveVerification(verification({
      verification_id: "verify:operator-review",
      operation_kind: "send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      verification_class: "operator_review",
      evidence_stage: "configured",
      result: "passed",
      created_at: "2026-05-09T00:00:03.000Z",
    }));

    const all = await store.listVerifications();
    expect(all.map((record) => [
      record.verification_id,
      record.operation_kind,
      record.side_effect_profile,
      record.verification_class,
      record.evidence_stage,
    ])).toEqual([
      ["verify:read-smoke", "read", "read", "smoke_execution", "smoke_verified"],
      ["verify:send-smoke", "send", "send", "smoke_execution", "smoke_verified"],
      ["verify:send-production", "send", "send", "production_caller_path", "production_succeeded"],
      ["verify:operator-review", "send", "send", "operator_review", "configured"],
    ]);
    await expect(store.loadVerification("verify:send-smoke")).resolves.toMatchObject({
      verification_id: "verify:send-smoke",
      side_effect_profile: "send",
    });
    await expect(store.listVerificationsForOperation({
      capabilityId: "capability:mcp:filesystem:read_file",
      providerRef: "mcp:filesystem",
      assetRef: "asset:mcp/filesystem",
      operationKind: "read",
      toolName: "read_file",
      payloadClass: "path",
      riskClass: "low",
      sideEffectProfile: "read",
    })).resolves.toEqual([
      expect.objectContaining({
        verification_id: "verify:read-smoke",
        operation_kind: "read",
        side_effect_profile: "read",
      }),
    ]);
    await expect(store.listVerificationsForOperation({
      capabilityId: "capability:mcp:filesystem:read_file",
      providerRef: "mcp:filesystem",
      assetRef: "asset:mcp/filesystem",
      operationKind: "send",
      toolName: "read_file",
      payloadClass: "path",
      riskClass: "low",
      sideEffectProfile: "send",
    })).resolves.toEqual([]);
    await expect(store.listVerificationsForOperation({
      capabilityId: "capability:mcp:filesystem:read_file",
      providerRef: "mcp:filesystem",
      assetRef: "asset:mcp/other-filesystem",
      operationKind: "read",
      toolName: "read_file",
      payloadClass: "path",
      riskClass: "low",
      sideEffectProfile: "read",
    })).resolves.toEqual([]);
    await expect(store.listVerificationsForOperation({
      capabilityId: "capability:mcp:filesystem:read_file",
      providerRef: "mcp:filesystem",
      assetRef: "asset:mcp/filesystem",
      operationKind: "read",
      toolName: "list_files",
      payloadClass: "path",
      riskClass: "low",
      sideEffectProfile: "read",
    })).resolves.toEqual([]);
  });

  it("does not let permission_probe replace concrete admission evaluation", async () => {
    const probe = verification({
      verification_id: "verify:permission-probe",
      verification_class: "permission_probe",
      evidence_stage: "configured",
      evidence_ref: "permission-source:github",
    });
    const store = new CapabilityVerificationStore(tmpDir);
    await store.saveVerification(probe);

    expect(readinessEvidenceEffect(probe)).toBe("none");
    await expect(store.listReadinessEvidenceSummaries()).resolves.toEqual([
      expect.objectContaining({
        verification_id: "verify:permission-probe",
        asset_ref: "asset:mcp/filesystem",
        tool_name: "read_file",
        verification_class: "permission_probe",
        readiness_effect: "none",
      }),
    ]);
  });

  it("preserves verification expiry for readiness staleness checks", async () => {
    const store = new CapabilityVerificationStore(tmpDir);
    await store.saveVerification(verification({
      verification_id: "verify:expiring-send-smoke",
      operation_kind: "send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      expires_at: "2026-05-10T00:00:00.000Z",
    }));

    await expect(store.listReadinessEvidenceSummaries()).resolves.toEqual([
      expect.objectContaining({
        verification_id: "verify:expiring-send-smoke",
        expires_at: "2026-05-10T00:00:00.000Z",
      }),
    ]);
  });

  it("marks failed production caller-path evidence as readiness-degrading without admission decisions", async () => {
    const failed = verification({
      verification_id: "verify:send-production-failed",
      operation_kind: "send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      verification_class: "production_caller_path",
      result: "failed",
      evidence_stage: "production_failed",
    });
    const store = new CapabilityVerificationStore(tmpDir);
    await store.saveVerification(failed);

    const [summary] = await store.listReadinessEvidenceSummaries();
    expect(summary).toMatchObject({
      verification_id: "verify:send-production-failed",
      asset_ref: "asset:mcp/filesystem",
      tool_name: "read_file",
      verification_class: "production_caller_path",
      evidence_stage: "production_failed",
      readiness_effect: "degrades_readiness",
    });
    expect(summary).not.toHaveProperty("admission");
    expect(summary).not.toHaveProperty("autonomy");
  });

  it("persists audit records separately from verification records", async () => {
    const store = new CapabilityVerificationStore(tmpDir);
    await store.saveVerification(verification());
    await store.saveAudit({
      schema_version: "capability-audit-record/v1",
      audit_id: "audit:read-smoke",
      operation_id: "operation:read-smoke",
      user_directed: true,
      initiated_by: "user",
      source_surface: "cli",
      capability_refs: ["capability:mcp:filesystem:read_file"],
      provider_refs: ["mcp:filesystem"],
      readiness_snapshot_refs: [],
      approval_refs: [],
      execution_refs: ["execution:mcp-list"],
      verification_refs: ["verify:read-smoke"],
      result: "succeeded",
      side_effect_summary: "Read-only smoke listed files.",
      user_visible_effect: "No user-visible output policy is decided by this audit.",
      follow_up_policy_effect: "record_only",
      created_at: "2026-05-09T00:00:01.000Z",
      metadata: {},
    });

    await expect(store.listAudits()).resolves.toEqual([
      expect.objectContaining({
        audit_id: "audit:read-smoke",
        verification_refs: ["verify:read-smoke"],
        follow_up_policy_effect: "record_only",
      }),
    ]);
    await expect(store.listVerifications()).resolves.toHaveLength(1);
  });
});
