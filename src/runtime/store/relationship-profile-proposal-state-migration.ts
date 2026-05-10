import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  RelationshipProfileProposalStoreSchema,
  saveRelationshipProfileProposalStore,
} from "../../platform/profile/profile-change-proposal.js";

const MIGRATION_NAME = "trust-ethics-profile-runtime-state";
const MIGRATION_VERSION = 15;
const LEGACY_RELATIONSHIP_PROFILE_PROPOSALS_PATH = "relationship-profile-proposals.json";

export interface RelationshipProfileProposalLegacyImportReport {
  proposalStoreFiles: number;
  importedProposals: number;
  importedAuditEvents: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyRelationshipProfileProposalState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<RelationshipProfileProposalLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: RelationshipProfileProposalLegacyImportReport = {
    proposalStoreFiles: 0,
    importedProposals: 0,
    importedAuditEvents: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_RELATIONSHIP_PROFILE_PROPOSALS_PATH);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, controlDb, report, error);
      return report;
    }

    try {
      const parsed = RelationshipProfileProposalStoreSchema.parse(JSON.parse(payload.raw) as unknown);
      await saveRelationshipProfileProposalStore(baseDir, parsed, { ...options, controlDb });
      report.proposalStoreFiles += 1;
      report.importedProposals += parsed.proposals.length;
      report.importedAuditEvents += parsed.audit_events.length;
      controlDb.recordLegacyImport({
        sourceKind: "relationship_profile_proposals",
        sourceId: parsed.profile_id,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: {
          proposal_count: parsed.proposals.length,
          audit_event_count: parsed.audit_events.length,
        },
      });
    } catch (error) {
      blockImport(baseDir, filePath, controlDb, report, error, payload.checksum, payload.mtimeMs);
    }

    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function readLegacyTextFile(filePath: string): Promise<{ raw: string; checksum: string; mtimeMs: number }> {
  const [raw, stat] = await Promise.all([
    fsp.readFile(filePath, "utf8"),
    fsp.stat(filePath),
  ]);
  return {
    raw,
    checksum: createHash("sha256").update(raw, "utf8").digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function blockImport(
  baseDir: string,
  filePath: string,
  controlDb: ControlDatabase,
  report: RelationshipProfileProposalLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({
    sourceKind: "relationship_profile_proposals",
    sourcePath: path.relative(baseDir, filePath),
    reason,
  });
  controlDb.recordLegacyImport({
    sourceKind: "relationship_profile_proposals",
    sourceId: "default",
    sourcePath: path.relative(baseDir, filePath),
    sourceChecksum: checksum ?? null,
    sourceMtimeMs: mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}
