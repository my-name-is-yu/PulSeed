import * as path from "node:path";
import { z } from "zod";
import type { StateManager } from "../base/state/state-manager.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import { createRuntimeSessionRegistry } from "./session-registry/index.js";
import type {
  BackgroundRun,
  RuntimeSessionRegistrySnapshot,
} from "./session-registry/types.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceSummary } from "./store/evidence-ledger.js";
import { RuntimeHealthStore } from "./store/health-store.js";
import type { RuntimeHealthSnapshot } from "./store/runtime-schemas.js";

export type RuntimeEvidenceQuestionTopic =
  | "progress"
  | "metric"
  | "artifact"
  | "strategy"
  | "blocker"
  | "report";

export interface RuntimeEvidenceAnswerResult {
  kind: "not_runtime_evidence_question" | "answered";
  message?: string;
  messageType?: "info" | "warning";
  targetRunId?: string;
  topics?: RuntimeEvidenceQuestionTopic[];
  confidence?: number;
}

export interface RuntimeEvidenceAnswerInput {
  text: string;
  stateManager: Pick<StateManager, "getBaseDir">;
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  now?: Date;
}

export interface RuntimeEvidenceQueryUnderstanding {
  decision: "runtime_evidence_question" | "not_runtime_evidence_question";
  topics: RuntimeEvidenceQuestionTopic[];
  confidence: number;
  targetRunId?: string;
  rationale?: string;
}

interface RuntimeEvidenceAnswerModelInput {
  text: string;
  topics: RuntimeEvidenceQuestionTopic[];
  snapshot: RuntimeSessionRegistrySnapshot | null;
  health: RuntimeHealthSnapshot | null;
  run: BackgroundRun | null;
  summary: RuntimeEvidenceSummary | null;
  now?: Date;
}

const STALE_EVIDENCE_MS = 30 * 60 * 1000;
const MIN_QUERY_CONFIDENCE = 0.7;

const RuntimeEvidenceQueryUnderstandingSchema = z.object({
  decision: z.enum(["runtime_evidence_question", "not_runtime_evidence_question"]),
  topics: z.array(z.enum(["progress", "metric", "artifact", "strategy", "blocker", "report"])).default([]),
  confidence: z.number().min(0).max(1),
  targetRunId: z.string().min(1).optional(),
  rationale: z.string().optional(),
});

function getQueryUnderstandingPrompt(): string {
  return `${getInternalIdentityPrefix("assistant")} You classify whether an operator message is asking for persisted PulSeed runtime evidence.

Runtime evidence questions ask about a current or recent background run using Runtime Session Catalog, Runtime Evidence Ledger, or Runtime Health. Supported evidence topics:
- progress: current state, liveness, latest evidence, stale/lost/stalled status
- metric: scores, best metric, leaderboard-like evidence, evaluator observations
- artifact: outputs, candidates, reports, manifests, retained artifacts
- strategy: hypotheses, approaches, experiment plan, Dream checkpoint guidance
- blocker: blockers, approval gates, missing secrets, failed attempts, external publish/submit readiness
- report: what should be included in a report/postmortem/writeup

Return not_runtime_evidence_question for ordinary chat, requests to start/stop/pause/control a run, instructions to do new work, explanatory questions not asking for persisted runtime evidence, or ambiguous/low-confidence text.
Set targetRunId only when the user copied an exact runtime catalog run id. Do not put natural-language labels, titles, task names, component names, tool names, "current", "latest", or "previous" in targetRunId.

Respond only as JSON: { "decision": "runtime_evidence_question" | "not_runtime_evidence_question", "topics": ["progress"], "confidence": 0.0-1.0, "targetRunId": "optional exact run id if explicitly named", "rationale": "short" }`;
}

export async function understandRuntimeEvidenceQuestion(
  text: string,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">,
): Promise<RuntimeEvidenceQueryUnderstanding> {
  const trimmed = text.trim();
  if (!trimmed || !llmClient) {
    return { decision: "not_runtime_evidence_question", topics: [], confidence: 0 };
  }
  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getQueryUnderstandingPrompt(), max_tokens: 384, temperature: 0 },
    );
    const parsed = llmClient.parseJSON(response.content, RuntimeEvidenceQueryUnderstandingSchema);
    const topics = [...new Set(parsed.topics)];
    if (
      parsed.decision !== "runtime_evidence_question"
      || parsed.confidence < MIN_QUERY_CONFIDENCE
      || topics.length === 0
    ) {
      return {
        decision: "not_runtime_evidence_question",
        topics: [],
        confidence: parsed.confidence,
        targetRunId: parsed.targetRunId,
        rationale: parsed.rationale,
      };
    }
    return {
      decision: "runtime_evidence_question",
      topics,
      confidence: parsed.confidence,
      targetRunId: parsed.targetRunId,
      rationale: parsed.rationale,
    };
  } catch {
    return { decision: "not_runtime_evidence_question", topics: [], confidence: 0 };
  }
}

export async function answerRuntimeEvidenceQuestion(input: RuntimeEvidenceAnswerInput): Promise<RuntimeEvidenceAnswerResult> {
  const query = await understandRuntimeEvidenceQuestion(input.text, input.llmClient);
  if (query.decision !== "runtime_evidence_question") {
    return { kind: "not_runtime_evidence_question", confidence: query.confidence };
  }

  const runtimeRoot = path.join(input.stateManager.getBaseDir(), "runtime");
  const registry = createRuntimeSessionRegistry({ stateManager: input.stateManager as StateManager });
  const ledger = new RuntimeEvidenceLedger(runtimeRoot);
  const healthStore = new RuntimeHealthStore(runtimeRoot);

  const [snapshot, health] = await Promise.all([
    registry.snapshot().catch(() => null),
    healthStore.loadSnapshot().catch(() => null),
  ]);
  const candidates = selectCandidateRuns(snapshot);
  const queryTargetRunId = query.targetRunId?.trim();
  const acceptedTargetRunId = queryTargetRunId && isExactRunIdReference(input.text, queryTargetRunId)
    ? queryTargetRunId
    : undefined;
  const targetRun = acceptedTargetRunId
    ? candidates.find((run) => run.id === acceptedTargetRunId)
    : undefined;
  if (
    acceptedTargetRunId
    && !targetRun
    && isStructuredRunIdReference(acceptedTargetRunId)
  ) {
    return {
      kind: "answered",
      message: [
        `Runtime evidence answer for run ${acceptedTargetRunId}.`,
        "Evidence missing: the requested run was not found in the Runtime Session Catalog.",
      ].join("\n"),
      messageType: "warning",
      targetRunId: acceptedTargetRunId,
      topics: query.topics,
      confidence: query.confidence,
    };
  }
  const runsToSummarize = selectRunsForEvidenceSummary(candidates, targetRun);
  const summaries = await Promise.all(runsToSummarize.map(async (run) => {
    const summary = await ledger.summarizeRun(run.id).catch(() => null);
    return { run, summary };
  }));
  const selected = selectUnderstoodRun(summaries, acceptedTargetRunId);
  const result = buildRuntimeEvidenceAnswer({
    text: input.text,
    topics: query.topics,
    snapshot,
    health,
    run: selected.run,
    summary: selected.summary,
    now: input.now,
  }, query.confidence);
  return appendIgnoredTargetRunCaveat(
    result,
    queryTargetRunId && (!acceptedTargetRunId || (!targetRun && !isStructuredRunIdReference(acceptedTargetRunId)))
      ? queryTargetRunId
      : undefined,
  );
}

export function buildRuntimeEvidenceAnswer(input: RuntimeEvidenceAnswerModelInput, confidence?: number): RuntimeEvidenceAnswerResult {
  const { topics, run, summary } = input;
  const target = run ? `run ${run.id}` : "runtime work";
  const lines: string[] = [`Runtime evidence answer for ${target}.`];
  const warningLines: string[] = [];

  if (!run) {
    lines.push("Evidence missing: no active or recent Runtime Session Catalog run was found.");
    return {
      kind: "answered",
      message: lines.join("\n"),
      messageType: "warning",
      topics,
      confidence,
    };
  }

  lines.push(`Sources: Runtime Session Catalog${summary ? ", Runtime Evidence Ledger" : ""}${input.health ? ", Runtime Health" : ""}.`);
  lines.push(`Catalog status: ${run.status}${run.summary ? `; ${sanitize(run.summary)}` : ""}.`);
  if (run.error) warningLines.push(`Run error: ${sanitize(run.error)}`);
  if (input.health?.long_running) {
    const health = input.health.long_running;
    lines.push(`Liveness: daemon aggregate ${health.signals.process.status}; logs ${health.signals.log_freshness.status}; ${health.summary}.`);
  }

  if (!summary || summary.total_entries === 0) {
    lines.push("Evidence missing: no persisted runtime evidence entries were found for the selected run.");
    if (input.snapshot?.warnings.length) {
      warningLines.push(...input.snapshot.warnings.slice(0, 3).map((warning) => `Catalog warning: ${sanitize(warning.message)}`));
    }
    appendWarnings(lines, warningLines);
    return {
      kind: "answered",
      message: lines.join("\n"),
      messageType: "warning",
      targetRunId: run.id,
      topics,
      confidence,
    };
  }

  lines.push(`Evidence entries: ${summary.total_entries}; generated ${summary.generated_at}.`);
  collectStalenessWarnings(summary, input.now ?? new Date(), warningLines);

  if (topics.includes("progress")) appendProgress(lines, summary);
  if (topics.includes("metric")) appendMetrics(lines, summary);
  if (topics.includes("artifact")) appendArtifacts(lines, run, summary);
  if (topics.includes("strategy")) appendStrategy(lines, summary);
  if (topics.includes("blocker")) appendBlockers(lines, summary);
  if (topics.includes("report")) appendReportSummary(lines, run, summary);
  if (topics.length === 0) appendProgress(lines, summary);

  appendEvidenceWarnings(lines, summary, warningLines);
  return {
    kind: "answered",
    message: lines.join("\n"),
    messageType: warningLines.length > 0 ? "warning" : "info",
    targetRunId: run.id,
    topics,
    confidence,
  };
}

function selectRunsForEvidenceSummary(candidates: BackgroundRun[], targetRun: BackgroundRun | undefined): BackgroundRun[] {
  const runs = candidates.slice(0, 8);
  if (targetRun && !runs.some((run) => run.id === targetRun.id)) {
    runs.push(targetRun);
  }
  return runs;
}

function selectUnderstoodRun(
  summaries: Array<{ run: BackgroundRun; summary: RuntimeEvidenceSummary | null }>,
  targetRunId: string | undefined,
): { run: BackgroundRun | null; summary: RuntimeEvidenceSummary | null } {
  if (targetRunId) {
    const matched = summaries.find(({ run }) => run.id === targetRunId);
    if (matched) return matched;
  }
  return summaries[0] ?? { run: null, summary: null };
}

function isExactRunIdReference(text: string, targetRunId: string): boolean {
  const target = targetRunId.trim();
  if (!target) return false;
  let start = text.indexOf(target);
  while (start !== -1) {
    const before = start > 0 ? text[start - 1] : undefined;
    const afterIndex = start + target.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    if (!isRunIdTokenChar(before) && !isRunIdTokenChar(after)) return true;
    start = text.indexOf(target, start + 1);
  }
  return false;
}

function isRunIdTokenChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === "_"
    || char === "."
    || char === ":"
    || char === "-"
    || char === "/";
}

function isStructuredRunIdReference(targetRunId: string): boolean {
  return /[:/_\-.]/.test(targetRunId);
}

function appendIgnoredTargetRunCaveat(
  result: RuntimeEvidenceAnswerResult,
  ignoredTargetRunId: string | undefined,
): RuntimeEvidenceAnswerResult {
  if (!ignoredTargetRunId || result.kind !== "answered" || !result.message) return result;
  const caveat = `Requested target "${sanitizeOneLine(ignoredTargetRunId)}" did not match an exact Runtime Session Catalog run id; selected the active or most recent run instead.`;
  const message = result.message.includes("Evidence caveats:\n")
    ? `${result.message}\n- ${caveat}.`
    : `${result.message}\nEvidence caveats:\n- ${caveat}.`;
  return {
    ...result,
    message,
    messageType: "warning",
  };
}

function selectCandidateRuns(snapshot: RuntimeSessionRegistrySnapshot | null): BackgroundRun[] {
  if (!snapshot) return [];
  const rank = (run: BackgroundRun): number => {
    if (run.status === "running" || run.status === "queued") return 0;
    if (run.status === "failed" || run.status === "timed_out" || run.status === "lost" || run.status === "unknown") return 1;
    return 2;
  };
  return [...snapshot.background_runs].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    return timestamp(right.updated_at ?? right.completed_at ?? right.started_at ?? right.created_at)
      - timestamp(left.updated_at ?? left.completed_at ?? left.started_at ?? left.created_at);
  });
}

function appendProgress(lines: string[], summary: RuntimeEvidenceSummary): void {
  const latest = summary.recent_entries[0] ?? summary.best_evidence ?? summary.latest_strategy;
  lines.push("Progress:");
  lines.push(`- Latest evidence: ${latest ? entryLabel(latest) : "none"}.`);
  if (summary.metric_trends.length > 0) {
    const trend = summary.metric_trends[0]!;
    lines.push(`- Metric state: ${trend.metric_key} is ${trend.trend}; latest ${trend.latest_value}, best ${trend.best_value}, observations ${trend.observation_count}.`);
  }
  if (summary.recent_failed_attempts.length > 0) {
    lines.push(`- Recent failures: ${summary.recent_failed_attempts.slice(0, 2).map(entryLabel).join("; ")}.`);
  }
}

function appendMetrics(lines: string[], summary: RuntimeEvidenceSummary): void {
  lines.push("Metrics:");
  if (summary.metric_trends.length === 0) {
    lines.push("- No metric trend evidence found.");
  } else {
    for (const trend of summary.metric_trends.slice(0, 4)) {
      lines.push(`- ${trend.metric_key}: latest ${trend.latest_value} at ${trend.latest_observed_at}; cumulative best ${trend.best_value} at ${trend.best_observed_at}; trend ${trend.trend}; confidence ${round(trend.confidence)}.`);
    }
  }
  const evaluator = summary.evaluator_summary;
  if (evaluator.local_best) lines.push(`- Local best: ${evaluatorObservationLabel(evaluator.local_best)}.`);
  if (evaluator.external_best) lines.push(`- External best: ${evaluatorObservationLabel(evaluator.external_best)}.`);
  if (summary.candidate_selection_summary.raw_best) lines.push(`- Raw best candidate: ${candidateLabel(summary.candidate_selection_summary.raw_best)}.`);
  if (summary.candidate_selection_summary.robust_best) lines.push(`- Robust best candidate: ${candidateLabel(summary.candidate_selection_summary.robust_best)}.`);
}

function appendArtifacts(lines: string[], run: BackgroundRun, summary: RuntimeEvidenceSummary): void {
  lines.push("Artifacts and candidates:");
  const artifacts = [
    ...run.artifacts.map((artifact) => `${artifact.label}: ${artifact.path ?? artifact.url ?? artifact.kind}`),
    ...summary.artifact_retention.cleanup_plan.actions.map((artifact) =>
      `${artifact.label}: ${artifact.path ?? artifact.state_relative_path ?? artifact.url ?? artifact.kind}`
    ),
    ...summary.recent_entries.flatMap((entry) =>
      entry.artifacts.map((artifact) => `${artifact.label}: ${artifact.path ?? artifact.state_relative_path ?? artifact.url ?? artifact.kind}`)
    ),
  ];
  const uniqueArtifacts = [...new Set(artifacts.map(sanitize))].slice(0, 5);
  if (uniqueArtifacts.length === 0) lines.push("- No artifact evidence found.");
  else for (const artifact of uniqueArtifacts) lines.push(`- ${artifact}.`);
  const portfolio = summary.recommended_candidate_portfolio.slice(0, 3).map(candidateLabel);
  if (portfolio.length > 0) lines.push(`- Recommended candidates: ${portfolio.join("; ")}.`);
  if (summary.near_miss_candidates.length > 0) {
    lines.push(`- Near misses: ${summary.near_miss_candidates.slice(0, 3).map((candidate) => sanitize(candidate.label ?? candidate.candidate_id)).join("; ")}.`);
  }
}

function appendStrategy(lines: string[], summary: RuntimeEvidenceSummary): void {
  lines.push("Strategy:");
  if (summary.latest_strategy) lines.push(`- Latest strategy evidence: ${entryLabel(summary.latest_strategy)}.`);
  const checkpoint = summary.dream_checkpoints[0];
  if (checkpoint) {
    lines.push(`- Dream checkpoint: ${sanitize(checkpoint.trigger)}; ${sanitize(checkpoint.summary)}.`);
    if (checkpoint.next_strategy_candidates.length > 0) {
      lines.push(`- Next candidates: ${checkpoint.next_strategy_candidates.slice(0, 3).map((candidate) => sanitize(candidate.title)).join("; ")}.`);
    }
    if (checkpoint.active_hypotheses.length > 0) {
      lines.push(`- Active hypotheses: ${checkpoint.active_hypotheses.slice(0, 2).map((hypothesis) => sanitize(hypothesis.hypothesis)).join("; ")}.`);
    }
  }
  if (!summary.latest_strategy && !checkpoint) lines.push("- No strategy or Dream checkpoint evidence found.");
}

function appendBlockers(lines: string[], summary: RuntimeEvidenceSummary): void {
  lines.push("Blockers and approvals:");
  const blockers = [
    ...summary.evaluator_summary.approval_required_actions.map((action) => `approval required: ${action.label}`),
    ...summary.recent_failed_attempts.map(entryLabel),
    ...summary.failed_lineages.map((lineage) => lineage.representative_summary),
  ].map(sanitize);
  if (summary.evaluator_summary.gap) blockers.push(sanitize(`${summary.evaluator_summary.gap.kind}: ${summary.evaluator_summary.gap.summary}`));
  if (blockers.length === 0) lines.push("- No blocker evidence found.");
  else for (const blocker of blockers.slice(0, 5)) lines.push(`- ${blocker}.`);
}

function appendReportSummary(lines: string[], run: BackgroundRun, summary: RuntimeEvidenceSummary): void {
  lines.push("Report-ready summary:");
  lines.push(`- Include catalog status ${run.status}, ${summary.total_entries} evidence entries, and ${summary.metric_trends.length} metric trend(s).`);
  if (summary.best_evidence) lines.push(`- Best evidence: ${entryLabel(summary.best_evidence)}.`);
  if (summary.artifact_retention.total_artifacts > 0) lines.push(`- Artifact footprint: ${summary.artifact_retention.total_artifacts} artifact(s), ${summary.artifact_retention.protected_count} protected.`);
  if (summary.research_memos.length > 0) lines.push(`- Research memo themes: ${summary.research_memos.slice(0, 2).map((memo) => sanitize(memo.summary)).join("; ")}.`);
  if (summary.dream_checkpoints.length > 0) lines.push(`- Dream checkpoints: ${summary.dream_checkpoints.slice(0, 2).map((checkpoint) => sanitize(checkpoint.summary)).join("; ")}.`);
}

function appendEvidenceWarnings(lines: string[], summary: RuntimeEvidenceSummary, warningLines: string[]): void {
  if (summary.warnings.length > 0) {
    warningLines.push(...summary.warnings.slice(0, 3).map((warning) =>
      `Evidence warning ${warning.file}:${warning.line}: ${warning.message}`
    ));
  }
  if (summary.evaluator_summary.gap) {
    warningLines.push(`Conflicting evaluator evidence: ${summary.evaluator_summary.gap.summary}`);
  }
  appendWarnings(lines, warningLines);
}

function appendWarnings(lines: string[], warnings: string[]): void {
  if (warnings.length === 0) return;
  lines.push("Evidence caveats:");
  for (const warning of [...new Set(warnings.map(sanitize))].slice(0, 5)) lines.push(`- ${warning}.`);
}

function collectStalenessWarnings(summary: RuntimeEvidenceSummary, now: Date, warnings: string[]): void {
  const generatedAt = Date.parse(summary.generated_at);
  if (Number.isFinite(generatedAt) && now.getTime() - generatedAt > STALE_EVIDENCE_MS) {
    warnings.push(`Evidence may be stale: summary generated ${summary.generated_at}`);
  }
  const latestEntry = summary.recent_entries[0] ?? summary.best_evidence ?? summary.latest_strategy;
  if (latestEntry) {
    const latestAt = Date.parse(latestEntry.occurred_at);
    if (Number.isFinite(latestAt) && now.getTime() - latestAt > STALE_EVIDENCE_MS) {
      warnings.push(`Latest evidence may be stale: ${latestEntry.occurred_at}`);
    }
  }
}

type EvidenceEntryLike = NonNullable<RuntimeEvidenceSummary["latest_strategy"]>;
type EvaluatorObservation = NonNullable<RuntimeEvidenceSummary["evaluator_summary"]["local_best"]>;
type CandidateSelection = NonNullable<RuntimeEvidenceSummary["candidate_selection_summary"]["raw_best"]>;
type PortfolioSlot = RuntimeEvidenceSummary["recommended_candidate_portfolio"][number];

function entryLabel(entry: EvidenceEntryLike): string {
  const status = entry.outcome ?? entry.result?.status ?? entry.verification?.verdict ?? entry.kind;
  const summary = entry.summary ?? entry.result?.summary ?? entry.decision_reason ?? entry.task?.description ?? "-";
  return sanitize(`${entry.occurred_at} ${entry.kind}/${status}: ${summary}`);
}

function evaluatorObservationLabel(observation: EvaluatorObservation): string {
  const candidate = observation.candidate_label ?? observation.candidate_id;
  const score = observation.score === undefined ? "" : ` score=${String(observation.score)}`;
  return sanitize(`${observation.evaluator_id}/${observation.source} ${candidate} status=${observation.status}${score}`);
}

function candidateLabel(candidate: CandidateSelection | PortfolioSlot): string {
  const metric = isCandidateSelection(candidate) ? candidate.raw_metric : candidate.metric;
  const score = metric ? ` ${metric.label}=${metric.value}` : "";
  return sanitize(`${candidate.label ?? candidate.candidate_id} (${candidate.strategy_family}${score})`);
}

function isCandidateSelection(candidate: CandidateSelection | PortfolioSlot): candidate is CandidateSelection {
  return "raw_rank" in candidate;
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

function sanitize(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "gh_[REDACTED]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, "xox-[REDACTED]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(^|\s)(?:token|secret|password|api_key)=\S+/gi, "$1[REDACTED]");
}

function sanitizeOneLine(value: string): string {
  return sanitize(value).replace(/\s+/g, " ").trim();
}
