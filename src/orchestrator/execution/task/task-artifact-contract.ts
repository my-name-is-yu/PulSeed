import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Goal } from "../../../base/types/goal.js";
import type { Task, TaskArtifactContract, TaskArtifactRequirement } from "../../../base/types/task.js";

export interface TaskArtifactContractVerification {
  applicable: boolean;
  passed: boolean;
  description: string;
}

export interface TaskArtifactContractVerificationOptions {
  goal?: Pick<Goal, "constraints"> | null;
}

const FRESHNESS_SLOP_MS = 1_000;
const ARTIFACT_CONTRACT_REQUIRED_CONSTRAINT = "artifact_contract:required";
const KAGGLE_RUN_SPEC_PROFILE_CONSTRAINT = "run_spec_profile:kaggle";
const KAGGLE_DOMAIN_CONSTRAINT = "domain:kaggle";

function hasArtifactRequiredConstraint(constraints: readonly string[] | undefined): boolean {
  return constraints?.some((constraint) => {
    const token = constraint.trim();
    return token === ARTIFACT_CONTRACT_REQUIRED_CONSTRAINT
      || token === KAGGLE_RUN_SPEC_PROFILE_CONSTRAINT
      || token === KAGGLE_DOMAIN_CONSTRAINT;
  }) ?? false;
}

function hasKaggleArtifactKindConstraint(constraints: readonly string[] | undefined): boolean {
  return constraints?.some((constraint) => {
    const token = constraint.trim();
    return token === KAGGLE_RUN_SPEC_PROFILE_CONSTRAINT || token === KAGGLE_DOMAIN_CONSTRAINT;
  }) ?? false;
}

export function isArtifactContractRequired(input: {
  artifactContract?: Pick<TaskArtifactContract, "required">;
  taskConstraints?: readonly string[];
  goal?: Pick<Goal, "constraints"> | null;
}): boolean {
  return input.artifactContract?.required === true
    || hasArtifactRequiredConstraint(input.taskConstraints)
    || hasArtifactRequiredConstraint(input.goal?.constraints);
}

export function isTaskArtifactContractRequired(
  task: Task,
  goal?: Pick<Goal, "constraints"> | null,
): boolean {
  return isArtifactContractRequired({
    artifactContract: task.artifact_contract,
    taskConstraints: task.constraints,
    goal,
  });
}

export async function verifyTaskArtifactContract(
  task: Task,
  cwd: string | undefined,
  options: TaskArtifactContractVerificationOptions = {},
): Promise<TaskArtifactContractVerification> {
  const requirements = task.artifact_contract?.required_artifacts ?? [];
  const required = isTaskArtifactContractRequired(task, options.goal);
  if (requirements.length === 0) {
    if (required) {
      return {
        applicable: true,
        passed: false,
        description: "Artifact contract verification failed: artifact evidence is required but no required_artifacts were declared.",
      };
    }
    return { applicable: false, passed: false, description: "No task artifact contract configured" };
  }
  if (!cwd) {
    return {
      applicable: true,
      passed: false,
      description: "Artifact contract verification failed: no task workspace is available.",
    };
  }

  const referenceTime = task.started_at ?? task.created_at;
  const failures = required && requiresKaggleArtifactKinds(task, options.goal)
    ? requiredArtifactKindFailures(requirements)
    : [];
  const passed: string[] = [];
  for (const requirement of requirements) {
    const result = await verifyArtifactRequirement(requirement, cwd, referenceTime, required);
    if (result.passed) passed.push(result.description);
    else failures.push(result.description);
  }

  if (failures.length > 0) {
    return {
      applicable: true,
      passed: false,
      description: `Artifact contract verification failed: ${failures.join("; ")}`,
    };
  }

  return {
    applicable: true,
    passed: true,
    description: `Artifact contract verification passed (${passed.length}/${requirements.length} artifact(s)): ${passed.join("; ")}`,
  };
}

export async function readTaskArtifactMetricValues(
  task: Pick<Task, "artifact_contract">,
  cwd: string | undefined,
): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  if (!cwd) return values;

  for (const requirement of task.artifact_contract?.required_artifacts ?? []) {
    if (requirement.kind !== "metrics_json") continue;
    const resolvedPath = resolveWorkspaceArtifactPath(cwd, requirement.path);
    if (!resolvedPath) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const data = parsed as Record<string, unknown>;
    const contractFields = new Set([
      ...requirement.required_fields,
      ...Object.keys(requirement.field_types ?? {}),
    ]);
    const candidateFields = contractFields.size > 0 ? contractFields : new Set(Object.keys(data));
    for (const field of candidateFields) {
      const value = data[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        values.set(field, value);
      }
    }
  }

  return values;
}

function requiresKaggleArtifactKinds(
  task: Task,
  goal?: Pick<Goal, "constraints"> | null,
): boolean {
  return hasKaggleArtifactKindConstraint(task.constraints) || hasKaggleArtifactKindConstraint(goal?.constraints);
}

function requiredArtifactKindFailures(requirements: readonly TaskArtifactRequirement[]): string[] {
  const declaredKinds = new Set(requirements.map((requirement) => requirement.kind));
  const missingKinds = ["metrics_json", "submission_csv"].filter((kind) => !declaredKinds.has(kind as TaskArtifactRequirement["kind"]));
  return missingKinds.length > 0
    ? [`required artifact contract missing required artifact kind(s): ${missingKinds.join(", ")}`]
    : [];
}

async function verifyArtifactRequirement(
  requirement: TaskArtifactRequirement,
  cwd: string,
  referenceTime: string,
  forceFreshness: boolean,
): Promise<{ passed: boolean; description: string }> {
  const resolvedPath = resolveWorkspaceArtifactPath(cwd, requirement.path);
  if (!resolvedPath) {
    return { passed: false, description: `${requirement.path} is not a safe workspace-relative artifact path` };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    return { passed: false, description: `${requirement.path} is missing` };
  }
  if (!stat.isFile()) {
    return { passed: false, description: `${requirement.path} is not a file` };
  }

  if (forceFreshness || requirement.fresh_after_task_start) {
    const referenceMs = Date.parse(referenceTime);
    if (Number.isFinite(referenceMs) && stat.mtimeMs + FRESHNESS_SLOP_MS < referenceMs) {
      return { passed: false, description: `${requirement.path} is stale relative to task start` };
    }
  }

  const content = await fs.readFile(resolvedPath, "utf8");
  if (requirement.kind === "metrics_json") {
    return verifyMetricsJson(requirement, content);
  }
  return verifySubmissionCsv(requirement, content);
}

function resolveWorkspaceArtifactPath(cwd: string, artifactPath: string): string | null {
  if (!artifactPath.trim() || artifactPath.includes("\0") || path.isAbsolute(artifactPath)) return null;
  const normalized = artifactPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment.length === 0)) return null;
  const resolved = path.resolve(cwd, normalized);
  const workspaceRoot = path.resolve(cwd);
  return resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`) ? resolved : null;
}

function verifyMetricsJson(
  requirement: TaskArtifactRequirement,
  content: string,
): { passed: boolean; description: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      passed: false,
      description: `${requirement.path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { passed: false, description: `${requirement.path} must be a JSON object with metric fields` };
  }

  const data = parsed as Record<string, unknown>;
  const missingFields = requirement.required_fields.filter((field) => !(field in data));
  if (missingFields.length > 0) {
    return {
      passed: false,
      description: `${requirement.path} missing required field(s): ${missingFields.join(", ")}`,
    };
  }
  const typeFailures = Object.entries(requirement.field_types ?? {})
    .filter(([field, expected]) => !artifactFieldMatchesType(data[field], expected))
    .map(([field, expected]) => `${field} expected ${expected}`);
  if (typeFailures.length > 0) {
    return {
      passed: false,
      description: `${requirement.path} field type mismatch(es): ${typeFailures.join(", ")}`,
    };
  }
  const typedFields = Object.keys(requirement.field_types ?? {});
  const hasExplicitFieldContract = requirement.required_fields.length > 0 || typedFields.length > 0;
  if (!hasExplicitFieldContract && !Object.values(data).some((value) => typeof value === "number")) {
    return { passed: false, description: `${requirement.path} does not contain any numeric metric fields` };
  }

  return {
    passed: true,
    description: `${requirement.path} metrics JSON contains ${requirement.required_fields.length > 0 ? requirement.required_fields.join(", ") : "required fields"}${typedFields.length > 0 ? ` with typed fields ${typedFields.join(", ")}` : ""}`,
  };
}

function artifactFieldMatchesType(value: unknown, expected: "number" | "string" | "array" | "object" | "boolean"): boolean {
  switch (expected) {
    case "array":
      return Array.isArray(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "boolean":
      return typeof value === expected;
  }
}

function verifySubmissionCsv(
  requirement: TaskArtifactRequirement,
  content: string,
): { passed: boolean; description: string } {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { passed: false, description: `${requirement.path} must contain a header and at least one prediction row` };
  }
  const headerColumns = splitCsvLine(lines[0] ?? "");
  if (headerColumns.length < 2) {
    return { passed: false, description: `${requirement.path} header must contain an id column and prediction column` };
  }
  return { passed: true, description: `${requirement.path} submission CSV has header and prediction rows` };
}

function splitCsvLine(line: string): string[] {
  const columns: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      columns.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  columns.push(current.trim());
  return columns.filter((column) => column.length > 0);
}
