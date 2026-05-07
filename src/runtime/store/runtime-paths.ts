import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { getPulseedDirPath } from "../../base/utils/paths.js";

export interface RuntimeStorePaths {
  rootDir: string;
  leaderDir: string;
  leaderPath: string;
  inboxDir: string;
  claimsDir: string;
  completedDir: string;
  completedByIdempotencyDir: string;
  completedByMessageDir: string;
  approvalsDir: string;
  approvalsPendingDir: string;
  approvalsResolvedDir: string;
  permissionGrantsDir: string;
  outboxDir: string;
  backgroundRunsDir: string;
  authHandoffsDir: string;
  browserSessionsDir: string;
  evidenceLedgerDir: string;
  evidenceLedgerGoalsDir: string;
  evidenceLedgerRunsDir: string;
  safePausesDir: string;
  leasesDir: string;
  goalLeasesDir: string;
  dlqDir: string;
  healthDir: string;
  guardrailsDir: string;
  guardrailBreakersDir: string;
  proactiveInterventionsDir: string;
  reproducibilityManifestsDir: string;
  experimentQueuesDir: string;
  budgetsDir: string;
  operatorHandoffsDir: string;
  postmortemsDir: string;
  backpressureSnapshotPath: string;
  proactiveInterventionLedgerPath: string;
  daemonHealthPath: string;
  componentsHealthPath: string;
  inboxBucketDir(dateKey: string): string;
  inboxRecordPath(dateKey: string, messageId: string): string;
  approvalPendingPath(approvalId: string): string;
  approvalResolvedPath(approvalId: string): string;
  permissionGrantPath(grantId: string): string;
  outboxRecordPath(seq: number): string;
  backgroundRunPath(runId: string): string;
  authHandoffPath(handoffId: string): string;
  browserSessionPath(sessionId: string): string;
  evidenceGoalPath(goalId: string): string;
  evidenceRunPath(runId: string): string;
  safePausePath(goalId: string): string;
  guardrailBreakerPath(key: string): string;
  reproducibilityManifestPath(manifestId: string): string;
  experimentQueuePath(queueId: string): string;
  budgetPath(budgetId: string): string;
  operatorHandoffPath(handoffId: string): string;
  postmortemDir(postmortemId: string): string;
  postmortemJsonPath(postmortemId: string): string;
  postmortemMarkdownPath(postmortemId: string): string;
  goalLeasePath(goalId: string): string;
  completedByIdempotencyPath(idempotencyKey: string): string;
  completedByMessagePath(messageId: string): string;
  dlqPath(dateKey: string): string;
}

function recordFileName(recordId: string): string {
  return `${recordId}.json`;
}

function outboxFileName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}

export function encodeRuntimePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function hashedRecordFileName(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest}.json`;
}

export function resolveRuntimeRootPath(runtimeRoot?: string): string {
  return runtimeRoot ? path.resolve(runtimeRoot) : path.join(getPulseedDirPath(), "runtime");
}

export function runtimeDateKey(timestamp: number | Date = Date.now()): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return date.toISOString().slice(0, 10);
}

export function createRuntimeStorePaths(runtimeRoot?: string): RuntimeStorePaths {
  const rootDir = resolveRuntimeRootPath(runtimeRoot);
  const leaderDir = path.join(rootDir, "leader");
  const inboxDir = path.join(rootDir, "inbox");
  const claimsDir = path.join(rootDir, "claims");
  const completedDir = path.join(rootDir, "completed");
  const completedByIdempotencyDir = path.join(completedDir, "by-idempotency");
  const completedByMessageDir = path.join(completedDir, "by-message");
  const approvalsDir = path.join(rootDir, "approvals");
  const approvalsPendingDir = path.join(approvalsDir, "pending");
  const approvalsResolvedDir = path.join(approvalsDir, "resolved");
  const permissionGrantsDir = path.join(rootDir, "permission-grants");
  const outboxDir = path.join(rootDir, "outbox");
  const backgroundRunsDir = path.join(rootDir, "background-runs");
  const authHandoffsDir = path.join(rootDir, "auth-handoffs");
  const browserSessionsDir = path.join(rootDir, "browser-sessions");
  const evidenceLedgerDir = path.join(rootDir, "evidence-ledger");
  const evidenceLedgerGoalsDir = path.join(evidenceLedgerDir, "goals");
  const evidenceLedgerRunsDir = path.join(evidenceLedgerDir, "runs");
  const safePausesDir = path.join(rootDir, "safe-pauses");
  const leasesDir = path.join(rootDir, "leases");
  const goalLeasesDir = path.join(leasesDir, "goal");
  const dlqDir = path.join(rootDir, "dlq");
  const healthDir = path.join(rootDir, "health");
  const guardrailsDir = path.join(rootDir, "guardrails");
  const guardrailBreakersDir = path.join(guardrailsDir, "breakers");
  const proactiveInterventionsDir = path.join(rootDir, "proactive-interventions");
  const reproducibilityManifestsDir = path.join(rootDir, "reproducibility-manifests");
  const experimentQueuesDir = path.join(rootDir, "experiment-queues");
  const budgetsDir = path.join(rootDir, "budgets");
  const operatorHandoffsDir = path.join(rootDir, "operator-handoffs");
  const postmortemsDir = path.join(rootDir, "postmortems");

  return {
    rootDir,
    leaderDir,
    leaderPath: path.join(leaderDir, "leader.json"),
    inboxDir,
    claimsDir,
    completedDir,
    completedByIdempotencyDir,
    completedByMessageDir,
    approvalsDir,
    approvalsPendingDir,
    approvalsResolvedDir,
    permissionGrantsDir,
    outboxDir,
    backgroundRunsDir,
    authHandoffsDir,
    browserSessionsDir,
    evidenceLedgerDir,
    evidenceLedgerGoalsDir,
    evidenceLedgerRunsDir,
    safePausesDir,
    leasesDir,
    goalLeasesDir,
    dlqDir,
    healthDir,
    guardrailsDir,
    guardrailBreakersDir,
    proactiveInterventionsDir,
    reproducibilityManifestsDir,
    experimentQueuesDir,
    budgetsDir,
    operatorHandoffsDir,
    postmortemsDir,
    backpressureSnapshotPath: path.join(guardrailsDir, "backpressure.json"),
    proactiveInterventionLedgerPath: path.join(proactiveInterventionsDir, "events.jsonl"),
    daemonHealthPath: path.join(healthDir, "daemon.json"),
    componentsHealthPath: path.join(healthDir, "components.json"),
    inboxBucketDir(dateKey: string) {
      return path.join(inboxDir, dateKey);
    },
    inboxRecordPath(dateKey: string, messageId: string) {
      return path.join(inboxDir, dateKey, recordFileName(messageId));
    },
    approvalPendingPath(approvalId: string) {
      return path.join(approvalsPendingDir, recordFileName(approvalId));
    },
    approvalResolvedPath(approvalId: string) {
      return path.join(approvalsResolvedDir, recordFileName(approvalId));
    },
    permissionGrantPath(grantId: string) {
      return path.join(permissionGrantsDir, recordFileName(encodeRuntimePathSegment(grantId)));
    },
    outboxRecordPath(seq: number) {
      return path.join(outboxDir, outboxFileName(seq));
    },
    backgroundRunPath(runId: string) {
      return path.join(backgroundRunsDir, recordFileName(encodeRuntimePathSegment(runId)));
    },
    authHandoffPath(handoffId: string) {
      return path.join(authHandoffsDir, recordFileName(encodeRuntimePathSegment(handoffId)));
    },
    browserSessionPath(sessionId: string) {
      return path.join(browserSessionsDir, recordFileName(encodeRuntimePathSegment(sessionId)));
    },
    evidenceGoalPath(goalId: string) {
      return path.join(evidenceLedgerGoalsDir, `${encodeRuntimePathSegment(goalId)}.jsonl`);
    },
    evidenceRunPath(runId: string) {
      return path.join(evidenceLedgerRunsDir, `${encodeRuntimePathSegment(runId)}.jsonl`);
    },
    safePausePath(goalId: string) {
      return path.join(safePausesDir, `${encodeRuntimePathSegment(goalId)}.json`);
    },
    guardrailBreakerPath(key: string) {
      return path.join(guardrailBreakersDir, recordFileName(encodeRuntimePathSegment(key)));
    },
    reproducibilityManifestPath(manifestId: string) {
      return path.join(reproducibilityManifestsDir, recordFileName(encodeRuntimePathSegment(manifestId)));
    },
    experimentQueuePath(queueId: string) {
      return path.join(experimentQueuesDir, recordFileName(encodeRuntimePathSegment(queueId)));
    },
    budgetPath(budgetId: string) {
      return path.join(budgetsDir, recordFileName(encodeRuntimePathSegment(budgetId)));
    },
    operatorHandoffPath(handoffId: string) {
      return path.join(operatorHandoffsDir, recordFileName(encodeRuntimePathSegment(handoffId)));
    },
    postmortemDir(postmortemId: string) {
      return path.join(postmortemsDir, encodeRuntimePathSegment(postmortemId));
    },
    postmortemJsonPath(postmortemId: string) {
      return path.join(postmortemsDir, encodeRuntimePathSegment(postmortemId), "postmortem.json");
    },
    postmortemMarkdownPath(postmortemId: string) {
      return path.join(postmortemsDir, encodeRuntimePathSegment(postmortemId), "postmortem.md");
    },
    goalLeasePath(goalId: string) {
      return path.join(goalLeasesDir, `${encodeRuntimePathSegment(goalId)}.json`);
    },
    completedByIdempotencyPath(idempotencyKey: string) {
      return path.join(completedByIdempotencyDir, hashedRecordFileName(idempotencyKey));
    },
    completedByMessagePath(messageId: string) {
      return path.join(completedByMessageDir, recordFileName(messageId));
    },
    dlqPath(dateKey: string) {
      return path.join(dlqDir, `${dateKey}.jsonl`);
    },
  };
}

export async function ensureRuntimeStorePaths(paths: RuntimeStorePaths): Promise<void> {
  await Promise.all(
    [
      paths.rootDir,
      paths.leaderDir,
      paths.inboxDir,
      paths.claimsDir,
      paths.completedDir,
      paths.completedByIdempotencyDir,
      paths.completedByMessageDir,
      paths.approvalsDir,
      paths.approvalsPendingDir,
      paths.approvalsResolvedDir,
      paths.permissionGrantsDir,
      paths.outboxDir,
      paths.backgroundRunsDir,
      paths.authHandoffsDir,
      paths.browserSessionsDir,
      paths.evidenceLedgerDir,
      paths.evidenceLedgerGoalsDir,
      paths.evidenceLedgerRunsDir,
      paths.safePausesDir,
      paths.leasesDir,
      paths.goalLeasesDir,
      paths.dlqDir,
      paths.healthDir,
      paths.guardrailsDir,
      paths.guardrailBreakersDir,
      paths.proactiveInterventionsDir,
      paths.reproducibilityManifestsDir,
      paths.experimentQueuesDir,
      paths.budgetsDir,
      paths.operatorHandoffsDir,
      paths.postmortemsDir,
    ].map((dir) => fsp.mkdir(dir, { recursive: true }))
  );
}
