import { randomUUID } from "node:crypto";
import type { KnowledgeEntry } from "../knowledge/types/knowledge.js";
import { KnowledgeEntrySchema } from "../knowledge/types/knowledge.js";
import type { LearnedPattern } from "../knowledge/types/learning.js";
import type { StrategyTemplate } from "../../orchestrator/strategy/types/cross-portfolio.js";
import type { Strategy } from "../../orchestrator/strategy/types/strategy.js";
import { loadDreamConfig } from "./dream-config.js";
import { LearningRuntimeStateStore } from "../../runtime/store/learning-runtime-state-store.js";
import { StrategyTemplateStateStore } from "../../orchestrator/strategy/strategy-template-state-store.js";
import {
  DreamDecisionHeuristicSchema,
  DreamStrategySelectorSchema,
  type DreamDecisionHeuristic,
  type DreamStrategySelector,
} from "./dream-decision-heuristics.js";
import { loadDreamWorkflowRecords, type DreamWorkflowRecord } from "./dream-event-workflows.js";
import { loadDreamPlaybooks, type DreamPlaybookRecord } from "./playbook-memory.js";
import { DreamDecisionHeuristicStore } from "../../runtime/store/dream-decision-heuristic-store.js";
export { formatPlaybookHints, selectPlaybookHints } from "./playbook-memory.js";
export {
  DreamDecisionHeuristicSchema,
  DreamStrategySelectorSchema,
  type DreamDecisionHeuristic,
  type DreamStrategySelector,
} from "./dream-decision-heuristics.js";

export interface DreamActivationRuntimeState {
  flags: Awaited<ReturnType<typeof loadDreamConfig>>["activation"];
}

function scoreTextOverlap(query: string, candidate: string): number {
  const queryTokens = new Set(
    query.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 3)
  );
  const candidateTokens = new Set(
    candidate.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 3)
  );
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return hits / Math.max(queryTokens.size, candidateTokens.size);
}

export async function loadDreamActivationState(baseDir: string): Promise<DreamActivationRuntimeState> {
  const config = await loadDreamConfig(baseDir);
  return { flags: config.activation };
}

export async function loadStrategyTemplates(baseDir: string): Promise<StrategyTemplate[]> {
  try {
    return await new StrategyTemplateStateStore(baseDir).list();
  } catch {
    return [];
  }
}

export async function loadDecisionHeuristics(baseDir: string): Promise<DreamDecisionHeuristic[]> {
  return new DreamDecisionHeuristicStore({ controlBaseDir: baseDir }).loadDecisionHeuristics();
}

export async function loadLearnedPatterns(baseDir: string, goalId?: string): Promise<LearnedPattern[]> {
  const store = new LearningRuntimeStateStore(baseDir);
  try {
    return goalId ? await store.loadPatterns(goalId) : await store.loadAllPatterns();
  } catch {
    return [];
  }
}

export function selectPatternHints(
  patterns: LearnedPattern[],
  query: string,
  limit = 3
): LearnedPattern[] {
  return [...patterns]
    .map((pattern) => ({
      pattern,
      score:
        pattern.confidence * 0.7 +
        Math.min(pattern.evidence_count, 5) * 0.03 +
        scoreTextOverlap(query, `${pattern.description} ${pattern.applicable_domains.join(" ")}`) * 0.5,
    }))
    .filter(({ score }) => score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pattern }) => pattern);
}

export function formatPatternHints(patterns: LearnedPattern[]): string {
  if (patterns.length === 0) return "";
  return [
    "Learned pattern hints:",
    ...patterns.map(
      (pattern, index) =>
        `${index + 1}. [${pattern.type}] ${pattern.description} (confidence ${pattern.confidence.toFixed(2)})`
    ),
  ].join("\n");
}

export async function loadDreamWorkflows(baseDir: string): Promise<DreamWorkflowRecord[]> {
  return loadDreamWorkflowRecords(baseDir);
}

export async function loadDreamPlaybookRecords(baseDir: string): Promise<DreamPlaybookRecord[]> {
  return loadDreamPlaybooks(baseDir);
}

export function selectWorkflowHints(
  workflows: DreamWorkflowRecord[],
  query: string,
  context: {
    goalId?: string;
    targetDimension?: string;
  } = {},
  limit = 2
): DreamWorkflowRecord[] {
  return [...workflows]
    .map((workflow) => {
      const goalMatch = context.goalId && workflow.applicability.goal_ids.includes(context.goalId) ? 0.35 : 0;
      const dimensionText = context.targetDimension ?? "";
      const score =
        workflow.confidence * 0.55 +
        Math.min(workflow.evidence_count, 5) * 0.04 +
        Math.min(workflow.success_count, 3) * 0.04 +
        goalMatch +
        scoreTextOverlap(
          `${query} ${dimensionText}`,
          [
            workflow.title,
            workflow.description,
            workflow.type,
            workflow.applicability.signals.join(" "),
            workflow.failure_modes.join(" "),
            workflow.recovery_steps.join(" "),
          ].join(" ")
        ) * 0.45;
      return { workflow, score };
    })
    .filter(({ score }) => score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ workflow }) => workflow);
}

export function formatWorkflowHints(workflows: DreamWorkflowRecord[]): string {
  if (workflows.length === 0) return "";
  return [
    "Workflow recovery hints:",
    ...workflows.map((workflow, index) => {
      const steps = workflow.steps.slice(0, 3).join(" -> ");
      const recovery = workflow.recovery_steps.slice(0, 2).join(" -> ");
      const evidence = `${workflow.evidence_count} evidence`;
      return `${index + 1}. [${workflow.type}] ${workflow.title} (confidence ${workflow.confidence.toFixed(2)}, ${evidence})${steps ? ` Steps: ${steps}.` : ""}${recovery ? ` Recovery: ${recovery}.` : ""}`;
    }),
  ].join("\n");
}

export function selectTemplateCandidates(
  templates: StrategyTemplate[],
  query: string,
  targetDimensions: string[],
  limit = 1
): StrategyTemplate[] {
  return selectTemplateCandidatesWithTrace(templates, query, targetDimensions, limit).map(({ template }) => template);
}

export interface DreamTemplateCandidateTrace {
  template: StrategyTemplate;
  trace: NonNullable<Strategy["planner_hint_trace"]>;
}

export function selectTemplateCandidatesWithTrace(
  templates: StrategyTemplate[],
  _query: string,
  targetDimensions: string[],
  limit = 1
): DreamTemplateCandidateTrace[] {
  const dimensionSet = new Set(targetDimensions.map((dimension) => dimension.toLowerCase()));
  return [...templates]
    .map((template) => {
      const dimensionOverlap = template.applicable_dimensions.filter((dimension) =>
        dimensionSet.has(dimension.toLowerCase())
      );
      const hasTypedApplicability = dimensionOverlap.length > 0;
      if (!hasTypedApplicability) {
        return null;
      }
      const score =
        template.effectiveness_score * 0.6 +
        Math.min(dimensionOverlap.length, 2) * 0.2;
      return {
        template,
        score,
        trace: {
          source: "dream_template_typed_applicability",
          source_id: template.template_id,
          confidence: Math.min(1, score),
          lexical_overlap_used: false,
          matched_dimensions: dimensionOverlap,
          evidence_refs: [template.source_strategy_id],
        } satisfies NonNullable<Strategy["planner_hint_trace"]>,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ template, trace }) => ({ template, trace }));
}

export function materializeTemplateCandidate(
  template: StrategyTemplate,
  goalId: string,
  primaryDimension: string,
  targetDimensions: string[],
  plannerHintTrace?: Strategy["planner_hint_trace"]
): Strategy {
  const now = new Date().toISOString();
  return {
    id: `dream-template-${template.template_id}-${randomUUID()}`,
    goal_id: goalId,
    primary_dimension: primaryDimension,
    target_dimensions: targetDimensions.length > 0 ? targetDimensions : template.applicable_dimensions,
    hypothesis: template.hypothesis_pattern,
    expected_effect: (targetDimensions.length > 0 ? targetDimensions : template.applicable_dimensions).map((dimension) => ({
      dimension,
      direction: "increase" as const,
      magnitude: "medium" as const,
    })),
    resource_estimate: {
      sessions: 1,
      duration: { value: 1, unit: "hours" as const },
      llm_calls: null,
    },
    state: "candidate",
    allocation: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: null,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    source_template_id: template.template_id,
    cross_goal_context: `Dream template from ${template.source_goal_id}`,
    rollback_target_id: null,
    max_pivot_count: 2,
    pivot_count: 0,
    toolset_locked: false,
    allowed_tools: [],
    required_tools: [],
    ...(plannerHintTrace ? { planner_hint_trace: plannerHintTrace } : {}),
  };
}

export function applyDecisionHeuristicsToCandidates(
  candidates: Strategy[],
  heuristics: DreamDecisionHeuristic[],
  context: {
    stallCount: number;
    activeStrategyId?: string | null;
  }
): Strategy[] {
  if (heuristics.length === 0 || candidates.length <= 1) return candidates;

  const scored = candidates.map((candidate, index) => {
    let score = 0;
    for (const heuristic of heuristics) {
      if (
        heuristic.if_stall_count_gte !== undefined &&
        context.stallCount < heuristic.if_stall_count_gte
      ) {
        continue;
      }
      if (heuristic.strategy_id && heuristic.strategy_id !== context.activeStrategyId) {
        continue;
      }
      if (heuristic.candidate_selector && !matchesStrategySelector(candidate, heuristic.candidate_selector)) {
        continue;
      }
      if (heuristic.prefer_candidate_selector && matchesStrategySelector(candidate, heuristic.prefer_candidate_selector)) {
        score += Math.abs(heuristic.score_delta || 0.15);
        continue;
      }
      if (heuristic.avoid_candidate_selector && matchesStrategySelector(candidate, heuristic.avoid_candidate_selector)) {
        score -= Math.abs(heuristic.score_delta || 0.15);
        continue;
      }
      if (heuristic.candidate_selector) {
        score += heuristic.score_delta;
      }
    }
    return { candidate, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ candidate }) => candidate);
}

function matchesStrategySelector(candidate: Strategy, selector: DreamStrategySelector): boolean {
  if (selector.strategy_id && selector.strategy_id !== candidate.id) return false;
  if (selector.source_template_id && selector.source_template_id !== candidate.source_template_id) return false;
  if (selector.strategy_family && selector.strategy_family !== candidate.exploration?.strategy_family) return false;
  if (selector.exploration_role && selector.exploration_role !== candidate.exploration?.role) return false;
  if (selector.smoke_status && selector.smoke_status !== candidate.exploration?.smoke.status) return false;
  if (selector.metric_trend && selector.metric_trend !== candidate.exploration?.lineage_assessment?.metric_trend) {
    return false;
  }
  if (
    selector.failed_lineage_fingerprint &&
    !candidate.exploration?.lineage_assessment?.matched_failed_lineage_fingerprints.includes(selector.failed_lineage_fingerprint)
  ) {
    return false;
  }
  return true;
}

export function mergeUniqueKnowledgeEntries(
  primary: KnowledgeEntry[],
  secondary: KnowledgeEntry[],
  limit?: number
): KnowledgeEntry[] {
  const merged: KnowledgeEntry[] = [];
  const seen = new Set<string>();

  for (const entry of [...primary, ...secondary]) {
    if (seen.has(entry.entry_id)) continue;
    seen.add(entry.entry_id);
    merged.push(KnowledgeEntrySchema.parse(entry));
    if (limit !== undefined && merged.length >= limit) break;
  }

  return merged;
}
