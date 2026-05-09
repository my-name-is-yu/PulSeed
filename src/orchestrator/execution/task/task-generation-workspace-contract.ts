import { access } from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "../../../runtime/logger.js";
import {
  extractWorkspacePathConstraint,
  formatWorkspacePathConstraint,
  resolveWorkspacePath,
} from "../../../base/utils/workspace-path.js";
import type { Goal } from "../../goal/types/goal.js";
import type { LLMGeneratedTask } from "./task-generation-schema.js";

const BROAD_REPO_VERIFICATION_COMMANDS = new Set([
  "npm test",
  "npm run test",
  "npm run build",
  "pnpm test",
  "pnpm run test",
  "pnpm run build",
  "yarn test",
  "yarn build",
  "npx vitest run",
]);

const NODE_PACKAGE_MANIFEST = "package.json";
const WORKSPACE_LOCAL_CHECK_CONTRACT_COMMAND_RE =
  /^(?:python3?|\.venv\/bin\/python|node)\s+([^\s]+)\s+--check-contract(?:\s|$)/;

function normalizeShellCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isBroadRepoVerificationCommand(command: string): boolean {
  return BROAD_REPO_VERIFICATION_COMMANDS.has(normalizeShellCommand(command));
}

async function workspaceHasNodePackageManifest(workspacePath: string): Promise<boolean> {
  return access(path.join(workspacePath, NODE_PACKAGE_MANIFEST))
    .then(() => true)
    .catch(() => false);
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath)
    .then(() => true)
    .catch(() => false);
}

function isInsideWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relative = path.relative(workspacePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getWorkspaceLocalCheckContractScriptPath(command: string): string | null {
  const match = normalizeShellCommand(command).match(WORKSPACE_LOCAL_CHECK_CONTRACT_COMMAND_RE);
  return match?.[1] ?? null;
}

function usesCheckContractFlag(command: string): boolean {
  return /(?:^|\s)--check-contract(?:\s|$)/.test(normalizeShellCommand(command));
}

function normalizeWorkspaceRelativePathToken(value: string, workspacePath: string): string | null {
  const trimmed = value.trim().replace(/^`(.+)`$/, "$1");
  const relativePath = path.isAbsolute(trimmed)
    ? path.relative(workspacePath, trimmed)
    : trimmed;
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return relativePath.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function generatedTaskDeclaresWorkspacePath(
  generated: LLMGeneratedTask,
  workspacePath: string,
  relativePath: string
): boolean {
  const expected = normalizeWorkspaceRelativePathToken(relativePath, workspacePath);
  if (!expected) return false;
  const declaredPaths = [
    ...generated.scope_boundary.in_scope,
    ...generated.artifact_contract.required_artifacts.map((artifact) => artifact.path),
  ];
  return declaredPaths.some((candidate) =>
    normalizeWorkspaceRelativePathToken(candidate, workspacePath) === expected
  );
}

async function getUnsupportedWorkspaceLocalCheckContractReason(
  command: string,
  workspacePath: string,
  generated: LLMGeneratedTask
): Promise<string | null> {
  const scriptPath = getWorkspaceLocalCheckContractScriptPath(command);
  if (!scriptPath) {
    return usesCheckContractFlag(command) ? "unsupported_check_contract_command" : null;
  }

  const absoluteScriptPath = path.resolve(workspacePath, scriptPath);
  if (!isInsideWorkspace(workspacePath, absoluteScriptPath)) {
    return "outside_workspace_check_contract_script";
  }
  if (await fileExists(absoluteScriptPath)) return null;

  const relativeScriptPath = path.relative(workspacePath, absoluteScriptPath);
  if (generatedTaskDeclaresWorkspacePath(generated, workspacePath, relativeScriptPath)) {
    return null;
  }
  return "missing_workspace_local_check_contract_script";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasWorkspacePathConstraint(constraints: readonly string[], workspacePath: string): boolean {
  return constraints.some((constraint) => {
    const raw = extractWorkspacePathConstraint([constraint]);
    return raw !== null && resolveWorkspacePath(raw) === workspacePath;
  });
}

function withWorkspacePathConstraint(
  generated: LLMGeneratedTask,
  workspacePath: string
): LLMGeneratedTask {
  if (hasWorkspacePathConstraint(generated.constraints, workspacePath)) return generated;
  return {
    ...generated,
    constraints: [...generated.constraints, formatWorkspacePathConstraint(workspacePath)],
  };
}

function buildArtifactFileCheckCriteria(generated: LLMGeneratedTask): LLMGeneratedTask["success_criteria"] {
  return generated.artifact_contract.required_artifacts.map((artifact) => ({
    description: `Required artifact exists: ${artifact.path}`,
    verification_method: `test -f ${shellQuote(artifact.path)}`,
    is_blocking: true,
  }));
}

export async function enforceWorkspaceBoundArtifactTaskContract(input: {
  generated: LLMGeneratedTask;
  goal: Goal | null;
  repoRoot?: string;
  artifactContractRequired: boolean;
  logger?: Logger;
}): Promise<LLMGeneratedTask> {
  const workspacePathConstraint = extractWorkspacePathConstraint(input.goal?.constraints);
  if (!workspacePathConstraint) return input.generated;

  const workspacePath = resolveWorkspacePath(workspacePathConstraint, input.repoRoot);
  const constrained = withWorkspacePathConstraint(input.generated, workspacePath);
  const hasArtifactRequirements = constrained.artifact_contract.required_artifacts.length > 0;
  if (!input.artifactContractRequired || !hasArtifactRequirements) return constrained;
  if (await workspaceHasNodePackageManifest(workspacePath)) return constrained;

  const filteredCriteria: LLMGeneratedTask["success_criteria"] = [];
  const removedVerificationMethods: Array<{ method: string; reason: string }> = [];
  for (const criterion of constrained.success_criteria) {
    if (isBroadRepoVerificationCommand(criterion.verification_method)) {
      removedVerificationMethods.push({
        method: normalizeShellCommand(criterion.verification_method),
        reason: "broad_repo_command",
      });
      continue;
    }
    const unsupportedCheckContractReason = await getUnsupportedWorkspaceLocalCheckContractReason(
      criterion.verification_method,
      workspacePath,
      constrained
    );
    if (unsupportedCheckContractReason) {
      removedVerificationMethods.push({
        method: normalizeShellCommand(criterion.verification_method),
        reason: unsupportedCheckContractReason,
      });
      continue;
    }
    filteredCriteria.push(criterion);
  }
  if (removedVerificationMethods.length === 0) return constrained;

  const successCriteria = filteredCriteria.some((criterion) => criterion.is_blocking)
    ? filteredCriteria
    : [...filteredCriteria, ...buildArtifactFileCheckCriteria(constrained)];

  input.logger?.warn("Task generation removed unsupported verification from workspace-bound artifact task", {
    workspace_path: workspacePath,
    removed_verification_methods: removedVerificationMethods,
  });

  return {
    ...constrained,
    success_criteria: successCriteria,
  };
}
