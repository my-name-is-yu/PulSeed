import { resolve } from "node:path";
import type { Task } from "../../../base/types/task.js";
import { createGroundingGateway, type GroundingGateway } from "../../../grounding/gateway.js";
import { discoverAgentInstructionCandidates } from "../../../grounding/providers/agents-provider.js";
import type { GroundingSection } from "../../../grounding/contracts.js";
import type { RelationshipProfileRetrievalContext } from "../../../platform/profile/retrieval-context.js";
import { renderPromptSections } from "../../../grounding/renderers/prompt-renderer.js";

export interface AgentLoopContextBlock {
  id: string;
  source: string;
  content: string;
  priority: number;
}

export interface TaskAgentLoopAssemblyInput {
  task: Task;
  cwd?: string;
  workspaceContext?: string;
  knowledgeContext?: string;
  relationshipProfileContext?: RelationshipProfileRetrievalContext;
  maxProjectDocChars?: number;
  trustProjectInstructions?: boolean;
}

export interface TaskAgentLoopAssembly {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  contextBlocks: AgentLoopContextBlock[];
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
  const id = section.key === "soil_knowledge" ? "soil-knowledge" : section.key;
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
      userVisibleSink: false,
      workspaceRoot: cwd,
      goalId: input.task.goal_id,
      taskId: input.task.id,
      query,
      userMessage: input.task.work_description,
      trustProjectInstructions: input.trustProjectInstructions ?? true,
      workspaceContext: input.workspaceContext,
      knowledgeContext: input.knowledgeContext,
      relationshipProfileContext: input.relationshipProfileContext,
      include: {
        session_history: false,
        progress_history: false,
        trust_state: false,
        provider_state: false,
        plugins: false,
      },
    });

    const blocks = bundle.dynamicSections.map(sectionToBlock).sort((a, b) => a.priority - b.priority);
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
    };
  }
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
