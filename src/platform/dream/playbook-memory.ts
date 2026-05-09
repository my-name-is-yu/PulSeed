import { createHash } from "node:crypto";
import { z } from "zod";
import { StrategyDreamStateStore } from "../../runtime/store/strategy-dream-state-store.js";
import type { Task, VerificationResult } from "../../base/types/task.js";

const PROMOTION_CONFIDENCE_THRESHOLD = 0.75;
const CANDIDATE_CONFIDENCE_THRESHOLD = 0.55;
const MAX_APPLICABILITY_TERMS = 12;

export const DreamPlaybookStatusSchema = z.enum(["candidate", "promoted", "disabled"]);
export type DreamPlaybookStatus = z.infer<typeof DreamPlaybookStatusSchema>;

export const DreamPlaybookKindSchema = z.enum(["verified_execution"]);
export type DreamPlaybookKind = z.infer<typeof DreamPlaybookKindSchema>;

export const DreamPlaybookCheckSchema = z.object({
  description: z.string().min(1),
  verification_method: z.string().min(1),
  blocking: z.boolean().default(true),
});
export type DreamPlaybookCheck = z.infer<typeof DreamPlaybookCheckSchema>;

export const DreamPlaybookRecordSchema = z.object({
  playbook_id: z.string().min(1),
  status: DreamPlaybookStatusSchema,
  kind: DreamPlaybookKindSchema.default("verified_execution"),
  title: z.string().min(1),
  summary: z.string().min(1),
  source_signature: z.string().min(1),
  applicability: z.object({
    goal_ids: z.array(z.string().min(1)).default([]),
    primary_dimensions: z.array(z.string().min(1)).default([]),
    task_categories: z.array(z.string().min(1)).default([]),
    terms: z.array(z.string().min(1)).default([]),
  }).default({}),
  preconditions: z.array(z.string().min(1)).default([]),
  recommended_steps: z.array(z.string().min(1)).default([]),
  verification_checks: z.array(DreamPlaybookCheckSchema).default([]),
  failure_warnings: z.array(z.string().min(1)).default([]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  source_task_ids: z.array(z.string().min(1)).default([]),
  verification: z.object({
    verdict: z.literal("pass"),
    confidence: z.number().min(0).max(1),
    last_verified_at: z.string(),
  }),
  usage: z.object({
    retrieved_count: z.number().int().nonnegative().default(0),
    verified_success_count: z.number().int().nonnegative().default(0),
    successful_reuse_count: z.number().int().nonnegative().default(0),
    failed_reuse_count: z.number().int().nonnegative().default(0),
  }).default({}),
  governance: z.object({
    created_by: z.literal("dream").default("dream"),
    review_state: z.enum(["pending", "verified", "disabled"]).default("pending"),
    auto_generated: z.literal(true).default(true),
    user_editable: z.literal(true).default(true),
    auto_mutation: z.literal("forbidden").default("forbidden"),
  }).default({}),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DreamPlaybookRecord = z.infer<typeof DreamPlaybookRecordSchema>;

export const DreamPlaybookIndexEntrySchema = z.object({
  playbook_id: z.string().min(1),
  title: z.string().min(1),
  status: DreamPlaybookStatusSchema,
  updated_at: z.string(),
  verification_confidence: z.number().min(0).max(1),
  verified_success_count: z.number().int().nonnegative(),
  successful_reuse_count: z.number().int().nonnegative(),
  failed_reuse_count: z.number().int().nonnegative(),
});
export type DreamPlaybookIndexEntry = z.infer<typeof DreamPlaybookIndexEntrySchema>;

export const DreamPlaybookIndexSchema = z.object({
  version: z.literal("dream-playbooks-v1").default("dream-playbooks-v1"),
  generated_at: z.string(),
  playbooks: z.array(DreamPlaybookIndexEntrySchema).default([]),
});
export type DreamPlaybookIndex = z.infer<typeof DreamPlaybookIndexSchema>;

export interface VerifiedPlaybookCaptureInput {
  task: Task;
  verificationResult: VerificationResult;
}

export interface PlaybookReuseOutcomeInput {
  playbookIds: string[];
  verificationResult: VerificationResult;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashStable(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildSourceSignature(task: Task): string {
  return [
    normalizeText(task.task_category),
    normalizeText(task.primary_dimension),
    normalizeText(task.work_description),
    normalizeText(task.approach),
    ...task.success_criteria.map((criterion) =>
      `${normalizeText(criterion.description)}::${normalizeText(criterion.verification_method)}`
    ),
  ].join("||");
}

function buildPlaybookId(task: Task): string {
  return `dream-playbook-${hashStable([buildSourceSignature(task)])}`;
}

function buildApplicabilityTerms(task: Task): string[] {
  return uniqueSorted([
    ...tokenize(task.primary_dimension),
    ...tokenize(task.task_category),
    ...tokenize(task.work_description),
    ...tokenize(task.approach),
    ...task.success_criteria.flatMap((criterion) =>
      tokenize(`${criterion.description} ${criterion.verification_method}`)
    ),
  ]).slice(0, MAX_APPLICABILITY_TERMS);
}

function buildPreconditions(task: Task): string[] {
  return uniqueSorted([
    ...task.scope_boundary.in_scope.map((scope) => `In scope: ${scope}`),
    ...task.constraints.map((constraint) => `Constraint: ${constraint}`),
  ]).slice(0, 4);
}

function buildRecommendedSteps(task: Task): string[] {
  return [
    task.work_description.trim(),
    task.approach.trim(),
    ...task.success_criteria
      .filter((criterion) => criterion.is_blocking)
      .slice(0, 2)
      .map((criterion) => `Verify: ${criterion.description}`),
  ].filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

function buildFailureWarnings(task: Task, verificationResult: VerificationResult): string[] {
  return uniqueSorted([
    ...task.scope_boundary.out_of_scope.map((scope) => `Out of scope: ${scope}`),
    ...verificationResult.evidence
      .map((evidence) => evidence.description.trim())
      .filter((description) => description.length > 0)
      .slice(0, 3),
  ]).slice(0, 4);
}

function buildChecks(task: Task): DreamPlaybookCheck[] {
  return task.success_criteria.slice(0, 4).map((criterion) => ({
    description: criterion.description,
    verification_method: criterion.verification_method,
    blocking: criterion.is_blocking,
  }));
}

function statusForVerification(verificationResult: VerificationResult): DreamPlaybookStatus | null {
  if (verificationResult.verdict !== "pass") return null;
  if (verificationResult.confidence >= PROMOTION_CONFIDENCE_THRESHOLD) return "promoted";
  if (verificationResult.confidence >= CANDIDATE_CONFIDENCE_THRESHOLD) return "candidate";
  return null;
}

function scoreTextOverlap(query: string, candidate: string): number {
  const queryTokens = new Set(tokenize(query));
  const candidateTokens = new Set(tokenize(candidate));
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return hits / Math.max(queryTokens.size, candidateTokens.size);
}

function canPromote(existing: DreamPlaybookRecord | undefined, nextStatus: DreamPlaybookStatus): DreamPlaybookStatus {
  if (existing?.status === "disabled") {
    return "disabled";
  }
  if (existing?.status === "promoted" || nextStatus === "promoted") {
    return "promoted";
  }
  return nextStatus;
}

function applyReuseOutcomeStatus(
  record: DreamPlaybookRecord,
  verificationResult: VerificationResult
): DreamPlaybookStatus {
  if (record.status === "disabled") return "disabled";
  if (verificationResult.verdict === "pass" && verificationResult.confidence >= PROMOTION_CONFIDENCE_THRESHOLD) {
    return "promoted";
  }
  if (
    record.status === "promoted" &&
    record.usage.failed_reuse_count >= 2 &&
    record.usage.failed_reuse_count > record.usage.successful_reuse_count
  ) {
    return "candidate";
  }
  if (
    record.usage.failed_reuse_count >= 3 &&
    record.usage.successful_reuse_count === 0
  ) {
    return "disabled";
  }
  return record.status;
}

function reviewStateFor(status: DreamPlaybookStatus): DreamPlaybookRecord["governance"]["review_state"] {
  switch (status) {
    case "promoted":
      return "verified";
    case "disabled":
      return "disabled";
    default:
      return "pending";
  }
}

function toPlaybookRecord(
  task: Task,
  verificationResult: VerificationResult,
  existing?: DreamPlaybookRecord
): DreamPlaybookRecord | null {
  const nextStatus = statusForVerification(verificationResult);
  if (!nextStatus) return null;

  const now = verificationResult.timestamp || new Date().toISOString();
  const status = canPromote(existing, nextStatus);
  const sourceSignature = buildSourceSignature(task);

  return DreamPlaybookRecordSchema.parse({
    playbook_id: existing?.playbook_id ?? buildPlaybookId(task),
    status,
    kind: "verified_execution",
    title: existing?.title ?? task.work_description.trim(),
    summary: existing?.summary ?? `Verified workflow for ${task.primary_dimension}: ${task.work_description.trim()}`,
    source_signature: sourceSignature,
    applicability: {
      goal_ids: uniqueSorted([...(existing?.applicability.goal_ids ?? []), task.goal_id]),
      primary_dimensions: uniqueSorted([...(existing?.applicability.primary_dimensions ?? []), task.primary_dimension]),
      task_categories: uniqueSorted([...(existing?.applicability.task_categories ?? []), task.task_category]),
      terms: uniqueSorted([...(existing?.applicability.terms ?? []), ...buildApplicabilityTerms(task)]).slice(0, MAX_APPLICABILITY_TERMS),
    },
    preconditions: existing?.preconditions.length ? existing.preconditions : buildPreconditions(task),
    recommended_steps: existing?.recommended_steps.length ? existing.recommended_steps : buildRecommendedSteps(task),
    verification_checks: existing?.verification_checks.length ? existing.verification_checks : buildChecks(task),
    failure_warnings: existing?.failure_warnings.length ? existing.failure_warnings : buildFailureWarnings(task, verificationResult),
    evidence_refs: uniqueSorted([
      ...(existing?.evidence_refs ?? []),
      ...verificationResult.evidence
        .map((evidence) => evidence.description.trim())
        .filter((description) => description.length > 0),
    ]),
    source_task_ids: uniqueSorted([...(existing?.source_task_ids ?? []), task.id]),
    verification: {
      verdict: "pass",
      confidence: Math.max(existing?.verification.confidence ?? 0, verificationResult.confidence),
      last_verified_at: now,
    },
    usage: {
      retrieved_count: existing?.usage.retrieved_count ?? 0,
      verified_success_count: (existing?.usage.verified_success_count ?? 0) + 1,
      successful_reuse_count: existing?.usage.successful_reuse_count ?? 0,
      failed_reuse_count: existing?.usage.failed_reuse_count ?? 0,
    },
    governance: {
      created_by: "dream",
      review_state: reviewStateFor(status),
      auto_generated: true,
      user_editable: true,
      auto_mutation: "forbidden",
    },
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
}

export async function loadDreamPlaybooks(
  baseDir: string,
  options: { statuses?: DreamPlaybookStatus[] } = {}
): Promise<DreamPlaybookRecord[]> {
  const records = (await new StrategyDreamStateStore(baseDir).loadDreamPlaybooks())
    .map((raw) => DreamPlaybookRecordSchema.safeParse(raw))
    .filter((parsed): parsed is { success: true; data: DreamPlaybookRecord } => parsed.success)
    .map((parsed) => parsed.data);

  const allowed = options.statuses ? new Set(options.statuses) : null;
  return records
    .filter((record) => (allowed ? allowed.has(record.status) : true))
    .sort((left, right) => left.playbook_id.localeCompare(right.playbook_id));
}

export async function upsertDreamPlaybook(
  baseDir: string,
  playbook: DreamPlaybookRecord
): Promise<DreamPlaybookRecord> {
  const parsed = DreamPlaybookRecordSchema.parse(playbook);
  await new StrategyDreamStateStore(baseDir).upsertDreamPlaybook(parsed as DreamPlaybookRecord & Record<string, unknown>);
  return parsed;
}

export async function captureVerifiedTaskPlaybook(
  baseDir: string,
  input: VerifiedPlaybookCaptureInput
): Promise<DreamPlaybookRecord | null> {
  const playbookId = buildPlaybookId(input.task);
  const parsedExisting = DreamPlaybookRecordSchema.safeParse(await loadDreamPlaybookById(baseDir, playbookId));
  const next = toPlaybookRecord(input.task, input.verificationResult, parsedExisting.success ? parsedExisting.data : undefined);
  if (!next) return null;
  return upsertDreamPlaybook(baseDir, next);
}

export async function setDreamPlaybookStatus(
  baseDir: string,
  playbookId: string,
  status: DreamPlaybookStatus
): Promise<DreamPlaybookRecord | null> {
  const parsed = DreamPlaybookRecordSchema.safeParse(await loadDreamPlaybookById(baseDir, playbookId));
  if (!parsed.success) return null;
  const next = DreamPlaybookRecordSchema.parse({
    ...parsed.data,
    status,
    governance: {
      ...parsed.data.governance,
      review_state: reviewStateFor(status),
    },
    updated_at: new Date().toISOString(),
  });
  return upsertDreamPlaybook(baseDir, next);
}

export async function recordDreamPlaybookReuseOutcome(
  baseDir: string,
  input: PlaybookReuseOutcomeInput
): Promise<DreamPlaybookRecord[]> {
  const uniqueIds = uniqueSorted(input.playbookIds);
  const updated: DreamPlaybookRecord[] = [];
  for (const playbookId of uniqueIds) {
    const parsed = DreamPlaybookRecordSchema.safeParse(await loadDreamPlaybookById(baseDir, playbookId));
    if (!parsed.success) continue;
    const reuseSucceeded = input.verificationResult.verdict === "pass";
    const nextUsage = {
      ...parsed.data.usage,
      retrieved_count: parsed.data.usage.retrieved_count + 1,
      successful_reuse_count: parsed.data.usage.successful_reuse_count + (reuseSucceeded ? 1 : 0),
      failed_reuse_count: parsed.data.usage.failed_reuse_count + (reuseSucceeded ? 0 : 1),
    };
    const status = applyReuseOutcomeStatus(
      {
        ...parsed.data,
        usage: nextUsage,
      },
      input.verificationResult
    );
    const next = DreamPlaybookRecordSchema.parse({
      ...parsed.data,
      status,
      verification: reuseSucceeded
        ? {
            ...parsed.data.verification,
            confidence: Math.max(parsed.data.verification.confidence, input.verificationResult.confidence),
            last_verified_at: input.verificationResult.timestamp,
          }
        : parsed.data.verification,
      usage: nextUsage,
      governance: {
        ...parsed.data.governance,
        review_state: reviewStateFor(status),
      },
      updated_at: input.verificationResult.timestamp,
    });
    updated.push(await upsertDreamPlaybook(baseDir, next));
  }
  return updated;
}

export async function deleteDreamPlaybook(baseDir: string, playbookId: string): Promise<boolean> {
  return new StrategyDreamStateStore(baseDir).deleteDreamPlaybook(playbookId);
}

async function loadDreamPlaybookById(baseDir: string, playbookId: string): Promise<unknown | null> {
  const records = await loadDreamPlaybooks(baseDir);
  return records.find((record) => record.playbook_id === playbookId) ?? null;
}

export function selectPlaybookHints(
  playbooks: DreamPlaybookRecord[],
  query: string,
  context: {
    goalId?: string;
    targetDimension?: string;
  } = {},
  limit = 2
): DreamPlaybookRecord[] {
  return [...playbooks]
    .filter((playbook) => playbook.status === "promoted")
    .map((playbook) => {
      const goalMatch = context.goalId && playbook.applicability.goal_ids.includes(context.goalId) ? 0.2 : 0;
      const dimensionMatch = context.targetDimension && playbook.applicability.primary_dimensions.includes(context.targetDimension) ? 0.25 : 0;
      const overlap = scoreTextOverlap(
        `${query} ${context.targetDimension ?? ""}`,
        [
          playbook.title,
          playbook.summary,
          playbook.applicability.terms.join(" "),
          playbook.recommended_steps.join(" "),
          playbook.verification_checks.map((check) => `${check.description} ${check.verification_method}`).join(" "),
        ].join(" ")
      );
      const score =
        playbook.verification.confidence * 0.45 +
        Math.min(playbook.usage.verified_success_count, 5) * 0.05 +
        goalMatch +
        dimensionMatch +
        overlap * 0.45;
      return { playbook, score };
    })
    .filter(({ score }) => score >= 0.3)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ playbook }) => playbook);
}

export function formatPlaybookHints(playbooks: DreamPlaybookRecord[]): string {
  if (playbooks.length === 0) return "";
  return [
    "Verified playbook hints:",
    ...playbooks.map((playbook, index) => {
      const steps = playbook.recommended_steps.slice(0, 2).join(" -> ");
      const checks = playbook.verification_checks
        .slice(0, 2)
        .map((check) => check.description)
        .join("; ");
      const provenCount = playbook.usage.verified_success_count + playbook.usage.successful_reuse_count;
      return `${index + 1}. ${playbook.title} (confidence ${playbook.verification.confidence.toFixed(2)}, proven ${provenCount}x)${steps ? ` Steps: ${steps}.` : ""}${checks ? ` Checks: ${checks}.` : ""}`;
    }),
  ].join("\n");
}
