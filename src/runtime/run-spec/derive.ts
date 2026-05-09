import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";
import {
  RunSpecConfidenceValueSchema,
  RunSpecFiniteScalarSchema,
  RunSpecRankPercentSchema,
  RunSpecSafeNonnegativeIntSchema,
  RunSpecSafePositiveIntSchema,
  type RunSpec,
  type RunSpecApprovalPolicy,
  type RunSpecArtifactContract,
  type RunSpecConfidence,
  type RunSpecDeadline,
  type RunSpecDerivationContext,
  type RunSpecMetric,
  type RunSpecMissingField,
  type RunSpecProgressContract,
} from "./types.js";

const MIN_RUNSPEC_CONFIDENCE = 0.7;

const DraftConfidenceSchema = z.enum(["high", "medium", "low"]).optional();

const DraftWorkspaceSchema = z.object({
  path: z.string().min(1),
  source: z.enum(["user", "context"]).optional(),
  confidence: DraftConfidenceSchema,
}).nullable();

const DraftExecutionTargetSchema = z.object({
  kind: z.enum(["local", "daemon", "remote"]),
  remote_host: z.string().nullable().optional(),
  confidence: DraftConfidenceSchema,
}).optional();

const DraftMetricSchema = z.object({
  name: z.string().min(1),
  direction: z.enum(["maximize", "minimize", "unknown"]),
  target: RunSpecFiniteScalarSchema.nullable().optional(),
  target_rank_percent: RunSpecRankPercentSchema.nullable().optional(),
  datasource: z.string().nullable().optional(),
  confidence: DraftConfidenceSchema,
}).nullable();

const DraftProgressContractSchema = z.object({
  kind: z.enum(["metric_target", "rank_percentile", "deadline_only", "open_ended", "unknown"]),
  dimension: z.string().nullable().optional(),
  threshold: RunSpecFiniteScalarSchema.nullable().optional(),
  semantics: z.string().min(1),
  confidence: DraftConfidenceSchema,
}).optional();

const DraftDeadlineSchema = z.object({
  raw: z.string().min(1),
  iso_at: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  finalization_buffer_minutes: RunSpecSafeNonnegativeIntSchema.nullable().optional(),
  confidence: DraftConfidenceSchema,
}).nullable();

const DraftBudgetSchema = z.object({
  max_trials: RunSpecSafePositiveIntSchema.nullable().optional(),
  max_wall_clock_minutes: RunSpecSafeNonnegativeIntSchema.nullable().optional(),
  resident_policy: z.enum(["until_deadline", "best_effort", "unknown"]).optional(),
}).optional();

const DraftApprovalPolicySchema = z.object({
  submit: z.enum(["approval_required", "allowed", "disallowed", "unspecified"]).optional(),
  publish: z.enum(["approval_required", "allowed", "disallowed", "unspecified"]).optional(),
  secret: z.enum(["approval_required", "disallowed", "unspecified"]).optional(),
  external_action: z.enum(["approval_required", "allowed", "disallowed", "unspecified"]).optional(),
  irreversible_action: z.enum(["approval_required", "disallowed", "unspecified"]).optional(),
}).optional();

const DraftArtifactContractSchema = z.object({
  expected_artifacts: z.array(z.string()).optional(),
  discovery_globs: z.array(z.string()).optional(),
  primary_outputs: z.array(z.string()).optional(),
}).optional();

const RunSpecDraftSchema = z.object({
  decision: z.enum(["run_spec_request", "not_run_spec_request"]),
  confidence: RunSpecConfidenceValueSchema,
  profile: z.enum(["generic", "kaggle"]).optional(),
  objective: z.string().optional(),
  workspace: DraftWorkspaceSchema.optional(),
  execution_target: DraftExecutionTargetSchema,
  metric: DraftMetricSchema.optional(),
  progress_contract: DraftProgressContractSchema,
  deadline: DraftDeadlineSchema.optional(),
  budget: DraftBudgetSchema,
  approval_policy: DraftApprovalPolicySchema,
  artifact_contract: DraftArtifactContractSchema,
  missing_fields: z.array(z.object({
    field: z.string().min(1),
    question: z.string().min(1),
    severity: z.enum(["required", "confirmation"]),
  })).default([]),
  reason: z.string().optional(),
});

type RunSpecDraft = z.infer<typeof RunSpecDraftSchema>;

export interface RunSpecIntent {
  needsRunSpec: true;
  profile: "generic" | "kaggle";
  reason: string;
  confidence: number;
}

function getRunSpecDraftPrompt(context: RunSpecDerivationContext): string {
  const cwdLine = context.cwd ? `Current workspace context: ${context.cwd}` : "Current workspace context: unavailable";
  const timezoneLine = context.timezone ? `Timezone: ${context.timezone}` : "Timezone: unavailable";
  const nowLine = `Current time: ${(context.now ?? new Date()).toISOString()}`;
  return `${getInternalIdentityPrefix("assistant")} Convert an operator message into a PulSeed long-running RunSpec draft only when the user is asking PulSeed to run, continue, optimize, evaluate, or monitor autonomous work over time.

Return not_run_spec_request for ordinary chat, explanations, questions about how PulSeed works, runtime-control commands, and ambiguous text that does not clearly request long-running work.

When it is a run spec request, extract a typed draft:
- profile: kaggle for Kaggle/competition/leaderboard/submission workflows, otherwise generic.
- objective: concise operator objective in the user's meaning.
- workspace: explicit user workspace path if named. If none is named, omit it; the caller may use context.
- execution_target: local, daemon, or remote; include remote_host only when explicitly known.
- metric: metric name, direction, numeric target or rank percentile target, datasource when known.
- progress_contract: measurable progress semantics, or deadline/open ended when no metric target exists.
- deadline: raw user deadline plus ISO timestamp if the user gave enough information. Use the provided current time and timezone.
- budget: max trials, wall-clock minutes, resident policy if specified or implied by deadline.
- approval_policy: mark submit/publish/external/irreversible/secret actions approval_required unless the user explicitly allows or disallows them.
- missing_fields: required clarifications for workspace, deadline, metric direction, target, or approval policy that must not be guessed.

${cwdLine}
${timezoneLine}
${nowLine}

Respond only as JSON with this shape:
{
  "decision": "run_spec_request" | "not_run_spec_request",
  "confidence": 0.0-1.0,
  "profile": "generic" | "kaggle",
  "objective": "...",
  "workspace": { "path": "...", "source": "user", "confidence": "high" } | null,
  "execution_target": { "kind": "local" | "daemon" | "remote", "remote_host": null, "confidence": "medium" },
  "metric": { "name": "...", "direction": "maximize" | "minimize" | "unknown", "target": 0.91, "target_rank_percent": null, "datasource": "...", "confidence": "medium" } | null,
  "progress_contract": { "kind": "metric_target" | "rank_percentile" | "deadline_only" | "open_ended" | "unknown", "dimension": "...", "threshold": 0.91, "semantics": "...", "confidence": "medium" },
  "deadline": { "raw": "...", "iso_at": "2026-05-03T00:00:00.000Z", "timezone": "...", "finalization_buffer_minutes": 60, "confidence": "medium" } | null,
  "budget": { "max_trials": null, "max_wall_clock_minutes": null, "resident_policy": "until_deadline" },
  "approval_policy": { "submit": "approval_required", "publish": "unspecified", "secret": "approval_required", "external_action": "approval_required", "irreversible_action": "approval_required" },
  "artifact_contract": { "expected_artifacts": ["..."], "discovery_globs": ["..."], "primary_outputs": ["..."] },
  "missing_fields": [{ "field": "deadline", "question": "...", "severity": "required" }],
  "reason": "short rationale"
}`;
}

export async function understandRunSpecDraft(
  text: string,
  context: RunSpecDerivationContext = {},
): Promise<RunSpecDraft | null> {
  const trimmed = text.trim();
  const llmClient = context.llmClient;
  if (!trimmed || !llmClient) return null;
  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getRunSpecDraftPrompt(context), max_tokens: 900, temperature: 0 },
    );
    const draft = llmClient.parseJSON(response.content, RunSpecDraftSchema);
    if (draft.decision !== "run_spec_request" || draft.confidence < MIN_RUNSPEC_CONFIDENCE) {
      return null;
    }
    return {
      ...draft,
      missing_fields: draft.missing_fields ?? [],
    };
  } catch {
    return null;
  }
}

export async function deriveRunSpecFromText(
  text: string,
  context: RunSpecDerivationContext = {},
): Promise<RunSpec | null> {
  const draft = await understandRunSpecDraft(text, context);
  if (!draft) return null;

  const now = context.now ?? new Date();
  const createdAt = now.toISOString();
  const profile = draft.profile ?? "generic";
  const workspace = normalizeWorkspace(draft, context);
  const deadline = normalizeDeadline(draft, context);
  const metric = normalizeMetric(draft);
  const progressContract = normalizeProgressContract(draft, metric, deadline);
  const approvalPolicy = normalizeApprovalPolicy(draft.approval_policy);
  const missingFields = normalizeMissingFields(draft, workspace, deadline, metric);

  return {
    schema_version: "run-spec-v1",
    id: `runspec-${randomUUID()}`,
    status: "draft",
    profile,
    source_text: text,
    objective: normalizeObjective(draft.objective, text),
    workspace,
    execution_target: normalizeExecutionTarget(draft),
    metric,
    progress_contract: progressContract,
    deadline,
    budget: {
      max_trials: draft.budget?.max_trials ?? null,
      max_wall_clock_minutes: draft.budget?.max_wall_clock_minutes
        ?? (deadline?.iso_at ? minutesUntil(now, new Date(deadline.iso_at)) : null),
      resident_policy: draft.budget?.resident_policy ?? (deadline ? "until_deadline" : "unknown"),
    },
    approval_policy: approvalPolicy,
    artifact_contract: normalizeArtifactContract(profile, draft.artifact_contract),
    risk_flags: deriveRiskFlags(approvalPolicy),
    missing_fields: missingFields,
    confidence: deriveSpecConfidence(draft.confidence, missingFields),
    links: {
      goal_id: null,
      runtime_session_id: null,
      conversation_id: context.conversationId ?? null,
    },
    origin: {
      channel: context.channel ?? null,
      session_id: context.sessionId ?? context.conversationId ?? null,
      reply_target: context.replyTarget ?? null,
      metadata: context.originMetadata ?? {},
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function normalizeWorkspace(draft: RunSpecDraft, context: RunSpecDerivationContext): RunSpec["workspace"] {
  if (draft.workspace?.path) {
    return {
      path: draft.workspace.path,
      source: draft.workspace.source ?? "user",
      confidence: toConfidence(draft.workspace.confidence, "high"),
    };
  }
  const normalizedCwd = context.cwd?.trim();
  if (normalizedCwd) {
    return { path: normalizedCwd, source: "context", confidence: "medium" };
  }
  return null;
}

function normalizeExecutionTarget(draft: RunSpecDraft): RunSpec["execution_target"] {
  const target = draft.execution_target;
  return {
    kind: target?.kind ?? "local",
    remote_host: target?.remote_host ?? null,
    confidence: toConfidence(target?.confidence, target ? "medium" : "low"),
  };
}

function normalizeMetric(draft: RunSpecDraft): RunSpecMetric | null {
  const metric = draft.metric;
  if (!metric) return null;
  return {
    name: metric.name,
    direction: metric.direction,
    target: metric.target ?? null,
    target_rank_percent: metric.target_rank_percent ?? null,
    datasource: metric.datasource ?? null,
    confidence: toConfidence(metric.confidence, "medium"),
  };
}

function normalizeProgressContract(
  draft: RunSpecDraft,
  metric: RunSpecMetric | null,
  deadline: RunSpecDeadline | null,
): RunSpecProgressContract {
  if (draft.progress_contract) {
    return {
      kind: draft.progress_contract.kind,
      dimension: draft.progress_contract.dimension ?? null,
      threshold: draft.progress_contract.threshold ?? null,
      semantics: draft.progress_contract.semantics,
      confidence: toConfidence(draft.progress_contract.confidence, "medium"),
    };
  }
  if (metric?.target_rank_percent !== null && metric?.target_rank_percent !== undefined) {
    return {
      kind: "rank_percentile",
      dimension: metric.name,
      threshold: metric.target_rank_percent,
      semantics: "Reach the requested rank percentile threshold.",
      confidence: "high",
    };
  }
  if (metric?.target !== null && metric?.target !== undefined) {
    return {
      kind: "metric_target",
      dimension: metric.name,
      threshold: metric.target,
      semantics: "Reach the requested metric target; metric direction is tracked separately.",
      confidence: metric.direction === "unknown" ? "medium" : "high",
    };
  }
  if (deadline) {
    return {
      kind: "deadline_only",
      dimension: "time",
      threshold: null,
      semantics: "Keep useful work going until the requested deadline or review time.",
      confidence: "medium",
    };
  }
  return {
    kind: "unknown",
    dimension: null,
    threshold: null,
    semantics: "RunSpec request needs a measurable progress contract.",
    confidence: "low",
  };
}

function normalizeDeadline(draft: RunSpecDraft, context: RunSpecDerivationContext): RunSpecDeadline | null {
  if (!draft.deadline) return null;
  return {
    raw: draft.deadline.raw,
    iso_at: draft.deadline.iso_at ?? null,
    timezone: draft.deadline.timezone ?? context.timezone ?? null,
    finalization_buffer_minutes: draft.deadline.finalization_buffer_minutes ?? null,
    confidence: toConfidence(draft.deadline.confidence, "medium"),
  };
}

function normalizeApprovalPolicy(policy: RunSpecDraft["approval_policy"]): RunSpecApprovalPolicy {
  return {
    submit: policy?.submit ?? "unspecified",
    publish: policy?.publish ?? "unspecified",
    secret: policy?.secret ?? "approval_required",
    external_action: policy?.external_action ?? "unspecified",
    irreversible_action: policy?.irreversible_action ?? "approval_required",
  };
}

function normalizeArtifactContract(
  profile: "generic" | "kaggle",
  draft: RunSpecDraft["artifact_contract"],
): RunSpecArtifactContract {
  const fallback = defaultArtifactContract(profile);
  return {
    expected_artifacts: nonEmpty(draft?.expected_artifacts) ?? fallback.expected_artifacts,
    discovery_globs: nonEmpty(draft?.discovery_globs) ?? fallback.discovery_globs,
    primary_outputs: nonEmpty(draft?.primary_outputs) ?? fallback.primary_outputs,
  };
}

function defaultArtifactContract(profile: "generic" | "kaggle"): RunSpecArtifactContract {
  if (profile === "kaggle") {
    return {
      expected_artifacts: ["submission files", "leaderboard metrics", "experiment notes", "model artifacts"],
      discovery_globs: ["**/submission*.csv", "**/leaderboard*.json", "**/metrics*.json", "reports/**/*.md"],
      primary_outputs: ["submission.csv", "metrics summary", "run report"],
    };
  }
  return {
    expected_artifacts: ["progress evidence", "final deliverable", "run report"],
    discovery_globs: ["reports/**/*.md", "artifacts/**/*", "outputs/**/*"],
    primary_outputs: ["run report"],
  };
}

function normalizeMissingFields(
  draft: RunSpecDraft,
  workspace: RunSpec["workspace"],
  deadline: RunSpecDeadline | null,
  metric: RunSpecMetric | null,
): RunSpecMissingField[] {
  const fields = [...draft.missing_fields];
  if (!workspace) {
    fields.push({
      field: "workspace",
      question: "Which local or remote workspace should PulSeed use for this run?",
      severity: "required",
    });
  }
  if (!deadline) {
    fields.push({
      field: "deadline",
      question: "What deadline or review time should PulSeed plan around?",
      severity: "required",
    });
  }
  if (metric && metric.direction === "unknown" && metric.target !== null) {
    fields.push({
      field: "metric.direction",
      question: `Should ${metric.name} be maximized or minimized?`,
      severity: "required",
    });
  }
  return dedupeMissingFields(fields);
}

function dedupeMissingFields(fields: RunSpecMissingField[]): RunSpecMissingField[] {
  const seen = new Set<string>();
  const result: RunSpecMissingField[] = [];
  for (const field of fields) {
    if (seen.has(field.field)) continue;
    seen.add(field.field);
    result.push(field);
  }
  return result;
}

function deriveSpecConfidence(confidence: number, missingFields: RunSpecMissingField[]): RunSpecConfidence {
  if (missingFields.some((field) => field.severity === "required")) return "medium";
  if (confidence >= 0.85) return "high";
  if (confidence >= MIN_RUNSPEC_CONFIDENCE) return "medium";
  return "low";
}

function deriveRiskFlags(policy: RunSpecApprovalPolicy): string[] {
  const flags: string[] = [];
  if (policy.submit === "approval_required") flags.push("external_submit_requires_approval");
  if (policy.publish === "approval_required") flags.push("publish_requires_approval");
  if (policy.secret === "approval_required") flags.push("secrets_require_approval");
  if (policy.external_action === "approval_required") flags.push("external_actions_require_approval");
  if (policy.irreversible_action === "approval_required") flags.push("irreversible_actions_require_approval");
  return flags;
}

function normalizeObjective(objective: string | undefined, text: string): string {
  const trimmed = objective?.trim();
  return trimmed ? trimmed : text.trim().replace(/\s+/g, " ");
}

function toConfidence(value: RunSpecConfidence | undefined, fallback: RunSpecConfidence): RunSpecConfidence {
  return value ?? fallback;
}

function nonEmpty(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function minutesUntil(now: Date, target: Date): number | null {
  const deltaMs = target.getTime() - now.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  return Math.ceil(deltaMs / 60_000);
}
