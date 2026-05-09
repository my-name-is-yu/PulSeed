import * as path from "node:path";
import type { z } from "zod";
import { RuntimeJournal, ensureRuntimeDirectory } from "./runtime-journal.js";
import {
  createRuntimeStorePaths,
  encodeRuntimePathSegment,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  CapabilityAuditRecordSchema,
  CapabilityVerificationEvidenceSummarySchema,
  CapabilityVerificationRefSchema,
  readinessEvidenceEffect,
  type CapabilityAuditRecord,
  type CapabilityVerificationEvidenceSummary,
  type CapabilityVerificationRef,
} from "./capability-verification-schemas.js";

const CapabilityVerificationRefRuntimeSchema =
  CapabilityVerificationRefSchema as unknown as z.ZodType<CapabilityVerificationRef>;
const CapabilityAuditRecordRuntimeSchema =
  CapabilityAuditRecordSchema as unknown as z.ZodType<CapabilityAuditRecord>;

export class CapabilityVerificationStore {
  private readonly rootDir: string;
  private readonly verificationDir: string;
  private readonly auditDir: string;
  private readonly journal: RuntimeJournal;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    const paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.rootDir = path.join(paths.rootDir, "capability-verification");
    this.verificationDir = path.join(this.rootDir, "verifications");
    this.auditDir = path.join(this.rootDir, "audits");
    this.journal = new RuntimeJournal(paths);
  }

  async ensureReady(): Promise<void> {
    await this.journal.ensureReady();
    await Promise.all([
      ensureRuntimeDirectory(this.rootDir),
      ensureRuntimeDirectory(this.verificationDir),
      ensureRuntimeDirectory(this.auditDir),
    ]);
  }

  async saveVerification(record: CapabilityVerificationRef): Promise<CapabilityVerificationRef> {
    const parsed = CapabilityVerificationRefSchema.parse(record);
    await this.ensureReady();
    await this.journal.save(
      this.verificationPath(parsed.verification_id),
      CapabilityVerificationRefRuntimeSchema,
      parsed
    );
    return parsed;
  }

  async loadVerification(verificationId: string): Promise<CapabilityVerificationRef | null> {
    return this.journal.load(this.verificationPath(verificationId), CapabilityVerificationRefRuntimeSchema);
  }

  async listVerifications(): Promise<CapabilityVerificationRef[]> {
    return (await this.journal.list(this.verificationDir, CapabilityVerificationRefRuntimeSchema))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listVerificationsForOperation(input: {
    capabilityId: string;
    providerRef: string;
    assetRef: string;
    operationKind: CapabilityVerificationRef["operation_kind"];
    toolName: string;
    payloadClass: string;
    riskClass: CapabilityVerificationRef["risk_class"];
    sideEffectProfile: CapabilityVerificationRef["side_effect_profile"];
  }): Promise<CapabilityVerificationRef[]> {
    return (await this.listVerifications()).filter((record) =>
      record.capability_id === input.capabilityId
      && record.provider_ref === input.providerRef
      && record.asset_ref === input.assetRef
      && record.operation_kind === input.operationKind
      && record.tool_name === input.toolName
      && record.payload_class === input.payloadClass
      && record.risk_class === input.riskClass
      && record.side_effect_profile === input.sideEffectProfile
    );
  }

  async listReadinessEvidenceSummaries(): Promise<CapabilityVerificationEvidenceSummary[]> {
    return (await this.listVerifications()).map((record) =>
      CapabilityVerificationEvidenceSummarySchema.parse({
        verification_id: record.verification_id,
        capability_id: record.capability_id,
        provider_ref: record.provider_ref,
        asset_ref: record.asset_ref,
        operation_kind: record.operation_kind,
        tool_name: record.tool_name,
        payload_class: record.payload_class,
        risk_class: record.risk_class,
        side_effect_profile: record.side_effect_profile,
        verification_class: record.verification_class,
        evidence_stage: record.evidence_stage,
        result: record.result,
        readiness_effect: readinessEvidenceEffect(record),
      })
    );
  }

  async saveAudit(record: CapabilityAuditRecord): Promise<CapabilityAuditRecord> {
    const parsed = CapabilityAuditRecordSchema.parse(record);
    await this.ensureReady();
    await this.journal.save(this.auditPath(parsed.audit_id), CapabilityAuditRecordRuntimeSchema, parsed);
    return parsed;
  }

  async loadAudit(auditId: string): Promise<CapabilityAuditRecord | null> {
    return this.journal.load(this.auditPath(auditId), CapabilityAuditRecordRuntimeSchema);
  }

  async listAudits(): Promise<CapabilityAuditRecord[]> {
    return (await this.journal.list(this.auditDir, CapabilityAuditRecordRuntimeSchema))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private verificationPath(verificationId: string): string {
    return path.join(this.verificationDir, `${encodeRuntimePathSegment(verificationId)}.json`);
  }

  private auditPath(auditId: string): string {
    return path.join(this.auditDir, `${encodeRuntimePathSegment(auditId)}.json`);
  }
}
