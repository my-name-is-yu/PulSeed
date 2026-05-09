import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  createRuntimeStorePaths,
  ensureRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  RuntimeEvidenceLedger,
} from "./evidence-ledger.js";
import {
  RuntimeEvidenceScalarValueSchema,
} from "./evidence-types.js";
import type {
  RuntimeEvidenceArtifactRef,
  RuntimeEvidenceCandidateRecord,
  RuntimeEvidenceEntry,
  RuntimeEvidenceEvaluatorObservation,
} from "./evidence-types.js";

export const RuntimeReproducibilityFileRefSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1).optional(),
  state_relative_path: z.string().min(1).optional(),
  kind: z.string().min(1).default("other"),
  sha256: z.string().min(1).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  hash_status: z.enum(["hashed", "missing", "unreadable", "not_local"]).default("not_local"),
  error: z.string().min(1).optional(),
}).strict();
export type RuntimeReproducibilityFileRef = z.infer<typeof RuntimeReproducibilityFileRefSchema>;

export const RuntimeReproducibilityManifestSchema = z.object({
  schema_version: z.literal("runtime-reproducibility-manifest-v1"),
  manifest_id: z.string().min(1),
  generated_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  scope: z.object({
    goal_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
  }).strict(),
  selected_candidate: z.object({
    candidate_id: z.string().min(1),
    label: z.string().min(1).optional(),
    evidence_entry_id: z.string().min(1),
    lineage: z.unknown(),
    metrics: z.array(z.unknown()).default([]),
    robustness: z.unknown().optional(),
    disposition: z.string().min(1).optional(),
    disposition_reason: z.string().min(1).optional(),
  }).strict().optional(),
  selected_deliverable: z.object({
    label: z.string().min(1),
    id: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    state_relative_path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    occurred_at: z.string().datetime().optional(),
    source: z.string().min(1),
  }).strict().optional(),
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
  command: z.object({
    command: z.string().min(1).optional(),
    tool_name: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
  }).strict().optional(),
  runtime: z.record(z.string(), z.unknown()).default({}),
  dependencies: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.array(RuntimeReproducibilityFileRefSchema).default([]),
  configs: z.array(RuntimeReproducibilityFileRefSchema).default([]),
  data_inputs: z.array(RuntimeReproducibilityFileRefSchema).default([]),
  evaluator_records: z.array(z.object({
    evaluator_id: z.string().min(1),
    signal: z.enum(["local", "external"]),
    source: z.string().min(1),
    candidate_id: z.string().min(1),
    status: z.string().min(1),
    score: RuntimeEvidenceScalarValueSchema.optional(),
    score_label: z.string().min(1).optional(),
    direction: z.enum(["maximize", "minimize", "neutral"]).optional(),
    observed_at: z.string().datetime().optional(),
    evidence_entry_id: z.string().min(1),
    provenance: z.unknown().optional(),
    budget: z.unknown().optional(),
    calibration: z.unknown().optional(),
    linked_manifest_id: z.string().min(1),
  }).strict()).default([]),
  raw_evidence_refs: z.array(z.object({
    entry_id: z.string().min(1),
    kind: z.string().min(1),
    occurred_at: z.string().datetime(),
    summary: z.string().min(1).optional(),
  }).strict()).default([]),
}).strict();
export type RuntimeReproducibilityManifest = z.infer<typeof RuntimeReproducibilityManifestSchema>;

export interface RuntimeReproducibilityCodeStateInput {
  commit?: string;
  dirty?: boolean;
  diff?: string;
  diff_sha256?: string;
  source?: string;
}

export interface RuntimeReproducibilityCommandInput {
  command?: string;
  tool_name?: string;
  args?: string[];
  cwd?: string;
}

export interface RuntimeReproducibilityManifestInput {
  goalId?: string;
  runId?: string;
  candidateId?: string;
  deliverableArtifact?: {
    id?: string;
    label: string;
    kind?: string;
    summary?: string;
    path?: string;
    state_relative_path?: string;
    url?: string;
    occurred_at?: string;
    source: string;
  };
  workspaceDir?: string;
  command?: RuntimeReproducibilityCommandInput;
  configPaths?: string[];
  dataPaths?: string[];
  codeState?: RuntimeReproducibilityCodeStateInput;
  runtime?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  requireBeforeDelivery?: boolean;
}

export interface RuntimeReproducibilityManifestLookupInput {
  goalId?: string;
  runId?: string;
  deliverable?: {
    id?: string;
    label?: string;
    path?: string;
    state_relative_path?: string;
    url?: string;
  } | null;
}

interface CandidateEvidenceMatch {
  entry: RuntimeEvidenceEntry;
  candidate: RuntimeEvidenceCandidateRecord;
}

export class RuntimeReproducibilityManifestStore {
  private readonly paths: RuntimeStorePaths;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
  }

  async createOrUpdateForCandidate(input: RuntimeReproducibilityManifestInput): Promise<RuntimeReproducibilityManifest> {
    await ensureRuntimeStorePaths(this.paths);
    const entries = await this.readEntries(input);
    const match = input.candidateId ? findCandidate(entries, input.candidateId) : null;
    if (input.candidateId && !match && !input.deliverableArtifact) {
      throw new Error(`Candidate evidence not found for reproducibility manifest: ${input.candidateId}`);
    }
    if (!match && !input.deliverableArtifact) {
      throw new Error("Candidate or deliverable artifact is required for reproducibility manifest.");
    }

    const manifestId = manifestIdFor(input);
    const existing = await this.load(manifestId);
    const now = new Date().toISOString();
    const sourceArtifacts = match?.candidate.artifacts
      ?? (input.deliverableArtifact ? [toEvidenceArtifactRef(input.deliverableArtifact)] : []);
    const artifactRefs = await Promise.all(sourceArtifacts.map((artifact) =>
      hashArtifactRef(artifact, this.paths.rootDir, input.workspaceDir)
    ));
    const configRefs = await Promise.all((input.configPaths ?? []).map((filePath) =>
      hashPathRef(filePath, "config", input.workspaceDir)
    ));
    const dataRefs = await Promise.all((input.dataPaths ?? []).map((filePath) =>
      hashPathRef(filePath, "data", input.workspaceDir)
    ));
    const evaluatorRecords = input.candidateId ? collectEvaluatorRecords(entries, input.candidateId, manifestId) : [];
    const missing = manifestMissingFields(artifactRefs, configRefs, dataRefs, input);

    const manifest = RuntimeReproducibilityManifestSchema.parse({
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: manifestId,
      generated_at: existing?.generated_at ?? now,
      updated_at: now,
      scope: {
        ...(input.goalId ? { goal_id: input.goalId } : {}),
        ...(input.runId ? { run_id: input.runId } : {}),
      },
      ...(match
        ? {
            selected_candidate: {
              candidate_id: match.candidate.candidate_id,
              ...(match.candidate.label ? { label: match.candidate.label } : {}),
              evidence_entry_id: match.entry.id,
              lineage: match.candidate.lineage,
              metrics: match.candidate.metrics,
              ...(match.candidate.robustness ? { robustness: match.candidate.robustness } : {}),
              disposition: match.candidate.disposition,
              ...(match.candidate.disposition_reason ? { disposition_reason: match.candidate.disposition_reason } : {}),
            },
          }
        : {}),
      ...(input.deliverableArtifact ? { selected_deliverable: input.deliverableArtifact } : {}),
      finalization_preflight: {
        manifest_required_before_delivery: input.requireBeforeDelivery ?? true,
        approval_required_before_external_submission: true,
        status: missing.length === 0 ? "manifest_ready" : "manifest_incomplete",
        missing,
      },
      code_state: buildCodeState(input.codeState),
      ...(input.command ? { command: { args: [], ...input.command } } : {}),
      runtime: input.runtime ?? {},
      dependencies: input.dependencies ?? {},
      artifacts: artifactRefs,
      configs: configRefs,
      data_inputs: dataRefs,
      evaluator_records: evaluatorRecords,
      raw_evidence_refs: collectEvidenceRefs(entries, input.candidateId, input.deliverableArtifact),
    });

    await fsp.writeFile(this.pathFor(manifestId), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async load(manifestId: string): Promise<RuntimeReproducibilityManifest | null> {
    try {
      const raw = await fsp.readFile(this.pathFor(manifestId), "utf8");
      return RuntimeReproducibilityManifestSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async findReadyForFinalization(
    input: RuntimeReproducibilityManifestLookupInput
  ): Promise<RuntimeReproducibilityManifest | null> {
    await ensureRuntimeStorePaths(this.paths);
    let fileNames: string[];
    try {
      fileNames = await fsp.readdir(this.paths.reproducibilityManifestsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    const manifests: RuntimeReproducibilityManifest[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      try {
        const raw = await fsp.readFile(path.join(this.paths.reproducibilityManifestsDir, fileName), "utf8");
        manifests.push(RuntimeReproducibilityManifestSchema.parse(JSON.parse(raw)));
      } catch {
        continue;
      }
    }

    return manifests
      .filter((manifest) =>
        manifest.finalization_preflight.status === "manifest_ready"
        && manifestScopeMatches(manifest, input)
        && manifestDeliverableMatches(manifest, input.deliverable ?? null)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }

  pathFor(manifestId: string): string {
    return this.paths.reproducibilityManifestPath(manifestId);
  }

  private async readEntries(input: RuntimeReproducibilityManifestInput): Promise<RuntimeEvidenceEntry[]> {
    const ledger = new RuntimeEvidenceLedger(this.paths);
    const reads = await Promise.all([
      input.goalId && ledger.readByGoal ? ledger.readByGoal(input.goalId) : Promise.resolve(null),
      input.runId && ledger.readByRun ? ledger.readByRun(input.runId) : Promise.resolve(null),
    ]);
    const byId = new Map<string, RuntimeEvidenceEntry>();
    for (const read of reads) {
      for (const entry of read?.entries ?? []) byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }
}

function manifestIdFor(input: RuntimeReproducibilityManifestInput): string {
  const scope = input.runId ? `run:${input.runId}` : `goal:${input.goalId ?? "unknown"}`;
  const subject = input.candidateId
    ? `candidate:${input.candidateId}`
    : `deliverable:${input.deliverableArtifact?.id ?? input.deliverableArtifact?.label ?? "unknown"}`;
  return `${safeManifestId(scope)}:${safeManifestId(subject)}`;
}

function safeManifestId(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9:._-]+/g, "_");
}

function toEvidenceArtifactRef(
  artifact: NonNullable<RuntimeReproducibilityManifestInput["deliverableArtifact"]>
): RuntimeEvidenceArtifactRef {
  return {
    label: artifact.label,
    ...(artifact.path ? { path: artifact.path } : {}),
    ...(artifact.state_relative_path ? { state_relative_path: artifact.state_relative_path } : {}),
    ...(artifact.url ? { url: artifact.url } : {}),
    kind: artifact.kind === "log" || artifact.kind === "metrics" || artifact.kind === "report" || artifact.kind === "diff" || artifact.kind === "url"
      ? artifact.kind
      : "other",
  };
}

function findCandidate(entries: RuntimeEvidenceEntry[], candidateId: string): CandidateEvidenceMatch | null {
  for (const entry of [...entries].reverse()) {
    const candidate = entry.candidates?.find((item) => item.candidate_id === candidateId);
    if (candidate) return { entry, candidate };
  }
  return null;
}

async function hashArtifactRef(
  artifact: RuntimeEvidenceArtifactRef,
  runtimeRoot: string,
  workspaceDir: string | undefined
): Promise<RuntimeReproducibilityFileRef> {
  const filePath = artifact.path
    ?? (artifact.state_relative_path ? path.join(runtimeRoot, artifact.state_relative_path) : undefined);
  return {
    ...(await hashPath(filePath, workspaceDir)),
    label: artifact.label,
    ...(artifact.path ? { path: artifact.path } : {}),
    ...(artifact.state_relative_path ? { state_relative_path: artifact.state_relative_path } : {}),
    kind: artifact.kind,
  };
}

async function hashPathRef(
  filePath: string,
  kind: string,
  workspaceDir: string | undefined
): Promise<RuntimeReproducibilityFileRef> {
  return {
    ...(await hashPath(filePath, workspaceDir)),
    label: path.basename(filePath),
    path: filePath,
    kind,
  };
}

async function hashPath(filePath: string | undefined, workspaceDir: string | undefined): Promise<{
  sha256?: string;
  size_bytes?: number;
  hash_status: RuntimeReproducibilityFileRef["hash_status"];
  error?: string;
}> {
  if (!filePath) return { hash_status: "not_local" };
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspaceDir ?? process.cwd(), filePath);
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) return { hash_status: "unreadable", error: "path is not a file" };
    const bytes = await fsp.readFile(resolved);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: stat.size,
      hash_status: "hashed",
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { hash_status: "missing" };
    return {
      hash_status: "unreadable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function collectEvaluatorRecords(
  entries: RuntimeEvidenceEntry[],
  candidateId: string,
  manifestId: string
): RuntimeReproducibilityManifest["evaluator_records"] {
  const records: RuntimeReproducibilityManifest["evaluator_records"] = [];
  for (const entry of entries) {
    for (const evaluator of entry.evaluators ?? []) {
      if (evaluator.candidate_id !== candidateId) continue;
      records.push(toManifestEvaluatorRecord(evaluator, entry.id, manifestId));
    }
  }
  return records;
}

function toManifestEvaluatorRecord(
  evaluator: RuntimeEvidenceEvaluatorObservation,
  entryId: string,
  manifestId: string
): RuntimeReproducibilityManifest["evaluator_records"][number] {
  return {
    evaluator_id: evaluator.evaluator_id,
    signal: evaluator.signal,
    source: evaluator.source,
    candidate_id: evaluator.candidate_id,
    status: evaluator.status,
    ...(evaluator.score !== undefined ? { score: evaluator.score } : {}),
    ...(evaluator.score_label ? { score_label: evaluator.score_label } : {}),
    ...(evaluator.direction ? { direction: evaluator.direction } : {}),
    ...(evaluator.observed_at ? { observed_at: evaluator.observed_at } : {}),
    evidence_entry_id: entryId,
    ...(evaluator.provenance ? { provenance: evaluator.provenance } : {}),
    ...(evaluator.budget ? { budget: evaluator.budget } : {}),
    ...(evaluator.calibration ? { calibration: evaluator.calibration } : {}),
    linked_manifest_id: manifestId,
  };
}

function collectEvidenceRefs(
  entries: RuntimeEvidenceEntry[],
  candidateId: string | undefined,
  deliverable: RuntimeReproducibilityManifestInput["deliverableArtifact"] | undefined
): RuntimeReproducibilityManifest["raw_evidence_refs"] {
  return entries
    .filter((entry) => evidenceMatchesManifestSubject(entry, candidateId, deliverable))
    .map((entry) => ({
      entry_id: entry.id,
      kind: entry.kind,
      occurred_at: entry.occurred_at,
      ...(entry.summary ? { summary: entry.summary } : {}),
    }));
}

function evidenceMatchesManifestSubject(
  entry: RuntimeEvidenceEntry,
  candidateId: string | undefined,
  deliverable: RuntimeReproducibilityManifestInput["deliverableArtifact"] | undefined
): boolean {
  if (candidateId && (
    entry.candidates?.some((candidate) => candidate.candidate_id === candidateId)
    || entry.evaluators?.some((evaluator) => evaluator.candidate_id === candidateId)
  )) {
    return true;
  }
  if (!deliverable) return false;
  return entry.artifacts.some((artifact) =>
    (deliverable.path && artifact.path === deliverable.path)
    || (deliverable.state_relative_path && artifact.state_relative_path === deliverable.state_relative_path)
    || artifact.label === deliverable.label
  );
}

function manifestScopeMatches(
  manifest: RuntimeReproducibilityManifest,
  input: RuntimeReproducibilityManifestLookupInput
): boolean {
  if (input.goalId && manifest.scope.goal_id && manifest.scope.goal_id !== input.goalId) return false;
  if (input.runId && manifest.scope.run_id && manifest.scope.run_id !== input.runId) return false;
  if (input.goalId && !input.runId) return manifest.scope.goal_id === input.goalId;
  if (input.runId) {
    return manifest.scope.run_id === input.runId || manifest.scope.goal_id === input.goalId;
  }
  return true;
}

function manifestDeliverableMatches(
  manifest: RuntimeReproducibilityManifest,
  deliverable: RuntimeReproducibilityManifestLookupInput["deliverable"]
): boolean {
  if (!deliverable) return true;
  if (manifest.selected_deliverable && deliverableRefMatches(manifest.selected_deliverable, deliverable)) return true;
  return manifest.artifacts.some((artifact) => deliverableRefMatches(artifact, deliverable));
}

function deliverableRefMatches(
  ref: {
    id?: string;
    label?: string;
    path?: string;
    state_relative_path?: string;
    url?: string;
  },
  deliverable: NonNullable<RuntimeReproducibilityManifestLookupInput["deliverable"]>
): boolean {
  return (Boolean(deliverable.id) && ref.id === deliverable.id)
    || (Boolean(deliverable.path) && ref.path === deliverable.path)
    || (Boolean(deliverable.state_relative_path) && ref.state_relative_path === deliverable.state_relative_path)
    || (Boolean(deliverable.url) && ref.url === deliverable.url)
    || (Boolean(deliverable.label) && ref.label === deliverable.label);
}

function buildCodeState(input: RuntimeReproducibilityCodeStateInput | undefined): RuntimeReproducibilityManifest["code_state"] {
  return {
    ...(input?.commit ? { commit: input.commit } : {}),
    ...(input?.dirty !== undefined ? { dirty: input.dirty } : {}),
    ...(input?.diff_sha256 ? { diff_sha256: input.diff_sha256 } : input?.diff ? { diff_sha256: createHash("sha256").update(input.diff).digest("hex") } : {}),
    source: input?.source ?? "provided",
  };
}

function manifestMissingFields(
  artifacts: RuntimeReproducibilityFileRef[],
  configs: RuntimeReproducibilityFileRef[],
  dataInputs: RuntimeReproducibilityFileRef[],
  input: RuntimeReproducibilityManifestInput
): string[] {
  const missing: string[] = [];
  if (artifacts.length === 0) missing.push("artifact_hashes");
  if (artifacts.some((artifact) => artifact.hash_status !== "hashed")) missing.push("some_artifacts_unhashed");
  if ((input.configPaths?.length ?? 0) > 0 && configs.some((config) => config.hash_status !== "hashed")) missing.push("some_configs_unhashed");
  if ((input.dataPaths?.length ?? 0) > 0 && dataInputs.some((data) => data.hash_status !== "hashed")) missing.push("some_data_inputs_unhashed");
  if (!input.codeState?.commit && !input.codeState?.diff_sha256 && !input.codeState?.diff) missing.push("code_state");
  return missing;
}
