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
import { KaggleMetricDirectionSchema, metricThresholdHintForDirection } from "./metrics.js";
import {
  ensureKaggleWorkspaceDirectories,
  resolveKaggleWorkspaceInput,
  stateRelativePath,
} from "./paths.js";

export const KaggleWorkspacePrepareInputSchema = z.object({
  workspace: z.string().min(1, "workspace is required"),
  competition: z.string().min(1, "competition is required"),
  metric_name: z.string().min(1, "metric_name is required"),
  metric_direction: KaggleMetricDirectionSchema,
  target_column: z.string().min(1).optional(),
  submission_format_hint: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
}).strict();

export type KaggleWorkspacePrepareInput = z.infer<typeof KaggleWorkspacePrepareInputSchema>;

export interface KaggleWorkspacePrepareOutput {
  workspace: {
    path: string;
    state_relative_path: string;
  };
  metadata: {
    path: string;
    state_relative_path: string;
  };
  directories: Array<{
    name: string;
    path: string;
    state_relative_path: string;
  }>;
  artifacts: {
    metrics_template: {
      path: string;
      workspace_relative_path: string;
      state_relative_path: string;
    };
    train_log: {
      path: string;
      workspace_relative_path: string;
      state_relative_path: string;
    };
    submissions_dir: {
      path: string;
      state_relative_path: string;
    };
  };
  wait_condition_hints: {
    file_exists: {
      type: "file_exists";
      path: string;
      absolute_path: string;
      hint: string;
    };
  };
  metric_threshold_guidance: ReturnType<typeof metricThresholdHintForDirection> & {
    metrics_artifact_path: string;
    metrics_artifact_state_relative_path: string;
  };
}

export class KaggleWorkspacePrepareTool implements ITool<KaggleWorkspacePrepareInput, KaggleWorkspacePrepareOutput> {
  readonly metadata: ToolMetadata = {
    name: "kaggle_workspace_prepare",
    aliases: ["kaggle_prepare_workspace"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: ["kaggle", "workspace", "ml", "filesystem"],
  };

  readonly inputSchema = KaggleWorkspacePrepareInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return [
      "Prepare a local Kaggle training workspace under PulSeed state.",
      "Creates data, notebooks, src, experiments, and submissions directories, writes workspace metadata, and returns artifact and wait-condition path hints.",
      "This tool does not call Kaggle APIs or read credentials.",
    ].join(" ");
  }

  async call(input: KaggleWorkspacePrepareInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const workspaceRoot = resolveKaggleWorkspaceInput(input.workspace, input.competition);
      const directories = await ensureKaggleWorkspaceDirectories(workspaceRoot);
      const metadataPath = path.join(workspaceRoot, "workspace.json");
      const metricsPath = path.join(workspaceRoot, "experiments", "metrics.json");
      const logPath = path.join(workspaceRoot, "experiments", "train.log");
      const now = new Date().toISOString();

      const metadata = {
        schema_version: "kaggle-workspace-v1",
        created_at: now,
        competition: input.competition,
        workspace_root: workspaceRoot,
        workspace_state_relative_path: stateRelativePath(workspaceRoot),
        metric: {
          name: input.metric_name,
          direction: input.metric_direction,
        },
        target_column: input.target_column ?? null,
        submission_format_hint: input.submission_format_hint ?? null,
        notes: input.notes ?? null,
        directories: Object.fromEntries(
          Object.entries(directories).map(([name, fullPath]) => [name, stateRelativePath(fullPath)]),
        ),
        metrics_schema_version: "kaggle-metrics-v1",
      };

      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

      const thresholdHint = metricThresholdHintForDirection(input.metric_name, input.metric_direction);
      const output: KaggleWorkspacePrepareOutput = {
        workspace: {
          path: workspaceRoot,
          state_relative_path: stateRelativePath(workspaceRoot),
        },
        metadata: {
          path: metadataPath,
          state_relative_path: stateRelativePath(metadataPath),
        },
        directories: Object.entries(directories).map(([name, fullPath]) => ({
          name,
          path: fullPath,
          state_relative_path: stateRelativePath(fullPath),
        })),
        artifacts: {
          metrics_template: {
            path: metricsPath,
            workspace_relative_path: "experiments/metrics.json",
            state_relative_path: stateRelativePath(metricsPath),
          },
          train_log: {
            path: logPath,
            workspace_relative_path: "experiments/train.log",
            state_relative_path: stateRelativePath(logPath),
          },
          submissions_dir: {
            path: directories.submissions,
            state_relative_path: stateRelativePath(directories.submissions),
          },
        },
        wait_condition_hints: {
          file_exists: {
            type: "file_exists",
            path: stateRelativePath(metricsPath),
            absolute_path: metricsPath,
            hint: "Wait for the training command to write metrics.json.",
          },
        },
        metric_threshold_guidance: {
          ...thresholdHint,
          metrics_artifact_path: metricsPath,
          metrics_artifact_state_relative_path: stateRelativePath(metricsPath),
        },
      };

      return {
        success: true,
        data: output,
        summary: `Prepared Kaggle workspace for ${input.competition} at ${output.workspace.state_relative_path}`,
        durationMs: Date.now() - startTime,
        artifacts: [metadataPath, ...Object.values(directories)],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Failed to prepare Kaggle workspace for ${input.competition}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: KaggleWorkspacePrepareInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Create Kaggle workspace directories and metadata for ${input.competition}`,
    };
  }

  isConcurrencySafe(_input: KaggleWorkspacePrepareInput): boolean {
    return false;
  }
}
