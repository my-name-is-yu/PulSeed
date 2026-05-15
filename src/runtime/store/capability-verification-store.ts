import type { z } from "zod/v3";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
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
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async saveVerification(record: CapabilityVerificationRef): Promise<CapabilityVerificationRef> {
    const parsed = CapabilityVerificationRefSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => upsertCapabilityVerification(sqlite, parsed));
    return parsed;
  }

  async loadVerification(verificationId: string): Promise<CapabilityVerificationRef | null> {
    const db = await this.database();
    return db.read((sqlite) => readCapabilityVerification(sqlite, verificationId));
  }

  async listVerifications(): Promise<CapabilityVerificationRef[]> {
    const db = await this.database();
    return db.read((sqlite) => listCapabilityVerifications(sqlite));
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
        ...(record.expires_at ? { expires_at: record.expires_at } : {}),
      })
    );
  }

  async saveAudit(record: CapabilityAuditRecord): Promise<CapabilityAuditRecord> {
    const parsed = CapabilityAuditRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => upsertCapabilityAudit(sqlite, parsed));
    return parsed;
  }

  async loadAudit(auditId: string): Promise<CapabilityAuditRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readCapabilityAudit(sqlite, auditId));
  }

  async listAudits(): Promise<CapabilityAuditRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listCapabilityAudits(sqlite));
  }

  async importLegacyVerification(record: CapabilityVerificationRef): Promise<CapabilityVerificationRef> {
    return this.saveVerification(CapabilityVerificationRefSchema.parse(record));
  }

  async importLegacyAudit(record: CapabilityAuditRecord): Promise<CapabilityAuditRecord> {
    return this.saveAudit(CapabilityAuditRecordSchema.parse(record));
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface CapabilityVerificationRow {
  record_json: string;
}

interface CapabilityAuditRow {
  record_json: string;
}

function parseCapabilityVerificationJson(recordJson: string): CapabilityVerificationRef | null {
  try {
    const parsed = CapabilityVerificationRefRuntimeSchema.safeParse(JSON.parse(recordJson) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseCapabilityAuditJson(recordJson: string): CapabilityAuditRecord | null {
  try {
    const parsed = CapabilityAuditRecordRuntimeSchema.safeParse(JSON.parse(recordJson) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readCapabilityVerification(sqlite: SqliteDatabase, verificationId: string): CapabilityVerificationRef | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM capability_verification_refs
    WHERE verification_id = ?
  `).get(verificationId) as CapabilityVerificationRow | undefined;
  return row ? parseCapabilityVerificationJson(row.record_json) : null;
}

function listCapabilityVerifications(sqlite: SqliteDatabase): CapabilityVerificationRef[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM capability_verification_refs
    ORDER BY created_at ASC, verification_id ASC
  `).all() as CapabilityVerificationRow[];
  return rows.flatMap((row) => {
    const record = parseCapabilityVerificationJson(row.record_json);
    return record ? [record] : [];
  });
}

function upsertCapabilityVerification(sqlite: SqliteDatabase, record: CapabilityVerificationRef): void {
  sqlite.prepare(`
    INSERT INTO capability_verification_refs (
      verification_id,
      capability_id,
      provider_ref,
      asset_ref,
      operation_kind,
      tool_name,
      payload_class,
      risk_class,
      side_effect_profile,
      verification_class,
      result,
      evidence_stage,
      created_at,
      expires_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(verification_id) DO UPDATE SET
      capability_id = excluded.capability_id,
      provider_ref = excluded.provider_ref,
      asset_ref = excluded.asset_ref,
      operation_kind = excluded.operation_kind,
      tool_name = excluded.tool_name,
      payload_class = excluded.payload_class,
      risk_class = excluded.risk_class,
      side_effect_profile = excluded.side_effect_profile,
      verification_class = excluded.verification_class,
      result = excluded.result,
      evidence_stage = excluded.evidence_stage,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      record_json = excluded.record_json
  `).run(
    record.verification_id,
    record.capability_id,
    record.provider_ref,
    record.asset_ref,
    record.operation_kind,
    record.tool_name,
    record.payload_class,
    record.risk_class,
    record.side_effect_profile,
    record.verification_class,
    record.result,
    record.evidence_stage,
    record.created_at,
    record.expires_at ?? null,
    JSON.stringify(record),
  );
}

function readCapabilityAudit(sqlite: SqliteDatabase, auditId: string): CapabilityAuditRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM capability_audit_records
    WHERE audit_id = ?
  `).get(auditId) as CapabilityAuditRow | undefined;
  return row ? parseCapabilityAuditJson(row.record_json) : null;
}

function listCapabilityAudits(sqlite: SqliteDatabase): CapabilityAuditRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM capability_audit_records
    ORDER BY created_at ASC, audit_id ASC
  `).all() as CapabilityAuditRow[];
  return rows.flatMap((row) => {
    const record = parseCapabilityAuditJson(row.record_json);
    return record ? [record] : [];
  });
}

function upsertCapabilityAudit(sqlite: SqliteDatabase, record: CapabilityAuditRecord): void {
  sqlite.prepare(`
    INSERT INTO capability_audit_records (
      audit_id,
      operation_id,
      result,
      follow_up_policy_effect,
      created_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(audit_id) DO UPDATE SET
      operation_id = excluded.operation_id,
      result = excluded.result,
      follow_up_policy_effect = excluded.follow_up_policy_effect,
      created_at = excluded.created_at,
      record_json = excluded.record_json
  `).run(
    record.audit_id,
    record.operation_id,
    record.result,
    record.follow_up_policy_effect,
    record.created_at,
    JSON.stringify(record),
  );
}
