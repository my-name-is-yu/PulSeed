import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import { readTextFileWithinLimit } from "../../base/utils/json-io.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { MAX_HTTP_BODY_SIZE } from "../../runtime/http-body.js";
import { BackgroundRunLedger } from "../../runtime/store/background-run-store.js";
import { RuntimeEvidenceLedger } from "../../runtime/store/evidence-ledger.js";
import { ProcessSessionStateStore } from "../../runtime/store/process-session-state-store.js";
import type { BackgroundRun, RuntimeArtifactRef, RuntimeSessionRef } from "../../runtime/session-registry/types.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";
import {
  defaultProcessSessionManager,
  type ProcessSessionManager,
} from "../system/ProcessSessionTool/ProcessSessionTool.js";
import {
  LongRunningArtifactRefSchema,
  LongRunningEvidenceSchema,
  LongRunningResultSchema,
  RuntimeReportWriteInputSchema,
  RuntimeResultNormalizeInputSchema,
  WorkspaceImportInputSchema,
} from "./long-running-runtime-schemas.js";
export {
  LongRunningArtifactRefSchema,
  LongRunningEvidenceSchema,
  LongRunningNextActionSchema,
  LongRunningNextActionTypeSchema,
  LongRunningResultSchema,
  LongRunningStatusSchema,
} from "./long-running-runtime-schemas.js";
export type {
  LongRunningArtifactRef,
  LongRunningEvidence,
  LongRunningNextAction,
  LongRunningNextActionType,
  LongRunningResult,
  LongRunningStatus,
  RuntimeReportWriteInput,
  RuntimeResultNormalizeInput,
  WorkspaceImportInput,
} from "./long-running-runtime-schemas.js";
import type {
  LongRunningArtifactRef,
  LongRunningEvidence,
  LongRunningNextAction,
  LongRunningResult,
  LongRunningStatus,
  RuntimeReportWriteInput,
  RuntimeResultNormalizeInput,
  WorkspaceImportInput,
} from "./long-running-runtime-schemas.js";
import { renderSummaryMarkdown } from "./long-running-report-render.js";
import {
  assertNotNestedImport,
  ensureDirectoryWithinStateRoot,
  resolveArtifactDirectory,
  resolveReadablePath,
  stateRelativePath,
  validateSafeSegment,
} from "./long-running-runtime-paths.js";

export const LONG_RUNNING_RESULT_JSON_MAX_BYTES = MAX_HTTP_BODY_SIZE;

export interface RuntimeReportWriteOutput {
  result: LongRunningResult;
  files: {
    directory: string;
    state_relative_directory: string;
    summary: string;
    result: string;
    next_action: string;
  };
  linked: {
    process_session_id: string | null;
    background_run_id: string | null;
  };
  warnings: string[];
}

export interface RuntimeResultNormalizeOutput {
  result: LongRunningResult;
  files: {
    directory: string;
    state_relative_directory: string;
    result: string;
  };
}

export interface WorkspaceImportOutput {
  source_path: string;
  workspace: {
    path: string;
    state_relative_path: string;
  };
  copied_entries: number;
}

export class RuntimeReportWriteTool implements ITool<RuntimeReportWriteInput, RuntimeReportWriteOutput> {
  constructor(private readonly processSessionManager: ProcessSessionManager = defaultProcessSessionManager) {}

  readonly metadata: ToolMetadata = {
    name: "runtime_report_write",
    aliases: ["long_running_report_write", "run_report_write"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 12000,
    tags: ["runtime", "long-running", "artifact", "report"],
  };

  readonly inputSchema = RuntimeReportWriteInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return [
      "Persist a durable summary.md, result.json, and next-action.json for a long-running workflow.",
      "Can link the artifacts to an existing process session or background run so runtime CLI/TUI surfaces can display them.",
    ].join(" ");
  }

  async call(input: RuntimeReportWriteInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const loaded = input.result_json_path
        ? await loadCanonicalResult(resolveReadablePath(input.result_json_path, context.cwd))
        : null;
      const result = makeResultFromReportInput(input, loaded);
      const output = await writeReportArtifacts(result, input.run_id);
      const warnings: string[] = [];

      if (input.process_session_id || result.source.process_session_id) {
        const sessionId = input.process_session_id ?? result.source.process_session_id!;
        const warning = await linkProcessSessionArtifacts(this.processSessionManager, sessionId, [
          output.files.summary,
          output.files.result,
          output.files.next_action,
        ]);
        if (warning) warnings.push(warning);
      }

      if (input.background_run_id || result.source.background_run_id) {
        const runId = input.background_run_id ?? result.source.background_run_id!;
        const warning = await linkBackgroundRunArtifacts(runId, result, output);
        if (warning) warnings.push(warning);
      }

      const evidenceWarning = await appendLongRunningEvidence(result, output, {
        runId: input.run_id,
        backgroundRunId: input.background_run_id ?? result.source.background_run_id,
        processSessionId: input.process_session_id ?? result.source.process_session_id,
      });
      if (evidenceWarning) warnings.push(evidenceWarning);

      const data: RuntimeReportWriteOutput = {
        result,
        files: output.files,
        linked: {
          process_session_id: input.process_session_id ?? result.source.process_session_id ?? null,
          background_run_id: input.background_run_id ?? result.source.background_run_id ?? null,
        },
        warnings,
      };
      return {
        success: true,
        data,
        summary: `Wrote long-running run report at ${output.files.state_relative_directory}`,
        durationMs: Date.now() - startTime,
        artifacts: [output.files.summary, output.files.result, output.files.next_action],
      };
    } catch (err) {
      return failureResult(`Failed to write long-running run report: ${messageFromError(err)}`, startTime);
    }
  }

  async checkPermissions(_input: RuntimeReportWriteInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: RuntimeReportWriteInput): boolean {
    return false;
  }
}

export class RuntimeResultNormalizeTool implements ITool<RuntimeResultNormalizeInput, RuntimeResultNormalizeOutput> {
  readonly metadata: ToolMetadata = {
    name: "runtime_result_normalize",
    aliases: ["long_running_result_normalize", "normalize_run_result"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 12000,
    tags: ["runtime", "long-running", "artifact", "metrics"],
  };

  readonly inputSchema = RuntimeResultNormalizeInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return [
      "Normalize loose JSON from an external workflow into PulSeed's canonical long-running result/evidence schema.",
      "Use profile=kaggle_metrics to map Kaggle-style metric JSON without weakening the strict Kaggle internal schema.",
    ].join(" ");
  }

  async call(input: RuntimeResultNormalizeInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const sourcePath = input.source_json_path ? resolveReadablePath(input.source_json_path, context.cwd) : null;
      const value = sourcePath ? await readJson(sourcePath) : input.value;
      const result = normalizeLooseResult(input, value, sourcePath);
      const directory = await resolveArtifactDirectory(input.run_id);
      const resultPath = path.join(directory, "result.json");
      await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      const data: RuntimeResultNormalizeOutput = {
        result,
        files: {
          directory,
          state_relative_directory: stateRelativePath(directory),
          result: resultPath,
        },
      };
      return {
        success: true,
        data,
        summary: `Normalized long-running result at ${stateRelativePath(resultPath)}`,
        durationMs: Date.now() - startTime,
        artifacts: [resultPath],
      };
    } catch (err) {
      return failureResult(`Failed to normalize long-running result: ${messageFromError(err)}`, startTime);
    }
  }

  async checkPermissions(_input: RuntimeResultNormalizeInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: RuntimeResultNormalizeInput): boolean {
    return false;
  }
}

export class WorkspaceImportTool implements ITool<WorkspaceImportInput, WorkspaceImportOutput> {
  readonly metadata: ToolMetadata = {
    name: "workspace_import",
    aliases: ["runtime_workspace_import", "materialize_workspace"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: ["runtime", "workspace", "filesystem", "long-running"],
  };

  readonly inputSchema = WorkspaceImportInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return [
      "Safely materialize an existing local workspace into PulSeed state under runtime/workspaces/imports.",
      "The import rejects symlinks and never relaxes PulSeed state-root path policy.",
    ].join(" ");
  }

  async call(input: WorkspaceImportInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const sourcePath = path.isAbsolute(input.source_path)
        ? path.resolve(input.source_path)
        : path.resolve(context.cwd, input.source_path);
      const sourceStat = await fs.lstat(sourcePath);
      if (sourceStat.isSymbolicLink()) {
        throw new Error("source_path must not be a symlink");
      }
      if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
        throw new Error("source_path must be a file or directory");
      }
      await assertTreeHasNoSymlinks(sourcePath);

      const workspaceId = validateSafeSegment(input.workspace_id ?? path.basename(sourcePath), "workspace_id");
      const destination = path.join(getPulseedDirPath(), "runtime", "workspaces", "imports", workspaceId);
      assertNotNestedImport(sourcePath, destination);
      await ensureDirectoryWithinStateRoot(path.dirname(destination));
      if (!input.overwrite && await exists(destination)) {
        throw new Error(`workspace import destination already exists: ${stateRelativePath(destination)}`);
      }
      if (input.overwrite) {
        await fs.rm(destination, { recursive: true, force: true });
      }
      await copyWithoutSymlinks(sourcePath, destination, sourceStat);
      const copiedEntries = await countEntries(destination);
      const data: WorkspaceImportOutput = {
        source_path: sourcePath,
        workspace: {
          path: destination,
          state_relative_path: stateRelativePath(destination),
        },
        copied_entries: copiedEntries,
      };
      return {
        success: true,
        data,
        summary: `Imported workspace into ${data.workspace.state_relative_path}`,
        durationMs: Date.now() - startTime,
        artifacts: [destination],
      };
    } catch (err) {
      return failureResult(`Failed to import workspace: ${messageFromError(err)}`, startTime);
    }
  }

  async checkPermissions(_input: WorkspaceImportInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: WorkspaceImportInput): boolean {
    return false;
  }
}

function makeResultFromReportInput(input: RuntimeReportWriteInput, loaded: LongRunningResult | null): LongRunningResult {
  const objective = input.objective ?? loaded?.objective;
  const status = input.status ?? loaded?.status;
  const nextAction = input.next_action ?? loaded?.next_action;
  if (!objective) throw new Error("objective is required when result_json_path is not supplied");
  if (!status) throw new Error("status is required when result_json_path is not supplied");
  if (!nextAction) throw new Error("next_action is required when result_json_path is not supplied");
  const source = {
    ...(loaded?.source ?? { kind: "manual" }),
    ...(input.process_session_id ? { process_session_id: input.process_session_id } : {}),
    ...(input.background_run_id ? { background_run_id: input.background_run_id } : {}),
  };
  return LongRunningResultSchema.parse({
    schema_version: "long-running-result-v1",
    objective,
    status,
    evidence: input.evidence ?? loaded?.evidence ?? [],
    artifacts: input.artifacts ?? loaded?.artifacts ?? [],
    failures: input.failures ?? loaded?.failures ?? [],
    next_action: nextAction,
    source,
    created_at: loaded?.created_at ?? new Date().toISOString(),
  });
}

function normalizeLooseResult(
  input: RuntimeResultNormalizeInput,
  value: unknown,
  sourcePath: string | null,
): LongRunningResult {
  const source = {
    kind: input.profile,
    ...(sourcePath ? { path: sourcePath } : {}),
    ...(input.process_session_id ? { process_session_id: input.process_session_id } : {}),
    ...(input.background_run_id ? { background_run_id: input.background_run_id } : {}),
  };
  const objectValue = isObject(value) ? value : {};
  const evidence = input.profile === "kaggle_metrics"
    ? normalizeKaggleMetricEvidence(objectValue, input)
    : normalizeGenericEvidence(value);
  const artifacts = normalizeArtifactRefs(objectValue);
  const status = input.status ?? inferStatus(objectValue);
  const nextAction = input.next_action ?? defaultNextAction(status);
  return LongRunningResultSchema.parse({
    schema_version: "long-running-result-v1",
    objective: input.objective,
    status,
    evidence,
    artifacts,
    failures: normalizeFailures(objectValue),
    next_action: nextAction,
    source,
    created_at: new Date().toISOString(),
  });
}

function normalizeKaggleMetricEvidence(
  value: Record<string, unknown>,
  input: RuntimeResultNormalizeInput,
): LongRunningEvidence[] {
  const evidence: LongRunningEvidence[] = [];
  const metricName = input.metric_name ?? stringField(value, "metric_name");
  const score = numberField(value, "cv_score")
    ?? numberField(value, "score")
    ?? (metricName ? numberField(value, metricName) : null)
    ?? numberField(value, "balanced_accuracy")
    ?? numberField(value, "accuracy");
  const resolvedMetricName = metricName
    ?? (numberField(value, "balanced_accuracy") !== null ? "balanced_accuracy" : null)
    ?? (numberField(value, "accuracy") !== null ? "accuracy" : null)
    ?? "score";
  if (score !== null) {
    evidence.push({
      kind: "metric",
      label: resolvedMetricName,
      value: score,
      ...(input.metric_direction ? { direction: input.metric_direction } : {}),
      summary: "normalized metric",
    });
  }
  const cvStd = numberField(value, "cv_std");
  if (cvStd !== null) {
    evidence.push({ kind: "metric", label: `${resolvedMetricName}_std`, value: cvStd });
  }
  const holdout = numberField(value, "holdout_score");
  if (holdout !== null) {
    evidence.push({ kind: "metric", label: "holdout_score", value: holdout });
  }
  return evidence.length > 0 ? evidence : normalizeGenericEvidence(value);
}

function normalizeGenericEvidence(value: unknown): LongRunningEvidence[] {
  if (!isObject(value)) {
    return [{ kind: "observation", label: "result", value: primitiveValue(value), summary: "loose result value" }];
  }
  const evidenceValue = value["evidence"];
  if (Array.isArray(evidenceValue)) {
    const parsed = z.array(LongRunningEvidenceSchema).safeParse(evidenceValue);
    if (parsed.success) return parsed.data;
  }
  const metrics = value["metrics"];
  if (isObject(metrics)) {
    return Object.entries(metrics).flatMap(([label, metricValue]) => {
      if (!isPrimitive(metricValue)) return [];
      return [{
        kind: "metric" as const,
        label,
        value: metricValue,
      }];
    });
  }
  return Object.entries(value).flatMap(([label, field]) => {
    if (!isPrimitive(field) || ["status", "failures", "artifacts", "next_action"].includes(label)) return [];
    return [{
      kind: typeof field === "number" ? "metric" as const : "observation" as const,
      label,
      value: field,
    }];
  }).slice(0, 20);
}

function normalizeArtifactRefs(value: Record<string, unknown>): LongRunningArtifactRef[] {
  const artifacts = value["artifacts"];
  if (Array.isArray(artifacts)) {
    return artifacts.flatMap((artifact) => {
      const parsed = LongRunningArtifactRefSchema.safeParse(artifact);
      return parsed.success ? [parsed.data] : [];
    });
  }
  if (isObject(artifacts)) {
    return Object.entries(artifacts).flatMap(([label, artifactPath]) => {
      if (typeof artifactPath !== "string" || artifactPath.length === 0) return [];
      return [artifactRef(label, artifactPath)];
    });
  }
  return [];
}

function normalizeFailures(value: Record<string, unknown>): string[] {
  const failures = value["failures"];
  if (Array.isArray(failures)) {
    return failures.filter((failure): failure is string => typeof failure === "string" && failure.length > 0);
  }
  const error = typeof value["error"] === "string" ? value["error"] : typeof value["message"] === "string" ? value["message"] : null;
  return error ? [error] : [];
}

function inferStatus(value: Record<string, unknown>): LongRunningStatus {
  const status = typeof value["status"] === "string" ? value["status"] : null;
  if (status === "succeeded" || status === "completed" || status === "complete" || status === "success") return "succeeded";
  if (status === "failed" || status === "error") return "failed";
  if (status === "running") return "running";
  if (status === "timed_out" || status === "timeout") return "timed_out";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "unknown";
}

function defaultNextAction(status: LongRunningStatus): LongRunningNextAction {
  if (status === "succeeded") {
    return { type: "continue", summary: "Review the result and choose the next experiment or follow-up step." };
  }
  if (status === "running") {
    return { type: "wait", summary: "Wait for the workflow to produce additional evidence." };
  }
  if (status === "failed" || status === "timed_out" || status === "blocked") {
    return { type: "investigate", summary: "Inspect failures and decide whether to retry or change the workflow." };
  }
  return { type: "investigate", summary: "Inspect the result and decide the next action." };
}

async function writeReportArtifacts(result: LongRunningResult, runId?: string): Promise<{ files: RuntimeReportWriteOutput["files"] }> {
  const directory = await resolveArtifactDirectory(runId);
  const resultPath = path.join(directory, "result.json");
  const summaryPath = path.join(directory, "summary.md");
  const nextActionPath = path.join(directory, "next-action.json");
  await Promise.all([
    fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    fs.writeFile(summaryPath, renderSummaryMarkdown(result), "utf8"),
    fs.writeFile(nextActionPath, `${JSON.stringify({
      schema_version: "long-running-next-action-v1",
      created_at: new Date().toISOString(),
      source: result.source,
      action: result.next_action,
    }, null, 2)}\n`, "utf8"),
  ]);
  return {
    files: {
      directory,
      state_relative_directory: stateRelativePath(directory),
      summary: summaryPath,
      result: resultPath,
      next_action: nextActionPath,
    },
  };
}

async function linkProcessSessionArtifacts(
  processSessionManager: ProcessSessionManager,
  sessionId: string,
  artifactPaths: string[],
): Promise<string | null> {
  try {
    const snapshot = processSessionManager.linkArtifacts(sessionId, artifactPaths);
    if (snapshot) return null;
    const store = new ProcessSessionStateStore(getPulseedDirPath());
    const persisted = await store.loadSnapshot(sessionId);
    if (!persisted) throw new Error("process session not found");
    await store.saveSnapshot({
      ...persisted,
      artifactRefs: dedupeStrings([
        ...(persisted.artifactRefs ?? []),
        ...artifactPaths,
      ]),
    });
    return null;
  } catch (err) {
    return `Could not link artifacts to process session ${sessionId}: ${messageFromError(err)}`;
  }
}

async function linkBackgroundRunArtifacts(
  runId: string,
  result: LongRunningResult,
  output: { files: RuntimeReportWriteOutput["files"] },
): Promise<string | null> {
  try {
    const ledger = new BackgroundRunLedger();
    const existing = await ledger.load(runId);
    if (!existing) throw new Error("background run not found");
    const artifacts = dedupeRuntimeArtifacts([
      ...existing.artifacts,
      runtimeArtifact("summary.md", output.files.summary, "report"),
      runtimeArtifact("result.json", output.files.result, "metrics"),
      runtimeArtifact("next-action.json", output.files.next_action, "other"),
    ]);
    const sourceRefs = dedupeSourceRefs([
      ...existing.source_refs,
      sourceRef("artifact", "summary.md", output.files.summary),
      sourceRef("artifact", "result.json", output.files.result),
      sourceRef("artifact", "next-action.json", output.files.next_action),
    ]);
    await ledger.save({
      ...existing,
      status: mapResultStatusToBackgroundStatus(existing, result.status),
      updated_at: new Date().toISOString(),
      completed_at: completedAtForLinkedRun(existing, result.status),
      summary: result.next_action.summary,
      error: result.failures[0] ?? existing.error,
      artifacts,
      source_refs: sourceRefs,
    });
    return null;
  } catch (err) {
    return `Could not link artifacts to background run ${runId}: ${messageFromError(err)}`;
  }
}

async function appendLongRunningEvidence(
  result: LongRunningResult,
  output: { files: RuntimeReportWriteOutput["files"] },
  ids: { runId?: string; backgroundRunId?: string; processSessionId?: string },
): Promise<string | null> {
  const runId = ids.backgroundRunId ?? ids.runId ?? result.source.background_run_id ?? result.source.process_session_id;
  if (!runId) return null;
  try {
    const ledger = new RuntimeEvidenceLedger();
    await ledger.append({
      kind: result.status === "failed" || result.status === "blocked" ? "failure" : "artifact",
      scope: { run_id: runId },
      summary: result.next_action.summary,
      outcome: longRunningStatusToOutcome(result.status),
      metrics: result.evidence.map((item) => ({
        label: item.label,
        value: item.value,
        unit: item.unit,
        ...(item.direction ? { direction: item.direction } : {}),
        summary: item.summary,
      })),
      artifacts: [
        { label: "summary.md", path: output.files.summary, state_relative_path: output.files.state_relative_directory + "/summary.md", kind: "report" },
        { label: "result.json", path: output.files.result, state_relative_path: output.files.state_relative_directory + "/result.json", kind: "metrics" },
        { label: "next-action.json", path: output.files.next_action, state_relative_path: output.files.state_relative_directory + "/next-action.json", kind: "other" },
        ...result.artifacts,
      ],
      result: {
        status: result.status,
        summary: result.next_action.summary,
        ...(result.failures[0] ? { error: result.failures[0] } : {}),
      },
      decision_reason: result.next_action.reason ?? result.next_action.summary,
      raw_refs: [
        ...(ids.processSessionId ? [{ kind: "process_session", id: ids.processSessionId }] : []),
        ...(ids.backgroundRunId ? [{ kind: "background_run", id: ids.backgroundRunId }] : []),
        ...(result.source.path ? [{ kind: result.source.kind, path: result.source.path }] : []),
      ],
    });
    return null;
  } catch (err) {
    return `Could not append long-running evidence for ${runId}: ${messageFromError(err)}`;
  }
}

function longRunningStatusToOutcome(status: LongRunningStatus) {
  if (status === "succeeded") return "improved";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "running") return "continued";
  return "inconclusive";
}

function mapResultStatusToBackgroundStatus(existing: BackgroundRun, status: LongRunningStatus): BackgroundRun["status"] {
  if (existing.status === "succeeded" || existing.status === "failed" || existing.status === "timed_out" || existing.status === "cancelled" || existing.status === "lost") {
    return existing.status;
  }
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "timed_out") return "timed_out";
  if (status === "cancelled") return "cancelled";
  if (status === "running") return "running";
  return existing.status;
}

function completedAtForLinkedRun(existing: BackgroundRun, status: LongRunningStatus): string | null {
  if (existing.completed_at) return existing.completed_at;
  if (status === "succeeded" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "blocked") {
    return new Date().toISOString();
  }
  return existing.completed_at;
}

function runtimeArtifact(label: string, artifactPath: string, kind: RuntimeArtifactRef["kind"]): RuntimeArtifactRef {
  return { label, path: artifactPath, url: null, kind };
}

function sourceRef(kind: RuntimeSessionRef["kind"], id: string, absolutePath: string): RuntimeSessionRef {
  return {
    kind,
    id,
    path: absolutePath,
    relative_path: stateRelativePath(absolutePath),
    updated_at: new Date().toISOString(),
  };
}

function dedupeRuntimeArtifacts(artifacts: RuntimeArtifactRef[]): RuntimeArtifactRef[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}:${artifact.path ?? artifact.url ?? artifact.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSourceRefs(refs: RuntimeSessionRef[]): RuntimeSessionRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id ?? ""}:${ref.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function artifactRef(label: string, artifactPath: string): LongRunningArtifactRef {
  const absolute = path.isAbsolute(artifactPath) ? artifactPath : undefined;
  let stateRelative: string | undefined;
  if (absolute) {
    try {
      stateRelative = stateRelativePath(absolute);
    } catch {
      stateRelative = undefined;
    }
  }
  return LongRunningArtifactRefSchema.parse({
    label,
    path: artifactPath,
    ...(stateRelative ? { state_relative_path: stateRelative } : {}),
    kind: classifyArtifactKind(artifactPath),
  });
}

function classifyArtifactKind(artifactPath: string): LongRunningArtifactRef["kind"] {
  const basename = path.basename(artifactPath).toLowerCase();
  if (basename.endsWith(".log") || basename.includes("log")) return "log";
  if (basename.endsWith(".json") && (basename.includes("metric") || basename.includes("score") || basename.includes("result"))) return "metrics";
  if (basename.endsWith(".md") || basename.endsWith(".txt")) return "report";
  if (basename.endsWith(".diff") || basename.endsWith(".patch")) return "diff";
  return "other";
}

async function loadCanonicalResult(filePath: string): Promise<LongRunningResult> {
  return LongRunningResultSchema.parse(await readJson(filePath));
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readTextFileWithinLimit(filePath, {
    maxBytes: LONG_RUNNING_RESULT_JSON_MAX_BYTES,
  });
  return JSON.parse(raw) as unknown;
}

async function assertTreeHasNoSymlinks(sourcePath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`workspace import rejects symlink: ${sourcePath}`);
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  await Promise.all(entries.map((entry) => assertTreeHasNoSymlinks(path.join(sourcePath, entry.name))));
}

async function copyWithoutSymlinks(sourcePath: string, destination: string, sourceStat: Awaited<ReturnType<typeof fs.lstat>>): Promise<void> {
  if (sourceStat.isFile()) {
    await ensureDirectoryWithinStateRoot(path.dirname(destination));
    await fs.copyFile(sourcePath, destination);
    return;
  }
  await ensureDirectoryWithinStateRoot(destination);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const childSource = path.join(sourcePath, entry.name);
    const childDestination = path.join(destination, entry.name);
    const stat = await fs.lstat(childSource);
    if (stat.isSymbolicLink()) throw new Error(`workspace import rejects symlink: ${childSource}`);
    if (stat.isDirectory()) {
      await copyWithoutSymlinks(childSource, childDestination, stat);
    } else if (stat.isFile()) {
      await ensureDirectoryWithinStateRoot(path.dirname(childDestination));
      await fs.copyFile(childSource, childDestination);
    }
  }
}

async function countEntries(root: string): Promise<number> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory()) return 1;
  const entries = await fs.readdir(root, { withFileTypes: true });
  let count = entries.length;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countEntries(path.join(root, entry.name));
    }
  }
  return count;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function primitiveValue(value: unknown): string | number | boolean | null {
  return isPrimitive(value) ? value : JSON.stringify(value);
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureResult(message: string, startTime: number): ToolResult {
  return {
    success: false,
    data: null,
    summary: message,
    error: message,
    durationMs: Date.now() - startTime,
  };
}
