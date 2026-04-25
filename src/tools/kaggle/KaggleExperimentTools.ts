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
  KaggleMetricDirectionSchema,
  type KaggleMetrics,
  normalizedMetricScore,
  parseKaggleMetrics,
} from "./metrics.js";
import {
  ensureDirectoryWithinStateRoot,
  getKaggleExperimentDir,
  resolveKaggleWorkspaceInput,
  resolveWorkspaceRelativePath,
  stateRelativePath,
  validateKaggleExperimentId,
  workspaceRelativePath,
} from "./paths.js";
import {
  defaultProcessSessionManager,
  type ProcessSessionManager,
  type ProcessSessionSnapshot,
} from "../system/ProcessSessionTool/ProcessSessionTool.js";

const DEFAULT_MAX_LOG_CHARS = 12_000;

export const KaggleExperimentStartInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  experiment_id: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  strategy_id: z.string().optional(),
  task_id: z.string().optional(),
  expected_metrics_path: z.string().min(1).optional(),
  artifact_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type KaggleExperimentStartInput = z.infer<typeof KaggleExperimentStartInputSchema>;

export const KaggleExperimentReadInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  experiment_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  maxChars: z.number().int().min(1).max(100_000).default(DEFAULT_MAX_LOG_CHARS),
  waitMs: z.number().int().min(0).max(30_000).default(0),
}).strict().refine((input) => input.experiment_id || input.session_id, {
  message: "experiment_id or session_id is required",
});
export type KaggleExperimentReadInput = z.infer<typeof KaggleExperimentReadInputSchema>;

export const KaggleExperimentListInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  include_exited: z.boolean().default(true),
}).strict();
export type KaggleExperimentListInput = z.infer<typeof KaggleExperimentListInputSchema>;

export const KaggleExperimentStopInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  experiment_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  signal: z.enum(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"]).default("SIGTERM"),
  waitMs: z.number().int().min(0).max(30_000).default(1_000),
}).strict().refine((input) => input.experiment_id || input.session_id, {
  message: "experiment_id or session_id is required",
});
export type KaggleExperimentStopInput = z.infer<typeof KaggleExperimentStopInputSchema>;

export const KaggleMetricReportInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  experiment_id: z.string().min(1).optional(),
  metrics_path: z.string().min(1).optional(),
  baseline_score: z.number().finite().optional(),
}).strict().refine((input) => input.experiment_id || input.metrics_path, {
  message: "experiment_id or metrics_path is required",
});
export type KaggleMetricReportInput = z.infer<typeof KaggleMetricReportInputSchema>;

export const KaggleCompareExperimentsInputSchema = z.object({
  workspace: z.string().min(1),
  competition: z.string().min(1),
  experiment_ids: z.array(z.string().min(1)).optional(),
  metric_direction: KaggleMetricDirectionSchema.optional(),
}).strict();
export type KaggleCompareExperimentsInput = z.infer<typeof KaggleCompareExperimentsInputSchema>;

interface ArtifactRef {
  path: string;
  workspace_relative_path: string;
  state_relative_path: string;
}

interface ExperimentMetadata {
  schema_version: "kaggle-experiment-v1";
  experiment_id: string;
  competition: string;
  workspace_root: string;
  workspace_state_relative_path: string;
  experiment_dir: string;
  experiment_state_relative_path: string;
  created_at: string;
  updated_at: string;
  command: {
    command: string;
    args: string[];
    env_keys: string[];
  };
  process: {
    session_id: string;
    metadata_path?: string;
    metadata_state_relative_path?: string;
  };
  strategy_id: string | null;
  task_id: string | null;
  artifacts: {
    log: ArtifactRef;
    metrics: ArtifactRef;
    command: ArtifactRef;
    process: ArtifactRef;
    child_process: ArtifactRef;
    extra: ArtifactRef[];
  };
}

interface ResolvedExperiment {
  workspaceRoot: string;
  experimentId: string;
  experimentDir: string;
  metadataPath: string;
  commandPath: string;
  processPath: string;
  childProcessPath: string;
  logPath: string;
  metricsPath: string;
}

type CompareRow = {
  experiment_id: string;
  status: "ok";
  metric_name: string;
  direction: "maximize" | "minimize";
  score: number;
  normalized_score: number;
  metrics: KaggleMetrics;
  artifact: ArtifactRef;
} | {
  experiment_id: string;
  status: "missing" | "malformed";
  summary: string;
  issues: string[];
  artifact: ArtifactRef;
};

abstract class KaggleToolBase<TInput> implements ITool<TInput> {
  abstract readonly metadata: ToolMetadata;
  abstract readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;

  constructor(protected readonly manager: ProcessSessionManager = defaultProcessSessionManager) {}

  abstract description(context?: ToolDescriptionContext): string;
  abstract call(input: TInput, context: ToolCallContext): Promise<ToolResult>;
  abstract checkPermissions(input: TInput, context: ToolCallContext): Promise<PermissionCheckResult>;
  abstract isConcurrencySafe(input: TInput): boolean;
}

export class KaggleExperimentStartTool extends KaggleToolBase<KaggleExperimentStartInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_experiment_start",
    aliases: ["kaggle_start_experiment"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 2,
    maxOutputChars: DEFAULT_MAX_LOG_CHARS,
    tags: ["kaggle", "experiment", "process", "ml"],
  };
  readonly inputSchema = KaggleExperimentStartInputSchema;

  description(): string {
    return "Start a named Kaggle training experiment under the PulSeed state root, teeing process output into a durable train.log artifact.";
  }

  async call(input: KaggleExperimentStartInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const commandArgs = input.args ?? [];
      const artifactRefs = input.artifact_refs ?? [];
      const experimentId = input.experiment_id
        ? validateKaggleExperimentId(input.experiment_id)
        : generateExperimentId();
      const resolved = resolveExperiment(input.workspace, input.competition, experimentId);
      await ensureDirectoryWithinStateRoot(resolved.experimentDir);
      await fs.writeFile(resolved.logPath, "", { flag: "a" });

      const metricsPath = input.expected_metrics_path
        ? resolveWorkspaceRelativePath(resolved.workspaceRoot, input.expected_metrics_path, "expected_metrics_path")
        : resolved.metricsPath;
      const extraRefs = artifactRefs.map((ref) => resolveWorkspaceRelativePath(resolved.workspaceRoot, ref, "artifact_refs"));
      const commandMetadata = {
        schema_version: "kaggle-command-v1",
        experiment_id: experimentId,
        competition: input.competition,
        command: input.command,
        args: commandArgs,
        env_keys: Object.keys(input.env ?? {}).sort(),
        cwd: resolved.workspaceRoot,
        created_at: new Date().toISOString(),
        log_path: resolved.logPath,
        metrics_path: metricsPath,
      };
      await fs.writeFile(resolved.commandPath, `${JSON.stringify(commandMetadata, null, 2)}\n`, "utf-8");

      const session = this.manager.start({
        command: process.execPath,
        args: teeWrapperArgs(input.command, commandArgs, resolved.logPath),
        cwd: resolved.workspaceRoot,
        env: input.env,
        label: `kaggle:${input.competition}:${experimentId}`,
        task_id: input.task_id,
        strategy_id: input.strategy_id,
        artifact_refs: [
          resolved.logPath,
          metricsPath,
          resolved.metadataPath,
          resolved.commandPath,
          resolved.processPath,
          resolved.childProcessPath,
          ...extraRefs,
        ],
      }, resolved.workspaceRoot, context);

      const metadata = experimentMetadata({ ...input, args: commandArgs, artifact_refs: artifactRefs }, resolved, experimentId, metricsPath, extraRefs, session);
      await fs.writeFile(resolved.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
      await fs.writeFile(resolved.processPath, `${JSON.stringify(session, null, 2)}\n`, "utf-8");

      const output = {
        experiment_id: experimentId,
        competition: input.competition,
        process: session,
        metadata: artifactRef(resolved.workspaceRoot, resolved.metadataPath),
        artifacts: {
          log: artifactRef(resolved.workspaceRoot, resolved.logPath),
          metrics: artifactRef(resolved.workspaceRoot, metricsPath),
          command: artifactRef(resolved.workspaceRoot, resolved.commandPath),
          process: artifactRef(resolved.workspaceRoot, resolved.processPath),
          child_process: artifactRef(resolved.workspaceRoot, resolved.childProcessPath),
          extra: extraRefs.map((ref) => artifactRef(resolved.workspaceRoot, ref)),
        },
        wait_condition_hints: {
          process_session_exited: {
            type: "process_session_exited",
            session_id: session.session_id,
          },
          metrics_file_exists: {
            type: "file_exists",
            path: stateRelativePath(metricsPath),
            absolute_path: metricsPath,
          },
        },
        metric_threshold_guidance: {
          wait_condition_type: "metric_threshold",
          metric: "cv_score",
          operator: "read_metrics_direction_first",
          value_required: true,
          metric_source: "wait_metadata.metrics",
          metrics_artifact_state_relative_path: stateRelativePath(metricsPath),
        },
      };

      return {
        success: true,
        data: output,
        summary: `Started Kaggle experiment ${experimentId} as process session ${session.session_id}`,
        durationMs: Date.now() - startTime,
        artifacts: [
          resolved.metadataPath,
          resolved.commandPath,
          resolved.processPath,
          resolved.logPath,
          metricsPath,
          ...(session.metadataPath ? [session.metadataPath] : []),
          ...extraRefs,
        ],
      };
    } catch (err) {
      return failureResult(`Failed to start Kaggle experiment: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(input: KaggleExperimentStartInput): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Start Kaggle training command for ${input.competition}: ${input.command} ${(input.args ?? []).join(" ")}`.trim(),
    };
  }

  isConcurrencySafe(_input: KaggleExperimentStartInput): boolean {
    return false;
  }
}

export class KaggleExperimentReadTool extends KaggleToolBase<KaggleExperimentReadInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_experiment_read",
    aliases: ["kaggle_read_experiment"],
    permissionLevel: "read_metrics",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: DEFAULT_MAX_LOG_CHARS,
    tags: ["kaggle", "experiment", "process", "ml"],
  };
  readonly inputSchema = KaggleExperimentReadInputSchema;

  description(): string {
    return "Read a Kaggle experiment from durable metadata, train.log, metrics.json, and the live process buffer when available.";
  }

  async call(input: KaggleExperimentReadInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const located = await locateExperiment(input.workspace, input.competition, input.experiment_id, input.session_id);
      if (!located) {
        return failureResult("Kaggle experiment not found", startTime);
      }
      const liveRead = located.sessionId
        ? await this.manager.read({
          session_id: located.sessionId,
          maxChars: input.maxChars,
          waitMs: input.waitMs,
          consume: false,
        })
        : null;
      const processSnapshot = liveRead ?? await readProcessSnapshotFromMetadata(located.processPath);
      const log = await readTail(located.logPath, input.maxChars);
      const metrics = await readMetrics(located.metricsPath);
      const missingArtifacts = await missingPaths([located.logPath, located.metricsPath]);

      const output = {
        experiment_id: located.experimentId,
        session_id: located.sessionId,
        status: statusFromProcessAndMetrics(processSnapshot, metrics.ok ? metrics.metrics : null),
        process: processSnapshot,
        live_output: liveRead?.output ?? null,
        log,
        metrics: metrics.ok ? metrics.metrics : null,
        metrics_status: metrics.ok ? "ok" : metrics.reason,
        metrics_error: metrics.ok ? null : metrics.message,
        missing_artifacts: missingArtifacts.map((artifactPath) => artifactRef(located.workspaceRoot, artifactPath)),
        artifacts: {
          log: artifactRef(located.workspaceRoot, located.logPath),
          metrics: artifactRef(located.workspaceRoot, located.metricsPath),
          metadata: artifactRef(located.workspaceRoot, located.metadataPath),
          process: artifactRef(located.workspaceRoot, located.processPath),
        },
      };

      return {
        success: true,
        data: output,
        summary: `Read Kaggle experiment ${located.experimentId}: ${output.status}`,
        durationMs: Date.now() - startTime,
        artifacts: [located.metadataPath, located.processPath, located.logPath, located.metricsPath],
      };
    } catch (err) {
      return failureResult(`Failed to read Kaggle experiment: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: KaggleExperimentReadInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: KaggleExperimentReadInput): boolean {
    return true;
  }
}

export class KaggleExperimentListTool extends KaggleToolBase<KaggleExperimentListInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_experiment_list",
    aliases: ["kaggle_list_experiments"],
    permissionLevel: "read_metrics",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: DEFAULT_MAX_LOG_CHARS,
    tags: ["kaggle", "experiment", "process", "ml"],
  };
  readonly inputSchema = KaggleExperimentListInputSchema;

  description(): string {
    return "List Kaggle experiments by merging durable experiment directories with currently live process sessions.";
  }

  async call(input: KaggleExperimentListInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = resolveKaggleWorkspaceInput(input.workspace, input.competition);
      const experiments = new Map<string, Record<string, unknown>>();
      for (const experimentId of await listExperimentIds(workspaceRoot)) {
        const located = resolveLocatedExperiment(workspaceRoot, input.competition, experimentId);
        const metadata = await readJsonObject(located.metadataPath);
        const processSnapshot = await readProcessSnapshotFromMetadata(located.processPath);
        const metrics = await readMetrics(located.metricsPath);
        experiments.set(experimentId, {
          experiment_id: experimentId,
          session_id: typeof metadata?.process === "object" && metadata.process !== null
            ? (metadata.process as { session_id?: string }).session_id
            : undefined,
          status: statusFromProcessAndMetrics(processSnapshot, metrics.ok ? metrics.metrics : null),
          source: "filesystem",
          metrics: metrics.ok ? metrics.metrics : null,
          metrics_status: metrics.ok ? "ok" : metrics.reason,
          artifacts: {
            log: artifactRef(workspaceRoot, located.logPath),
            metrics: artifactRef(workspaceRoot, located.metricsPath),
            metadata: artifactRef(workspaceRoot, located.metadataPath),
          },
        });
      }

      for (const session of this.manager.list(input.include_exited)) {
        const experimentId = experimentIdFromSession(session, workspaceRoot);
        if (!experimentId) continue;
        const located = resolveLocatedExperiment(workspaceRoot, input.competition, experimentId);
        const existing = experiments.get(experimentId) ?? {};
        const metrics = await readMetrics(located.metricsPath);
        experiments.set(experimentId, {
          ...existing,
          experiment_id: experimentId,
          session_id: session.session_id,
          status: statusFromProcessAndMetrics(session, metrics.ok ? metrics.metrics : null),
          source: existing.source ? "filesystem+live" : "live",
          process: session,
          metrics: metrics.ok ? metrics.metrics : null,
          metrics_status: metrics.ok ? "ok" : metrics.reason,
          artifacts: {
            log: artifactRef(workspaceRoot, located.logPath),
            metrics: artifactRef(workspaceRoot, located.metricsPath),
            metadata: artifactRef(workspaceRoot, located.metadataPath),
          },
        });
      }

      const data = [...experiments.values()].sort((a, b) => String(a.experiment_id).localeCompare(String(b.experiment_id)));
      return {
        success: true,
        data,
        summary: `Found ${data.length} Kaggle experiment(s) for ${input.competition}`,
        durationMs: Date.now() - startTime,
        artifacts: data.flatMap((item) => {
          const artifacts = item.artifacts as Record<string, ArtifactRef> | undefined;
          return artifacts ? Object.values(artifacts).map((ref) => ref.path) : [];
        }),
      };
    } catch (err) {
      return failureResult(`Failed to list Kaggle experiments: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: KaggleExperimentListInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: KaggleExperimentListInput): boolean {
    return true;
  }
}

export class KaggleExperimentStopTool extends KaggleToolBase<KaggleExperimentStopInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_experiment_stop",
    aliases: ["kaggle_stop_experiment"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: DEFAULT_MAX_LOG_CHARS,
    tags: ["kaggle", "experiment", "process", "ml"],
  };
  readonly inputSchema = KaggleExperimentStopInputSchema;

  description(): string {
    return "Stop a running Kaggle experiment process session.";
  }

  async call(input: KaggleExperimentStopInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const located = await locateExperiment(input.workspace, input.competition, input.experiment_id, input.session_id);
      const sessionId = input.session_id ?? located?.sessionId;
      if (!sessionId) {
        return failureResult("Kaggle experiment session not found", startTime);
      }
      if (located) {
        await signalKaggleChildProcess(located.childProcessPath, input.signal);
      }
      const stopped = await this.manager.stop({ session_id: sessionId, signal: input.signal, waitMs: input.waitMs });
      if (!stopped) {
        return failureResult(`Process session not found: ${sessionId}`, startTime);
      }
      if (located) {
        await fs.writeFile(located.processPath, `${JSON.stringify(stopped, null, 2)}\n`, "utf-8");
      }
      return {
        success: true,
        data: {
          experiment_id: located?.experimentId ?? null,
          session_id: sessionId,
          process: stopped,
          artifacts: located ? {
            process: artifactRef(located.workspaceRoot, located.processPath),
            log: artifactRef(located.workspaceRoot, located.logPath),
          } : null,
        },
        summary: `Stopped Kaggle experiment process session ${sessionId}`,
        durationMs: Date.now() - startTime,
        artifacts: located ? [located.processPath, located.logPath] : stopped.artifactRefs,
      };
    } catch (err) {
      return failureResult(`Failed to stop Kaggle experiment: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(input: KaggleExperimentStopInput): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Stop Kaggle experiment ${input.experiment_id ?? input.session_id}`,
    };
  }

  isConcurrencySafe(_input: KaggleExperimentStopInput): boolean {
    return false;
  }
}

export class KaggleMetricReportTool extends KaggleToolBase<KaggleMetricReportInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_metric_report",
    aliases: ["kaggle_report_metric"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: DEFAULT_MAX_LOG_CHARS,
    tags: ["kaggle", "metrics", "ml"],
  };
  readonly inputSchema = KaggleMetricReportInputSchema;

  description(): string {
    return "Validate a Kaggle metrics.json artifact and return direction-aware score information for wait metadata.";
  }

  async call(input: KaggleMetricReportInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = resolveKaggleWorkspaceInput(input.workspace, input.competition);
      const metricsPath = input.metrics_path
        ? resolveWorkspaceRelativePath(workspaceRoot, input.metrics_path, "metrics_path")
        : path.join(getKaggleExperimentDir(workspaceRoot, input.experiment_id!), "metrics.json");
      const metrics = await readMetrics(metricsPath);
      if (!metrics.ok) {
        return {
          success: false,
          data: {
            status: "failure",
            reason: metrics.reason,
            message: metrics.message,
            issues: metrics.issues ?? [],
            artifact: artifactRef(workspaceRoot, metricsPath),
          },
          summary: `Failed to read Kaggle metrics: ${metrics.message} (${stateRelativePath(metricsPath)})`,
          error: metrics.message,
          durationMs: Date.now() - startTime,
          artifacts: [metricsPath],
        };
      }

      const normalizedScore = normalizedMetricScore(metrics.metrics);
      const baselineDelta = input.baseline_score === undefined
        ? null
        : metrics.metrics.direction === "maximize"
          ? metrics.metrics.cv_score - input.baseline_score
          : input.baseline_score - metrics.metrics.cv_score;
      const warnings = [
        ...(metrics.metrics.cv_std === null ? ["cv_std is null"] : []),
        ...(metrics.metrics.holdout_score === null ? ["holdout_score is null"] : []),
        ...(!metrics.metrics.artifacts.submission ? ["submission artifact is missing"] : []),
        ...(!metrics.metrics.artifacts.model ? ["model artifact is missing"] : []),
      ];
      const data = {
        status: "ok",
        experiment_id: metrics.metrics.experiment_id,
        metric_name: metrics.metrics.metric_name,
        direction: metrics.metrics.direction,
        score: metrics.metrics.cv_score,
        normalized_score: normalizedScore,
        baseline_delta: baselineDelta,
        confidence: confidenceForMetrics(metrics.metrics),
        metrics: metrics.metrics,
        warnings,
        artifact: artifactRef(workspaceRoot, metricsPath),
        wait_metadata: {
          metrics: {
            cv_score: metrics.metrics.cv_score,
            normalized_score: normalizedScore,
            baseline_delta: baselineDelta,
          },
        },
        metric_threshold_guidance: {
          wait_condition_type: "metric_threshold",
          metric: "cv_score",
          operator: metrics.metrics.direction === "maximize" ? "gte" : "lte",
          value_required: true,
          metric_source: "wait_metadata.metrics",
          metrics_artifact_state_relative_path: stateRelativePath(metricsPath),
        },
      };
      return {
        success: true,
        data,
        summary: `Kaggle metric ${metrics.metrics.metric_name}=${metrics.metrics.cv_score} (${metrics.metrics.direction}) for ${metrics.metrics.experiment_id}`,
        durationMs: Date.now() - startTime,
        artifacts: [metricsPath],
      };
    } catch (err) {
      return failureResult(`Failed to report Kaggle metrics: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: KaggleMetricReportInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: KaggleMetricReportInput): boolean {
    return true;
  }
}

export class KaggleCompareExperimentsTool extends KaggleToolBase<KaggleCompareExperimentsInput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_compare_experiments",
    aliases: ["kaggle_compare_metrics"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: DEFAULT_MAX_LOG_CHARS,
    tags: ["kaggle", "metrics", "ml"],
  };
  readonly inputSchema = KaggleCompareExperimentsInputSchema;

  description(): string {
    return "Compare Kaggle experiment metrics and select the best run using maximize or minimize semantics.";
  }

  async call(input: KaggleCompareExperimentsInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = resolveKaggleWorkspaceInput(input.workspace, input.competition);
      const experimentIds = input.experiment_ids?.map(validateKaggleExperimentId) ?? await listExperimentIds(workspaceRoot);
      const rows: CompareRow[] = [];
      for (const experimentId of experimentIds) {
        const metricsPath = path.join(getKaggleExperimentDir(workspaceRoot, experimentId), "metrics.json");
        const metrics = await readMetrics(metricsPath);
        if (!metrics.ok) {
          rows.push({
            experiment_id: experimentId,
            status: metrics.reason,
            summary: metrics.message,
            issues: metrics.issues ?? [],
            artifact: artifactRef(workspaceRoot, metricsPath),
          });
          continue;
        }
        const direction = input.metric_direction ?? metrics.metrics.direction;
        const normalizedScore = direction === "maximize" ? metrics.metrics.cv_score : -metrics.metrics.cv_score;
        rows.push({
          experiment_id: experimentId,
          status: "ok",
          metric_name: metrics.metrics.metric_name,
          direction,
          score: metrics.metrics.cv_score,
          normalized_score: normalizedScore,
          metrics: metrics.metrics,
          artifact: artifactRef(workspaceRoot, metricsPath),
        });
      }

      const validRows = rows
        .filter((row): row is Extract<typeof rows[number], { status: "ok" }> => row.status === "ok")
        .sort((a, b) => b.normalized_score - a.normalized_score);
      if (validRows.length === 0) {
        return {
          success: true,
          data: {
            status: "inconclusive",
            best_experiment_id: null,
            delta: null,
            rows,
            recommendation: "No valid metrics.json files were available to compare.",
          },
          summary: "Kaggle experiment comparison inconclusive: no valid metrics.json files",
          durationMs: Date.now() - startTime,
          artifacts: rows.map((row) => row.artifact.path),
        };
      }
      const metricNames = new Set(validRows.map((row) => row.metric_name));
      const metricDirections = new Set(validRows.map((row) => row.metrics.direction));
      if (metricNames.size > 1 || (!input.metric_direction && metricDirections.size > 1)) {
        return {
          success: true,
          data: {
            status: "inconclusive",
            best_experiment_id: null,
            delta: null,
            rows,
            recommendation: "Experiments must share metric_name and direction before comparison.",
          },
          summary: "Kaggle experiment comparison inconclusive: metrics are not comparable",
          durationMs: Date.now() - startTime,
          artifacts: rows.map((row) => row.artifact.path),
        };
      }

      const best = validRows[0]!;
      const runnerUp = validRows[1];
      const delta = runnerUp ? best.normalized_score - runnerUp.normalized_score : null;
      const rankTable = rows.map((row) => row.status === "ok"
        ? { ...row, rank: validRows.findIndex((valid) => valid.experiment_id === row.experiment_id) + 1 }
        : { ...row, rank: null });
      return {
        success: true,
        data: {
          status: rows.length === validRows.length ? "ok" : "inconclusive",
          best_experiment_id: best.experiment_id,
          direction: best.direction,
          metric_name: best.metric_name,
          delta,
          rows: rankTable,
          recommendation: delta === null
            ? `Use ${best.experiment_id}; it is the only valid experiment.`
            : `Use ${best.experiment_id}; it leads by ${delta}.`,
        },
        summary: `Best Kaggle experiment is ${best.experiment_id} (${best.metric_name}=${best.score}, ${best.direction})`,
        durationMs: Date.now() - startTime,
        artifacts: rows.map((row) => row.artifact.path),
      };
    } catch (err) {
      return failureResult(`Failed to compare Kaggle experiments: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: KaggleCompareExperimentsInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: KaggleCompareExperimentsInput): boolean {
    return true;
  }
}

function resolveExperiment(workspace: string, competition: string, experimentId: string): ResolvedExperiment {
  const workspaceRoot = resolveKaggleWorkspaceInput(workspace, competition);
  const experimentDir = getKaggleExperimentDir(workspaceRoot, experimentId);
  return {
    workspaceRoot,
    experimentId,
    experimentDir,
    metadataPath: path.join(experimentDir, "config.json"),
    commandPath: path.join(experimentDir, "command.json"),
    processPath: path.join(experimentDir, "process.json"),
    childProcessPath: path.join(experimentDir, "child-process.json"),
    logPath: path.join(experimentDir, "train.log"),
    metricsPath: path.join(experimentDir, "metrics.json"),
  };
}

function resolveLocatedExperiment(workspaceRoot: string, competition: string, experimentId: string): ResolvedExperiment {
  return resolveExperiment(workspaceRoot, competition, experimentId);
}

async function locateExperiment(
  workspace: string,
  competition: string,
  experimentId?: string,
  sessionId?: string,
): Promise<(ResolvedExperiment & { sessionId?: string }) | null> {
  const workspaceRoot = resolveKaggleWorkspaceInput(workspace, competition);
  if (experimentId) {
    const resolved = resolveLocatedExperiment(workspaceRoot, competition, validateKaggleExperimentId(experimentId));
    const metadata = await readJsonObject(resolved.metadataPath);
    const metadataSessionId = typeof metadata?.process === "object" && metadata.process !== null
      ? (metadata.process as { session_id?: string }).session_id
      : undefined;
    return { ...resolved, sessionId: sessionId ?? metadataSessionId };
  }

  for (const candidateId of await listExperimentIds(workspaceRoot)) {
    const resolved = resolveLocatedExperiment(workspaceRoot, competition, candidateId);
    const metadata = await readJsonObject(resolved.metadataPath);
    const metadataSessionId = typeof metadata?.process === "object" && metadata.process !== null
      ? (metadata.process as { session_id?: string }).session_id
      : undefined;
    if (metadataSessionId === sessionId) {
      return { ...resolved, sessionId };
    }
  }
  return null;
}

function experimentMetadata(
  input: KaggleExperimentStartInput,
  resolved: ResolvedExperiment,
  experimentId: string,
  metricsPath: string,
  extraRefs: string[],
  session: ProcessSessionSnapshot,
): ExperimentMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "kaggle-experiment-v1",
    experiment_id: experimentId,
    competition: input.competition,
    workspace_root: resolved.workspaceRoot,
    workspace_state_relative_path: stateRelativePath(resolved.workspaceRoot),
    experiment_dir: resolved.experimentDir,
    experiment_state_relative_path: stateRelativePath(resolved.experimentDir),
    created_at: now,
    updated_at: now,
    command: {
      command: input.command,
      args: input.args,
      env_keys: Object.keys(input.env ?? {}).sort(),
    },
    process: {
      session_id: session.session_id,
      metadata_path: session.metadataPath,
      metadata_state_relative_path: session.metadataPath ? stateRelativePath(session.metadataPath) : undefined,
    },
    strategy_id: input.strategy_id ?? null,
    task_id: input.task_id ?? null,
    artifacts: {
      log: artifactRef(resolved.workspaceRoot, resolved.logPath),
      metrics: artifactRef(resolved.workspaceRoot, metricsPath),
      command: artifactRef(resolved.workspaceRoot, resolved.commandPath),
      process: artifactRef(resolved.workspaceRoot, resolved.processPath),
      child_process: artifactRef(resolved.workspaceRoot, resolved.childProcessPath),
      extra: extraRefs.map((ref) => artifactRef(resolved.workspaceRoot, ref)),
    },
  };
}

function artifactRef(workspaceRoot: string, artifactPath: string): ArtifactRef {
  return {
    path: artifactPath,
    workspace_relative_path: workspaceRelativePath(workspaceRoot, artifactPath),
    state_relative_path: stateRelativePath(artifactPath),
  };
}

async function readMetrics(metricsPath: string): Promise<ReturnType<typeof parseKaggleMetrics>> {
  let raw: string;
  try {
    raw = await fs.readFile(metricsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing", message: "metrics.json is missing" };
    }
    throw err;
  }
  try {
    return parseKaggleMetrics(JSON.parse(raw));
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      message: `metrics.json is not valid JSON: ${(err as Error).message}`,
    };
  }
}

async function readTail(filePath: string, maxChars: number): Promise<{ text: string; truncated: boolean; path: string }> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return {
      text: raw.length > maxChars ? raw.slice(raw.length - maxChars) : raw,
      truncated: raw.length > maxChars,
      path: filePath,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", truncated: false, path: filePath };
    }
    throw err;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readProcessSnapshotFromMetadata(processPath: string): Promise<ProcessSessionSnapshot | null> {
  const localProcess = await readJsonObject(processPath);
  const processMetadataPath = typeof localProcess?.metadataPath === "string" ? localProcess.metadataPath : null;
  if (processMetadataPath) {
    const durable = await readJsonObject(processMetadataPath);
    if (durable) return durable as unknown as ProcessSessionSnapshot;
  }
  return localProcess as unknown as ProcessSessionSnapshot | null;
}

async function missingPaths(pathsToCheck: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const candidate of pathsToCheck) {
    try {
      await fs.access(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(candidate);
        continue;
      }
      throw err;
    }
  }
  return missing;
}

async function listExperimentIds(workspaceRoot: string): Promise<string[]> {
  const experimentsDir = path.join(workspaceRoot, "experiments");
  try {
    const entries = await fs.readdir(experimentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          validateKaggleExperimentId(name);
          return true;
        } catch {
          return false;
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function experimentIdFromSession(session: ProcessSessionSnapshot, workspaceRoot: string): string | null {
  for (const ref of session.artifactRefs ?? []) {
    const relative = path.relative(path.join(workspaceRoot, "experiments"), path.resolve(ref));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const [experimentId] = relative.split(path.sep);
    if (!experimentId) continue;
    try {
      return validateKaggleExperimentId(experimentId);
    } catch {
      continue;
    }
  }
  return null;
}

function statusFromProcessAndMetrics(
  processSnapshot: ProcessSessionSnapshot | null,
  metrics: KaggleMetrics | null,
): "running" | "completed" | "failed" | "unknown" {
  if (processSnapshot?.running) return "running";
  if (metrics?.status === "completed") return "completed";
  if (metrics?.status === "failed") return "failed";
  if (processSnapshot && processSnapshot.exitCode !== null) {
    return processSnapshot.exitCode === 0 ? "completed" : "failed";
  }
  return "unknown";
}

function confidenceForMetrics(metrics: KaggleMetrics): "high" | "medium" {
  return metrics.status === "completed" && metrics.cv_std !== null && metrics.valid_rows > 0 ? "high" : "medium";
}

function generateExperimentId(): string {
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `exp-${timestamp}`;
}

function teeWrapperArgs(command: string, args: string[], logPath: string): string[] {
  const script = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
const logPath = process.argv[3];
const childProcessPath = process.argv[4];
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.createWriteStream(logPath, { flags: "a" });
const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
fs.writeFileSync(childProcessPath, JSON.stringify({ pid: child.pid, command, args, startedAt: new Date().toISOString() }, null, 2));
let exiting = false;
const write = (stream, chunk) => {
  stream.write(chunk);
  log.write(chunk);
};
const forwardSignal = (signal) => {
  if (exiting) return;
  exiting = true;
  if (child.exitCode === null && !child.killed) {
    child.kill(signal);
  }
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => forwardSignal(signal));
}
child.stdout.on("data", (chunk) => write(process.stdout, chunk));
child.stderr.on("data", (chunk) => write(process.stderr, chunk));
child.on("error", (err) => {
  const msg = "[kaggle experiment process error] " + err.message + "\\n";
  process.stderr.write(msg);
  log.write(msg);
});
child.on("exit", (code, signal) => {
  const msg = "[kaggle experiment exited code=" + (code ?? "null") + " signal=" + (signal ?? "null") + "]\\n";
  log.write(msg, () => process.exit(code ?? 1));
});
`;
  const childProcessPath = path.join(path.dirname(logPath), "child-process.json");
  return ["-e", script, command, JSON.stringify(args), logPath, childProcessPath];
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

async function signalKaggleChildProcess(childProcessPath: string, signal: NodeJS.Signals): Promise<void> {
  const childProcess = await readJsonObject(childProcessPath);
  const pid = typeof childProcess?.pid === "number" ? childProcess.pid : null;
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      throw err;
    }
  }
}
