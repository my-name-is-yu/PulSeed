import * as _path from "node:path";
import { access, readFile } from "node:fs/promises";
import type { StateManager } from "../../../base/state/state-manager.js";
import {
  formatExecutionModePromptSection,
  type ExecutionModeState,
} from "../../../platform/time/execution-mode.js";
import {
  extractWorkspacePathConstraint,
  resolveWorkspacePath,
} from "../../../base/utils/workspace-path.js";
import type { Goal } from "../../goal/types/goal.js";

interface RepositoryPromptContext {
  projectName: string;
  projectDescription: string;
}

const MAX_KNOWLEDGE_CONTEXT_CHARS = 4_000;
const MAX_WORKSPACE_CONTEXT_CHARS = 6_000;
const MAX_EXISTING_TASKS_CHARS = 2_000;
const MAX_FAILURE_CONTEXT_CHARS = 2_000;
const RECENT_FAILURE_HISTORY_LIMIT = 6;

const repositoryContextCache = new Map<string, Promise<RepositoryPromptContext>>();
const referencedIssueContextCache = new Map<string, Promise<string>>();

interface PromptTaskHistoryEntry {
  id?: string;
  task_id?: string;
  work_description?: string;
  status?: string;
  verification_verdict?: string | null;
  verification_evidence?: string[];
  consecutive_failure_count?: number;
  recovery_reason?: string;
  retry_intent?: string;
}

function clampSection(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n...[${label} truncated to ${maxChars} chars]`;
}

async function getRepositoryPromptContext(repoRoot: string): Promise<RepositoryPromptContext> {
  const cached = repositoryContextCache.get(repoRoot);
  if (cached) {
    return cached;
  }

  const contextPromise = (async () => {
    // Read package.json once per repo root; prompt text should stay stable across daemon cycles.
    const pkgPath = _path.join(repoRoot, "package.json");
    const exists = await access(pkgPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      return { projectName: "", projectDescription: "" };
    }

    try {
      const content = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as {
        name?: string;
        description?: string;
      };

      return {
        projectName: pkg.name ?? "",
        projectDescription: pkg.description ?? "",
      };
    } catch {
      // silently ignore — repo context is best-effort
      return { projectName: "", projectDescription: "" };
    }
  })();

  repositoryContextCache.set(repoRoot, contextPromise);
  return contextPromise;
}

async function getReferencedIssueContext(repoRoot: string, issueLookupText: string): Promise<string> {
  const cacheKey = `${repoRoot}\u0000${issueLookupText}`;
  const cached = referencedIssueContextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const issueContextPromise = (async () => {
    if (!issueLookupText) {
      return "";
    }

    try {
      const { fetchIssueContext } = await import("../context/issue-context-fetcher.js");
      return await fetchIssueContext(issueLookupText, { cwd: repoRoot });
    } catch {
      // issue-context-fetcher not available
      return "";
    }
  })();

  referencedIssueContextCache.set(cacheKey, issueContextPromise);
  return issueContextPromise;
}

function getTaskHistoryEntryId(entry: PromptTaskHistoryEntry): string | undefined {
  return entry.task_id ?? entry.id;
}

function isRecentFailureEntry(entry: PromptTaskHistoryEntry): boolean {
  if (entry.verification_verdict === "fail" || entry.verification_verdict === "partial") return true;
  if ((entry.consecutive_failure_count ?? 0) > 0) return true;
  return ["failed", "error", "timed_out", "blocked", "abandoned", "discarded"].includes(entry.status ?? "");
}

function buildGoalConstraintsSection(goal: Goal | null): string {
  const constraints = goal?.constraints ?? [];
  if (constraints.length === 0) return "";

  return `\n=== Goal Constraints ===\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}\n`;
}

function buildWorkspaceBoundarySection(goal: Goal | null, repoRoot: string): string {
  const workspacePathConstraint = extractWorkspacePathConstraint(goal?.constraints);
  if (!workspacePathConstraint) return "";

  const workspacePath = resolveWorkspacePath(workspacePathConstraint, repoRoot);
  return `\n=== Workspace Boundary ===
- Active writable workspace: ${workspacePath}
- Generated file edits and artifact writes must stay inside this workspace unless the goal explicitly names another local path.
- Preserve the workspace_path constraint in the generated task constraints.
- Workspace artifact/evidence creation is a valid implementation output for artifact/evidence goals; do not convert a workspace artifact task into a PulSeed runtime source-code change merely because the executing adapter is a code agent.
- For artifact-only workspace tasks, use artifact-local checks such as file existence, exact content/schema checks, or a contract check that exists in the workspace. Do not add broad repository test/build commands unless the task edits repository source or the active workspace contains the relevant package manifest.
- Only use a --check-contract verification command when that script is already present in the active workspace or the generated task explicitly creates it.
`;
}

async function resolveTaskHistoryDescription(
  stateManager: StateManager,
  goalId: string,
  entry: PromptTaskHistoryEntry
): Promise<string> {
  if (entry.work_description?.trim()) return entry.work_description;

  const taskId = getTaskHistoryEntryId(entry);
  if (!taskId) return "";

  try {
    const raw = await stateManager.readRaw(`tasks/${goalId}/${taskId}.json`);
    if (raw && typeof raw === "object") {
      const description = (raw as { work_description?: unknown }).work_description;
      return typeof description === "string" ? description : "";
    }
  } catch {
    // Non-fatal: old task history entries may point at pruned task files.
  }

  return "";
}

async function buildRecentFailureHistorySection(
  stateManager: StateManager,
  goalId: string
): Promise<string> {
  let history: PromptTaskHistoryEntry[] = [];
  try {
    const raw = await stateManager.readRaw(`tasks/${goalId}/task-history.json`);
    if (Array.isArray(raw)) {
      history = raw as PromptTaskHistoryEntry[];
    }
  } catch {
    return "";
  }

  const recentFailures = history.filter(isRecentFailureEntry).slice(-RECENT_FAILURE_HISTORY_LIMIT);
  if (recentFailures.length === 0) return "";

  const lines: string[] = [];
  for (const entry of recentFailures) {
    const description = await resolveTaskHistoryDescription(stateManager, goalId, entry);
    if (!description) continue;
    const verdict = entry.verification_verdict ? `, verdict=${entry.verification_verdict}` : "";
    const evidence = entry.verification_evidence?.length
      ? ` — evidence: ${entry.verification_evidence.slice(0, 2).join("; ")}`
      : "";
    const recoveryReason = entry.recovery_reason ? ` — recovery: ${entry.recovery_reason}` : "";
    const retryIntent = entry.retry_intent ? ` — retry intent: ${entry.retry_intent}` : "";
    lines.push(`- [${entry.status ?? "unknown"}${verdict}] ${description}${evidence}${recoveryReason}${retryIntent}`);
  }

  if (lines.length === 0) return "";

  return clampSection(
    `\n=== Recent Failed/Discarded Task Attempts (avoid repeating) ===\n${lines.join("\n")}\nDo not generate another task that repeats the same edit/test direction unless the new task directly addresses the listed failure reason.\n`,
    MAX_FAILURE_CONTEXT_CHARS,
    "recent failure history"
  );
}

/**
 * Build the LLM prompt used to generate a task for the given goal and target dimension.
 *
 * Extracted from TaskLifecycle to keep prompt construction logic separate from
 * orchestration logic.
 */
export async function buildTaskGenerationPrompt(
  stateManager: StateManager,
  goalId: string,
  targetDimension: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string,
  reflections?: string,
  lessons?: string,
  executionMode?: ExecutionModeState,
  options?: {
    repoRoot?: string;
  },
): Promise<string> {
  // Load goal context to enrich the prompt
  const goal = await stateManager.loadGoal(goalId);

  // Load parent goal chain (max 3 levels)
  const parentChain: Array<{ title: string; description: string }> = [];
  let current = goal;
  for (let i = 0; i < 3 && current?.parent_id; i++) {
    const parent = await stateManager.loadGoal(current.parent_id);
    if (!parent) break;
    parentChain.push({ title: parent.title, description: parent.description });
    current = parent;
  }

  const dim = goal?.dimensions.find((d) => d.name === targetDimension);

  // Build goal context section
  let goalSection: string;
  if (goal) {
    const titleLine = `Goal: ${goal.title}`;
    const descLine = goal.description ? `Description: ${goal.description}` : "";
    goalSection = [titleLine, descLine].filter(Boolean).join("\n");
  } else {
    goalSection = `Goal ID: ${goalId}`;
  }

  // Build dimension context section
  let dimensionSection: string;
  if (dim) {
    const currentVal = dim.current_value !== null && dim.current_value !== undefined
      ? String(dim.current_value)
      : "unknown";
    const threshold = dim.threshold;
    let targetDesc: string;
    if (threshold.type === "min") {
      targetDesc = `at least ${threshold.value}`;
    } else if (threshold.type === "max") {
      targetDesc = `at most ${threshold.value}`;
    } else if (threshold.type === "range") {
      targetDesc = `between ${threshold.low} and ${threshold.high}`;
    } else if (threshold.type === "present") {
      targetDesc = "present (non-null)";
    } else {
      targetDesc = `equal to ${(threshold as { value: unknown }).value}`;
    }
    const gapDesc = (() => {
      if (threshold.type === "min") {
        const val = typeof dim.current_value === "number" ? dim.current_value : null;
        if (val !== null) return `${(threshold.value as number) - val} below minimum`;
        return "current value unknown";
      } else if (threshold.type === "max") {
        const val = typeof dim.current_value === "number" ? dim.current_value : null;
        if (val !== null) return `${val - (threshold.value as number)} above maximum`;
        return "current value unknown";
      } else if (threshold.type === "present") {
        return dim.current_value == null ? "value is absent (needs to be set)" : "value is present";
      }
      return "gap exists";
    })();
    dimensionSection = `Dimension to improve: "${targetDimension}" (label: ${dim.label})

Gap Analysis:
- Current value: ${currentVal}
- Target threshold: ${targetDesc}
- Gap: ${gapDesc}`;
  } else {
    dimensionSection = `Dimension to improve: "${targetDimension}"`;
  }

  // Build adapter context section
  let adapterSection = "";
  if (adapterType === "github_issue") {
    adapterSection = `\nExecution context: GitHub issue creation.
- work_description: issue title (line 1) + issue body
- Generate specific, actionable issues only\n`;
  } else if (adapterType === "openai_codex_cli" || adapterType === "claude_code_cli") {
    adapterSection = `\nExecution context: CLI code agent.
You MUST produce implementation tasks that modify or create files inside the active workspace.
The executing agent's filesystem and network boundary depends on the configured terminal backend.
Tasks should involve writing code, fixing bugs, adding tests, editing configuration, or creating/updating workspace artifacts that are the goal evidence — NOT analysis or planning.
For operational KPI dimensions such as reliability, recovery, latency, uptime, or daemon stability, do not generate a test-only/regression-only task unless the goal explicitly asks for tests; prefer the smallest runtime/config/code change that directly moves the KPI, with tests only as supporting validation. If a workspace boundary and artifact contract make local artifacts the KPI evidence, artifact creation is the direct implementation output.
Constraints:
- No git commit/push/merge operations
- Success criteria must be directly verifiable. For workspace artifact/evidence tasks, file/content/schema/contract checks can be primary evidence. For runtime/code behavior changes, include at least one relevant test/build command such as "npx vitest run <test-file>" or "npm run build".
- verification_method: use one single-line, directly runnable check command such as "rg ...", "grep ...", "test -f ...", "npm ...", "npx ...", "python src/experiments/run.py --check-contract", or ".venv/bin/python src/experiments/run.py --check-contract"; do not use heredocs, multiline inline scripts, or prose like "Use rg ..."\n`;
  } else if (adapterType) {
    adapterSection = `\nExecution context: ${adapterType} adapter.\n`;
  }

  const knowledgeSection = knowledgeContext
    ? `\nRelevant domain knowledge:\n${clampSection(knowledgeContext, MAX_KNOWLEDGE_CONTEXT_CHARS, "knowledge context")}\n`
    : "";

  const repoRoot = options?.repoRoot ?? process.cwd();
  const goalConstraintsSection = buildGoalConstraintsSection(goal);
  const workspaceBoundarySection = buildWorkspaceBoundarySection(goal, repoRoot);
  const issueLookupText = [goal?.title, goal?.description, ...parentChain.map((p) => `${p.title} ${p.description}`)]
    .filter(Boolean)
    .join(" ");
  const [repositoryContext, issueSection] = await Promise.all([
    getRepositoryPromptContext(repoRoot),
    getReferencedIssueContext(repoRoot, issueLookupText),
  ]);

  const repoContextParts: string[] = [];
  if (repositoryContext.projectName) repoContextParts.push(`Project name: ${repositoryContext.projectName}`);
  if (repositoryContext.projectDescription) repoContextParts.push(`Project description: ${repositoryContext.projectDescription}`);
  const repoSection = repoContextParts.length > 0
    ? `\nRepository context:\n${repoContextParts.join("\n")}\n`
    : "";

  const existingTasksSection = existingTasks && existingTasks.length > 0
    ? `\n=== Previously Generated Tasks (avoid duplication) ===\n${clampSection(existingTasks.join("\n"), MAX_EXISTING_TASKS_CHARS, "existing tasks")}\nGenerate a task that addresses a DIFFERENT aspect of the goal than the existing tasks above.\n`
    : "";

  const workspaceSection = workspaceContext
    ? `\n=== Current Workspace State ===\n${clampSection(workspaceContext, MAX_WORKSPACE_CONTEXT_CHARS, "workspace context")}\n`
    : "\n=== Current Workspace State ===\nNo workspace context available.\n";

  // §4.7 Inject last failure context if available
  let failureContextSection = "";
  try {
    const failureCtx = await stateManager.readRaw(`tasks/${goalId}/last-failure-context.json`) as {
      prev_task_description?: string;
      verdict?: string;
      reasoning?: string;
      criteria_met?: number;
      criteria_total?: number;
    } | null;
    if (failureCtx && failureCtx.prev_task_description) {
      failureContextSection = clampSection(
        `\n前回のタスク「${failureCtx.prev_task_description}」は以下の理由で${failureCtx.verdict ?? "failed"}と判定された:\n${failureCtx.reasoning ?? ""}\n達成基準: ${failureCtx.criteria_met ?? 0}/${failureCtx.criteria_total ?? 0}\nこの失敗を踏まえて、異なるアプローチのタスクを生成すること。\n`,
        MAX_FAILURE_CONTEXT_CHARS,
        "failure context"
      );
    }
  } catch {
    // no failure context — skip injection
  }

  const recentFailureHistorySection = await buildRecentFailureHistorySection(stateManager, goalId);

  // Parent Goal Context section
  const parentSection = parentChain.length > 0
    ? `## Parent Goal Context\n${parentChain.map((p, i) => `${"  ".repeat(i)}Goal: ${p.title}\n${"  ".repeat(i)}Description: ${p.description}`).join("\n")}`
    : "";

  // Task Purpose section
  const purposeSection = goal
    ? `## Task Purpose\nThis task addresses dimension "${targetDimension}" of subgoal "${goal.title}"${parentChain.length > 0 ? `, which is part of the parent goal "${parentChain[0].title}"` : ""}.`
    : "";

  const reflectionsSection = reflections ? `\n${reflections}\n` : "";
  const lessonsSection = lessons ? `\n${lessons}\n` : "";
  const executionModeSection = formatExecutionModePromptSection(executionMode);

  return `${goalSection}
${dimensionSection}${goalConstraintsSection}${workspaceBoundarySection}${executionModeSection}
${parentSection ? `${parentSection}\n` : ""}${issueSection ? `${issueSection}\n` : ""}${purposeSection ? `${purposeSection}\n` : ""}${repoSection}${adapterSection}${knowledgeSection}${workspaceSection}${existingTasksSection}${failureContextSection}${recentFailureHistorySection}${reflectionsSection}${lessonsSection}
Requirements:
- Specific to actual project (goal, description, repo context)
- No generic improvements unless in goal description
- One concrete, actionable task for "${targetDimension}" dimension
- Single measurable output in one session
- work_description: target file path(s), specific changes (not "improve X" → "add section Y to file Z")
- No vague review/triage tasks
- Prefer minimal-change approach: make the smallest targeted change that moves the metric; avoid unrelated refactoring
- Set risk_profile.external_action from the task's intended side effects, not from keywords. Mark approval_required true whenever the task requires submitting, publishing, notifying, deploying, uploading, sending, or mutating an external system outside the local workspace.
- Always include artifact_contract. Use artifact_contract.required=false and an empty required_artifacts array when generated artifacts are not completion evidence.
- For Kaggle/profile experiment tasks that claim score or submission progress, set artifact_contract.required=true and include fresh metrics_json and submission_csv outputs. Source-file or marker checks are only supporting evidence for those tasks; the artifact contract is the completion evidence.
- In artifact_contract metrics_json entries, use required_fields for field presence and field_types for fields that must have a concrete JSON type such as {"roc_auc":"number"}.
- For generated experiment scripts with a --check-contract mode, the script's metrics writer and --check-contract validator must emit and validate the exact artifact_contract.required_fields and field_types. Do not invent alias fields in artifact_contract unless the script is required to write those exact keys.
- Do not make --check-contract reject otherwise valid artifacts only because they predate the --check-contract process. PulSeed enforces fresh_after_task_start relative to the task start time; script validators should regenerate missing or schema-invalid artifacts, then validate the exact schema.
- verification_method must be a single line. Do not generate heredocs, here-strings, or multiline inline Python/Node/Ruby/Perl checks.

Return JSON only (inside markdown code block):
{
  "work_description": "what to do (include file paths and specific changes)",
  "rationale": "why this matters",
  "approach": "how to accomplish it",
  "success_criteria": [
    {"description": "what success looks like", "verification_method": "how to verify", "is_blocking": true}
  ],
  "scope_boundary": {"in_scope": ["included"], "out_of_scope": ["excluded"], "blast_radius": "what could be affected"},
  "constraints": ["any constraints"],
	  "risk_profile": {
	    "external_action": {
	      "required": false,
      "approval_required": false,
      "action_kind": "none|submission|publication|notification|deployment|external_mutation|unknown",
	      "rationale": "why this is or is not an external action" | null
	    }
	  },
	  "artifact_contract": {
	    "required": false,
	    "required_artifacts": [
	      {"kind": "metrics_json", "path": "reports/<run>.json", "required_fields": ["<metric_name>", "<metadata_field>"], "field_types": {"<metric_name>": "number"}, "fresh_after_task_start": true},
	      {"kind": "submission_csv", "path": "submissions/<run>.csv", "required_fields": [], "field_types": {}, "fresh_after_task_start": true}
	    ]
	  },
	  "reversibility": "reversible|irreversible|unknown",
  "intended_direction": "increase|decrease|neutral — direction this task intends to move the primary dimension",
  "estimated_duration": {"value": number, "unit": "minutes|hours|days|weeks"} | null
}`;
}
