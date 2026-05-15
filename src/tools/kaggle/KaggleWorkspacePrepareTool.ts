import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
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
  getKaggleWorkspaceRoot,
  resolveKaggleWorkspaceInput,
  stateRelativePath,
} from "./paths.js";
import { ensureDirectoryWithinWorkspaceRoot } from "../../base/utils/workspace-root.js";

export const KaggleWorkspacePrepareInputSchema = z.object({
  workspace: z.string().min(1, "workspace is required"),
  competition: z.string().min(1, "competition is required"),
  metric_name: z.string().min(1, "metric_name is required"),
  metric_direction: KaggleMetricDirectionSchema,
  source_workspace: z.string().min(1).optional(),
  overwrite_existing: z.boolean().default(false),
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
  imported_workspace: {
    source_path: string;
    destination_path: string;
    copied: boolean;
    overwritten: boolean;
    entry_count: number;
  } | null;
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
      "Prepare a local Kaggle training workspace under the PulSeed-managed workspace root.",
      "Creates data, notebooks, src, experiments, and submissions directories, writes workspace metadata, and returns artifact and wait-condition path hints.",
      "Can copy an existing Kaggle workspace into the canonical PulSeed workspace root using source_workspace.",
      "This tool does not call Kaggle APIs or read credentials.",
    ].join(" ");
  }

  async call(input: KaggleWorkspacePrepareInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const resolved = await resolvePrepareTargets(input, context.cwd);
      const workspaceRoot = resolved.workspaceRoot;
      const importedWorkspace = resolved.sourceWorkspace
        ? await importSourceWorkspace(resolved.sourceWorkspace, workspaceRoot, input.overwrite_existing)
        : null;
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
        imported_workspace: importedWorkspace,
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
        imported_workspace: importedWorkspace,
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
      reason: input.source_workspace
        ? `Copy Kaggle workspace into the PulSeed workspace root and write metadata for ${input.competition}`
        : `Create Kaggle workspace directories and metadata for ${input.competition}`,
    };
  }

  isConcurrencySafe(_input: KaggleWorkspacePrepareInput): boolean {
    return false;
  }
}

async function resolvePrepareTargets(
  input: KaggleWorkspacePrepareInput,
  cwd: string,
): Promise<{ workspaceRoot: string; sourceWorkspace: string | null }> {
  if (input.source_workspace) {
    return {
      workspaceRoot: resolveKaggleWorkspaceInput(input.workspace, input.competition),
      sourceWorkspace: await resolveSourceWorkspace(input.source_workspace, cwd),
    };
  }

  try {
    return {
      workspaceRoot: resolveKaggleWorkspaceInput(input.workspace, input.competition),
      sourceWorkspace: null,
    };
  } catch (err) {
    const candidateSource = resolveUserPath(input.workspace, cwd);
    if (await looksImportableWorkspace(candidateSource)) {
      return {
        workspaceRoot: getKaggleWorkspaceRoot(input.competition),
        sourceWorkspace: candidateSource,
      };
    }
    throw err;
  }
}

async function resolveSourceWorkspace(sourceWorkspace: string, cwd: string): Promise<string> {
  const resolved = resolveUserPath(sourceWorkspace, cwd);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error("source_workspace must not be a symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error("source_workspace must be a directory");
  }
  return resolved;
}

async function looksImportableWorkspace(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const entries = await fs.readdir(candidate);
    if (entries.length === 0) return false;
    return entries.some((entry) => ["data", "scripts", "src", "notebooks", "experiments", "submission.csv", "train.py"].includes(entry));
  } catch {
    return false;
  }
}

async function importSourceWorkspace(
  sourceWorkspace: string,
  destinationWorkspace: string,
  overwriteExisting: boolean,
): Promise<NonNullable<KaggleWorkspacePrepareOutput["imported_workspace"]>> {
  const [realSource, realDestination] = await Promise.all([
    fs.realpath(sourceWorkspace),
    realpathOrNull(destinationWorkspace),
  ]);
  if (realDestination && realSource === realDestination) {
    return {
      source_path: sourceWorkspace,
      destination_path: destinationWorkspace,
      copied: false,
      overwritten: false,
      entry_count: await countEntries(sourceWorkspace),
    };
  }
  assertNotNestedImport(realSource, destinationWorkspace);
  await assertTreeHasNoSymlinks(sourceWorkspace);
  await ensureDirectoryWithinWorkspaceRoot(path.dirname(destinationWorkspace));

  await assertDestinationLeafIsSafe(destinationWorkspace);
  const destinationHasEntries = await directoryHasEntries(destinationWorkspace);
  if (destinationHasEntries && !overwriteExisting) {
    throw new Error("destination workspace already exists; set overwrite_existing=true to replace it");
  }
  await fs.rm(destinationWorkspace, { recursive: true, force: true });
  await copyDirectoryWithoutSymlinks(sourceWorkspace, destinationWorkspace);
  return {
    source_path: sourceWorkspace,
    destination_path: destinationWorkspace,
    copied: true,
    overwritten: destinationHasEntries,
    entry_count: await countEntries(destinationWorkspace),
  };
}

async function assertDestinationLeafIsSafe(destinationWorkspace: string): Promise<void> {
  try {
    const stat = await fs.lstat(destinationWorkspace);
    if (stat.isSymbolicLink()) {
      throw new Error("destination workspace must not be a symlink");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function assertNotNestedImport(realSource: string, destinationWorkspace: string): void {
  const destination = path.resolve(destinationWorkspace);
  const relativeDestination = path.relative(realSource, destination);
  if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))) {
    throw new Error("destination workspace must not be inside source_workspace");
  }
}

async function assertTreeHasNoSymlinks(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`source_workspace contains symlink: ${root}`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(root)) {
    await assertTreeHasNoSymlinks(path.join(root, entry));
  }
}

async function copyDirectoryWithoutSymlinks(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`source_workspace contains symlink: ${source}`);
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      await copyDirectoryWithoutSymlinks(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function directoryHasEntries(candidate: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(candidate);
    return entries.length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function countEntries(root: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory()) {
      count += await countEntries(path.join(root, entry.name));
    }
  }
  return count;
}

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function resolveUserPath(candidate: string, cwd: string): string {
  const requested = candidate.trim();
  if (requested === "~" || requested.startsWith("~/")) {
    return path.resolve(process.env["HOME"] ?? cwd, requested.slice(requested === "~" ? 1 : 2));
  }
  return path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(cwd, requested);
}
