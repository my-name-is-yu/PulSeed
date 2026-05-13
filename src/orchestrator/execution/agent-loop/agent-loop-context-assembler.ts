import { resolve } from "node:path";
import type { Task } from "../../../base/types/task.js";
import { createGroundingGateway, type GroundingGateway } from "../../../grounding/gateway.js";
import { discoverAgentInstructionCandidates } from "../../../grounding/providers/agents-provider.js";
import type { GroundingBundle, GroundingSection } from "../../../grounding/contracts.js";
import type { RelationshipProfileRetrievalContext } from "../../../platform/profile/retrieval-context.js";
import { renderPromptSections } from "../../../grounding/renderers/prompt-renderer.js";
import {
  assembleCompanionDecisionFrame,
  type CompanionDecisionEvidenceRef,
  type CompanionDecisionFrame,
  type CompanionDecisionInputRef,
  type CompanionDecisionPolicyRef,
} from "../../../runtime/decision/index.js";

export interface AgentLoopContextBlock {
  id: string;
  source: string;
  content: string;
  priority: number;
}

export interface SoilPrefetchQuery {
  query: string;
  rootDir: string;
  limit: number;
}

export interface SoilPrefetchResult {
  content: string;
  soilIds?: string[];
  retrievalSource?: "index" | "manifest";
  warnings?: string[];
}

export interface TaskAgentLoopAssemblyInput {
  task: Task;
  cwd?: string;
  workspaceContext?: string;
  knowledgeContext?: string;
  relationshipProfileContext?: RelationshipProfileRetrievalContext;
  soilPrefetch?: (query: SoilPrefetchQuery) => Promise<SoilPrefetchResult | null>;
  maxProjectDocChars?: number;
  trustProjectInstructions?: boolean;
}

export interface TaskAgentLoopAssembly {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  contextBlocks: AgentLoopContextBlock[];
  companionDecisionFrame: CompanionDecisionFrame;
}

function formatArtifactContractSection(task: Task): string {
  if (!task.artifact_contract) return "";
  return [
    "Artifact contract:",
    JSON.stringify(task.artifact_contract, null, 2),
    "If this task creates a --check-contract mode or equivalent validator, it must validate the exact required_artifacts, required_fields, and field_types above. The metrics writer must emit those exact keys before status=done.",
    "Do not make --check-contract reject otherwise valid artifacts only because they predate the --check-contract process. PulSeed enforces fresh_after_task_start relative to the task start time.",
  ].join("\n");
}

function formatSuccessCriteria(task: Task): string {
  return task.success_criteria
    .map((criterion) => `- ${criterion.description} (verify: ${criterion.verification_method})`)
    .join("\n");
}

function sectionToBlock(section: GroundingSection): AgentLoopContextBlock {
  const source = section.sources[0]?.path ?? section.sources[0]?.label ?? section.key;
  const id = section.key === "soil_knowledge" ? "soil-prefetch" : section.key;
  return {
    id,
    source,
    content: section.content,
    priority: section.priority,
  };
}

export class AgentLoopContextAssembler {
  constructor(private readonly groundingGateway: GroundingGateway = createGroundingGateway()) {}

  async assembleTask(input: TaskAgentLoopAssemblyInput): Promise<TaskAgentLoopAssembly> {
    const cwd = resolve(input.cwd ?? process.cwd());
    const soilQuery = input.soilPrefetch
      ? async ({ query, rootDir, limit }: { query: string; rootDir: string; limit: number }) => {
          let soil: SoilPrefetchResult | null;
          try {
            soil = await input.soilPrefetch!({ query, rootDir, limit });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
              retrievalSource: "prefetch" as const,
              warnings: [`Soil prefetch failed; continuing without Soil context: ${detail}`],
              hits: [],
            };
          }
          if (!soil?.content.trim()) {
            return null;
          }
          return {
            retrievalSource: (soil.retrievalSource ?? "prefetch") as "prefetch" | "index" | "manifest",
            warnings: soil.warnings ?? [],
            hits: [
              {
                soilId: soil.soilIds?.[0] ?? "soil:prefetch",
                title: "Prefetched Soil context",
                summary: soil.content,
              },
            ],
          };
        }
      : undefined;

    const query = [
      input.task.work_description,
      input.task.approach,
      ...input.task.success_criteria.map((criterion) => criterion.description),
      formatArtifactContractSection(input.task),
      input.workspaceContext ?? "",
      input.knowledgeContext ?? "",
    ].join("\n");

    const bundle = await this.groundingGateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      workspaceRoot: cwd,
      goalId: input.task.goal_id,
      taskId: input.task.id,
      query,
      userMessage: input.task.work_description,
      trustProjectInstructions: input.trustProjectInstructions ?? true,
      workspaceContext: input.workspaceContext,
      knowledgeContext: input.knowledgeContext,
      relationshipProfileContext: input.relationshipProfileContext,
      soilQuery,
      include: {
        session_history: false,
        progress_history: false,
        trust_state: false,
        provider_state: false,
        plugins: false,
      },
    });

    const blocks = bundle.dynamicSections.map(sectionToBlock).sort((a, b) => a.priority - b.priority);
    const companionDecisionFrame = assembleTaskCompanionDecisionFrame(input.task, cwd, bundle);
    const userPrompt = [
      `Task: ${input.task.work_description}`,
      `Approach: ${input.task.approach}`,
      `Success criteria:\n${formatSuccessCriteria(input.task)}`,
      formatArtifactContractSection(input.task),
      "Code search policy: for repository inspection, bugfixes, feature work, and verification failures, prefer code_search -> code_read_context -> code_search_repair before falling back to raw grep/read. Keep initial prompt context small; read concrete ranges through tools.",
      blocks.length > 0
        ? `Context:\n${blocks.map((block) => `[${block.source}]\n${block.content}`).join("\n\n")}`
        : "",
      "Return final output as JSON matching the required schema.",
    ].filter(Boolean).join("\n\n");

    return {
      cwd,
      systemPrompt: renderPromptSections(bundle.staticSections, { preserveOrder: true }),
      userPrompt,
      contextBlocks: blocks,
      companionDecisionFrame,
    };
  }
}

function assembleTaskCompanionDecisionFrame(
  task: Task,
  cwd: string,
  bundle: GroundingBundle,
): CompanionDecisionFrame {
  const assembledAt = taskDateTime(task.started_at ?? task.created_at);
  const taskRef = taskFrameRef(task.id, "unknown-task");
  const goalRef = taskFrameRef(task.goal_id, "unknown-goal");
  const taskFreshness = taskRef === task.id?.trim() ? "current" : "unknown";
  const goalFreshness = goalRef === task.goal_id?.trim() ? "current" : "unknown";
  const groundingBundleRef = `grounding:bundle:${bundle.profile}:${goalRef}:${taskRef}`;
  return assembleCompanionDecisionFrame({
    frameId: `companion-frame:task:${taskRef}`,
    assembledAt,
    source: {
      kind: "task_execution",
      source_ref: `task:${taskRef}`,
      received_at: assembledAt,
      caller_path: "task_agent_loop",
      goal_ref: goalRef,
      task_ref: taskRef,
    },
    trigger: {
      kind: "task",
      ref: taskRef,
      role: "trigger",
      freshness: taskFreshness,
      ...(taskFreshness === "unknown" ? { reason: "Task id was empty in the task record." } : {}),
    },
    inputRefs: [
      {
        kind: "goal",
        ref: goalRef,
        role: "context",
        freshness: goalFreshness,
        ...(goalFreshness === "unknown" ? { reason: "Goal id was empty in the task record." } : {}),
      },
      {
        kind: "grounding_bundle",
        ref: groundingBundleRef,
        role: "context",
        freshness: "current",
      },
      ...taskGroundingInputRefs(bundle),
    ],
    evidenceRefs: taskGroundingEvidenceRefs(bundle),
    policyRefs: taskPolicyRefs(task, taskRef),
    activeTargetRef: {
      kind: "task",
      id: taskRef,
    },
    groundingBundleRef,
  });
}

function taskFrameRef(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function taskDateTime(value: string | null | undefined): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function taskGroundingInputRefs(bundle: GroundingBundle): CompanionDecisionInputRef[] {
  return bundle.dynamicSections.map((section) => ({
    kind: "grounding_section",
    ref: `grounding:section:${bundle.profile}:${section.key}`,
    role: "context",
    freshness: "current",
    reason: section.title || section.key,
  }));
}

function taskGroundingEvidenceRefs(bundle: GroundingBundle): CompanionDecisionEvidenceRef[] {
  return bundle.traces.source.map((source, index) => ({
    evidence_ref: source.retrievalId
      ? `grounding:retrieval:${source.retrievalId}`
      : source.path
        ? `grounding:source:${source.path}`
        : `grounding:source:${source.sectionKey}:${index}`,
    source: "grounding",
    visibility: source.trusted === false || source.accepted === false ? "operator_only" : "audit_only",
    summary: source.label || source.sectionKey,
  }));
}

function taskPolicyRefs(task: Task, taskRef: string): CompanionDecisionPolicyRef[] {
  const externalAction = task.risk_profile?.external_action;
  return [
    {
      kind: "approval_gate",
      ref: `task-approval:${taskRef}`,
      result: externalAction?.approval_required ? "approval_required" : "not_required",
    },
    {
      kind: "safety_boundary",
      ref: `task-reversibility:${taskRef}`,
      result: task.reversibility ?? "unknown",
    },
  ];
}

export async function loadProjectInstructionBlocks(
  cwd: string,
  maxChars: number,
  options: { trustProjectInstructions?: boolean } = {},
): Promise<AgentLoopContextBlock[]> {
  const candidates = await discoverAgentInstructionCandidates(cwd, maxChars, options);
  return candidates
    .filter((candidate) => candidate.accepted)
    .map((candidate) => ({
      id: `project-doc:${candidate.filePath}`,
      source: candidate.filePath,
      content: candidate.content,
      priority: candidate.priority,
    }));
}
