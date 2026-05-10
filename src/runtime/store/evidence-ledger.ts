import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  createRuntimeStorePaths,
  encodeRuntimePathSegment,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  RuntimeEvidenceStateStore,
  type RuntimeEvidenceScopeKey,
} from "./runtime-evidence-state-store.js";
import {
  correctionStateForTarget,
  MemoryCorrectionEntrySchema,
  summarizeMemoryCorrectionState,
  type MemoryCorrectionEntry,
  type MemoryCorrectionEntryInput,
  type MemoryCorrectionTargetState,
  type MemoryCorrectionTargetRef,
} from "../../platform/corrections/memory-correction-ledger.js";
import {
  type MemoryProvenance,
} from "../../platform/corrections/memory-quarantine.js";
import {
  extractMetricObservationsFromEvidence,
  summarizeEvidenceMetricTrends,
  type MetricObservation,
} from "./metric-history.js";
import {
  summarizeEvidenceEvaluatorResults,
  type RuntimeEvaluatorCalibrationContext,
  type RuntimeEvaluatorSummary,
} from "./evaluator-results.js";
import {
  summarizeEvidenceResearchMemos,
} from "./research-evidence.js";
import {
  summarizeEvidenceDreamCheckpoints,
  type RuntimeDreamCheckpointContext,
} from "./dream-checkpoints.js";
import {
  summarizeArtifactRetention,
} from "./artifact-retention.js";
import type {
  CandidateComparableMetric,
  ComparableEvidenceMetric,
  ComparableMetricKey,
  RuntimeCandidateLineageContext,
  RuntimeCandidatePortfolioSlot,
  RuntimeCandidateSelectionCandidate,
  RuntimeCandidateSelectionSummary,
  RuntimeDiversifiedCandidatePortfolioOptions,
  RuntimeEvidenceSummary,
  RuntimeEvidenceSummaryIndex,
  RuntimeEvidenceSummaryMetricObservationState,
  RuntimeFailedLineageContext,
  RuntimeNearMissCandidateContext,
} from "./runtime-evidence-summary-types.js";
export type {
  CandidateComparableMetric,
  RuntimeCandidateLineageContext,
  RuntimeCandidatePortfolioSlot,
  RuntimeCandidateSelectionCandidate,
  RuntimeCandidateSelectionSummary,
  RuntimeDiversifiedCandidatePortfolioOptions,
  RuntimeEvidenceSummary,
  RuntimeEvidenceSummaryIndex,
  RuntimeFailedLineageContext,
  RuntimeNearMissCandidateContext,
} from "./runtime-evidence-summary-types.js";

interface RuntimeEvidenceReproducibilityManifest {
  schema_version: "runtime-reproducibility-manifest-v1";
  scope: {
    goal_id?: string;
    run_id?: string;
  };
  artifacts: Array<{
    label: string;
    path?: string;
    state_relative_path?: string;
    url?: string;
  }>;
}

const RuntimeEvidenceReproducibilityManifestSchema = z.object({
  schema_version: z.literal("runtime-reproducibility-manifest-v1"),
  manifest_id: z.string().min(1),
  generated_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  scope: z.object({
    goal_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
  }).strict(),
  finalization_preflight: z.object({
    manifest_required_before_delivery: z.boolean().default(true),
    approval_required_before_external_submission: z.boolean().default(true),
    status: z.enum(["manifest_ready", "manifest_incomplete"]),
    missing: z.array(z.string().min(1)).default([]),
  }).strict(),
  code_state: z.object({
    commit: z.string().min(1).optional(),
    dirty: z.boolean().optional(),
    diff_sha256: z.string().min(1).optional(),
    source: z.string().min(1).default("provided"),
  }).strict(),
  artifacts: z.array(z.unknown()).default([]),
}).passthrough();

import {
  RuntimeEvidenceEntrySchema,
  type RuntimeEvidenceCandidateDisposition,
  type RuntimeEvidenceCandidateNearMiss,
  type RuntimeEvidenceCandidateNearMissReason,
  type RuntimeEvidenceCandidateRecord,
  type RuntimeEvidenceCandidateSimilarity,
  type RuntimeEvidenceEntry,
  type RuntimeEvidenceEntryInput,
  type RuntimeEvidenceMetric,
  type RuntimeEvidenceReadResult,
  type RuntimeEvidenceReadWarning,
} from "./evidence-types.js";
export {
  RuntimeArtifactRetentionClassSchema,
  RuntimeEvidenceArtifactRefSchema,
  RuntimeEvidenceCandidateDispositionSchema,
  RuntimeEvidenceCandidateLineageSchema,
  RuntimeEvidenceCandidateNearMissReasonSchema,
  RuntimeEvidenceCandidateNearMissSchema,
  RuntimeEvidenceCandidateRecordSchema,
  RuntimeEvidenceCandidateSimilaritySchema,
  RuntimeEvidenceDivergentHypothesisSchema,
  RuntimeEvidenceDreamCheckpointSchema,
  RuntimeEvidenceDreamCheckpointActiveHypothesisSchema,
  RuntimeEvidenceDreamCheckpointMemoryRefSchema,
  RuntimeEvidenceDreamCheckpointRejectedApproachSchema,
  RuntimeEvidenceDreamCheckpointStrategyCandidateSchema,
  RuntimeEvidenceDreamCheckpointTriggerSchema,
  RuntimeEvidenceDreamRunControlRecommendationSchema,
  RuntimeEvidenceEntryKindSchema,
  RuntimeEvidenceEntrySchema,
  RuntimeEvidenceEvaluatorBudgetSchema,
  RuntimeEvidenceEvaluatorCalibrationSchema,
  RuntimeEvidenceEvaluatorCandidateSnapshotSchema,
  RuntimeEvidenceEvaluatorObservationSchema,
  RuntimeEvidenceEvaluatorProvenanceSchema,
  RuntimeEvidenceEvaluatorPublishActionSchema,
  RuntimeEvidenceEvaluatorSignalSchema,
  RuntimeEvidenceEvaluatorStatusSchema,
  RuntimeEvidenceEvaluatorValidationSchema,
  RuntimeEvidenceMetricSchema,
  RuntimeEvidenceMemoryUsageStatsSchema,
  RuntimeEvidenceOutcomeSchema,
  RuntimeEvidenceResearchExternalActionSchema,
  RuntimeEvidenceResearchFindingSchema,
  RuntimeEvidenceResearchMemoSchema,
  RuntimeEvidenceResearchSourceSchema,
  RuntimeEvidenceScalarValueSchema,
} from "./evidence-types.js";
export type {
  RuntimeArtifactRetentionClass,
  RuntimeEvidenceArtifactRef,
  RuntimeEvidenceCandidateDisposition,
  RuntimeEvidenceCandidateLineage,
  RuntimeEvidenceCandidateNearMiss,
  RuntimeEvidenceCandidateNearMissReason,
  RuntimeEvidenceCandidateRecord,
  RuntimeEvidenceCandidateSimilarity,
  RuntimeEvidenceDivergentHypothesis,
  RuntimeEvidenceDreamCheckpoint,
  RuntimeEvidenceDreamCheckpointActiveHypothesis,
  RuntimeEvidenceDreamCheckpointMemoryRef,
  RuntimeEvidenceDreamCheckpointRejectedApproach,
  RuntimeEvidenceDreamCheckpointStrategyCandidate,
  RuntimeEvidenceDreamCheckpointTrigger,
  RuntimeEvidenceDreamRunControlRecommendation,
  RuntimeEvidenceEntry,
  RuntimeEvidenceEntryInput,
  RuntimeEvidenceEntryKind,
  RuntimeEvidenceEvaluatorBudget,
  RuntimeEvidenceEvaluatorCalibration,
  RuntimeEvidenceEvaluatorCandidateSnapshot,
  RuntimeEvidenceEvaluatorObservation,
  RuntimeEvidenceEvaluatorProvenance,
  RuntimeEvidenceEvaluatorPublishAction,
  RuntimeEvidenceEvaluatorSignal,
  RuntimeEvidenceEvaluatorStatus,
  RuntimeEvidenceEvaluatorValidation,
  RuntimeEvidenceMetric,
  RuntimeEvidenceMemoryUsageStats,
  RuntimeEvidenceOutcome,
  RuntimeEvidenceReadResult,
  RuntimeEvidenceReadWarning,
  RuntimeEvidenceResearchMemo,
  RuntimeEvidenceResearchExternalAction,
  RuntimeEvidenceResearchFinding,
  RuntimeEvidenceResearchSource,
  RuntimeEvidenceScalarValue,
} from "./evidence-types.js";
const summaryIndexUpdateLocks = new Map<string, Promise<void>>();

export interface RuntimeEvidenceLedgerPort {
  append(input: RuntimeEvidenceEntryInput): Promise<RuntimeEvidenceEntry[]>;
  appendCorrection?(input: MemoryCorrectionEntryInput & {
    scope: RuntimeEvidenceEntry["scope"];
    evidence_id?: string;
  }): Promise<MemoryCorrectionEntry>;
  readByGoal?(goalId: string): Promise<RuntimeEvidenceReadResult>;
  readByRun?(runId: string): Promise<RuntimeEvidenceReadResult>;
  summarizeGoal?(goalId: string): Promise<RuntimeEvidenceSummary>;
  summarizeRun?(runId: string): Promise<RuntimeEvidenceSummary>;
  rebuildSummaryIndexForGoal?(goalId: string): Promise<RuntimeEvidenceSummary>;
  rebuildSummaryIndexForRun?(runId: string): Promise<RuntimeEvidenceSummary>;
}

export class RuntimeEvidenceLedger implements RuntimeEvidenceLedgerPort {
  private readonly paths: RuntimeStorePaths;
  private readonly store: RuntimeEvidenceStateStore;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.store = new RuntimeEvidenceStateStore(this.paths);
  }

  async ensureReady(): Promise<void> {
    await this.store.ensureReady();
  }

  goalPath(goalId: string): string {
    return legacyEvidenceScopePath(this.paths.rootDir, "goals", goalId);
  }

  runPath(runId: string): string {
    return legacyEvidenceScopePath(this.paths.rootDir, "runs", runId);
  }

  async append(input: RuntimeEvidenceEntryInput): Promise<RuntimeEvidenceEntry[]> {
    const entry = RuntimeEvidenceEntrySchema.parse({
      schema_version: "runtime-evidence-entry-v1",
      id: input.id ?? randomUUID(),
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      metrics: input.metrics ?? [],
      evaluators: input.evaluators ?? [],
      research: input.research ?? [],
      dream_checkpoints: input.dream_checkpoints ?? [],
      divergent_exploration: input.divergent_exploration ?? [],
      candidates: input.candidates ?? [],
      artifacts: input.artifacts ?? [],
      raw_refs: input.raw_refs ?? [],
      ...input,
    });
    await this.ensureReady();

    const scopes = scopesForEntry(entry);
    await this.store.append(entry);
    await Promise.all(scopes.map(async (scope) => {
      await withSummaryIndexUpdateLock(summaryIndexKey(scope), async () => {
        await rebuildSummaryIndexForScope(scope, this.paths, this.store);
      });
    }));
    return [entry];
  }

  async appendCorrection(input: MemoryCorrectionEntryInput & {
    scope: RuntimeEvidenceEntry["scope"];
    evidence_id?: string;
  }): Promise<MemoryCorrectionEntry> {
    const { scope, evidence_id, ...correctionInput } = input;
    const correction = MemoryCorrectionEntrySchema.parse(correctionInput);
    await this.append({
      id: evidence_id ?? correction.correction_id,
      occurred_at: correction.created_at,
      kind: "correction",
      scope,
      correction,
      summary: correction.reason,
      raw_refs: [{
        kind: correction.target_ref.kind,
        id: correction.target_ref.id,
      }],
    });
    return correction;
  }

  async readByGoal(goalId: string): Promise<RuntimeEvidenceReadResult> {
    return this.store.readByGoal(goalId);
  }

  async readByRun(runId: string): Promise<RuntimeEvidenceReadResult> {
    return this.store.readByRun(runId);
  }

  async summarizeGoal(goalId: string): Promise<RuntimeEvidenceSummary> {
    const scope = evidenceGoalScope(goalId);
    const manifests = await readReproducibilityManifests(this.paths, { goal_id: goalId });
    const indexed = manifests.length === 0
      ? await readDbSummaryIndex(scope, this.store)
      : null;
    if (indexed) return indexed.summary;
    const read = await this.readByGoal(goalId);
    const summary = summarizeEvidence({ goal_id: goalId }, read, manifests);
    return summary;
  }

  async summarizeRun(runId: string): Promise<RuntimeEvidenceSummary> {
    const scope = evidenceRunScope(runId);
    const manifests = await readReproducibilityManifests(this.paths, { run_id: runId });
    const indexed = manifests.length === 0
      ? await readDbSummaryIndex(scope, this.store)
      : null;
    if (indexed) return indexed.summary;
    const read = await this.readByRun(runId);
    const summary = summarizeEvidence({ run_id: runId }, read, manifests);
    return summary;
  }

  async rebuildSummaryIndexForGoal(goalId: string): Promise<RuntimeEvidenceSummary> {
    return rebuildSummaryIndexForScope(evidenceGoalScope(goalId), this.paths, this.store);
  }

  async rebuildSummaryIndexForRun(runId: string): Promise<RuntimeEvidenceSummary> {
    return rebuildSummaryIndexForScope(evidenceRunScope(runId), this.paths, this.store);
  }

  async listExtractionRefs(limit?: number) {
    return this.store.listExtractionRefs(limit);
  }
}

function legacyEvidenceScopePath(runtimeRoot: string, scopeDir: "goals" | "runs", scopeId: string): string {
  return path.join(runtimeRoot, "evidence-ledger", scopeDir, `${encodeRuntimePathSegment(scopeId)}.jsonl`);
}

function evidenceGoalScope(goalId: string): RuntimeEvidenceScopeKey {
  return { kind: "goal", id: goalId };
}

function evidenceRunScope(runId: string): RuntimeEvidenceScopeKey {
  return { kind: "run", id: runId };
}

function scopesForEntry(entry: RuntimeEvidenceEntry): RuntimeEvidenceScopeKey[] {
  const scopes: RuntimeEvidenceScopeKey[] = [];
  if (entry.scope.goal_id) scopes.push(evidenceGoalScope(entry.scope.goal_id));
  if (entry.scope.run_id) scopes.push(evidenceRunScope(entry.scope.run_id));
  return scopes;
}

function scopeToSummaryScope(scope: RuntimeEvidenceScopeKey): RuntimeEvidenceSummary["scope"] {
  return scope.kind === "goal" ? { goal_id: scope.id } : { run_id: scope.id };
}

function summaryIndexKey(scope: RuntimeEvidenceScopeKey): string {
  return `control-db://runtime-evidence/${scope.kind}/${scope.id}`;
}

async function readDbSummaryIndex(
  scope: RuntimeEvidenceScopeKey,
  store: RuntimeEvidenceStateStore
): Promise<RuntimeEvidenceSummaryIndex | null> {
  const indexed = await store.loadSummaryIndex(scope);
  if (!indexed) return null;
  if (indexed.summary.schema_version !== "runtime-evidence-summary-v1") return null;
  if (!isCurrentEvidenceSummaryShape(indexed.summary)) return null;
  const summaryScope = scopeToSummaryScope(scope);
  if (summaryScope.goal_id && indexed.summary.scope.goal_id !== summaryScope.goal_id) return null;
  if (summaryScope.run_id && indexed.summary.scope.run_id !== summaryScope.run_id) return null;
  return indexed;
}

async function rebuildSummaryIndexForScope(
  scope: RuntimeEvidenceScopeKey,
  paths: RuntimeStorePaths,
  store: RuntimeEvidenceStateStore
): Promise<RuntimeEvidenceSummary> {
  const summaryScope = scopeToSummaryScope(scope);
  const read = scope.kind === "goal" ? await store.readByGoal(scope.id) : await store.readByRun(scope.id);
  const manifests = await readReproducibilityManifests(paths, summaryScope);
  const summary = summarizeEvidence(summaryScope, read, manifests);
  const activeRead = manifests.length === 0 ? activeEvidenceRead(read) : null;
  if (activeRead) {
    await writeDbSummaryIndex(scope, summary, store, {
      warnings: read.warnings,
      primaryMetric: resolvePrimaryMetricKey([...activeRead.entries].reverse()) ?? undefined,
      metricObservationState: buildMetricObservationState(activeRead.entries),
    });
  }
  return summary;
}

async function writeDbSummaryIndex(
  scope: RuntimeEvidenceScopeKey,
  summary: RuntimeEvidenceSummary,
  store: RuntimeEvidenceStateStore,
  checkpointRead?: {
    warnings: RuntimeEvidenceReadWarning[];
    primaryMetric?: ComparableMetricKey;
    metricObservationState?: RuntimeEvidenceSummaryMetricObservationState[];
  }
): Promise<void> {
  const warnings = checkpointRead ? checkpointRead.warnings : [];
  const index: RuntimeEvidenceSummaryIndex = {
    schema_version: "runtime-evidence-summary-index-v1",
    generated_at: new Date().toISOString(),
    canonical_log_path: summaryIndexKey(scope),
    canonical_log_size: 0,
    canonical_log_mtime_ms: 0,
    summary,
    append_state: {
      schema_version: "runtime-evidence-summary-append-state-v1",
      warnings,
      ...(checkpointRead && "primaryMetric" in checkpointRead && checkpointRead.primaryMetric
        ? { primary_metric: checkpointRead.primaryMetric }
        : {}),
      metric_observations: checkpointRead && "metricObservationState" in checkpointRead
        ? checkpointRead.metricObservationState
        : buildMetricObservationState(summary.recent_entries),
    },
  };
  await store.saveSummaryIndex(scope, index);
}

async function withSummaryIndexUpdateLock<T>(canonicalPath: string, action: () => Promise<T>): Promise<T> {
  const previous = summaryIndexUpdateLocks.get(canonicalPath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  summaryIndexUpdateLocks.set(canonicalPath, next);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (summaryIndexUpdateLocks.get(canonicalPath) === next) {
      summaryIndexUpdateLocks.delete(canonicalPath);
    }
  }
}

async function readReproducibilityManifests(
  paths: RuntimeStorePaths,
  scope: RuntimeEvidenceSummary["scope"]
): Promise<RuntimeEvidenceReproducibilityManifest[]> {
  let fileNames: string[];
  try {
    fileNames = await fsp.readdir(paths.reproducibilityManifestsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const manifests: RuntimeEvidenceReproducibilityManifest[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    if (!reproducibilityManifestFileMayMatchScope(fileName, scope)) continue;
    const manifest = await readReproducibilityManifestFile(path.join(paths.reproducibilityManifestsDir, fileName));
    if (!manifest) continue;
    if (scope.goal_id && manifest.scope.goal_id !== scope.goal_id) continue;
    if (scope.run_id && manifest.scope.run_id !== scope.run_id) continue;
    manifests.push(manifest);
  }
  return manifests;
}

async function readReproducibilityManifestFile(filePath: string): Promise<RuntimeEvidenceReproducibilityManifest | null> {
  const raw = await fsp.readFile(filePath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }

  const parsed = RuntimeEvidenceReproducibilityManifestSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  return {
    schema_version: parsed.data.schema_version,
    scope: parsed.data.scope,
    artifacts: parsed.data.artifacts.filter(isManifestArtifactRef),
  };
}

function reproducibilityManifestFileMayMatchScope(
  fileName: string,
  scope: RuntimeEvidenceSummary["scope"]
): boolean {
  const basename = fileName.slice(0, -".json".length);
  let manifestId: string;
  try {
    manifestId = decodeURIComponent(basename);
  } catch {
    return true;
  }

  if (scope.run_id && manifestId.startsWith("run:")) {
    return basename.startsWith(`${encodeRuntimePathSegment(`run:${safeManifestScopeId(scope.run_id)}:`)}`);
  }
  if (scope.goal_id && manifestId.startsWith("goal:")) {
    return basename.startsWith(`${encodeRuntimePathSegment(`goal:${safeManifestScopeId(scope.goal_id)}:`)}`);
  }
  if (scope.goal_id && manifestId.startsWith("run:")) {
    return true;
  }
  if (manifestId.startsWith("run:") || manifestId.startsWith("goal:")) {
    return false;
  }
  return true;
}

function safeManifestScopeId(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9:._-]+/g, "_");
}

function isManifestArtifactRef(value: unknown): value is RuntimeEvidenceReproducibilityManifest["artifacts"][number] {
  return typeof value === "object"
    && value !== null
    && typeof (value as { label?: unknown }).label === "string"
    && ((value as { path?: unknown }).path === undefined || typeof (value as { path?: unknown }).path === "string")
    && (
      (value as { state_relative_path?: unknown }).state_relative_path === undefined
      || typeof (value as { state_relative_path?: unknown }).state_relative_path === "string"
    )
    && ((value as { url?: unknown }).url === undefined || typeof (value as { url?: unknown }).url === "string")
    && (
      (value as { size_bytes?: unknown }).size_bytes === undefined
      || isSafeNonnegativeInteger((value as { size_bytes?: unknown }).size_bytes)
    );
}

function isCurrentEvidenceSummaryShape(summary: RuntimeEvidenceSummary): boolean {
  return summary.context_policy_version === "quarantine-filtered-planning-context-v2"
    && Array.isArray(summary.candidate_lineages)
    && Array.isArray(summary.corrections)
    && typeof summary.correction_state === "object"
    && summary.correction_state !== null
    && Array.isArray(summary.recommended_candidate_portfolio)
    && Array.isArray(summary.near_miss_candidates)
    && typeof summary.artifact_retention === "object"
    && summary.artifact_retention !== null
    && isCurrentArtifactRetentionShape(summary.artifact_retention)
    && isCurrentSummaryEntry(summary.latest_strategy)
    && isCurrentSummaryEntry(summary.best_evidence)
    && Array.isArray(summary.recent_entries)
    && summary.recent_entries.every((entry) => isCurrentSummaryEntry(entry))
    && Array.isArray(summary.recent_failed_attempts)
    && summary.recent_failed_attempts.every((entry) => isCurrentSummaryEntry(entry))
    && Array.isArray(summary.evaluator_summary.budgets)
    && Array.isArray(summary.evaluator_summary.calibration)
    && typeof summary.candidate_selection_summary === "object"
    && summary.candidate_selection_summary !== null;
}

function isCurrentSummaryEntry(value: unknown): value is RuntimeEvidenceEntry | null {
  return value === null || RuntimeEvidenceEntrySchema.safeParse(value).success;
}

function isCurrentArtifactRetentionShape(
  artifactRetention: RuntimeEvidenceSummary["artifact_retention"]
): boolean {
  const cleanupPlan = artifactRetention.cleanup_plan;
  if (
    !isSafeNonnegativeInteger(artifactRetention.total_artifacts)
    || !isSafeNonnegativeInteger(artifactRetention.total_size_bytes)
    || !isSafeNonnegativeInteger(artifactRetention.unknown_size_count)
    || !isSafeNonnegativeInteger(artifactRetention.protected_count)
    || typeof artifactRetention.by_retention_class !== "object"
    || artifactRetention.by_retention_class === null
    || Object.values(artifactRetention.by_retention_class).some((value) => !isSafeNonnegativeInteger(value))
    || typeof cleanupPlan !== "object"
    || cleanupPlan === null
    || !Array.isArray(cleanupPlan.actions)
  ) {
    return false;
  }
  return cleanupPlan.actions.every((action) =>
    typeof action.retention_basis === "string"
    && (action.size_bytes === undefined || isSafeNonnegativeInteger(action.size_bytes))
  );
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function activeEvidenceRead(read: RuntimeEvidenceReadResult): RuntimeEvidenceReadResult {
  const entries = [...read.entries].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const corrections = entries.flatMap((entry) => entry.correction ? [entry.correction] : []);
  const correctionState = summarizeMemoryCorrectionState(corrections);
  return {
    entries: entries.filter((entry) => isRuntimeEvidenceEntryActive(entry, correctionState)),
    warnings: read.warnings,
  };
}

function buildMetricObservationState(entries: RuntimeEvidenceEntry[]): RuntimeEvidenceSummaryMetricObservationState[] {
  return updateMetricObservationState([], entries);
}

function updateMetricObservationState(
  previous: RuntimeEvidenceSummaryMetricObservationState[] | null,
  appendedEntries: RuntimeEvidenceEntry[]
): RuntimeEvidenceSummaryMetricObservationState[] {
  const groups = new Map<string, RuntimeEvidenceSummaryMetricObservationState>();
  for (const group of previous ?? []) {
    groups.set(`${group.metric_key}\0${group.direction}`, {
      ...group,
      recent: [...group.recent],
    });
  }
  for (const observation of extractMetricObservationsFromEvidence(appendedEntries).sort((a, b) =>
    a.observed_at.localeCompare(b.observed_at)
  )) {
    const key = `${observation.metric_key}\0${observation.direction}`;
    const next = updateMetricState(groups.get(key), observation);
    groups.set(key, next);
  }
  return [...groups.values()];
}

function updateMetricState(
  previous: RuntimeEvidenceSummaryMetricObservationState | undefined,
  observation: MetricObservation
): RuntimeEvidenceSummaryMetricObservationState {
  const normalized = observation.direction === "maximize" ? observation.value : -observation.value;
  if (!previous) {
    return {
      metric_key: observation.metric_key,
      direction: observation.direction,
      count: 1,
      confidence_sum: observation.confidence,
      first_value: observation.value,
      first_normalized: normalized,
      first_observed_at: observation.observed_at,
      latest_value: observation.value,
      latest_normalized: normalized,
      latest_observed_at: observation.observed_at,
      best_value: observation.value,
      best_normalized: normalized,
      best_observed_at: observation.observed_at,
      previous_best_normalized: normalized,
      last_meaningful_improvement_delta: null,
      last_meaningful_improvement_observed_at: null,
      last_meaningful_improvement_index: null,
      last_breakthrough_delta: null,
      post_improvement_min_normalized: normalized,
      post_improvement_max_normalized: normalized,
      recent: [{ value: observation.value, normalized, observed_at: observation.observed_at, source: observation.source }],
    };
  }

  const improvementThreshold = 0.01;
  const breakthroughThreshold = 0.05;
  const delta = normalized - previous.latest_normalized;
  const meaningful = delta >= improvementThreshold;
  const breakthrough = delta >= breakthroughThreshold;
  const count = previous.count + 1;
  const bestImproved = normalized > previous.best_normalized;
  const postMin = meaningful ? normalized : Math.min(previous.post_improvement_min_normalized, normalized);
  const postMax = meaningful ? normalized : Math.max(previous.post_improvement_max_normalized, normalized);
  return {
    ...previous,
    count,
    confidence_sum: previous.confidence_sum + observation.confidence,
    latest_value: observation.value,
    latest_normalized: normalized,
    latest_observed_at: observation.observed_at,
    best_value: bestImproved ? observation.value : previous.best_value,
    best_normalized: bestImproved ? normalized : previous.best_normalized,
    best_observed_at: bestImproved ? observation.observed_at : previous.best_observed_at,
    previous_best_normalized: previous.best_normalized,
    last_meaningful_improvement_delta: meaningful ? delta : previous.last_meaningful_improvement_delta,
    last_meaningful_improvement_observed_at: meaningful
      ? observation.observed_at
      : previous.last_meaningful_improvement_observed_at,
    last_meaningful_improvement_index: meaningful ? count - 1 : previous.last_meaningful_improvement_index,
    last_breakthrough_delta: breakthrough ? delta : previous.last_breakthrough_delta,
    post_improvement_min_normalized: postMin,
    post_improvement_max_normalized: postMax,
    recent: [
      ...previous.recent,
      { value: observation.value, normalized, observed_at: observation.observed_at, source: observation.source },
    ].slice(-5),
  };
}

function summarizeEvidence(
  scope: RuntimeEvidenceSummary["scope"],
  read: RuntimeEvidenceReadResult,
  manifests: RuntimeEvidenceReproducibilityManifest[] = []
): RuntimeEvidenceSummary {
  const entries = [...read.entries].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const corrections = entries.flatMap((entry) => entry.correction ? [entry.correction] : []);
  const correctionState = summarizeMemoryCorrectionState(corrections);
  const activeEntries = entries.filter((entry) => isRuntimeEvidenceEntryActive(entry, correctionState));
  const newestFirst = [...activeEntries].reverse();
  const evaluatorSummary = summarizeEvidenceEvaluatorResults(activeEntries);
  const activeDreamCheckpoints = filterRetractedDreamCheckpointMemories(
    summarizeEvidenceDreamCheckpoints(activeEntries),
    correctionState,
    scope
  );
  return {
    schema_version: "runtime-evidence-summary-v1",
    context_policy_version: "quarantine-filtered-planning-context-v2",
    generated_at: new Date().toISOString(),
    scope,
    total_entries: entries.length,
    latest_strategy: newestFirst.find((entry) =>
      entry.kind === "strategy" || Boolean(entry.strategy) || Boolean(entry.decision_reason)
    ) ?? null,
    best_evidence: chooseBestEvidence(newestFirst),
    metric_trends: summarizeEvidenceMetricTrends(activeEntries),
    evaluator_summary: evaluatorSummary,
    research_memos: summarizeEvidenceResearchMemos(activeEntries),
    dream_checkpoints: activeDreamCheckpoints,
    divergent_exploration: activeEntries
      .flatMap((entry) => entry.divergent_exploration ?? [])
      .slice(-10)
      .reverse(),
    corrections,
    correction_state: correctionState,
    candidate_lineages: summarizeCandidateLineages(activeEntries),
    recommended_candidate_portfolio: selectDiversifiedCandidatePortfolio(activeEntries),
    candidate_selection_summary: summarizeCandidateSelection(activeEntries, evaluatorSummary),
    near_miss_candidates: summarizeNearMissCandidates(activeEntries),
    artifact_retention: summarizeArtifactRetention(activeEntries, { manifests }),
    recent_failed_attempts: newestFirst
      .filter((entry) =>
        entry.outcome === "failed"
        || entry.outcome === "regressed"
        || entry.kind === "failure"
        || entry.result?.status === "failed"
        || entry.verification?.verdict === "fail"
      )
      .slice(0, 5),
    failed_lineages: summarizeFailedLineages(activeEntries),
    recent_entries: newestFirst.slice(0, 10),
    warnings: read.warnings,
  };
}

function isRuntimeEvidenceEntryActive(
  entry: RuntimeEvidenceEntry,
  correctionState: Record<string, MemoryCorrectionTargetState>
): boolean {
  if (entry.kind === "correction") return false;
  if (entry.quarantine_state?.status === "quarantined") return false;
  if (entry.verification_status === "suspicious" || entry.verification_status === "contradicted") return false;
  if (isSuspiciousProvenance(entry.provenance)) return false;
  return runtimeEvidenceCorrectionRefs(entry).every((ref) =>
    correctionStateForTarget(correctionState, ref).active
  );
}

function runtimeEvidenceCorrectionRefs(entry: RuntimeEvidenceEntry): MemoryCorrectionTargetRef[] {
  const refs: MemoryCorrectionTargetRef[] = [
    { kind: "runtime_evidence", id: entry.id },
  ];
  if (entry.scope.run_id) {
    refs.push({ kind: "runtime_evidence", id: entry.id, scope: { run_id: entry.scope.run_id } });
  }
  if (entry.scope.goal_id) {
    refs.push({ kind: "runtime_evidence", id: entry.id, scope: { goal_id: entry.scope.goal_id } });
  }
  if (entry.scope.goal_id || entry.scope.run_id || entry.scope.task_id) {
    refs.push({
      kind: "runtime_evidence",
      id: entry.id,
      scope: {
        ...(entry.scope.goal_id ? { goal_id: entry.scope.goal_id } : {}),
        ...(entry.scope.run_id ? { run_id: entry.scope.run_id } : {}),
        ...(entry.scope.task_id ? { task_id: entry.scope.task_id } : {}),
      },
    });
  }
  return refs;
}

function filterRetractedDreamCheckpointMemories(
  checkpoints: RuntimeDreamCheckpointContext[],
  correctionState: Record<string, MemoryCorrectionTargetState>,
  scope: RuntimeEvidenceSummary["scope"]
): RuntimeDreamCheckpointContext[] {
  return checkpoints
    .map((checkpoint) => {
      const relevant_memories = checkpoint.relevant_memories.filter((memory) =>
        isDreamCheckpointMemoryRefAdmissible(memory)
        && (!memory.ref || dreamMemoryCorrectionRefs(memory.ref, checkpoint, scope).every((ref) =>
          correctionStateForTarget(correctionState, ref).active
        ))
      );
      return {
        checkpoint,
        relevant_memories,
        planning_context_status: relevant_memories.length === checkpoint.relevant_memories.length
          ? "active" as const
          : "partially_retracted" as const,
      };
    })
    .filter(({ checkpoint, relevant_memories }) =>
      checkpoint.relevant_memories.length === 0 || relevant_memories.length > 0
    )
    .map(({ checkpoint, relevant_memories, planning_context_status }) => ({
      ...checkpoint,
      relevant_memories,
      planning_context_status,
    }));
}

function isDreamCheckpointMemoryRefAdmissible(
  memory: RuntimeDreamCheckpointContext["relevant_memories"][number]
): boolean {
  if (memory.quarantine_state?.status === "quarantined") return false;
  if (memory.verification_status === "suspicious" || memory.verification_status === "contradicted") return false;
  if (isSuspiciousProvenance(memory.provenance)) return false;
  if (
    memory.provenance
    && (memory.provenance.source_type === "web" || memory.provenance.source_type === "external")
    && memory.provenance.reliability !== undefined
    && memory.provenance.reliability < 0.5
  ) {
    return false;
  }
  return true;
}

function isSuspiciousProvenance(provenance: MemoryProvenance | undefined): boolean {
  if (!provenance) return false;
  if (provenance.verification_status === "suspicious" || provenance.verification_status === "contradicted") {
    return true;
  }
  const riskSignals = new Set(provenance.risk_signals);
  return riskSignals.has("hallucinated")
    || riskSignals.has("low_provenance")
    || riskSignals.has("contradiction")
    || riskSignals.has("prompt_injection_like")
    || riskSignals.has("unverified_external");
}

function dreamMemoryCorrectionRefs(
  ref: string,
  checkpoint: RuntimeDreamCheckpointContext,
  scope: RuntimeEvidenceSummary["scope"]
): MemoryCorrectionTargetRef[] {
  const refs: MemoryCorrectionTargetRef[] = [{ kind: "dream_checkpoint", id: ref }];
  if (checkpoint.run_id) refs.push({ kind: "dream_checkpoint", id: ref, scope: { run_id: checkpoint.run_id } });
  if (checkpoint.goal_id) refs.push({ kind: "dream_checkpoint", id: ref, scope: { goal_id: checkpoint.goal_id } });
  if (scope.run_id) refs.push({ kind: "dream_checkpoint", id: ref, scope: { run_id: scope.run_id } });
  if (scope.goal_id) refs.push({ kind: "dream_checkpoint", id: ref, scope: { goal_id: scope.goal_id } });
  return refs;
}

interface CandidateEvidenceContext {
  entry_id: string;
  occurred_at: string;
  candidate: RuntimeEvidenceCandidateRecord;
  metric: CandidateComparableMetric | null;
}

export function selectDiversifiedCandidatePortfolio(
  entriesOldestFirst: RuntimeEvidenceEntry[],
  options: RuntimeDiversifiedCandidatePortfolioOptions = {}
): RuntimeCandidatePortfolioSlot[] {
  const limit = options.limit ?? 3;
  if (limit <= 0) return [];
  const nearDuplicateSimilarity = options.nearDuplicateSimilarity ?? 0.85;
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const candidates = extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)
    .filter((context) => context.candidate.disposition !== "retired")
    .sort(compareCandidateEvidenceContexts);
  const selected: Array<CandidateEvidenceContext & {
    role: RuntimeCandidatePortfolioSlot["role"];
    similarity_to_selected?: RuntimeEvidenceCandidateSimilarity;
  }> = [];
  const skipped: Array<CandidateEvidenceContext & { similarity_to_selected?: RuntimeEvidenceCandidateSimilarity }> = [];

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const duplicateSignal = mostSimilarSelectedCandidate(candidate, selected);
    if (duplicateSignal && duplicateSignal.similarity >= nearDuplicateSimilarity) {
      skipped.push({ ...candidate, similarity_to_selected: duplicateSignal });
      continue;
    }
    selected.push({
      ...candidate,
      role: selected.length === 0 ? "top_metric" : "diverse_representative",
      ...(duplicateSignal ? { similarity_to_selected: duplicateSignal } : {}),
    });
  }

  for (const candidate of skipped) {
    if (selected.length >= limit) break;
    selected.push({
      ...candidate,
      role: "lineage_representative",
    });
  }

  return selected.map(toPortfolioSlot);
}

function summarizeCandidateSelection(
  entriesOldestFirst: RuntimeEvidenceEntry[],
  evaluatorSummary?: RuntimeEvaluatorSummary
): RuntimeCandidateSelectionSummary {
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const contexts = extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)
    .filter((context) => context.candidate.disposition !== "retired");
  const rawRanked = [...contexts].sort(compareCandidateEvidenceContexts);
  const scored = scoreCandidateSelectionContexts(rawRanked, evaluatorSummary?.calibration ?? []);
  const ranked = [...scored].sort((a, b) => b.robust_score - a.robust_score || a.raw_rank - b.raw_rank);
  const rawBest = scored.find((candidate) => candidate.raw_rank === 1) ?? null;
  const robustBest = ranked[0] ?? null;

  return {
    primary_metric: primaryMetric,
    raw_best: rawBest,
    robust_best: robustBest,
    ranked,
    final_portfolio: {
      safe: selectSafeCandidate(scored),
      aggressive: rawBest,
      diverse: selectDiverseCandidate(scored, robustBest),
    },
  };
}

function scoreCandidateSelectionContexts(
  rawRanked: CandidateEvidenceContext[],
  calibration: RuntimeEvaluatorCalibrationContext[] = []
): RuntimeCandidateSelectionCandidate[] {
  const metricValues = rawRanked
    .map((context) => context.metric?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const minMetric = metricValues.length > 0 ? Math.min(...metricValues) : 0;
  const maxMetric = metricValues.length > 0 ? Math.max(...metricValues) : 0;
  const rawBestFamily = rawRanked[0]?.candidate.lineage.strategy_family;
  const allCandidates = rawRanked.map((context) => context.candidate);

  return rawRanked.map((context, index) => {
    const candidate = context.candidate;
    const metricScore = normalizedMetricScore(context.metric, minMetric, maxMetric);
    const stabilityScore = clamp01(candidate.robustness?.stability_score ?? context.metric?.confidence ?? 0.5);
    const inferredDiversity = inferredDiversityScore(candidate, rawBestFamily, allCandidates);
    const diversityScore = clamp01(candidate.robustness?.diversity_score === undefined
      ? inferredDiversity
      : Math.min(candidate.robustness.diversity_score, inferredDiversity));
    const riskPenalty = clamp01(candidate.robustness?.risk_penalty ?? 0);
    const evidenceConfidence = clamp01(candidate.robustness?.evidence_confidence ?? context.metric?.confidence ?? 0.5);
    const calibrationAdjustment = evaluatorCalibrationAdjustment(candidate.candidate_id, calibration);
    const robustScore = clamp01(candidate.robustness?.robust_score
      ?? (metricScore * 0.45 + stabilityScore * 0.3 + diversityScore * 0.15 + evidenceConfidence * 0.1 - riskPenalty + calibrationAdjustment));

    return {
      candidate_id: candidate.candidate_id,
      ...(candidate.label ? { label: candidate.label } : {}),
      strategy_family: candidate.lineage.strategy_family,
      evidence_entry_id: context.entry_id,
      raw_rank: index + 1,
      ...(context.metric ? { raw_metric: context.metric } : {}),
      robust_score: roundScore(robustScore),
      calibration_adjustment: roundScore(calibrationAdjustment),
      metric_score: roundScore(metricScore),
      stability_score: roundScore(stabilityScore),
      diversity_score: roundScore(diversityScore),
      risk_penalty: roundScore(riskPenalty),
      evidence_confidence: roundScore(evidenceConfidence),
      reasons: candidateSelectionReasons(candidate, {
        metricScore,
        stabilityScore,
        diversityScore,
        riskPenalty,
        evidenceConfidence,
        calibrationAdjustment,
      }),
    };
  });
}

function evaluatorCalibrationAdjustment(
  candidateId: string,
  calibration: RuntimeEvaluatorCalibrationContext[]
): number {
  const relevant = calibration.filter((item) =>
    item.candidate_id === candidateId
    && item.use_for_selection
    && item.direct_optimization_allowed === false
  );
  if (relevant.length === 0) return 0;
  const average = relevant.reduce((sum, item) => sum + item.selection_adjustment, 0) / relevant.length;
  if (relevant.length < Math.max(...relevant.map((item) => item.minimum_observations))) return 0;
  return Math.min(0.08, Math.max(-0.08, average));
}

function normalizedMetricScore(
  metric: CandidateComparableMetric | null,
  minMetric: number,
  maxMetric: number
): number {
  if (!metric) return 0;
  if (maxMetric === minMetric) return 0.5;
  const distance = metric.direction === "maximize"
    ? (metric.value - minMetric) / (maxMetric - minMetric)
    : (maxMetric - metric.value) / (maxMetric - minMetric);
  return clamp01(distance);
}

function inferredDiversityScore(
  candidate: RuntimeEvidenceCandidateRecord,
  rawBestFamily: string | undefined,
  allCandidates: RuntimeEvidenceCandidateRecord[]
): number {
  if (!rawBestFamily) return 0.5;
  const highestSimilarity = highestKnownSimilarity(candidate, allCandidates);
  const lineageBase = candidate.lineage.strategy_family !== rawBestFamily ? 0.75 : 0.45;
  if (highestSimilarity > 0) return clamp01(Math.min(lineageBase, 1 - highestSimilarity));
  return lineageBase;
}

function highestKnownSimilarity(
  candidate: RuntimeEvidenceCandidateRecord,
  allCandidates: RuntimeEvidenceCandidateRecord[]
): number {
  let highest = candidate.similarity.reduce((max, similarity) => Math.max(max, similarity.similarity), 0);
  for (const other of allCandidates) {
    if (other.candidate_id === candidate.candidate_id) continue;
    for (const similarity of other.similarity) {
      if (similarity.candidate_id === candidate.candidate_id) {
        highest = Math.max(highest, similarity.similarity);
      }
    }
  }
  return highest;
}

function candidateSelectionReasons(
  candidate: RuntimeEvidenceCandidateRecord,
  scores: {
    metricScore: number;
    stabilityScore: number;
    diversityScore: number;
    riskPenalty: number;
    evidenceConfidence: number;
    calibrationAdjustment: number;
  }
): string[] {
  const reasons: string[] = [];
  if (scores.stabilityScore >= 0.8) reasons.push("strong stability evidence");
  if (scores.diversityScore >= 0.8) reasons.push("diverse lineage");
  if (scores.riskPenalty >= 0.15) reasons.push("penalized for overfit-prone lineage or post-processing");
  if (scores.metricScore >= 0.95) reasons.push("top raw metric evidence");
  if (scores.calibrationAdjustment > 0) reasons.push("external feedback calibrates local validation upward");
  if (scores.calibrationAdjustment < 0) reasons.push("external feedback calibrates local validation downward");
  if (candidate.robustness?.summary) reasons.push(candidate.robustness.summary);
  return reasons.length > 0 ? reasons : ["risk-adjusted candidate evidence"];
}

function selectSafeCandidate(
  candidates: RuntimeCandidateSelectionCandidate[]
): RuntimeCandidateSelectionCandidate | null {
  return [...candidates].sort((a, b) =>
    b.stability_score - a.stability_score
    || a.risk_penalty - b.risk_penalty
    || b.robust_score - a.robust_score
    || a.raw_rank - b.raw_rank
  )[0] ?? null;
}

function selectDiverseCandidate(
  candidates: RuntimeCandidateSelectionCandidate[],
  robustBest: RuntimeCandidateSelectionCandidate | null
): RuntimeCandidateSelectionCandidate | null {
  const robustFamily = robustBest?.strategy_family;
  return [...candidates]
    .filter((candidate) => !robustFamily || candidate.strategy_family !== robustFamily)
    .filter((candidate) => candidate.diversity_score >= 0.5)
    .sort((a, b) =>
      b.diversity_score - a.diversity_score
      || b.robust_score - a.robust_score
      || a.raw_rank - b.raw_rank
    )[0] ?? null;
}

function summarizeNearMissCandidates(entriesOldestFirst: RuntimeEvidenceEntry[]): RuntimeNearMissCandidateContext[] {
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const contexts = extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)
    .filter((context) => context.candidate.disposition !== "retired");
  const rawRanked = [...contexts].sort(compareCandidateEvidenceContexts);
  const rawBest = rawRanked[0] ?? null;
  const scoredByCandidateId = new Map(
    scoreCandidateSelectionContexts(rawRanked).map((candidate) => [candidate.candidate_id, candidate])
  );
  const result: RuntimeNearMissCandidateContext[] = [];
  for (const context of rawRanked) {
    if (!rawBest || context.candidate.candidate_id === rawBest.candidate.candidate_id) continue;
    const scored = scoredByCandidateId.get(context.candidate.candidate_id);
    const reasons = nearMissReasonsForCandidate(context, rawBest, scored);
    if (reasons.length === 0) continue;
    const nearMiss = context.candidate.near_miss;
    if (nearMiss?.status === "rejected") continue;
    result.push({
      candidate_id: context.candidate.candidate_id,
      ...(context.candidate.label ? { label: context.candidate.label } : {}),
      strategy_family: context.candidate.lineage.strategy_family,
      evidence_entry_id: context.entry_id,
      occurred_at: context.occurred_at,
      raw_rank: scored?.raw_rank ?? rawRanked.indexOf(context) + 1,
      ...(context.metric ? { raw_metric: context.metric } : {}),
      raw_best_candidate_id: rawBest.candidate.candidate_id,
      ...nearMissMarginContext(context, rawBest, nearMiss),
      reason_to_keep: reasons,
      weak_dimensions: nearMiss?.weak_dimensions ?? context.candidate.robustness?.weak_dimensions ?? [],
      complementary_candidate_ids: nearMiss?.complementary_candidate_ids ?? complementaryCandidateIds(context.candidate),
      ...(nearMiss?.follow_up ? { follow_up: nearMiss.follow_up } : {}),
      ...(context.candidate.disposition_reason ? { retained_reason: context.candidate.disposition_reason } : {}),
      evidence_refs: nearMiss?.evidence_refs ?? context.candidate.robustness?.provenance_refs ?? [],
      ...(nearMiss?.summary ?? context.candidate.robustness?.summary
        ? { summary: nearMiss?.summary ?? context.candidate.robustness?.summary }
        : {}),
    });
  }
  return result.sort((a, b) =>
    nearMissReasonRank(b.reason_to_keep) - nearMissReasonRank(a.reason_to_keep)
    || (b.raw_metric?.confidence ?? 0) - (a.raw_metric?.confidence ?? 0)
    || a.raw_rank - b.raw_rank
  ).slice(0, 8);
}

function nearMissReasonsForCandidate(
  context: CandidateEvidenceContext,
  rawBest: CandidateEvidenceContext,
  scored: RuntimeCandidateSelectionCandidate | undefined
): RuntimeEvidenceCandidateNearMissReason[] {
  const explicit = context.candidate.near_miss?.reason_to_keep ?? [];
  if (explicit.length > 0) return [...explicit];
  const reasons = new Set<RuntimeEvidenceCandidateNearMissReason>(explicit);
  if (context.candidate.near_miss?.status === "retained" || context.candidate.near_miss?.status === "promoted") {
    for (const reason of inferredNearMissReasons(context, rawBest, scored)) reasons.add(reason);
  } else if (context.candidate.near_miss) {
    for (const reason of inferredNearMissReasons(context, rawBest, scored)) reasons.add(reason);
  } else if (isImplicitNearMiss(context, rawBest, scored)) {
    for (const reason of inferredNearMissReasons(context, rawBest, scored)) reasons.add(reason);
  }
  return [...reasons];
}

function inferredNearMissReasons(
  context: CandidateEvidenceContext,
  rawBest: CandidateEvidenceContext,
  scored: RuntimeCandidateSelectionCandidate | undefined
): RuntimeEvidenceCandidateNearMissReason[] {
  const reasons: RuntimeEvidenceCandidateNearMissReason[] = [];
  const margin = candidateMetricMargin(context.metric, rawBest.metric);
  if (margin !== null && isCloseToBestMargin(margin, rawBest.metric)) reasons.push("close_to_best");
  if ((context.candidate.robustness?.stability_score ?? 0) >= 0.8) reasons.push("stability");
  if ((context.candidate.near_miss?.weak_dimensions.length ?? context.candidate.robustness?.weak_dimensions.length ?? 0) > 0) {
    reasons.push("weak_dimension_improvement");
  }
  if (context.candidate.lineage.strategy_family !== rawBest.candidate.lineage.strategy_family
    && (scored?.diversity_score ?? inferredDiversityScore(context.candidate, rawBest.candidate.lineage.strategy_family, [context.candidate, rawBest.candidate])) >= 0.5) {
    reasons.push("novelty");
  }
  if (complementaryCandidateIds(context.candidate).length > 0 || highestKnownSimilarity(context.candidate, [context.candidate, rawBest.candidate]) <= 0.5) {
    reasons.push("complementarity");
  }
  return reasons;
}

function isImplicitNearMiss(
  context: CandidateEvidenceContext,
  rawBest: CandidateEvidenceContext,
  scored: RuntimeCandidateSelectionCandidate | undefined
): boolean {
  if (context.candidate.disposition !== "retained" && context.candidate.disposition !== "promoted") return false;
  const margin = candidateMetricMargin(context.metric, rawBest.metric);
  const close = margin !== null && isCloseToBestMargin(margin, rawBest.metric);
  const weakDimension = (context.candidate.robustness?.weak_dimensions.length ?? 0) > 0;
  const distinctFamily = context.candidate.lineage.strategy_family !== rawBest.candidate.lineage.strategy_family
    && (scored?.diversity_score ?? 0) >= 0.5;
  return close || weakDimension || distinctFamily;
}

function nearMissMarginContext(
  context: CandidateEvidenceContext,
  rawBest: CandidateEvidenceContext,
  nearMiss: RuntimeEvidenceCandidateNearMiss | undefined
): Pick<RuntimeNearMissCandidateContext, "margin_to_raw_best"> {
  const margin = nearMiss?.margin_to_best ?? candidateMetricMargin(context.metric, rawBest.metric);
  return margin === null || margin === undefined ? {} : { margin_to_raw_best: Math.round(margin * 1_000_000) / 1_000_000 };
}

function candidateMetricMargin(
  candidateMetric: CandidateComparableMetric | null,
  bestMetric: CandidateComparableMetric | null
): number | null {
  if (!candidateMetric || !bestMetric || candidateMetric.direction !== bestMetric.direction) return null;
  const margin = candidateMetric.direction === "maximize"
    ? bestMetric.value - candidateMetric.value
    : candidateMetric.value - bestMetric.value;
  return Number.isFinite(margin) ? Math.max(0, margin) : null;
}

function isCloseToBestMargin(
  margin: number,
  bestMetric: CandidateComparableMetric | null
): boolean {
  if (!bestMetric) return false;
  const tolerance = Math.max(Math.abs(bestMetric.value) * 0.005, 0.001);
  return margin <= tolerance;
}

function complementaryCandidateIds(candidate: RuntimeEvidenceCandidateRecord): string[] {
  const explicit = candidate.near_miss?.complementary_candidate_ids ?? [];
  if (explicit.length > 0) return explicit;
  return candidate.similarity
    .filter((similarity) => similarity.signal === "metric_correlation" && similarity.similarity <= 0.5)
    .map((similarity) => similarity.candidate_id);
}

function nearMissReasonRank(reasons: RuntimeEvidenceCandidateNearMissReason[]): number {
  const weights: Record<RuntimeEvidenceCandidateNearMissReason, number> = {
    weak_dimension_improvement: 5,
    novelty: 4,
    complementarity: 4,
    ensemble_potential: 3,
    stability: 2,
    close_to_best: 1,
  };
  return reasons.reduce((score, reason) => score + weights[reason], 0);
}

function summarizeCandidateLineages(entriesOldestFirst: RuntimeEvidenceEntry[]): RuntimeCandidateLineageContext[] {
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const byFamily = new Map<string, CandidateEvidenceContext[]>();
  for (const context of extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)) {
    const family = context.candidate.lineage.strategy_family;
    byFamily.set(family, [...(byFamily.get(family) ?? []), context]);
  }

  return [...byFamily.entries()]
    .map(([strategyFamily, contexts]) => {
      const sorted = [...contexts].sort(compareCandidateEvidenceContexts);
      const best = sorted[0];
      const diversityNotes = new Set<string>();
      for (const context of contexts) {
        for (const similarity of context.candidate.similarity) {
          if (similarity.similarity >= 0.85) {
            diversityNotes.add(`${context.candidate.candidate_id} near-duplicate of ${similarity.candidate_id}`);
          }
        }
      }
      return {
        strategy_family: strategyFamily,
        candidate_ids: contexts.map((context) => context.candidate.candidate_id),
        retained_representative_ids: sorted
          .filter((context) => context.candidate.disposition === "retained" || context.candidate.disposition === "promoted")
          .map((context) => context.candidate.candidate_id)
          .slice(0, 3),
        promoted_ids: contexts
          .filter((context) => context.candidate.disposition === "promoted")
          .map((context) => context.candidate.candidate_id),
        retired_ids: contexts
          .filter((context) => context.candidate.disposition === "retired")
          .map((context) => context.candidate.candidate_id),
        ...(best ? { best_candidate_id: best.candidate.candidate_id } : {}),
        ...(best?.metric
          ? {
              best_metric: {
                label: best.metric.label,
                value: best.metric.value,
                direction: best.metric.direction,
              },
            }
          : {}),
        diversity_notes: [...diversityNotes].slice(0, 5),
      } satisfies RuntimeCandidateLineageContext;
    })
    .sort((a, b) => {
      const aMetric = a.best_metric;
      const bMetric = b.best_metric;
      if (aMetric && bMetric && aMetric.direction === bMetric.direction) {
        const delta = aMetric.direction === "maximize" ? bMetric.value - aMetric.value : aMetric.value - bMetric.value;
        if (delta !== 0) return delta;
      }
      if (aMetric && !bMetric) return -1;
      if (!aMetric && bMetric) return 1;
      return a.strategy_family.localeCompare(b.strategy_family);
    });
}

function extractCandidateEvidenceContexts(
  entriesOldestFirst: RuntimeEvidenceEntry[],
  primaryMetric: ComparableMetricKey | null
): CandidateEvidenceContext[] {
  const contexts: CandidateEvidenceContext[] = [];
  for (const entry of entriesOldestFirst) {
    for (const candidate of entry.candidates ?? []) {
      contexts.push({
        entry_id: entry.id,
        occurred_at: candidate.produced_at ?? entry.occurred_at,
        candidate,
        metric: candidateComparableMetric(candidate, primaryMetric),
      });
    }
  }
  return contexts;
}

function resolvePrimaryCandidateMetricKey(entriesOldestFirst: RuntimeEvidenceEntry[]): ComparableMetricKey | null {
  const candidates = entriesOldestFirst.flatMap((entry) => entry.candidates ?? []);
  const byMetric = new Map<string, {
    key: ComparableMetricKey;
    candidate_count: number;
    position_sum: number;
    latest_index: number;
  }>();

  candidates.forEach((candidate, candidateIndex) => {
    const seenForCandidate = new Set<string>();
    candidate.metrics.forEach((metric, metricIndex) => {
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) return;
      if (metric.direction !== "maximize" && metric.direction !== "minimize") return;
      const key = { label: metric.label, direction: metric.direction };
      const mapKey = `${key.label}:${key.direction}`;
      if (seenForCandidate.has(mapKey)) return;
      seenForCandidate.add(mapKey);
      const existing = byMetric.get(mapKey);
      if (!existing) {
        byMetric.set(mapKey, {
          key,
          candidate_count: 1,
          position_sum: metricIndex,
          latest_index: candidateIndex,
        });
        return;
      }
      existing.candidate_count += 1;
      existing.position_sum += metricIndex;
      existing.latest_index = candidateIndex;
    });
  });

  return [...byMetric.values()].sort((a, b) => {
    const coverageDelta = b.candidate_count - a.candidate_count;
    if (coverageDelta !== 0) return coverageDelta;
    const positionDelta = a.position_sum / a.candidate_count - b.position_sum / b.candidate_count;
    if (positionDelta !== 0) return positionDelta;
    return b.latest_index - a.latest_index;
  })[0]?.key ?? null;
}

function candidateComparableMetric(
  candidate: RuntimeEvidenceCandidateRecord,
  primaryMetric: ComparableMetricKey | null
): CandidateComparableMetric | null {
  for (const metric of candidate.metrics) {
    if (primaryMetric && (metric.label !== primaryMetric.label || metric.direction !== primaryMetric.direction)) continue;
    if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) continue;
    if (metric.direction !== "maximize" && metric.direction !== "minimize") continue;
    return {
      label: metric.label,
      value: metric.value,
      direction: metric.direction,
      confidence: metric.confidence ?? 1,
    };
  }
  return null;
}

function compareCandidateEvidenceContexts(a: CandidateEvidenceContext, b: CandidateEvidenceContext): number {
  const metricDelta = compareCandidateMetrics(a.metric, b.metric);
  if (metricDelta !== 0) return metricDelta;
  const dispositionDelta = dispositionRank(b.candidate.disposition) - dispositionRank(a.candidate.disposition);
  if (dispositionDelta !== 0) return dispositionDelta;
  const confidenceDelta = (b.metric?.confidence ?? 0) - (a.metric?.confidence ?? 0);
  if (confidenceDelta !== 0) return confidenceDelta;
  return b.occurred_at.localeCompare(a.occurred_at);
}

function compareCandidateMetrics(a: CandidateComparableMetric | null, b: CandidateComparableMetric | null): number {
  if (a && b && a.direction === b.direction) {
    const valueDelta = a.direction === "maximize" ? b.value - a.value : a.value - b.value;
    if (valueDelta !== 0) return valueDelta;
  }
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

function dispositionRank(disposition: RuntimeEvidenceCandidateDisposition): number {
  if (disposition === "promoted") return 2;
  if (disposition === "retained") return 1;
  return 0;
}

function mostSimilarSelectedCandidate(
  candidate: CandidateEvidenceContext,
  selected: CandidateEvidenceContext[]
): RuntimeEvidenceCandidateSimilarity | undefined {
  let best: RuntimeEvidenceCandidateSimilarity | undefined;
  for (const selectedCandidate of selected) {
    const similarity = similarityBetweenCandidates(candidate.candidate, selectedCandidate.candidate);
    if (!similarity) continue;
    if (!best || similarity.similarity > best.similarity) best = similarity;
  }
  return best;
}

function similarityBetweenCandidates(
  candidate: RuntimeEvidenceCandidateRecord,
  selected: RuntimeEvidenceCandidateRecord
): RuntimeEvidenceCandidateSimilarity | undefined {
  const direct = candidate.similarity.find((similarity) => similarity.candidate_id === selected.candidate_id);
  const inverse = selected.similarity.find((similarity) => similarity.candidate_id === candidate.candidate_id);
  if (direct && inverse) return direct.similarity >= inverse.similarity ? direct : inverse;
  if (direct) return direct;
  if (inverse) {
    return {
      ...inverse,
      candidate_id: selected.candidate_id,
    };
  }
  if (
    candidate.lineage.strategy_family === selected.lineage.strategy_family
    && candidateLineageFingerprint(candidate) === candidateLineageFingerprint(selected)
  ) {
    return {
      candidate_id: selected.candidate_id,
      similarity: 0.9,
      signal: "lineage",
      summary: "candidate shares strategy family and lineage fingerprint",
    };
  }
  return undefined;
}

function candidateLineageFingerprint(candidate: RuntimeEvidenceCandidateRecord): string {
  const lineage = candidate.lineage;
  return [
    lineage.strategy_family,
    ...lineage.feature_lineage,
    ...lineage.model_lineage,
    ...lineage.config_lineage,
    ...lineage.postprocess_lineage,
  ].map(normalizeLineageText).filter(Boolean).join("|");
}

function toPortfolioSlot(
  context: CandidateEvidenceContext & {
    role: RuntimeCandidatePortfolioSlot["role"];
    similarity_to_selected?: RuntimeEvidenceCandidateSimilarity;
  }
): RuntimeCandidatePortfolioSlot {
  const candidate = context.candidate;
  return {
    candidate_id: candidate.candidate_id,
    ...(candidate.label ? { label: candidate.label } : {}),
    strategy_family: candidate.lineage.strategy_family,
    role: context.role,
    evidence_entry_id: context.entry_id,
    occurred_at: context.occurred_at,
    ...(context.metric ? { metric: context.metric } : {}),
    ...(candidate.lineage.parent_candidate_id ? { parent_candidate_id: candidate.lineage.parent_candidate_id } : {}),
    ...(candidate.lineage.source_candidate_id ? { source_candidate_id: candidate.lineage.source_candidate_id } : {}),
    ...(candidate.lineage.source_strategy_id ? { source_strategy_id: candidate.lineage.source_strategy_id } : {}),
    disposition: candidate.disposition,
    ...(candidate.disposition_reason ? { retained_reason: candidate.disposition_reason } : {}),
    ...(context.similarity_to_selected ? { similarity_to_selected: context.similarity_to_selected } : {}),
  };
}

function summarizeFailedLineages(entriesOldestFirst: RuntimeEvidenceEntry[]): RuntimeFailedLineageContext[] {
  const lineages = new Map<string, RuntimeFailedLineageContext>();
  for (const entry of entriesOldestFirst) {
    if (!isFailedEvidenceEntry(entry)) continue;
    const fingerprintInput = failedLineageFingerprintInput(entry);
    const normalizedIdentityParts = [
      normalizeLineageText(fingerprintInput.strategy_family),
      normalizeLineageText(fingerprintInput.hypothesis),
      normalizeLineageText(fingerprintInput.primary_dimension),
      normalizeLineageText(fingerprintInput.task_action),
    ].filter(Boolean);
    const normalizedFallbackParts = [normalizeLineageText(fingerprintInput.failure_reason)].filter(Boolean);
    const fingerprintParts = normalizedIdentityParts.length > 0 ? normalizedIdentityParts : normalizedFallbackParts;
    if (fingerprintParts.length === 0) continue;
    const fingerprint = fingerprintParts.join("|");
    const summary = entry.summary
      ?? entry.result?.summary
      ?? entry.verification?.summary
      ?? entry.result?.error
      ?? `${entry.kind} failed`;
    const existing = lineages.get(fingerprint);
    if (!existing) {
      lineages.set(fingerprint, {
        fingerprint,
        count: 1,
        first_seen_at: entry.occurred_at,
        last_seen_at: entry.occurred_at,
        ...(fingerprintInput.strategy_family ? { strategy_family: fingerprintInput.strategy_family } : {}),
        ...(fingerprintInput.hypothesis ? { hypothesis: fingerprintInput.hypothesis } : {}),
        ...(fingerprintInput.primary_dimension ? { primary_dimension: fingerprintInput.primary_dimension } : {}),
        ...(fingerprintInput.task_action ? { task_action: fingerprintInput.task_action } : {}),
        ...(fingerprintInput.failure_reason ? { failure_reason: fingerprintInput.failure_reason } : {}),
        representative_entry_id: entry.id,
        representative_summary: summary,
        evidence_entry_ids: [entry.id],
      });
      continue;
    }
    existing.count += 1;
    existing.last_seen_at = entry.occurred_at;
    existing.representative_entry_id = entry.id;
    existing.representative_summary = summary;
    existing.evidence_entry_ids = [...existing.evidence_entry_ids, entry.id].slice(-5);
  }

  return [...lineages.values()]
    .sort((a, b) => b.count - a.count || b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, 10);
}

function isFailedEvidenceEntry(entry: RuntimeEvidenceEntry): boolean {
  return entry.outcome === "failed"
    || entry.outcome === "regressed"
    || entry.kind === "failure"
    || entry.result?.status === "failed"
    || entry.verification?.verdict === "fail";
}

function failedLineageFingerprintInput(entry: RuntimeEvidenceEntry): {
  strategy_family?: string;
  hypothesis?: string;
  primary_dimension?: string;
  task_action?: string;
  failure_reason?: string;
} {
  const strategyFamily = entry.strategy ?? entry.task?.action;
  return {
    ...(strategyFamily ? { strategy_family: strategyFamily } : {}),
    ...(entry.hypothesis ? { hypothesis: entry.hypothesis } : {}),
    ...(entry.task?.primary_dimension ? { primary_dimension: entry.task.primary_dimension } : {}),
    ...(entry.task?.action ? { task_action: entry.task.action } : {}),
    ...(entry.result?.error || entry.result?.summary || entry.verification?.summary
      ? { failure_reason: entry.result?.error ?? entry.result?.summary ?? entry.verification?.summary }
      : {}),
  };
}

function normalizeLineageText(value: string | undefined): string {
  return value?.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim() ?? "";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function chooseBestEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  const metricBest = chooseBestMetricEvidence(entriesNewestFirst);
  if (metricBest) return metricBest;

  return chooseBestFallbackEvidence(entriesNewestFirst);
}

function chooseBestFallbackEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  return entriesNewestFirst.find((entry) => entry.outcome === "improved")
    ?? entriesNewestFirst.find((entry) => entry.verification?.verdict === "pass")
    ?? entriesNewestFirst.find((entry) => entry.metrics.length > 0)
    ?? entriesNewestFirst.find((entry) => entry.kind === "artifact")
    ?? null;
}

function chooseBestMetricEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  const primaryMetric = resolvePrimaryMetricKey(entriesNewestFirst);
  if (!primaryMetric) return null;

  const oldestFirst = [...entriesNewestFirst].reverse();
  const baseline = findComparableMetric(oldestFirst, primaryMetric)?.value;
  const candidates = entriesNewestFirst
    .map((entry) => {
      const metric = findComparableMetric([entry], primaryMetric);
      if (!metric) return null;
      return {
        entry,
        metric: metric.metric,
        value: metric.value,
        direction: metric.direction,
        primary_metric: primaryMetric,
        improvement_strength: baseline === undefined
          ? 0
          : metric.direction === "maximize"
            ? metric.value - baseline
            : baseline - metric.value,
        confidence: metric.metric.confidence ?? entry.verification?.confidence ?? 1,
        has_pass_verification: entry.verification?.verdict === "pass",
        has_artifact: entry.artifacts.length > 0 || entry.kind === "artifact",
      } satisfies ComparableEvidenceMetric;
    })
    .filter((candidate): candidate is ComparableEvidenceMetric => Boolean(candidate));

  if (candidates.length === 0) return null;
  return candidates.sort(compareComparableEvidenceMetrics)[0]?.entry ?? null;
}

function resolvePrimaryMetricKey(entriesNewestFirst: RuntimeEvidenceEntry[]): ComparableMetricKey | null {
  const oldestFirst = [...entriesNewestFirst].reverse();
  const byMetric = new Map<string, {
    key: ComparableMetricKey;
    entry_count: number;
    explicit_primary_count: number;
    position_sum: number;
    latest_index: number;
  }>();

  oldestFirst.forEach((entry, entryIndex) => {
    const seenForEntry = new Set<string>();
    entry.metrics.forEach((metric, metricIndex) => {
      const comparable = toComparableMetric(metric);
      if (!comparable) return;
      const key = { label: metric.label, direction: comparable.direction };
      const mapKey = `${key.label}:${key.direction}`;
      if (seenForEntry.has(mapKey)) return;
      seenForEntry.add(mapKey);
      const existing = byMetric.get(mapKey);
      const explicitPrimary = entry.task?.primary_dimension === metric.label ? 1 : 0;
      if (!existing) {
        byMetric.set(mapKey, {
          key,
          entry_count: 1,
          explicit_primary_count: explicitPrimary,
          position_sum: metricIndex,
          latest_index: entryIndex,
        });
        return;
      }
      existing.entry_count += 1;
      existing.explicit_primary_count += explicitPrimary;
      existing.position_sum += metricIndex;
      existing.latest_index = entryIndex;
    });
  });

  // Primary evidence metric inference is intentionally structural: exact
  // task.primary_dimension matches win, then broadest repeated metric coverage,
  // then stable first-position metric ordering, then recency as the final tie.
  return [...byMetric.values()].sort((a, b) => {
    const explicitDelta = b.explicit_primary_count - a.explicit_primary_count;
    if (explicitDelta !== 0) return explicitDelta;
    const coverageDelta = b.entry_count - a.entry_count;
    if (coverageDelta !== 0) return coverageDelta;
    const positionDelta = a.position_sum / a.entry_count - b.position_sum / b.entry_count;
    if (positionDelta !== 0) return positionDelta;
    return b.latest_index - a.latest_index;
  })[0]?.key ?? null;
}

function findComparableMetric(
  entries: RuntimeEvidenceEntry[],
  key: ComparableMetricKey
): { metric: RuntimeEvidenceMetric; value: number; direction: "maximize" | "minimize" } | null {
  for (const entry of entries) {
    for (const metric of entry.metrics) {
      if (metric.label !== key.label || metric.direction !== key.direction) continue;
      const comparable = toComparableMetric(metric);
      if (comparable) return comparable;
    }
  }
  return null;
}

function toComparableMetric(
  metric: RuntimeEvidenceMetric
): { metric: RuntimeEvidenceMetric; value: number; direction: "maximize" | "minimize" } | null {
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) return null;
  if (metric.direction !== "maximize" && metric.direction !== "minimize") return null;
  return {
    metric,
    value: metric.value,
    direction: metric.direction,
  };
}

function compareComparableEvidenceMetrics(a: ComparableEvidenceMetric, b: ComparableEvidenceMetric): number {
  const direction = a.direction;
  const valueDelta = direction === "maximize" ? b.value - a.value : a.value - b.value;
  if (valueDelta !== 0) return valueDelta;

  const passDelta = Number(b.has_pass_verification) - Number(a.has_pass_verification);
  if (passDelta !== 0) return passDelta;

  const artifactDelta = Number(b.has_artifact) - Number(a.has_artifact);
  if (artifactDelta !== 0) return artifactDelta;

  const confidenceDelta = b.confidence - a.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;

  const improvementDelta = b.improvement_strength - a.improvement_strength;
  if (improvementDelta !== 0) return improvementDelta;

  return b.entry.occurred_at.localeCompare(a.entry.occurred_at);
}
