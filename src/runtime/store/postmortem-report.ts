import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  createRuntimeStorePaths,
  ensureRuntimeStorePaths,
  encodeRuntimePathSegment,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  RuntimeEvidenceLedger,
  type RuntimeEvidenceSummary,
} from "./evidence-ledger.js";
import type { RuntimeEvidenceEntry } from "./evidence-types.js";
import { extractMetricObservationsFromEvidence } from "./metric-history.js";
import {
  RuntimeReproducibilityManifestSchema,
  type RuntimeReproducibilityManifest,
} from "./reproducibility-manifest.js";
import { RuntimeOperatorHandoffStore, type RuntimeOperatorHandoffRecord } from "./operator-handoff-store.js";
import { RuntimeExperimentQueueStore, type RuntimeExperimentQueueRecord } from "./experiment-queue-store.js";
import { RuntimeBudgetStore, type RuntimeBudgetRecord } from "./budget-store.js";

export const RuntimePostmortemScopeSchema = z.object({
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
}).strict().refine((scope) => Boolean(scope.goal_id || scope.run_id), {
  message: "goal_id or run_id is required",
});
export type RuntimePostmortemScope = z.infer<typeof RuntimePostmortemScopeSchema>;

export const RuntimePostmortemEvidenceRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  observed_at: z.string().datetime().optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimePostmortemEvidenceRef = z.infer<typeof RuntimePostmortemEvidenceRefSchema>;

const RuntimePostmortemFiniteNumberSchema = z.number().finite();
const RuntimePostmortemSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();

export const RuntimePostmortemReportSchema = z.object({
  schema_version: z.literal("runtime-postmortem-v1"),
  postmortem_id: z.string().min(1),
  generated_at: z.string().datetime(),
  scope: RuntimePostmortemScopeSchema,
  final_status: z.string().min(1),
  trigger: z.enum(["completion", "pause", "finalization", "operator_request"]),
  artifact_paths: z.object({
    json_path: z.string().min(1),
    markdown_path: z.string().min(1),
    state_relative_json_path: z.string().min(1),
    state_relative_markdown_path: z.string().min(1),
  }).strict(),
  timeline: z.array(z.object({
    occurred_at: z.string().datetime(),
    kind: z.string().min(1),
    summary: z.string().min(1),
    evidence_refs: z.array(RuntimePostmortemEvidenceRefSchema).default([]),
  }).strict()).default([]),
  metric_timeline: z.array(z.object({
    metric_key: z.string().min(1),
    direction: z.enum(["maximize", "minimize"]),
    trend: z.string().min(1),
    latest_value: RuntimePostmortemFiniteNumberSchema,
    best_value: RuntimePostmortemFiniteNumberSchema,
    observation_count: RuntimePostmortemSafeNonnegativeIntSchema,
    source_refs: z.array(RuntimePostmortemEvidenceRefSchema).default([]),
    summary: z.string().min(1),
  }).strict()).default([]),
  candidate_decisions: z.object({
    lineages: z.array(z.unknown()).default([]),
    selection_summary: z.unknown(),
    recommended_portfolio: z.array(z.unknown()).default([]),
    near_misses: z.array(z.unknown()).default([]),
    failed_lineages: z.array(z.unknown()).default([]),
  }).strict(),
  final_outputs: z.array(z.object({
    label: z.string().min(1),
    path: z.string().min(1).optional(),
    state_relative_path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    kind: z.string().min(1).optional(),
    retention_class: z.string().min(1).optional(),
    evidence_entry_ids: z.array(z.string().min(1)).default([]),
    manifest_id: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
    observed_at: z.string().datetime().optional(),
  }).strict()).default([]),
  evaluator_gaps: z.array(z.unknown()).default([]),
  handoffs: z.array(z.unknown()).default([]),
  manifests: z.array(z.unknown()).default([]),
  budgets: z.array(z.unknown()).default([]),
  experiment_queues: z.array(z.unknown()).default([]),
  follow_up_actions: z.array(z.object({
    title: z.string().min(1),
    rationale: z.string().min(1),
    evidence_refs: z.array(RuntimePostmortemEvidenceRefSchema).default([]),
    approval_required: z.boolean().default(false),
    auto_create: z.literal(false).default(false),
  }).strict()).default([]),
  evidence_refs: z.array(RuntimePostmortemEvidenceRefSchema).default([]),
  warnings: z.array(z.string().min(1)).default([]),
}).strict();
export type RuntimePostmortemReport = z.infer<typeof RuntimePostmortemReportSchema>;

export interface RuntimePostmortemGenerateInput {
  goalId?: string;
  runId?: string;
  finalStatus?: string;
  trigger?: RuntimePostmortemReport["trigger"];
}

export class RuntimePostmortemReportStore {
  private readonly paths: RuntimeStorePaths;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
  }

  async generate(input: RuntimePostmortemGenerateInput): Promise<RuntimePostmortemReport> {
    const scope = RuntimePostmortemScopeSchema.parse({
      ...(input.goalId ? { goal_id: input.goalId } : {}),
      ...(input.runId ? { run_id: input.runId } : {}),
    });
    await ensureRuntimeStorePaths(this.paths);
    const postmortemId = postmortemIdFor(scope);
    const generatedAt = new Date().toISOString();
    const ledger = new RuntimeEvidenceLedger(this.paths);
    const { entries, summary } = await this.readEvidence(scope, ledger);
    const scopeContext = buildScopeContext(scope, entries);
    const manifests = await this.readManifests(scopeContext);
    const handoffs = await this.readHandoffs(scopeContext);
    const budgets = await this.readBudgets(scopeContext);
    const experimentQueues = await this.readExperimentQueues(scopeContext);
    const reportPaths = this.reportPaths(postmortemId);

    const report = RuntimePostmortemReportSchema.parse({
      schema_version: "runtime-postmortem-v1",
      postmortem_id: postmortemId,
      generated_at: generatedAt,
      scope,
      final_status: input.finalStatus ?? inferFinalStatus(scope, summary, handoffs),
      trigger: input.trigger ?? inferTrigger(input.finalStatus, handoffs),
      artifact_paths: reportPaths,
      timeline: buildTimeline(entries),
      metric_timeline: buildMetricTimeline(entries, summary),
      candidate_decisions: {
        lineages: summary.candidate_lineages,
        selection_summary: summary.candidate_selection_summary,
        recommended_portfolio: summary.recommended_candidate_portfolio,
        near_misses: summary.near_miss_candidates,
        failed_lineages: summary.failed_lineages,
      },
      final_outputs: buildFinalOutputs(summary, manifests, entries),
      evaluator_gaps: summary.evaluator_summary.gap ? [summary.evaluator_summary.gap] : [],
      handoffs: handoffs.map(summarizeHandoff),
      manifests: manifests.map(summarizeManifest),
      budgets: budgets.map((budget) => ({
        budget_id: budget.budget_id,
        scope: budget.scope,
        title: budget.title,
        updated_at: budget.updated_at,
        status: new RuntimeBudgetStore(this.paths).status(budget),
      })),
      experiment_queues: experimentQueues.map(summarizeExperimentQueue),
      follow_up_actions: buildFollowUpActions(summary, handoffs),
      evidence_refs: collectEvidenceRefs(entries, manifests, handoffs),
      warnings: summary.warnings.map((warning) => `${warning.file}:${warning.line} ${warning.message}`),
    });

    await this.writeReport(report);
    await this.appendEvidenceEntry(ledger, report);
    return report;
  }

  async load(postmortemId: string): Promise<RuntimePostmortemReport | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.paths.postmortemJsonPath(postmortemId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }

    const parsed = RuntimePostmortemReportSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  }

  async latestFor(input: { goalId?: string; runId?: string }): Promise<RuntimePostmortemReport | null> {
    const scope = RuntimePostmortemScopeSchema.parse({
      ...(input.goalId ? { goal_id: input.goalId } : {}),
      ...(input.runId ? { run_id: input.runId } : {}),
    });
    return this.load(postmortemIdFor(scope));
  }

  markdownFor(report: RuntimePostmortemReport): string {
    return renderPostmortemMarkdown(report);
  }

  private async readEvidence(
    scope: RuntimePostmortemScope,
    ledger: RuntimeEvidenceLedger
  ): Promise<{ entries: RuntimeEvidenceEntry[]; summary: RuntimeEvidenceSummary }> {
    if (scope.run_id) {
      const [read, summary] = await Promise.all([
        ledger.readByRun(scope.run_id),
        ledger.summarizeRun(scope.run_id),
      ]);
      return { entries: read.entries, summary };
    }
    const [read, summary] = await Promise.all([
      ledger.readByGoal(scope.goal_id!),
      ledger.summarizeGoal(scope.goal_id!),
    ]);
    return { entries: read.entries, summary };
  }

  private async readManifests(scope: RuntimePostmortemScopeContext): Promise<RuntimeReproducibilityManifest[]> {
    let fileNames: string[];
    try {
      fileNames = await fsp.readdir(this.paths.reproducibilityManifestsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const manifests: RuntimeReproducibilityManifest[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      try {
        const parsed = RuntimeReproducibilityManifestSchema.parse(JSON.parse(
          await fsp.readFile(path.join(this.paths.reproducibilityManifestsDir, fileName), "utf8")
        ));
        if (scopeMatches(scope, parsed.scope)) manifests.push(parsed);
      } catch {
        continue;
      }
    }
    return manifests.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  private async readHandoffs(scope: RuntimePostmortemScopeContext): Promise<RuntimeOperatorHandoffRecord[]> {
    const store = new RuntimeOperatorHandoffStore(this.paths);
    const handoffs = await store.list();
    return handoffs.filter((handoff) => scopeMatches(scope, { goal_id: handoff.goal_id, run_id: handoff.run_id }));
  }

  private async readBudgets(scope: RuntimePostmortemScopeContext): Promise<RuntimeBudgetRecord[]> {
    const store = new RuntimeBudgetStore(this.paths);
    const budgets = await store.list();
    return budgets.filter((budget) => scopeMatches(scope, budget.scope));
  }

  private async readExperimentQueues(scope: RuntimePostmortemScopeContext): Promise<RuntimeExperimentQueueRecord[]> {
    const store = new RuntimeExperimentQueueStore(this.paths);
    const queues = await store.list();
    return queues.filter((queue) => scopeMatches(scope, { goal_id: queue.goal_id, run_id: queue.run_id }));
  }

  private reportPaths(postmortemId: string): RuntimePostmortemReport["artifact_paths"] {
    const dirName = encodeRuntimePathSegment(postmortemId);
    return {
      json_path: this.paths.postmortemJsonPath(postmortemId),
      markdown_path: this.paths.postmortemMarkdownPath(postmortemId),
      state_relative_json_path: path.join("postmortems", dirName, "postmortem.json"),
      state_relative_markdown_path: path.join("postmortems", dirName, "postmortem.md"),
    };
  }

  private async writeReport(report: RuntimePostmortemReport): Promise<void> {
    await fsp.mkdir(this.paths.postmortemDir(report.postmortem_id), { recursive: true });
    await Promise.all([
      fsp.writeFile(report.artifact_paths.json_path, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      fsp.writeFile(report.artifact_paths.markdown_path, renderPostmortemMarkdown(report), "utf8"),
    ]);
  }

  private async appendEvidenceEntry(ledger: RuntimeEvidenceLedger, report: RuntimePostmortemReport): Promise<void> {
    const evidenceId = `${report.postmortem_id}:artifact`;
    const read = report.scope.run_id
      ? await ledger.readByRun(report.scope.run_id)
      : await ledger.readByGoal(report.scope.goal_id!);
    if (read.entries.some((entry) => entry.id === evidenceId)) return;
    await ledger.append({
      id: evidenceId,
      occurred_at: report.generated_at,
      kind: "artifact",
      scope: {
        ...(report.scope.goal_id ? { goal_id: report.scope.goal_id } : {}),
        ...(report.scope.run_id ? { run_id: report.scope.run_id } : {}),
      },
      artifacts: [
        {
          label: "postmortem.md",
          path: report.artifact_paths.markdown_path,
          state_relative_path: report.artifact_paths.state_relative_markdown_path,
          kind: "report",
          retention_class: "evidence_report",
        },
        {
          label: "postmortem.json",
          path: report.artifact_paths.json_path,
          state_relative_path: report.artifact_paths.state_relative_json_path,
          kind: "metrics",
          retention_class: "evidence_report",
        },
      ],
      raw_refs: [{ kind: "runtime_postmortem", id: report.postmortem_id }],
      summary: `Postmortem generated for ${report.scope.run_id ?? report.scope.goal_id}.`,
      outcome: "continued",
    });
  }
}

function postmortemIdFor(scope: RuntimePostmortemScope): string {
  return scope.run_id ? `postmortem:run:${scope.run_id}` : `postmortem:goal:${scope.goal_id}`;
}

interface RuntimePostmortemScopeContext extends RuntimePostmortemScope {
  linked_goal_ids: string[];
}

function buildScopeContext(
  scope: RuntimePostmortemScope,
  entries: RuntimeEvidenceEntry[]
): RuntimePostmortemScopeContext {
  const linkedGoalIds = new Set<string>();
  if (scope.goal_id) linkedGoalIds.add(scope.goal_id);
  for (const entry of entries) {
    if (entry.scope.goal_id) linkedGoalIds.add(entry.scope.goal_id);
  }
  return {
    ...scope,
    linked_goal_ids: [...linkedGoalIds],
  };
}

function scopeMatches(
  requested: RuntimePostmortemScopeContext,
  candidate: { goal_id?: string; run_id?: string }
): boolean {
  if (requested.run_id) {
    if (candidate.run_id) return candidate.run_id === requested.run_id;
    return Boolean(candidate.goal_id && requested.linked_goal_ids.includes(candidate.goal_id));
  }
  if (candidate.goal_id && requested.linked_goal_ids.includes(candidate.goal_id)) return true;
  return !requested.run_id && candidate.goal_id === requested.goal_id;
}

function buildTimeline(entries: RuntimeEvidenceEntry[]): RuntimePostmortemReport["timeline"] {
  return entries
    .slice()
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map((entry) => ({
      occurred_at: entry.occurred_at,
      kind: entry.kind,
      summary: entry.summary ?? entry.result?.summary ?? entry.decision_reason ?? entry.id,
      evidence_refs: refsForEntry(entry),
    }));
}

function buildMetricTimeline(
  entries: RuntimeEvidenceEntry[],
  summary: RuntimeEvidenceSummary
): RuntimePostmortemReport["metric_timeline"] {
  const observations = extractMetricObservationsFromEvidence(entries);
  return summary.metric_trends.map((trend) => ({
    metric_key: trend.metric_key,
    direction: trend.direction,
    trend: trend.trend,
    latest_value: trend.latest_value,
    best_value: trend.best_value,
    observation_count: trend.observation_count,
    source_refs: observations
      .filter((observation) => observation.metric_key === trend.metric_key && observation.direction === trend.direction)
      .map((observation) => ({
        kind: observation.source.kind,
        ref: observation.source.entry_id,
        observed_at: observation.observed_at,
        ...(observation.source.summary ? { summary: observation.source.summary } : {}),
      })),
    summary: trend.summary,
  }));
}

function buildFinalOutputs(
  summary: RuntimeEvidenceSummary,
  manifests: RuntimeReproducibilityManifest[],
  entries: RuntimeEvidenceEntry[]
): RuntimePostmortemReport["final_outputs"] {
  const outputs = new Map<string, RuntimePostmortemReport["final_outputs"][number]>();
  for (const action of summary.artifact_retention.cleanup_plan.actions) {
    if (!action.protected && action.retention_class !== "final_deliverable") continue;
    const key = action.path ?? action.state_relative_path ?? action.url ?? action.key;
    outputs.set(key, {
      label: action.label,
      ...(action.path ? { path: action.path } : {}),
      ...(action.state_relative_path ? { state_relative_path: action.state_relative_path } : {}),
      ...(action.url ? { url: action.url } : {}),
      kind: action.kind,
      retention_class: action.retention_class,
      evidence_entry_ids: action.evidence_entry_ids,
    });
  }
  for (const manifest of manifests) {
    for (const artifact of manifest.artifacts) {
      const key = artifact.path ?? artifact.state_relative_path ?? artifact.label;
      const existing = outputs.get(key);
      outputs.set(key, {
        label: artifact.label,
        ...(artifact.path ? { path: artifact.path } : {}),
        ...(artifact.state_relative_path ? { state_relative_path: artifact.state_relative_path } : {}),
        kind: artifact.kind,
        evidence_entry_ids: existing?.evidence_entry_ids ?? evidenceIdsForArtifact(entries, artifact),
        manifest_id: manifest.manifest_id,
        ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
        ...(existing?.observed_at ? { observed_at: existing.observed_at } : {}),
      });
    }
  }
  return [...outputs.values()];
}

function buildFollowUpActions(
  summary: RuntimeEvidenceSummary,
  handoffs: RuntimeOperatorHandoffRecord[]
): RuntimePostmortemReport["follow_up_actions"] {
  const actions: RuntimePostmortemReport["follow_up_actions"] = [];
  for (const nearMiss of summary.near_miss_candidates) {
    if (!nearMiss.follow_up) continue;
    actions.push({
      title: nearMiss.follow_up.title,
      rationale: nearMiss.follow_up.rationale,
      evidence_refs: nearMiss.evidence_refs.map((ref) => ({ kind: "evidence", ref })),
      approval_required: false,
      auto_create: false,
    });
  }
  for (const failed of summary.failed_lineages.slice(0, 3)) {
    actions.push({
      title: `Revisit failed lineage: ${failed.fingerprint}`,
      rationale: failed.failure_reason ?? failed.representative_summary,
      evidence_refs: failed.evidence_entry_ids.map((ref) => ({ kind: "evidence", ref })),
      approval_required: false,
      auto_create: false,
    });
  }
  for (const handoff of handoffs.filter((item) => item.status === "open").slice(0, 5)) {
    actions.push({
      title: handoff.next_action.label,
      rationale: handoff.recommended_action,
      evidence_refs: handoff.evidence_refs.map((ref) => ({
        kind: ref.kind,
        ref: ref.ref,
        ...(ref.observed_at ? { observed_at: ref.observed_at } : {}),
      })),
      approval_required: handoff.next_action.approval_required,
      auto_create: false,
    });
  }
  if (summary.evaluator_summary.gap && summary.evaluator_summary.gap.kind !== "none") {
    actions.push({
      title: `Resolve evaluator gap: ${summary.evaluator_summary.gap.kind}`,
      rationale: summary.evaluator_summary.gap.summary,
      evidence_refs: [],
      approval_required: summary.evaluator_summary.approval_required_actions.length > 0,
      auto_create: false,
    });
  }
  return actions;
}

function collectEvidenceRefs(
  entries: RuntimeEvidenceEntry[],
  manifests: RuntimeReproducibilityManifest[],
  handoffs: RuntimeOperatorHandoffRecord[]
): RuntimePostmortemEvidenceRef[] {
  const refs = new Map<string, RuntimePostmortemEvidenceRef>();
  for (const entry of entries) {
    refs.set(`evidence:${entry.id}`, {
      kind: "runtime_evidence",
      ref: entry.id,
      observed_at: entry.occurred_at,
      ...(entry.summary ? { summary: entry.summary } : {}),
    });
    for (const artifact of entry.artifacts) {
      const ref = artifact.state_relative_path ?? artifact.path ?? artifact.url;
      if (ref) refs.set(`artifact:${ref}`, { kind: "artifact", ref, observed_at: entry.occurred_at, summary: artifact.label });
    }
  }
  for (const manifest of manifests) {
    refs.set(`manifest:${manifest.manifest_id}`, {
      kind: "reproducibility_manifest",
      ref: manifest.manifest_id,
      observed_at: manifest.updated_at,
      summary: manifest.finalization_preflight.status,
    });
  }
  for (const handoff of handoffs) {
    refs.set(`handoff:${handoff.handoff_id}`, {
      kind: "operator_handoff",
      ref: handoff.handoff_id,
      observed_at: handoff.created_at,
      summary: handoff.title,
    });
  }
  return [...refs.values()].sort((a, b) => (a.observed_at ?? "").localeCompare(b.observed_at ?? ""));
}

function refsForEntry(entry: RuntimeEvidenceEntry): RuntimePostmortemEvidenceRef[] {
  return [
    {
      kind: "runtime_evidence",
      ref: entry.id,
      observed_at: entry.occurred_at,
      ...(entry.summary ? { summary: entry.summary } : {}),
    },
    ...entry.raw_refs.map((ref) => ({
      kind: ref.kind,
      ref: ref.state_relative_path ?? ref.path ?? ref.url ?? ref.id ?? entry.id,
      observed_at: entry.occurred_at,
    })),
  ];
}

function evidenceIdsForArtifact(
  entries: RuntimeEvidenceEntry[],
  artifact: { label: string; path?: string; state_relative_path?: string }
): string[] {
  return entries
    .filter((entry) => entry.artifacts.some((candidate) =>
      candidate.label === artifact.label
      || (artifact.path && candidate.path === artifact.path)
      || (artifact.state_relative_path && candidate.state_relative_path === artifact.state_relative_path)
    ))
    .map((entry) => entry.id);
}

function summarizeManifest(manifest: RuntimeReproducibilityManifest): Record<string, unknown> {
  return {
    manifest_id: manifest.manifest_id,
    updated_at: manifest.updated_at,
    scope: manifest.scope,
    selected_candidate: manifest.selected_candidate?.candidate_id ?? null,
    selected_deliverable: manifest.selected_deliverable?.label ?? null,
    finalization_preflight: manifest.finalization_preflight,
    artifact_count: manifest.artifacts.length,
    evaluator_record_count: manifest.evaluator_records.length,
  };
}

function summarizeHandoff(handoff: RuntimeOperatorHandoffRecord): Record<string, unknown> {
  return {
    handoff_id: handoff.handoff_id,
    status: handoff.status,
    triggers: handoff.triggers,
    title: handoff.title,
    created_at: handoff.created_at,
    resolved_at: handoff.resolved_at ?? null,
    recommended_action: handoff.recommended_action,
    required_approvals: handoff.required_approvals,
    evidence_refs: handoff.evidence_refs,
  };
}

function summarizeExperimentQueue(queue: RuntimeExperimentQueueRecord): Record<string, unknown> {
  const revision = queue.revisions.find((candidate) => candidate.version === queue.current_version) ?? queue.revisions.at(-1)!;
  return {
    queue_id: queue.queue_id,
    goal_id: queue.goal_id ?? null,
    run_id: queue.run_id ?? null,
    title: queue.title ?? null,
    current_version: queue.current_version,
    phase: revision.phase,
    status: revision.status,
    updated_at: queue.updated_at,
    items: {
      total: revision.items.length,
      succeeded: revision.items.filter((item) => item.status === "succeeded").length,
      failed: revision.items.filter((item) => item.status === "failed").length,
      pending: revision.items.filter((item) => item.status === "pending").length,
      running: revision.items.filter((item) => item.status === "running").length,
    },
  };
}

function inferFinalStatus(
  scope: RuntimePostmortemScope,
  summary: RuntimeEvidenceSummary,
  handoffs: RuntimeOperatorHandoffRecord[]
): string {
  const recentStatus = summary.recent_entries.find((entry) => entry.result?.status)?.result?.status;
  if (recentStatus) return recentStatus;
  if (handoffs.some((handoff) => handoff.triggers.includes("finalization"))) return "finalization";
  return scope.run_id ? "completed_or_paused" : "completed";
}

function inferTrigger(
  finalStatus: string | undefined,
  handoffs: RuntimeOperatorHandoffRecord[]
): RuntimePostmortemReport["trigger"] {
  if (finalStatus === "finalization" || handoffs.some((handoff) => handoff.triggers.includes("finalization"))) return "finalization";
  if (finalStatus === "stopped" || finalStatus === "paused") return "pause";
  return finalStatus === "completed" ? "completion" : "operator_request";
}

function renderPostmortemMarkdown(report: RuntimePostmortemReport): string {
  const lines: string[] = [
    `# Runtime Postmortem: ${report.scope.run_id ?? report.scope.goal_id}`,
    "",
    `- Generated: ${report.generated_at}`,
    `- Final status: ${report.final_status}`,
    `- Trigger: ${report.trigger}`,
    "",
    "## Metric Timeline",
    ...sectionLines(report.metric_timeline, (metric) =>
      `- ${metric.metric_key}: ${metric.trend}, latest=${metric.latest_value}, best=${metric.best_value}, observations=${metric.observation_count}`
    ),
    "",
    "## Candidate Decisions",
    `- Candidate lineages: ${report.candidate_decisions.lineages.length}`,
    `- Recommended portfolio items: ${report.candidate_decisions.recommended_portfolio.length}`,
    `- Near misses: ${report.candidate_decisions.near_misses.length}`,
    `- Failed lineages: ${report.candidate_decisions.failed_lineages.length}`,
    "",
    "## Final Outputs",
    ...sectionLines(report.final_outputs, (artifact) =>
      `- ${artifact.label}: ${artifact.state_relative_path ?? artifact.path ?? artifact.url ?? "no path"}${artifact.manifest_id ? ` (manifest ${artifact.manifest_id})` : ""}`
    ),
    "",
    "## Operator Handoffs",
    ...sectionLines(report.handoffs as Array<{ handoff_id?: string; status?: string; title?: string }>, (handoff) =>
      `- ${handoff.handoff_id ?? "-"}: ${handoff.status ?? "-"} ${handoff.title ?? ""}`.trim()
    ),
    "",
    "## Follow-up Actions",
    ...sectionLines(report.follow_up_actions, (action) =>
      `- ${action.title}: ${action.rationale} (auto_create=${action.auto_create}, approval_required=${action.approval_required})`
    ),
    "",
    "## Evidence",
    ...sectionLines(report.evidence_refs.slice(0, 40), (ref) =>
      `- ${ref.kind}: ${ref.ref}${ref.observed_at ? ` @ ${ref.observed_at}` : ""}${ref.summary ? ` - ${ref.summary}` : ""}`
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function sectionLines<T>(items: T[], format: (item: T) => string): string[] {
  return items.length > 0 ? items.map(format) : ["- (none)"];
}
