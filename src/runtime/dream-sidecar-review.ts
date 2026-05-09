import path from "node:path";
import type { StateManager } from "../base/state/state-manager.js";
import { createRuntimeSessionRegistry } from "./session-registry/index.js";
import { coreLoopSessionFromLedgerRun } from "./session-registry/registry-helpers.js";
import type {
  BackgroundRun,
  RuntimeArtifactRef,
  RuntimeSession,
  RuntimeSessionRef,
} from "./session-registry/types.js";
import type {
  RuntimeEvidenceEntry,
  RuntimeEvidenceDreamCheckpointRejectedApproach,
  RuntimeEvidenceDreamCheckpointStrategyCandidate,
  RuntimeFailedLineageContext,
  RuntimeEvidenceSummary,
} from "./store/evidence-ledger.js";
import { BackgroundRunLedger } from "./store/background-run-store.js";
import { RuntimeEvidenceLedger } from "./store/evidence-ledger.js";

export type RuntimeDreamSidecarReviewErrorCode = "missing_run" | "stale_run";

export class RuntimeDreamSidecarReviewError extends Error {
  constructor(readonly code: RuntimeDreamSidecarReviewErrorCode, message: string) {
    super(message);
    this.name = "RuntimeDreamSidecarReviewError";
  }
}

export interface RuntimeDreamSidecarReviewInput {
  stateManager: StateManager;
  runId: string;
  requestGuidanceInjection?: boolean;
}

export interface RuntimeDreamSidecarReviewRef {
  kind: string;
  id?: string | null;
  path?: string | null;
  relative_path?: string | null;
  url?: string | null;
  updated_at?: string | null;
}

export interface RuntimeDreamSidecarReview {
  schema_version: "runtime-dream-sidecar-review-v1";
  sidecar_session: {
    id: string;
    attached_run_id: string;
    mode: "read_only";
    created_at: string;
  };
  attach_status: "active";
  reviewed_at: string;
  read_only_enforced: true;
  run: Pick<
    BackgroundRun,
    | "id"
    | "kind"
    | "status"
    | "title"
    | "workspace"
    | "parent_session_id"
    | "child_session_id"
    | "process_session_id"
    | "started_at"
    | "updated_at"
  >;
  runtime_session: Pick<RuntimeSession, "id" | "kind" | "status" | "attachable" | "state_ref" | "source_refs"> | null;
  status_summary: string;
  best_evidence: {
    id: string;
    kind: RuntimeEvidenceEntry["kind"];
    summary: string | null;
    outcome: RuntimeEvidenceEntry["outcome"] | null;
    occurred_at: string;
  } | null;
  promising_non_winners: Array<{
    candidate_id: string;
    label?: string;
    strategy_family: string;
    raw_rank: number;
    reason_to_keep: string[];
    follow_up_title?: string;
    summary?: string;
  }>;
  known_gaps: string[];
  strategy_families: string[];
  trend_state: {
    state: "breakthrough" | "plateau" | "progressing" | "unknown";
    metric_key?: string;
    summary?: string;
  };
  evidence_refs: RuntimeDreamSidecarReviewRef[];
  artifact_refs: RuntimeArtifactRef[];
  advisory_memories: Array<{
    source_type: string;
    ref?: string;
    summary: string;
    authority: "advisory_only";
    usage_stats?: RuntimeEvidenceSummary["dream_checkpoints"][number]["relevant_memories"][number]["usage_stats"];
    ranking_trace?: {
      score: number;
      decision: "admitted" | "rejected";
      reason: string;
    };
  }>;
  suggested_next_moves: Array<{
    title: string;
    rationale: string;
    source: "dream_checkpoint" | "near_miss" | "public_research" | "evaluator" | "fallback";
  }>;
  operator_decisions: Array<{
    label: string;
    reason: string;
    approval_required: true;
    source: "evaluator" | "public_research" | "guidance_injection";
  }>;
  guidance_injection: {
    status: "not_requested" | "approval_required";
    approval_required: boolean;
    target_run_id: string;
    reason: string;
  };
  warnings: string[];
}

export async function createRuntimeDreamSidecarReview(
  input: RuntimeDreamSidecarReviewInput
): Promise<RuntimeDreamSidecarReview> {
  const runtimeRoot = path.join(input.stateManager.getBaseDir(), "runtime");
  const ledgerRun = await new BackgroundRunLedger(
    runtimeRoot,
    { controlBaseDir: input.stateManager.getBaseDir() },
  ).load(input.runId);
  const projected = await resolveProjectedRun(input.stateManager, input.runId);
  const resolved = selectResolvedRun(ledgerRun, projected) ?? (ledgerRun
    ? {
        run: ledgerRun,
        runtimeSession: runtimeSessionFromLedgerRun(ledgerRun),
      }
    : null);
  const run = resolved?.run ?? null;
  if (!run) {
    throw new RuntimeDreamSidecarReviewError("missing_run", `Background run not found: ${input.runId}`);
  }
  if (!isActiveRun(run)) {
    throw new RuntimeDreamSidecarReviewError(
      "stale_run",
      `Background run ${input.runId} is not active: ${run.status}`
    );
  }

  const runtimeSession = resolved?.runtimeSession ?? null;
  const ledger = new RuntimeEvidenceLedger(runtimeRoot);
  const evidenceSummary = await ledger.summarizeRun(run.id);
  const reviewedAt = new Date().toISOString();
  const trendState = summarizeTrendState(evidenceSummary);
  const statusSummary = buildStatusSummary(run, evidenceSummary, trendState);
  const suggestedNextMoves = buildSuggestedNextMoves(evidenceSummary);
  const operatorDecisions = buildOperatorDecisions(evidenceSummary);
  if (input.requestGuidanceInjection) {
    operatorDecisions.push({
      label: "Inject sidecar guidance into active run",
      reason: "Sidecar guidance can influence the active run and requires explicit operator approval.",
      approval_required: true,
      source: "guidance_injection",
    });
  }

  return {
    schema_version: "runtime-dream-sidecar-review-v1",
    sidecar_session: {
      id: `sidecar:dream-review:${run.id}`,
      attached_run_id: run.id,
      mode: "read_only",
      created_at: reviewedAt,
    },
    attach_status: "active",
    reviewed_at: reviewedAt,
    read_only_enforced: true,
    run: {
      id: run.id,
      kind: run.kind,
      status: run.status,
      title: run.title,
      workspace: run.workspace,
      parent_session_id: run.parent_session_id,
      child_session_id: run.child_session_id,
      process_session_id: run.process_session_id,
      started_at: run.started_at,
      updated_at: run.updated_at,
    },
    runtime_session: runtimeSession
      ? {
          id: runtimeSession.id,
          kind: runtimeSession.kind,
          status: runtimeSession.status,
          attachable: runtimeSession.attachable,
          state_ref: runtimeSession.state_ref,
          source_refs: runtimeSession.source_refs,
        }
      : null,
    status_summary: statusSummary,
    best_evidence: evidenceSummary.best_evidence ? compactEvidence(evidenceSummary.best_evidence) : null,
    promising_non_winners: buildPromisingNonWinners(evidenceSummary),
    known_gaps: buildKnownGaps(evidenceSummary),
    strategy_families: buildStrategyFamilies(evidenceSummary),
    trend_state: trendState,
    evidence_refs: buildEvidenceRefs(run, runtimeSession, evidenceSummary),
    artifact_refs: run.artifacts,
    advisory_memories: buildAdvisoryMemories(evidenceSummary),
    suggested_next_moves: suggestedNextMoves,
    operator_decisions: operatorDecisions,
    guidance_injection: input.requestGuidanceInjection
      ? {
          status: "approval_required",
          approval_required: true,
          target_run_id: run.id,
          reason: "Guidance injection into an active run is mutation-prone and must be approved explicitly.",
        }
      : {
          status: "not_requested",
          approval_required: false,
          target_run_id: run.id,
          reason: "Sidecar review is read-only; no active-run guidance injection was requested.",
        },
    warnings: buildWarnings(run, runtimeSession, evidenceSummary),
  };
}

function selectResolvedRun(
  ledgerRun: BackgroundRun | null,
  projected: { run: BackgroundRun; runtimeSession: RuntimeSession | null } | null,
): { run: BackgroundRun; runtimeSession: RuntimeSession | null } | null {
  if (!projected) return null;
  if (ledgerRun && projected.run.status === "unknown" && isActiveRun(ledgerRun)) {
    return {
      run: ledgerRun,
      runtimeSession: runtimeSessionFromLedgerRun(ledgerRun) ?? projected.runtimeSession,
    };
  }
  return projected;
}

async function resolveProjectedRun(
  stateManager: StateManager,
  runId: string,
): Promise<{ run: BackgroundRun; runtimeSession: RuntimeSession | null } | null> {
  const registry = createRuntimeSessionRegistry({
    stateManager,
    // Sidecar review must never signal/probe active process PIDs. If a run is
    // not represented by the durable ledger, the registry projection remains
    // conservative rather than using process.kill(pid, 0).
    isPidAlive: () => "unknown",
  });
  const snapshot = await registry.snapshot();
  const run = snapshot.background_runs.find((candidate) => candidate.id === runId);
  if (!run) return null;
  return {
    run,
    runtimeSession: run.child_session_id
      ? snapshot.sessions.find((session) => session.id === run.child_session_id) ?? null
      : null,
  };
}

function runtimeSessionFromLedgerRun(run: BackgroundRun): RuntimeSession | null {
  if (run.kind === "coreloop_run" && run.child_session_id) {
    return coreLoopSessionFromLedgerRun(run);
  }
  return null;
}

function isActiveRun(run: BackgroundRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function summarizeTrendState(summary: RuntimeEvidenceSummary): RuntimeDreamSidecarReview["trend_state"] {
  const breakthrough = summary.metric_trends.find((trend) => trend.trend === "breakthrough");
  if (breakthrough) {
    return {
      state: "breakthrough",
      metric_key: breakthrough.metric_key,
      summary: breakthrough.summary,
    };
  }
  const plateau = summary.metric_trends.find((trend) => trend.trend === "stalled" || trend.trend === "regressing");
  if (plateau) {
    return {
      state: "plateau",
      metric_key: plateau.metric_key,
      summary: plateau.summary,
    };
  }
  const progressing = summary.metric_trends.find((trend) => trend.trend === "improving");
  if (progressing) {
    return {
      state: "progressing",
      metric_key: progressing.metric_key,
      summary: progressing.summary,
    };
  }
  return { state: "unknown" };
}

function buildStatusSummary(
  run: BackgroundRun,
  summary: RuntimeEvidenceSummary,
  trendState: RuntimeDreamSidecarReview["trend_state"],
): string {
  const title = run.title ? `${run.title} ` : "";
  const evidenceCount = `${summary.total_entries} evidence entr${summary.total_entries === 1 ? "y" : "ies"}`;
  const trend = trendState.summary ?? `trend=${trendState.state}`;
  const nearMissCount = summary.near_miss_candidates.length > 0
    ? ` ${summary.near_miss_candidates.length} promising non-winner${summary.near_miss_candidates.length === 1 ? "" : "s"}.`
    : "";
  return `${title}${run.kind} ${run.status}; ${evidenceCount}; ${trend}.${nearMissCount}`;
}

function compactEvidence(entry: RuntimeEvidenceEntry): NonNullable<RuntimeDreamSidecarReview["best_evidence"]> {
  return {
    id: entry.id,
    kind: entry.kind,
    summary: entry.summary ?? entry.result?.summary ?? entry.verification?.summary ?? null,
    outcome: entry.outcome ?? null,
    occurred_at: entry.occurred_at,
  };
}

function buildPromisingNonWinners(summary: RuntimeEvidenceSummary): RuntimeDreamSidecarReview["promising_non_winners"] {
  return summary.near_miss_candidates.slice(0, 6).map((candidate) => ({
    candidate_id: candidate.candidate_id,
    ...(candidate.label ? { label: candidate.label } : {}),
    strategy_family: candidate.strategy_family,
    raw_rank: candidate.raw_rank,
    reason_to_keep: candidate.reason_to_keep,
    ...(candidate.follow_up?.title ? { follow_up_title: candidate.follow_up.title } : {}),
    ...(candidate.summary ? { summary: candidate.summary } : {}),
  }));
}

function buildKnownGaps(summary: RuntimeEvidenceSummary): string[] {
  const gaps = new Set<string>();
  for (const failure of summary.recent_failed_attempts) {
    gaps.add(failure.summary ?? failure.result?.summary ?? failure.verification?.summary ?? `${failure.kind} failed`);
  }
  for (const memo of summary.research_memos.slice(0, 3)) {
    for (const finding of memo.findings) {
      if (finding.risks_constraints.length > 0) {
        gaps.add(finding.risks_constraints.join("; "));
      }
    }
  }
  for (const rejected of collectRejectedApproaches(summary).slice(0, 3)) {
    gaps.add(`Rejected approach: ${rejected.approach} (${rejected.rejection_reason})`);
  }
  for (const lineage of summary.failed_lineages.filter((item) => item.count >= 2).slice(0, 3)) {
    gaps.add(`Repeated failed lineage: ${lineageLabel(lineage)} (count=${lineage.count})`);
  }
  if (!summary.best_evidence) gaps.add("No best evidence has been recorded for this run.");
  if (summary.metric_trends.length === 0) gaps.add("No progress metric history has been recorded for this run.");
  return [...gaps].slice(0, 6);
}

function buildStrategyFamilies(summary: RuntimeEvidenceSummary): string[] {
  const families = new Set<string>();
  for (const checkpoint of summary.dream_checkpoints) {
    for (const family of checkpoint.recent_strategy_families) families.add(family);
  }
  for (const entry of summary.recent_entries) {
    const candidate = entry.strategy ?? entry.task?.action ?? entry.task?.primary_dimension;
    if (candidate) families.add(candidate);
  }
  return [...families].slice(0, 8);
}

function buildSuggestedNextMoves(summary: RuntimeEvidenceSummary): RuntimeDreamSidecarReview["suggested_next_moves"] {
  const moves: RuntimeDreamSidecarReview["suggested_next_moves"] = [];
  const rejectedApproaches = collectRejectedApproaches(summary);
  const failedLineages = summary.failed_lineages.filter((lineage) => lineage.count >= 2);
  for (const checkpoint of rankCheckpointsByMemory(summary).slice(0, 2)) {
    if (checkpoint.planning_context_status !== "partially_retracted") {
      for (const candidate of checkpoint.next_strategy_candidates) {
        if (isRejectedDreamCandidate(candidate, rejectedApproaches)) continue;
        if (!candidate.retry_reason && isFailedLineageCandidate(candidate, failedLineages)) continue;
        moves.push({
          title: candidate.title,
          rationale: candidate.rationale,
          source: "dream_checkpoint",
        });
      }
      if (checkpoint.guidance && moves.length === 0) {
        moves.push({
          title: "Apply latest Dream checkpoint guidance",
          rationale: checkpoint.guidance,
          source: "dream_checkpoint",
        });
      }
    }
  }
  for (const nearMiss of summary.near_miss_candidates.slice(0, 3)) {
    const title = nearMiss.follow_up?.title ?? `Follow up near-miss candidate ${nearMiss.candidate_id}`;
    const rationale = nearMiss.follow_up?.rationale
      ?? nearMiss.summary
      ?? `Candidate ${nearMiss.candidate_id} did not beat raw best but was retained for ${nearMiss.reason_to_keep.join(", ")}.`;
    if (isRejectedRef([nearMiss.candidate_id, ...nearMiss.evidence_refs], rejectedApproaches)) continue;
    if (isFailedLineageRef(nearMiss.evidence_refs, failedLineages)) continue;
    moves.push({
      title,
      rationale,
      source: "near_miss",
    });
  }
  for (const memo of summary.research_memos.slice(0, 2)) {
    for (const finding of memo.findings.slice(0, 2)) {
      moves.push({
        title: finding.proposed_experiment,
        rationale: finding.applicability,
        source: "public_research",
      });
    }
  }
  if (summary.evaluator_summary.gap?.kind === "pending_external") {
    moves.push({
      title: "Resolve pending evaluator decision",
      rationale: summary.evaluator_summary.gap.summary,
      source: "evaluator",
    });
  }
  if (moves.length === 0) {
    moves.push({
      title: "Continue read-only monitoring",
      rationale: "No checkpoint, research, or evaluator action has produced a stronger next move yet.",
      source: "fallback",
    });
  }
  return moves.slice(0, 6);
}

function rankCheckpointsByMemory(summary: RuntimeEvidenceSummary): RuntimeEvidenceSummary["dream_checkpoints"] {
  return [...summary.dream_checkpoints].sort((a, b) =>
    checkpointMemoryScore(b) - checkpointMemoryScore(a)
    || b.occurred_at.localeCompare(a.occurred_at)
  );
}

function checkpointMemoryScore(checkpoint: RuntimeEvidenceSummary["dream_checkpoints"][number]): number {
  return Math.max(0, ...checkpoint.relevant_memories.map((memory) =>
    memory.ranking_trace?.score ?? sidecarMemoryRankScore(memory)
  ));
}

function isFailedLineageCandidate(
  candidate: RuntimeEvidenceDreamCheckpointStrategyCandidate,
  failedLineages: RuntimeFailedLineageContext[]
): boolean {
  const warning = candidate.failed_lineage_warning;
  if (!warning || warning.count < 2) return false;
  return failedLineages.length === 0 || failedLineages.some((lineage) =>
    lineage.fingerprint === warning.fingerprint
  ) || warning.count >= 2;
}

function isFailedLineageRef(
  refs: string[],
  failedLineages: RuntimeFailedLineageContext[]
): boolean {
  const refSet = new Set(refs);
  return failedLineages.some((lineage) => refSet.has(lineage.fingerprint));
}

function lineageLabel(lineage: RuntimeFailedLineageContext): string {
  return lineage.strategy_family
    ?? lineage.task_action
    ?? lineage.hypothesis
    ?? lineage.primary_dimension
    ?? lineage.fingerprint;
}

function collectRejectedApproaches(summary: RuntimeEvidenceSummary): RuntimeEvidenceDreamCheckpointRejectedApproach[] {
  const seen = new Set<string>();
  const rejectedApproaches: RuntimeEvidenceDreamCheckpointRejectedApproach[] = [];
  for (const checkpoint of summary.dream_checkpoints) {
    for (const rejected of checkpoint.rejected_approaches ?? []) {
      const key = rejected.candidate_ref ?? rejected.evidence_ref;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rejectedApproaches.push(rejected);
    }
  }
  return rejectedApproaches;
}

function isRejectedDreamCandidate(
  candidate: RuntimeEvidenceDreamCheckpointStrategyCandidate,
  rejectedApproaches: RuntimeEvidenceDreamCheckpointRejectedApproach[]
): boolean {
  return isRejectedRef([
    ...(candidate.candidate_ref ? [candidate.candidate_ref] : []),
  ], rejectedApproaches);
}

function isRejectedRef(
  refs: string[],
  rejectedApproaches: RuntimeEvidenceDreamCheckpointRejectedApproach[]
): boolean {
  if (rejectedApproaches.length === 0) return false;
  const refSet = new Set(refs);
  if (refSet.size === 0) return false;
  return rejectedApproaches.some((rejected) =>
    Boolean(rejected.candidate_ref && refSet.has(rejected.candidate_ref))
    || Boolean(rejected.evidence_ref && refSet.has(rejected.evidence_ref))
  );
}

function buildOperatorDecisions(summary: RuntimeEvidenceSummary): RuntimeDreamSidecarReview["operator_decisions"] {
  const decisions: RuntimeDreamSidecarReview["operator_decisions"] = [];
  for (const action of summary.evaluator_summary.approval_required_actions) {
    decisions.push({
      label: action.label,
      reason: `External evaluator action for candidate ${action.candidate_id} requires approval.`,
      approval_required: true,
      source: "evaluator",
    });
  }
  for (const memo of summary.research_memos) {
    for (const action of memo.external_actions) {
      decisions.push({
        label: action.label,
        reason: action.reason,
        approval_required: true,
        source: "public_research",
      });
    }
  }
  return decisions.slice(0, 8);
}

function buildEvidenceRefs(
  run: BackgroundRun,
  runtimeSession: RuntimeSession | null,
  summary: RuntimeEvidenceSummary,
): RuntimeDreamSidecarReviewRef[] {
  const refs: RuntimeDreamSidecarReviewRef[] = [
    ...run.source_refs.map(convertSessionRef),
    ...(runtimeSession?.source_refs.map(convertSessionRef) ?? []),
    ...(runtimeSession?.state_ref ? [convertSessionRef(runtimeSession.state_ref)] : []),
    ...summary.recent_entries.flatMap((entry) =>
      entry.raw_refs.map((ref) => ({
        kind: ref.kind,
        id: ref.id ?? null,
        path: ref.path ?? null,
        relative_path: ref.state_relative_path ?? null,
        url: ref.url ?? null,
      }))
    ),
  ];
  refs.push({
    kind: "evidence_ledger",
    id: run.id,
    relative_path: `runtime/evidence-ledger/runs/${encodeURIComponent(run.id)}.jsonl`,
  });
  return dedupeRefs(refs).slice(0, 20);
}

function convertSessionRef(ref: RuntimeSessionRef): RuntimeDreamSidecarReviewRef {
  return {
    kind: ref.kind,
    id: ref.id,
    path: ref.path,
    relative_path: ref.relative_path,
    updated_at: ref.updated_at,
  };
}

function dedupeRefs(refs: RuntimeDreamSidecarReviewRef[]): RuntimeDreamSidecarReviewRef[] {
  const seen = new Set<string>();
  const deduped: RuntimeDreamSidecarReviewRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id ?? ""}:${ref.path ?? ""}:${ref.relative_path ?? ""}:${ref.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

function buildAdvisoryMemories(summary: RuntimeEvidenceSummary): RuntimeDreamSidecarReview["advisory_memories"] {
  const memories = summary.dream_checkpoints.flatMap((checkpoint) =>
    checkpoint.relevant_memories.map((memory) => ({
      source_type: memory.source_type,
      ...(memory.ref ? { ref: memory.ref } : {}),
      summary: memory.summary,
      authority: "advisory_only" as const,
      ...(memory.usage_stats ? { usage_stats: memory.usage_stats } : {}),
      ranking_trace: {
        score: memory.ranking_trace?.score ?? sidecarMemoryRankScore(memory),
        decision: "admitted" as const,
        reason: sidecarMemoryRankReason(memory, memory.ranking_trace?.decision),
      },
    }))
  );
  return memories
    .sort((a, b) => (b.ranking_trace?.score ?? 0) - (a.ranking_trace?.score ?? 0))
    .map((memory, index) => ({
      ...memory,
      ranking_trace: {
        score: memory.ranking_trace?.score ?? 0,
        decision: index < 8 ? "admitted" : "rejected",
        reason: index < 8 ? memory.ranking_trace?.reason ?? "Ranked into sidecar memory context." : "Rejected by sidecar memory cap 8.",
      },
    }));
}

function sidecarMemoryRankScore(
  memory: RuntimeEvidenceSummary["dream_checkpoints"][number]["relevant_memories"][number]
): number {
  const retrievalKind = memory.retrieval?.kind ?? (memory.source_type === "soil" ? "route_hit" : "checkpoint");
  const routeScore =
    retrievalKind === "route_hit" ? 0.2
      : retrievalKind === "fallback_hit" ? 0.08
        : retrievalKind === "checkpoint" ? 0.05
          : 0;
  const score =
    (memory.relevance_score ?? memory.retrieval?.score ?? 0.5) * 0.35
    + (memory.source_reliability ?? memory.retrieval?.confidence ?? 0.5) * 0.25
    + (memory.prior_success_contribution ?? 0) * 0.2
    + (memory.recency_score ?? 0.5) * 0.1
    + routeScore
    + sidecarMemoryUsageRankAdjustment(memory.usage_stats);
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function sidecarMemoryRankReason(
  memory: RuntimeEvidenceSummary["dream_checkpoints"][number]["relevant_memories"][number],
  checkpointDecision?: "admitted" | "rejected"
): string {
  const retrievalKind = memory.retrieval?.kind ?? (memory.source_type === "soil" ? "route_hit" : "checkpoint");
  return [
    `sidecar_rank=advisory`,
    ...(checkpointDecision ? [`checkpoint_decision=${checkpointDecision}`] : []),
    `kind=${retrievalKind}`,
    `relevance=${memory.relevance_score ?? memory.retrieval?.score ?? "default"}`,
    `reliability=${memory.source_reliability ?? memory.retrieval?.confidence ?? "default"}`,
    `success=${memory.prior_success_contribution ?? 0}`,
    `recency=${memory.recency_score ?? "default"}`,
    `usage_outcome=${sidecarMemoryUsageRankAdjustment(memory.usage_stats).toFixed(4)}`,
  ].join("; ");
}

function sidecarMemoryUsageRankAdjustment(
  usage: RuntimeEvidenceSummary["dream_checkpoints"][number]["relevant_memories"][number]["usage_stats"]
): number {
  if (!usage) return 0;
  const validatedBoost = Math.min(usage.validated_count, 10) * 0.01;
  const negativePenalty = Math.min(usage.negative_outcome_count, 10) * 0.02;
  return validatedBoost - negativePenalty;
}

function buildWarnings(
  run: BackgroundRun,
  runtimeSession: RuntimeSession | null,
  summary: RuntimeEvidenceSummary,
): string[] {
  const warnings: string[] = [];
  if (run.child_session_id && !runtimeSession) {
    warnings.push(`Run child session ${run.child_session_id} was not found in the Runtime Session Catalog.`);
  }
  if (summary.total_entries === 0) {
    warnings.push("No run-scoped Runtime Evidence Ledger entries were found.");
  }
  warnings.push(...summary.warnings.map((warning) => warning.message));
  return warnings;
}
