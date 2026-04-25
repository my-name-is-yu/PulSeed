import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";
import {
  ensureDirectoryWithinStateRoot,
  resolveKaggleWorkspaceInput,
  resolveWorkspaceRelativePath,
  stateRelativePath,
  workspaceRelativePath,
} from "./paths.js";
import { KaggleMetricsSchema, parseKaggleMetrics, type KaggleMetrics } from "./metrics.js";

const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OUTPUT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface KaggleCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface KaggleCommandRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<KaggleCommandResult>;
}

export const defaultKaggleCommandRunner: KaggleCommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = options.timeoutMs
        ? setTimeout(() => {
          child.kill("SIGTERM");
        }, options.timeoutMs)
        : null;

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  },
};

export const KaggleSubmissionPrepareInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  source_file: z.string().min(1),
  selected_experiment_id: z.string().regex(SUBMISSION_ID_PATTERN),
  metrics_path: z.string().min(1).optional(),
  submission_id: z.string().regex(SUBMISSION_ID_PATTERN).optional(),
  output_filename: z.string().regex(OUTPUT_FILENAME_PATTERN).optional(),
  message: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
}).strict();
export type KaggleSubmissionPrepareInput = z.infer<typeof KaggleSubmissionPrepareInputSchema>;

export const KaggleSubmitInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  file: z.string().min(1),
  message: z.string().min(1),
  kernel: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  sandbox: z.boolean().default(false),
  quiet: z.boolean().default(false),
  timeoutMs: z.number().int().min(1).max(600_000).default(120_000),
}).strict();
export type KaggleSubmitInput = z.infer<typeof KaggleSubmitInputSchema>;

export const KaggleListSubmissionsInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000).default(120_000),
}).strict();
export type KaggleListSubmissionsInput = z.infer<typeof KaggleListSubmissionsInputSchema>;

export const KaggleLeaderboardSnapshotInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  snapshot_id: z.string().regex(SUBMISSION_ID_PATTERN).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).default(120_000),
}).strict();
export type KaggleLeaderboardSnapshotInput = z.infer<typeof KaggleLeaderboardSnapshotInputSchema>;

interface ArtifactRef {
  path: string;
  workspace_relative_path: string;
  state_relative_path: string;
}

const ArtifactRefSchema = z.object({
  path: z.string().min(1),
  workspace_relative_path: z.string().min(1),
  state_relative_path: z.string().min(1),
}).strict();

const PreparedSubmissionMetadataSchema = z.object({
  schema_version: z.literal("kaggle-submission-v1"),
  created_at: z.string().datetime(),
  competition: z.string().min(1),
  submission_id: z.string().regex(SUBMISSION_ID_PATTERN),
  message: z.string().nullable(),
  notes: z.string().nullable(),
  source: ArtifactRefSchema,
  prepared: ArtifactRefSchema,
  provenance: z.object({
    selected_experiment_id: z.string().regex(SUBMISSION_ID_PATTERN),
    local_metrics: z.object({
      schema_version: z.literal("kaggle-metrics-v1"),
      evidence_type: z.literal("local_cv"),
      metrics: KaggleMetricsSchema,
      artifact: ArtifactRefSchema,
    }).strict(),
  }).strict(),
}).strict();

abstract class KaggleSubmissionToolBase<TInput> implements ITool<TInput> {
  abstract readonly metadata: ToolMetadata;
  abstract readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;

  constructor(protected readonly runner: KaggleCommandRunner = defaultKaggleCommandRunner) {}

  abstract description(context?: ToolDescriptionContext): string;
  abstract call(input: TInput, context: ToolCallContext): Promise<ToolResult>;
  abstract checkPermissions(input: TInput, context: ToolCallContext): Promise<PermissionCheckResult>;
  abstract isConcurrencySafe(input: TInput): boolean;
}

export class KaggleSubmissionPrepareTool implements ITool<KaggleSubmissionPrepareInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_submission_prepare",
    aliases: ["kaggle_prepare_submission"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    tags: ["kaggle", "submission", "ml", "filesystem"],
  };
  readonly inputSchema = KaggleSubmissionPrepareInputSchema;

  description(): string {
    return "Copy a candidate submission file into the fixed Kaggle workspace submissions directory and write local submission metadata.";
  }

  async call(input: KaggleSubmissionPrepareInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = await resolveSafeWorkspaceRoot(input.workspace, input.competition);
      const sourcePath = await resolveExistingWorkspaceFile(workspaceRoot, input.source_file, "source_file");
      const metricsPath = input.metrics_path
        ? await resolveExistingWorkspaceFile(workspaceRoot, input.metrics_path, "metrics_path")
        : await resolveExistingWorkspaceFile(
          workspaceRoot,
          path.join("experiments", input.selected_experiment_id, "metrics.json"),
          "metrics_path",
        );
      const metrics = await readKaggleMetrics(metricsPath);
      if (metrics.experiment_id !== input.selected_experiment_id) {
        throw new Error("metrics_path experiment_id must match selected_experiment_id");
      }
      if (metrics.competition !== input.competition) {
        throw new Error("metrics_path competition must match competition");
      }
      const submissionsDir = path.join(workspaceRoot, "submissions");
      await ensureDirectoryWithinStateRoot(submissionsDir);

      const submissionId = input.submission_id ?? generateSubmissionId("submission");
      const filename = input.output_filename ?? `${submissionId}${path.extname(sourcePath) || ".csv"}`;
      if (!OUTPUT_FILENAME_PATTERN.test(filename)) {
        throw new Error("output_filename must be a safe filename");
      }
      const preparedPath = path.join(submissionsDir, filename);
      const metadataPath = path.join(submissionsDir, `${submissionId}.json`);
      await assertSafeOutputLeaf(preparedPath, "prepared submission");
      await assertSafeOutputLeaf(metadataPath, "submission metadata");
      await fs.copyFile(sourcePath, preparedPath);

      const now = new Date().toISOString();
      const metadata = {
        schema_version: "kaggle-submission-v1",
        created_at: now,
        competition: input.competition,
        submission_id: submissionId,
        message: input.message ?? null,
        notes: input.notes ?? null,
        source: artifactRef(workspaceRoot, sourcePath),
        prepared: artifactRef(workspaceRoot, preparedPath),
        provenance: {
          selected_experiment_id: input.selected_experiment_id,
          local_metrics: {
            schema_version: "kaggle-metrics-v1",
            evidence_type: "local_cv",
            metrics,
            artifact: artifactRef(workspaceRoot, metricsPath),
          },
        },
      };
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

      return {
        success: true,
        data: {
          competition: input.competition,
          submission_id: submissionId,
          file: artifactRef(workspaceRoot, preparedPath),
          metadata: artifactRef(workspaceRoot, metadataPath),
          submit_hint: {
            tool: "kaggle_submit",
            file: workspaceRelativePath(workspaceRoot, preparedPath),
            message: input.message ?? "",
          },
        },
        summary: `Prepared Kaggle submission ${submissionId} for ${input.competition}`,
        durationMs: Date.now() - startTime,
        artifacts: [preparedPath, metadataPath],
      };
    } catch (err) {
      return failureResult(`Failed to prepare Kaggle submission: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(input: KaggleSubmissionPrepareInput): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Copy local Kaggle submission artifact for ${input.competition}`,
    };
  }

  isConcurrencySafe(_input: KaggleSubmissionPrepareInput): boolean {
    return false;
  }
}

export class KaggleSubmitTool extends KaggleSubmissionToolBase<KaggleSubmitInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_submit",
    aliases: ["kaggle_competition_submit"],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: true,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    tags: ["kaggle", "submission", "remote", "network", "automation"],
    requiresNetwork: true,
  };
  readonly inputSchema = KaggleSubmitInputSchema;

  description(): string {
    return "Submit a prepared file to Kaggle using kaggle competitions submit <competition> -f <file> -m <message>.";
  }

  async call(input: KaggleSubmitInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = await resolveSafeWorkspaceRoot(input.workspace, input.competition);
      const filePath = await resolveExistingWorkspaceFile(workspaceRoot, input.file, "file");
      const preparedMetadata = await requirePreparedSubmissionMetadata(workspaceRoot, filePath, input.competition);
      const args = [
        "competitions",
        "submit",
        input.competition,
        "-f",
        filePath,
        "-m",
        input.message,
        ...optionalSubmitArgs(input),
      ];
      const result = await this.runner.run("kaggle", args, {
        cwd: workspaceRoot,
        timeoutMs: input.timeoutMs,
        signal: context.abortSignal,
      });
      const data = {
        competition: input.competition,
        command: { command: "kaggle", args },
        exit_code: result.exitCode,
        stdout: truncate(result.stdout, this.metadata.maxOutputChars),
        stderr: truncate(result.stderr, this.metadata.maxOutputChars),
        file: artifactRef(workspaceRoot, filePath),
        prepared_metadata: artifactRef(workspaceRoot, preparedMetadata.metadataPath),
        provenance: preparedMetadata.metadata.provenance,
      };
      return {
        success: result.exitCode === 0,
        data,
        summary: result.exitCode === 0
          ? `Submitted Kaggle file for ${input.competition}`
          : `Kaggle submit failed for ${input.competition} with exit code ${result.exitCode}`,
        error: result.exitCode === 0 ? undefined : result.stderr || result.stdout || `exit code ${result.exitCode}`,
        durationMs: Date.now() - startTime,
        artifacts: [filePath],
      };
    } catch (err) {
      return failureResult(`Failed to submit to Kaggle: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(input: KaggleSubmitInput): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Submit ${input.file} to remote Kaggle competition ${input.competition}`,
    };
  }

  isConcurrencySafe(_input: KaggleSubmitInput): boolean {
    return false;
  }
}

export class KaggleListSubmissionsTool extends KaggleSubmissionToolBase<KaggleListSubmissionsInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_list_submissions",
    aliases: ["kaggle_competition_submissions"],
    permissionLevel: "read_metrics",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 2,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    tags: ["kaggle", "submission", "metrics", "network"],
    requiresNetwork: true,
  };
  readonly inputSchema = KaggleListSubmissionsInputSchema;

  description(): string {
    return "List remote Kaggle submissions using kaggle competitions submissions <competition> -v -q.";
  }

  async call(input: KaggleListSubmissionsInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = await resolveSafeWorkspaceRoot(input.workspace, input.competition);
      const args = ["competitions", "submissions", input.competition, "-v", "-q"];
      const result = await this.runner.run("kaggle", args, {
        cwd: workspaceRoot,
        timeoutMs: input.timeoutMs,
        signal: context.abortSignal,
      });
      return {
        success: result.exitCode === 0,
        data: {
          competition: input.competition,
          command: { command: "kaggle", args },
          exit_code: result.exitCode,
          stdout: truncate(result.stdout, this.metadata.maxOutputChars),
          stderr: truncate(result.stderr, this.metadata.maxOutputChars),
        },
        summary: result.exitCode === 0
          ? `Listed Kaggle submissions for ${input.competition}`
          : `Kaggle submissions failed for ${input.competition} with exit code ${result.exitCode}`,
        error: result.exitCode === 0 ? undefined : result.stderr || result.stdout || `exit code ${result.exitCode}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return failureResult(`Failed to list Kaggle submissions: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: KaggleListSubmissionsInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: KaggleListSubmissionsInput): boolean {
    return true;
  }
}

export class KaggleLeaderboardSnapshotTool extends KaggleSubmissionToolBase<KaggleLeaderboardSnapshotInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_leaderboard_snapshot",
    aliases: ["kaggle_snapshot_leaderboard"],
    permissionLevel: "read_metrics",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    tags: ["kaggle", "leaderboard", "metrics", "network", "filesystem"],
    requiresNetwork: true,
  };
  readonly inputSchema = KaggleLeaderboardSnapshotInputSchema;

  description(): string {
    return "Fetch a Kaggle leaderboard snapshot using kaggle competitions leaderboard <competition> -s -v -q and store it locally.";
  }

  async call(input: KaggleLeaderboardSnapshotInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = await resolveSafeWorkspaceRoot(input.workspace, input.competition);
      const leaderboardDir = path.join(workspaceRoot, "submissions", "leaderboard");
      await ensureDirectoryWithinStateRoot(leaderboardDir);
      const snapshotId = input.snapshot_id ?? generateSubmissionId("leaderboard");
      const snapshotPath = path.join(leaderboardDir, `${snapshotId}.json`);
      await assertSafeOutputLeaf(snapshotPath, "leaderboard snapshot");
      const args = ["competitions", "leaderboard", input.competition, "-s", "-v", "-q"];
      const result = await this.runner.run("kaggle", args, {
        cwd: workspaceRoot,
        timeoutMs: input.timeoutMs,
        signal: context.abortSignal,
      });
      const snapshot = {
        schema_version: "kaggle-leaderboard-snapshot-v1",
        created_at: new Date().toISOString(),
        competition: input.competition,
        snapshot_id: snapshotId,
        command: { command: "kaggle", args },
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");

      return {
        success: result.exitCode === 0,
        data: {
          competition: input.competition,
          snapshot_id: snapshotId,
          snapshot: artifactRef(workspaceRoot, snapshotPath),
          command: { command: "kaggle", args },
          exit_code: result.exitCode,
          stdout: truncate(result.stdout, this.metadata.maxOutputChars),
          stderr: truncate(result.stderr, this.metadata.maxOutputChars),
        },
        summary: result.exitCode === 0
          ? `Stored Kaggle leaderboard snapshot for ${input.competition}`
          : `Kaggle leaderboard snapshot failed for ${input.competition} with exit code ${result.exitCode}`,
        error: result.exitCode === 0 ? undefined : result.stderr || result.stdout || `exit code ${result.exitCode}`,
        durationMs: Date.now() - startTime,
        artifacts: [snapshotPath],
      };
    } catch (err) {
      return failureResult(`Failed to snapshot Kaggle leaderboard: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: KaggleLeaderboardSnapshotInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: KaggleLeaderboardSnapshotInput): boolean {
    return false;
  }
}

function optionalSubmitArgs(input: KaggleSubmitInput): string[] {
  const args: string[] = [];
  if (input.kernel) args.push("-k", input.kernel);
  if (input.version) args.push("-v", input.version);
  if (input.sandbox) args.push("--sandbox");
  if (input.quiet) args.push("-q");
  return args;
}

async function readKaggleMetrics(metricsPath: string): Promise<KaggleMetrics> {
  const raw = await readJsonObject(metricsPath, "metrics_path");
  const parsed = parseKaggleMetrics(raw);
  if (!parsed.ok) {
    throw new Error(`${parsed.message}: ${parsed.issues?.join("; ") ?? parsed.reason}`);
  }
  return parsed.metrics;
}

async function requirePreparedSubmissionMetadata(
  workspaceRoot: string,
  filePath: string,
  competition: string,
): Promise<{ metadataPath: string; metadata: z.infer<typeof PreparedSubmissionMetadataSchema> }> {
  const submissionsDir = path.join(workspaceRoot, "submissions");
  await ensureDirectoryWithinStateRoot(submissionsDir);
  const realSubmissionsDir = await realpathOrNull(submissionsDir);
  if (!realSubmissionsDir) {
    throw new Error("file must be a prepared submission under submissions/");
  }
  const realFile = await fs.realpath(filePath);
  const relativeToSubmissions = path.relative(realSubmissionsDir, realFile);
  if (relativeToSubmissions === "" || relativeToSubmissions.startsWith("..") || path.isAbsolute(relativeToSubmissions)) {
    throw new Error("file must be a prepared submission under submissions/");
  }

  const metadataFiles = await listSubmissionMetadataFiles(submissionsDir);
  for (const metadataPath of metadataFiles) {
    const raw = await readJsonObject(metadataPath, "submission metadata");
    const candidate = PreparedSubmissionMetadataSchema.safeParse(raw);
    if (!candidate.success || candidate.data.competition !== competition) {
      continue;
    }
    const preparedPath = resolveWorkspaceRelativePath(
      workspaceRoot,
      candidate.data.prepared.workspace_relative_path,
      "prepared metadata file",
    );
    const realPreparedPath = await realpathOrNull(preparedPath);
    if (realPreparedPath === realFile) {
      return { metadataPath, metadata: candidate.data };
    }
  }
  throw new Error("file must have a valid kaggle_submission_prepare metadata sidecar");
}

async function listSubmissionMetadataFiles(submissionsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(submissionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(submissionsDir, entry));
}

async function resolveExistingWorkspaceFile(workspaceRoot: string, candidate: string, label: string): Promise<string> {
  const resolved = resolveWorkspaceRelativePath(workspaceRoot, candidate, label);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a file`);
  }
  const [realWorkspaceRoot, realFile] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(resolved),
  ]);
  const relative = path.relative(realWorkspaceRoot, realFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within the Kaggle workspace`);
  }
  return resolved;
}

async function realpathOrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function readJsonObject(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${label} must be valid JSON`);
    }
    throw err;
  }
}

async function assertSafeOutputLeaf(outputPath: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(outputPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink: ${stateRelativePath(outputPath)}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

async function resolveSafeWorkspaceRoot(workspace: string, competition: string): Promise<string> {
  const workspaceRoot = resolveKaggleWorkspaceInput(workspace, competition);
  await ensureDirectoryWithinStateRoot(workspaceRoot);
  return workspaceRoot;
}

function artifactRef(workspaceRoot: string, artifactPath: string): ArtifactRef {
  return {
    path: artifactPath,
    workspace_relative_path: workspaceRelativePath(workspaceRoot, artifactPath),
    state_relative_path: stateRelativePath(artifactPath),
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function generateSubmissionId(prefix: string): string {
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${prefix}-${timestamp}`;
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
