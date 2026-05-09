import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  ApprovalRecordSchema,
  BackpressureSnapshotSchema,
  CircuitBreakerRecordSchema,
  GoalLeaseRecordSchema,
  OutboxRecordSchema,
  RuntimeSafePauseRecordSchema,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  listRuntimeJson,
  loadRuntimeJson,
} from "./runtime-journal.js";
import { ApprovalStore } from "./approval-store.js";
import { OutboxStore } from "./outbox-store.js";
import { RuntimeSafePauseStore } from "./safe-pause-store.js";
import {
  PermissionGrantRecordSchema,
  PermissionGrantStore,
} from "./permission-grant-store.js";
import {
  PermissionWaitPlanRecordSchema,
  PermissionWaitPlanStore,
} from "./permission-wait-plan-store.js";
import { GuardrailStore } from "../guardrails/guardrail-store.js";
import {
  GoalLeaseManager,
} from "../goal-lease-manager.js";
import {
  LeaderLockManager,
  LeaderLockRecordSchema,
} from "../leader-lock-manager.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportRecord,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const RUNTIME_CONTROL_STATE_LEGACY_IMPORT_MIGRATION_VERSION = 3;

export interface ImportLegacyRuntimeControlStateStoresInput extends RuntimeControlDbStoreOptions {
  runtimeRootOrPaths?: string | RuntimeStorePaths;
  importedAt?: string;
}

export interface ImportLegacyRuntimeControlStateStoresResult {
  approvals: {
    pending: number;
    resolved: number;
  };
  permissionGrants: number;
  permissionWaitPlans: number;
  outboxRecords: number;
  safePauses: number;
  guardrailBreakers: number;
  backpressureSnapshots: number;
  leaderLocks: number;
  goalLeases: number;
  legacyImports: ControlLegacyImportRecord[];
}

export async function importLegacyRuntimeControlStateStores(
  input: ImportLegacyRuntimeControlStateStoresInput = {}
): Promise<ImportLegacyRuntimeControlStateStoresResult> {
  const paths = typeof input.runtimeRootOrPaths === "string"
    ? createRuntimeStorePaths(input.runtimeRootOrPaths)
    : input.runtimeRootOrPaths ?? createRuntimeStorePaths();
  const providedDb = input.controlDb !== undefined;
  const controlDb = await openRuntimeControlDatabase(paths, input);
  const storeOptions = { controlDb };
  const approvalStore = new ApprovalStore(paths, storeOptions);
  const permissionGrantStore = new PermissionGrantStore(paths, storeOptions);
  const permissionWaitPlanStore = new PermissionWaitPlanStore(paths, storeOptions);
  const outboxStore = new OutboxStore(paths, storeOptions);
  const safePauseStore = new RuntimeSafePauseStore(paths, storeOptions);
  const guardrailStore = new GuardrailStore(paths, storeOptions);
  const leaderLockManager = new LeaderLockManager(paths.rootDir, undefined, storeOptions);
  const goalLeaseManager = new GoalLeaseManager(paths.rootDir, undefined, storeOptions);
  const legacyImports: ControlLegacyImportRecord[] = [];

  try {
    const pendingApprovals = await listRuntimeJson(paths.approvalsPendingDir, ApprovalRecordSchema);
    for (const record of pendingApprovals) {
      await approvalStore.savePending(record);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.approvalsPendingDir,
      "approval-json",
      "approvals:pending",
      "runtime-approval-json-import",
      pendingApprovals.length,
      input.importedAt,
    ));

    const resolvedApprovals = await listRuntimeJson(paths.approvalsResolvedDir, ApprovalRecordSchema);
    for (const record of resolvedApprovals) {
      await approvalStore.saveResolved(record);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.approvalsResolvedDir,
      "approval-json",
      "approvals:resolved",
      "runtime-approval-json-import",
      resolvedApprovals.length,
      input.importedAt,
    ));

    const permissionGrants = await listRuntimeJson(paths.permissionGrantsDir, PermissionGrantRecordSchema);
    for (const record of permissionGrants) {
      await permissionGrantStore.importLegacyRecord(PermissionGrantRecordSchema.parse(record));
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.permissionGrantsDir,
      "permission-grant-json",
      "permission-grants",
      "runtime-permission-grant-json-import",
      permissionGrants.length,
      input.importedAt,
    ));

    const permissionWaitPlans = await listRuntimeJson(paths.permissionWaitPlansDir, PermissionWaitPlanRecordSchema);
    for (const record of permissionWaitPlans) {
      await permissionWaitPlanStore.importLegacyRecord(PermissionWaitPlanRecordSchema.parse(record));
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.permissionWaitPlansDir,
      "permission-wait-plan-json",
      "permission-wait-plans",
      "runtime-permission-wait-plan-json-import",
      permissionWaitPlans.length,
      input.importedAt,
    ));

    const outboxRecords = await listRuntimeJson(paths.outboxDir, OutboxRecordSchema);
    for (const record of outboxRecords) {
      await outboxStore.save(record);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.outboxDir,
      "outbox-json",
      "outbox",
      "runtime-outbox-json-import",
      outboxRecords.length,
      input.importedAt,
    ));

    const safePauses = await listRuntimeJson(paths.safePausesDir, RuntimeSafePauseRecordSchema);
    for (const record of safePauses) {
      await safePauseStore.save(record);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.safePausesDir,
      "safe-pause-json",
      "safe-pauses",
      "runtime-safe-pause-json-import",
      safePauses.length,
      input.importedAt,
    ));

    const guardrailBreakers = await listRuntimeJson(paths.guardrailBreakersDir, CircuitBreakerRecordSchema);
    for (const record of guardrailBreakers) {
      await guardrailStore.saveBreaker(record);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.guardrailBreakersDir,
      "guardrail-breaker-json",
      "guardrail-breakers",
      "runtime-guardrail-breaker-json-import",
      guardrailBreakers.length,
      input.importedAt,
    ));

    let backpressureSnapshots = 0;
    const backpressureSnapshot = await loadRuntimeJson(paths.backpressureSnapshotPath, BackpressureSnapshotSchema);
    if (backpressureSnapshot) {
      await guardrailStore.saveBackpressureSnapshot(BackpressureSnapshotSchema.parse(backpressureSnapshot));
      backpressureSnapshots = 1;
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.backpressureSnapshotPath,
      "guardrail-backpressure-json",
      "guardrail-backpressure",
      "runtime-guardrail-backpressure-json-import",
      backpressureSnapshots,
      input.importedAt,
    ));

    let leaderLocks = 0;
    const leaderLock = await loadRuntimeJson(paths.leaderPath, LeaderLockRecordSchema);
    if (leaderLock) {
      await leaderLockManager.importLegacyRecord(leaderLock);
      leaderLocks = 1;
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.leaderPath,
      "leader-lock-json",
      "leader-lock",
      "runtime-leader-lock-json-import",
      leaderLocks,
      input.importedAt,
    ));

    const goalLeases = await listRuntimeJson(paths.goalLeasesDir, GoalLeaseRecordSchema);
    for (const record of goalLeases) {
      await goalLeaseManager.importLegacyRecord(record);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.goalLeasesDir,
      "goal-lease-json",
      "goal-leases",
      "runtime-goal-lease-json-import",
      goalLeases.length,
      input.importedAt,
    ));

    return {
      approvals: {
        pending: pendingApprovals.length,
        resolved: resolvedApprovals.length,
      },
      permissionGrants: permissionGrants.length,
      permissionWaitPlans: permissionWaitPlans.length,
      outboxRecords: outboxRecords.length,
      safePauses: safePauses.length,
      guardrailBreakers: guardrailBreakers.length,
      backpressureSnapshots,
      leaderLocks,
      goalLeases: goalLeases.length,
      legacyImports,
    };
  } finally {
    if (!providedDb) {
      controlDb.close();
    }
  }
}

async function recordLegacyImport(
  controlDb: ControlDatabase,
  paths: RuntimeStorePaths,
  sourcePath: string,
  sourceKind: string,
  sourceId: string,
  migrationName: string,
  rowCount: number,
  importedAt?: string,
): Promise<ControlLegacyImportRecord> {
  const metadata = await readSourceMetadata(sourcePath);
  return controlDb.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath: displayLegacySourcePath(paths, sourcePath),
    sourceChecksum: metadata.checksum,
    sourceMtimeMs: metadata.mtimeMs,
    migrationName,
    migrationVersion: RUNTIME_CONTROL_STATE_LEGACY_IMPORT_MIGRATION_VERSION,
    status: "imported",
    details: {
      row_count: rowCount,
    },
    importedAt,
  });
}

async function readSourceMetadata(sourcePath: string): Promise<{
  checksum: string | null;
  mtimeMs: number | null;
}> {
  try {
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) {
      return { checksum: null, mtimeMs: stat.mtimeMs };
    }
    const contents = await fsp.readFile(sourcePath);
    return {
      checksum: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { checksum: null, mtimeMs: null };
    }
    throw error;
  }
}

function displayLegacySourcePath(paths: RuntimeStorePaths, sourcePath: string): string {
  const root = path.resolve(paths.rootDir);
  const baseDir = path.basename(root) === "runtime" ? path.dirname(root) : root;
  return path.relative(baseDir, sourcePath);
}
