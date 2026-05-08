import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Logger } from "../../../runtime/logger.js";
import { buildTaskGenerationPrompt } from "./task-prompt-builder.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { TaskSchema } from "../../../base/types/task.js";
import { TaskArtifactContractSchema } from "../../../base/types/task.js";
import type { Task } from "../../../base/types/task.js";
import { TaskGroupSchema } from "../../../base/types/index.js";
import type { TaskGroup } from "../../../base/types/index.js";
import type { TaskPipeline } from "../../../base/types/pipeline.js";
import { wrapXmlTag, formatReflections, formatLessons } from "../../../prompt/formatters.js";
import { loadDreamActivationState } from "../../../platform/dream/dream-activation.js";
import { getFailureReflectionsForGoal, getReflectionsForGoal } from "../reflection-generator.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { IPromptGateway } from "../../../prompt/gateway.js";
import {
  isGeneratedTaskAllowedForExecutionMode,
  type ExecutionModeState,
} from "../../../platform/time/execution-mode.js";
import { isArtifactContractRequired } from "./task-artifact-contract.js";
import {
  extractWorkspacePathConstraint,
  formatWorkspacePathConstraint,
  resolveWorkspacePath,
} from "../../../base/utils/workspace-path.js";
import type { Goal } from "../../goal/types/goal.js";

// ─── Schema for LLM-generated task fields ───

const GeneratedVerificationMethodSchema = z.string()
  .trim()
  .min(1)
  .refine(
    (value) => !/[\r\n]/.test(value) && !value.includes("<<"),
    "verification_method must be a single-line command and must not use heredocs or multiline inline scripts"
  );

const LLMGeneratedCriterionSchema = z.object({
  description: z.string(),
  verification_method: GeneratedVerificationMethodSchema,
  is_blocking: z.boolean().default(true),
});

export const LLMGeneratedTaskSchema = z.object({
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),
  success_criteria: z.array(LLMGeneratedCriterionSchema),
  scope_boundary: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    blast_radius: z.string(),
  }),
  constraints: z.array(z.string()),
  risk_profile: z.object({
    external_action: z.object({
      required: z.boolean().default(true),
      approval_required: z.boolean().default(true),
      action_kind: z.enum(["none", "submission", "publication", "notification", "deployment", "external_mutation", "unknown"]).default("unknown"),
      rationale: z.string().nullable().default(null),
    }).default({}),
  }).default({}),
  artifact_contract: TaskArtifactContractSchema.default({}),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),
  estimated_duration: z
    .object({
      value: z.number(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
    })
    .nullable()
    .default(null),
});
type LLMGeneratedTask = z.infer<typeof LLMGeneratedTaskSchema>;

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

// ─── Deps interface ───

export interface TaskGenerationDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  strategyManager: StrategyManager;
  logger?: Logger;
  knowledgeManager?: KnowledgeManager;
  /** Optional PromptGateway — when provided, LLM calls are routed through it */
  gateway?: IPromptGateway;
  memoryLifecycle?: {
    selectForWorkingMemory(
      goalId: string,
      dims: string[],
      tags: string[],
      max?: number
    ): Promise<{ shortTerm: unknown[]; lessons: Array<{ type?: string; lesson?: string; content?: string; relevance_tags?: string[] }> }>;
  };
}

// ─── evaluateTaskComplexity ───

export function evaluateTaskComplexity(task: Task): "small" | "medium" | "large" {
  const targets = task.target_dimensions ?? [];
  const inScope = uniqueNonEmpty(task.scope_boundary?.in_scope ?? []);
  const requiredArtifacts = uniqueNonEmpty(task.artifact_contract?.required_artifacts.map((artifact) => artifact.path) ?? []);
  const successCriteria = task.success_criteria ?? [];
  const constraints = task.constraints ?? [];
  const duration = task.estimated_duration;

  if (targets.length > 1) return "large";
  if (inScope.length > 1) return "large";
  if (requiredArtifacts.length > 1) return "large";
  if (task.risk_profile?.external_action.required) return "large";
  if (duration && (duration.unit === "days" || duration.unit === "weeks")) return "large";

  if (
    successCriteria.length > 2
    || constraints.length > 2
    || task.artifact_contract?.required === true
    || duration?.unit === "hours"
  ) {
    return "medium";
  }

  return "small";
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

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

async function enforceWorkspaceBoundArtifactTaskContract(input: {
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

// ─── Pipeline builder ───

function buildPipeline(complexity: "small" | "medium" | "large"): TaskPipeline | null {
  if (complexity === "small") return null;
  if (complexity === "medium") {
    return {
      stages: [{ role: "implementor" }, { role: "verifier" }],
      fail_fast: true,
    };
  }
  // large
  return {
    stages: [
      { role: "researcher" },
      { role: "implementor" },
      { role: "verifier" },
      { role: "reviewer" },
    ],
    fail_fast: true,
  };
}

// ─── trigramSimilarity ───

/**
 * Compute Jaccard similarity between character trigram sets of two strings.
 * Returns a value in [0, 1]. Higher means more similar.
 */
export function trigramSimilarity(a: string, b: string): number {
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const norm = s.toLowerCase();
    for (let i = 0; i <= norm.length - 3; i++) {
      set.add(norm.slice(i, i + 3));
    }
    return set;
  };

  const ta = trigrams(a);
  const tb = trigrams(b);

  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }

  const union = ta.size + tb.size - intersection;
  return intersection / union;
}

// ─── Task history entry (minimal shape needed for duplicate check) ───

interface TaskHistoryEntry {
  id?: string;
  task_id?: string;
  work_description?: string;
  status: string;
  verification_verdict?: string | null;
  consecutive_failure_count?: number;
  recovery_reason?: string;
  retry_intent?: string;
}

const DUPLICATE_HISTORY_WINDOW = 30;
const DUPLICATE_STATUS_ALLOWLIST = new Set([
  "completed",
  "failed",
  "error",
  "timed_out",
  "blocked",
  "abandoned",
  "discarded",
]);

function isDuplicateCandidate(entry: TaskHistoryEntry): boolean {
  if (DUPLICATE_STATUS_ALLOWLIST.has(entry.status)) return true;
  if (entry.verification_verdict === "fail" || entry.verification_verdict === "partial") return true;
  return (entry.consecutive_failure_count ?? 0) > 0;
}

function getHistoryTaskId(entry: TaskHistoryEntry): string | undefined {
  return entry.task_id ?? entry.id;
}

async function resolveHistoryWorkDescription(
  stateManager: StateManager,
  goalId: string,
  entry: TaskHistoryEntry
): Promise<string> {
  if (entry.work_description?.trim()) return entry.work_description;

  const taskId = getHistoryTaskId(entry);
  if (!taskId) return "";

  try {
    const raw = await stateManager.readRaw(`tasks/${goalId}/${taskId}.json`);
    if (raw && typeof raw === "object") {
      const description = (raw as { work_description?: unknown }).work_description;
      return typeof description === "string" ? description : "";
    }
  } catch {
    // Non-fatal: old history entries may reference tasks that were pruned.
  }
  return "";
}

// ─── checkDuplicateTask ───

/**
 * Check whether `description` is too similar to a recently finalized or failed task.
 *
 * Reads `tasks/${goalId}/task-history.json`, takes a recent window, and returns
 * the matching entry if trigram similarity >= 0.7. Returns null if no duplicate.
 */
async function checkDuplicateTask(
  stateManager: StateManager,
  goalId: string,
  description: string,
  logger?: Logger
): Promise<TaskHistoryEntry | null> {
  let history: TaskHistoryEntry[] = [];
  try {
    const raw = await stateManager.readRaw(`tasks/${goalId}/task-history.json`);
    if (Array.isArray(raw)) {
      history = raw as TaskHistoryEntry[];
    }
  } catch {
    // no history yet — not an error
    return null;
  }

  const recent = history.slice(-DUPLICATE_HISTORY_WINDOW);
  for (const entry of recent) {
    if (!isDuplicateCandidate(entry)) continue;
    const workDescription = await resolveHistoryWorkDescription(stateManager, goalId, entry);
    if (!workDescription) continue;
    const sim = trigramSimilarity(description, workDescription);
    if (sim >= 0.7) {
      logger?.warn(
        `WARN: duplicate task rejected: similar to recently ${entry.status} task "${getHistoryTaskId(entry) ?? "unknown"}"`
      );
      return entry;
    }
  }
  return null;
}

// ─── generateTask ───

/**
 * Generate a task for the given goal and target dimension via LLM.
 *
 * @param deps - dependencies (stateManager, llmClient, strategyManager, logger)
 * @param goalId - the goal this task belongs to
 * @param targetDimension - the dimension this task should improve
 * @param strategyId - optional override; if not provided, uses active strategy
 * @returns the generated and persisted Task, or null if duplicate detected
 */
export async function generateTask(
  deps: TaskGenerationDeps,
  goalId: string,
  targetDimension: string,
  strategyId?: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string,
  executionMode?: ExecutionModeState,
  repoRoot?: string
): Promise<{ task: Task | null; tokensUsed: number; refusalReason?: string }> {
  const isCodeExecutionContext =
    adapterType === "openai_codex_cli" || adapterType === "claude_code_cli";
  const maxGenerationTokens = isCodeExecutionContext ? 1024 : 1536;
  const modelTier: "light" | "main" = isCodeExecutionContext ? "light" : "main";
  const dreamActivation = await loadDreamActivationState(deps.stateManager.getBaseDir()).catch(() => null);
  const verifiedPlannerHintsOnly = dreamActivation?.flags.verifiedPlannerHintsOnly ?? true;
  // Build optional reflections and lessons XML blocks
  let reflectionsBlock = "";
  let lessonsBlock = "";

  if (deps.knowledgeManager) {
    try {
      const reflections = verifiedPlannerHintsOnly
        ? await getFailureReflectionsForGoal(deps.knowledgeManager, goalId, 5, deps.logger)
        : await getReflectionsForGoal(deps.knowledgeManager, goalId, 5, deps.logger);
      if (reflections.length > 0) {
        reflectionsBlock = wrapXmlTag(
          "past_reflections",
          formatReflections(
            reflections.map((r) => ({
              what_failed: r.why_it_worked_or_failed,
              suggestion: r.what_to_do_differently,
              content: r.what_was_attempted,
            }))
          )
        );
      }
    } catch {
      // non-fatal: proceed without reflections
    }
  }

  if (deps.memoryLifecycle && !verifiedPlannerHintsOnly) {
    try {
      const memory = await deps.memoryLifecycle.selectForWorkingMemory(
        goalId,
        [targetDimension],
        [],
        5
      );
      if (memory.lessons.length > 0) {
        lessonsBlock = wrapXmlTag(
          "lessons_learned",
          formatLessons(
            memory.lessons.map((l) => ({
              importance: l.relevance_tags?.includes("HIGH")
                ? "HIGH"
                : l.relevance_tags?.includes("LOW")
                ? "LOW"
                : l.type === "failure_pattern"
                ? "HIGH"
                : "MEDIUM",
              content: l.lesson ?? l.content ?? "",
            }))
          )
        );
      }
    } catch {
      // non-fatal: proceed without lessons
    }
  }

  const prompt = await buildTaskGenerationPrompt(
    deps.stateManager,
    goalId,
    targetDimension,
    knowledgeContext,
    adapterType,
    existingTasks,
    workspaceContext,
    reflectionsBlock || undefined,
    lessonsBlock || undefined,
    executionMode,
    { ...(repoRoot ? { repoRoot } : {}) },
  );
  deps.logger?.info("Task generation prompt prepared", {
    goalId,
    targetDimension,
    prompt_chars: prompt.length,
    existing_task_count: existingTasks?.length ?? 0,
    workspace_context_chars: workspaceContext?.length ?? 0,
    knowledge_context_chars: knowledgeContext?.length ?? 0,
  });

  let generated: LLMGeneratedTask;
  let generationTokens = 0;
  const llmStartedAt = Date.now();
  if (deps.gateway) {
    try {
      console.log(`  [LLM] Calling LLM for task generation (${targetDimension})...`);
      if (typeof deps.gateway.executeWithUsage === "function") {
        const gatewayResult = await deps.gateway.executeWithUsage({
          purpose: "task_generation",
          goalId,
          dimensionName: targetDimension,
          additionalContext: { task_prompt: prompt },
          responseSchema: LLMGeneratedTaskSchema as z.ZodSchema<LLMGeneratedTask>,
          maxTokens: maxGenerationTokens,
        });
        generated = gatewayResult.data;
        generationTokens = gatewayResult.usage.totalTokens;
      } else {
        generated = await deps.gateway.execute({
          purpose: "task_generation",
          goalId,
          dimensionName: targetDimension,
          additionalContext: { task_prompt: prompt },
          responseSchema: LLMGeneratedTaskSchema as z.ZodSchema<LLMGeneratedTask>,
          maxTokens: maxGenerationTokens,
        });
        generationTokens = 0;
      }
      console.log(`  [LLM] Task generation complete (${targetDimension}).`);
    } catch (err) {
      deps.logger?.error(
        "Task generation failed: PromptGateway.execute() error.",
        { error: String(err) }
      );
      throw err;
    }
  } else {
    console.log(`  [LLM] Calling LLM for task generation (${targetDimension})...`);
    const response = await deps.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task. Respond with a JSON object inside a markdown code block.",
        max_tokens: maxGenerationTokens,
        model_tier: modelTier,
      }
    );
    console.log(`  [LLM] Task generation complete (${targetDimension}).`);
    generationTokens = response.usage ? (response.usage.input_tokens + response.usage.output_tokens) : 0;
    try {
      generated = deps.llmClient.parseJSON(response.content, LLMGeneratedTaskSchema) as LLMGeneratedTask;
    } catch (err) {
      deps.logger?.error(
        "Task generation failed: LLM response did not match expected schema.",
        { rawResponse: response.content.substring(0, 500) }
      );
      throw err;
    }
  }
  deps.logger?.info("Task generation LLM completed", {
    goalId,
    targetDimension,
    duration_ms: Date.now() - llmStartedAt,
    tokens_used: generationTokens,
  });

  const goalForArtifactContract = await deps.stateManager.loadGoal(goalId).catch(() => null);
  const artifactContractRequired = isArtifactContractRequired({
    artifactContract: generated.artifact_contract,
    taskConstraints: generated.constraints,
    goal: goalForArtifactContract,
  });
  generated = await enforceWorkspaceBoundArtifactTaskContract({
    generated,
    goal: goalForArtifactContract,
    repoRoot,
    artifactContractRequired,
    logger: deps.logger,
  });

  if (!isGeneratedTaskAllowedForExecutionMode(generated, executionMode)) {
    deps.logger?.warn("Task generation refused exploratory task in finalization mode", {
      goalId,
      targetDimension,
      executionMode: executionMode?.mode,
      reason: executionMode?.reason,
      workDescription: generated.work_description,
    });
    return {
      task: null,
      tokensUsed: generationTokens,
      refusalReason: "execution_mode_finalization_blocks_exploration",
    };
  }

  // §4.2 Duplicate task guard — reject if too similar to a recent completed/failed task
  const duplicate = await checkDuplicateTask(
    deps.stateManager,
    goalId,
    generated.work_description,
    deps.logger
  );
  if (duplicate !== null) {
    return { task: null, tokensUsed: generationTokens };
  }

  // Resolve strategy_id
  const activeStrategy = await deps.strategyManager.getActiveStrategy(goalId);
  const resolvedStrategyId = strategyId ?? activeStrategy?.id ?? null;

  const taskId = randomUUID();
  const now = new Date().toISOString();
  const artifactContract = artifactContractRequired
    ? { ...generated.artifact_contract, required: true }
    : generated.artifact_contract;

  const task = TaskSchema.parse({
    id: taskId,
    goal_id: goalId,
    strategy_id: resolvedStrategyId,
    target_dimensions: [targetDimension],
    primary_dimension: targetDimension,
    work_description: generated.work_description,
    rationale: generated.rationale,
    approach: generated.approach,
    success_criteria: generated.success_criteria,
    scope_boundary: generated.scope_boundary,
    constraints: generated.constraints,
    risk_profile: generated.risk_profile,
    artifact_contract: artifactContract,
    reversibility: generated.reversibility,
    intended_direction: generated.intended_direction,
    estimated_duration: generated.estimated_duration,
    status: "pending",
    created_at: now,
  });

  // Attach pipeline based on complexity (additive, backward compatible)
  const complexity = evaluateTaskComplexity(task);
  const pipeline = buildPipeline(complexity);
  if (pipeline) {
    (task as Record<string, unknown>).pipeline = pipeline;
  }

  // Persist
  await deps.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

  return { task, tokensUsed: generationTokens };
}

// ─── generateTaskGroup ───

const LLMTaskGroupSchema = z.object({
  subtasks: z.array(
    z.object({
      work_description: z.string(),
      rationale: z.string(),
      approach: z.string(),
      target_dimension: z.string(),
      success_criteria: z.array(LLMGeneratedCriterionSchema),
      scope_boundary: z.object({
        in_scope: z.array(z.string()),
        out_of_scope: z.array(z.string()),
        blast_radius: z.string(),
      }),
      constraints: z.array(z.string()).default([]),
      risk_profile: z.object({
        external_action: z.object({
          required: z.boolean().default(true),
          approval_required: z.boolean().default(true),
          action_kind: z.enum(["none", "submission", "publication", "notification", "deployment", "external_mutation", "unknown"]).default("unknown"),
          rationale: z.string().nullable().default(null),
        }).default({}),
      }).default({}),
      artifact_contract: TaskArtifactContractSchema.default({}),
      reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
    })
  ).min(2),
  dependencies: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .default([]),
  file_ownership: z.record(z.string(), z.array(z.string())).default({}),
  shared_context: z.string().optional(),
});

/**
 * Ask the LLM to decompose a complex task into a TaskGroup of subtasks.
 *
 * @returns TaskGroup on success, null on parse failure
 */
export async function generateTaskGroup(
  llmClient: ILLMClient,
  context: {
    goalDescription: string;
    targetDimension: string;
    currentState: string;
    gap: number;
    availableAdapters: string[];
    contextBlock?: string;
    goalId?: string;
  },
  logger?: Logger,
  gateway?: IPromptGateway
): Promise<TaskGroup | null> {
  const promptParts = [
    `You are a task decomposition assistant. Decompose the following complex task into 2-5 focused subtasks that can be assigned to separate agents.`,
    ``,
    `Goal: ${context.goalDescription}`,
    `Target dimension: ${context.targetDimension}`,
    `Current state: ${context.currentState}`,
    `Gap to close: ${context.gap}`,
    `Available adapters: ${context.availableAdapters.join(", ")}`,
  ];

  if (context.contextBlock) {
    promptParts.push(``, `Relevant context from past experience:`, context.contextBlock);
  }

  promptParts.push(
    ``,
    `Respond with a JSON object inside a markdown code block with this structure:`,
    `{`,
    `  "subtasks": [ { "work_description", "rationale", "approach", "target_dimension", "success_criteria", "scope_boundary", "constraints", "risk_profile", "artifact_contract", "reversibility" }, ... ],`,
    `  "dependencies": [ { "from": "<subtask index>", "to": "<subtask index>" }, ... ],`,
    `  "file_ownership": { "<subtask index>": ["file1", "file2"], ... },`,
    `  "shared_context": "<optional shared context for all subtasks>"`,
    `}`,
    ``,
    `Use subtask array index (as string) for dependency/ownership keys. Ensure at least 2 subtasks.`,
    `Set risk_profile.external_action from each subtask's intended side effects. Use action_kind "none" only when the subtask stays local; use "unknown" with approval_required true when uncertain.`,
    `Always include artifact_contract. Use artifact_contract.required=false and an empty required_artifacts array when generated artifacts are not completion evidence.`,
    `For Kaggle/profile experiment subtasks that claim score or submission progress, set artifact_contract.required=true and include required_artifacts entries for fresh metrics_json and submission_csv outputs. Use required_fields for field presence and field_types for fields that must have a specific JSON type such as {"roc_auc":"number"}.`,
    `Do not make --check-contract reject otherwise valid artifacts only because they predate the --check-contract process. PulSeed enforces fresh_after_task_start relative to the task start time; script validators should regenerate missing or schema-invalid artifacts, then validate the exact schema.`
  );

  const prompt = promptParts.join("\n");

  let raw: z.infer<typeof LLMTaskGroupSchema>;
  if (gateway) {
    try {
      console.log(`  [LLM] Calling LLM for task group decomposition (${context.targetDimension})...`);
      raw = await gateway.execute({
        purpose: "task_generation",
        goalId: context.goalId,
        dimensionName: context.targetDimension,
        additionalContext: { decomposition_prompt: prompt },
        responseSchema: LLMTaskGroupSchema as z.ZodSchema<z.infer<typeof LLMTaskGroupSchema>>,
        maxTokens: 4096,
      });
      console.log(`  [LLM] Task group decomposition complete (${context.targetDimension}).`);
    } catch (err) {
      logger?.error("generateTaskGroup: PromptGateway.execute() failed", { error: String(err) });
      return null;
    }
  } else {
    let response: { content: string };
    try {
      console.log(`  [LLM] Calling LLM for task group decomposition (${context.targetDimension})...`);
      response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system: "You are a task decomposition assistant. Respond with valid JSON only.",
          max_tokens: 4096,
          model_tier: 'main',
        }
      );
      console.log(`  [LLM] Task group decomposition complete (${context.targetDimension}).`);
    } catch (err) {
      logger?.error("generateTaskGroup: LLM call failed", { error: String(err) });
      return null;
    }

    try {
      raw = llmClient.parseJSON(response.content, LLMTaskGroupSchema) as z.infer<typeof LLMTaskGroupSchema>;
    } catch (err) {
      logger?.error("generateTaskGroup: LLM response did not match TaskGroup schema", {
        rawResponse: response.content.substring(0, 500),
      });
      return null;
    }
  }

  const now = new Date().toISOString();

  // Build full Task objects from LLM subtask descriptions
  const subtasks: Task[] = raw.subtasks.map((sub, i) => {
    const taskId = `subtask-${i}-${randomUUID()}`;
    const complexity = sub.work_description.length < 50 ? "small" : "medium";
    const task = TaskSchema.parse({
      id: taskId,
      goal_id: "",
      strategy_id: null,
      target_dimensions: [sub.target_dimension],
      primary_dimension: sub.target_dimension,
      work_description: sub.work_description,
      rationale: sub.rationale,
      approach: sub.approach,
      success_criteria: sub.success_criteria,
      scope_boundary: sub.scope_boundary,
      constraints: sub.constraints,
      risk_profile: sub.risk_profile,
      artifact_contract: sub.artifact_contract,
      reversibility: sub.reversibility,
      estimated_duration: null,
      status: "pending",
      created_at: now,
    });
    const pipeline = buildPipeline(complexity);
    if (pipeline) {
      (task as Record<string, unknown>).pipeline = pipeline;
    }
    return task;
  });

  // Remap file_ownership keys from index strings to task IDs
  const remappedOwnership: Record<string, string[]> = {};
  for (const [key, files] of Object.entries(raw.file_ownership)) {
    const idx = parseInt(key, 10);
    if (!isNaN(idx) && subtasks[idx]) {
      remappedOwnership[subtasks[idx].id] = files;
    } else {
      remappedOwnership[key] = files;
    }
  }

  // Remap dependency keys from index strings to task IDs
  const remappedDeps = raw.dependencies.map((dep) => {
    const fromIdx = parseInt(dep.from, 10);
    const toIdx = parseInt(dep.to, 10);
    return {
      from: !isNaN(fromIdx) && subtasks[fromIdx] ? subtasks[fromIdx].id : dep.from,
      to: !isNaN(toIdx) && subtasks[toIdx] ? subtasks[toIdx].id : dep.to,
    };
  });

  try {
    return TaskGroupSchema.parse({
      subtasks,
      dependencies: remappedDeps,
      file_ownership: remappedOwnership,
      shared_context: raw.shared_context,
    });
  } catch (err) {
    logger?.error("generateTaskGroup: final TaskGroup parse failed", { error: String(err) });
    return null;
  }
}
