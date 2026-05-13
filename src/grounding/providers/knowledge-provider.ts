import {
  getMemoryGatewayResult,
  retrieveGroundingMemory,
  setMemoryGatewayResult,
} from "../memory-gateway.js";
import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource, nonEmptyString, resolveHomeDir, resolveStateManagerBaseDir, soilRootFromHome } from "./helpers.js";

async function resolveGatewayResult(context: Parameters<GroundingProvider["build"]>[0]) {
  const cached = getMemoryGatewayResult(context.runtime);
  if (cached) return cached;
  const query = context.request.query ?? context.request.userMessage;
  const homeDir = resolveHomeDir(context.request.homeDir ?? resolveStateManagerBaseDir(context.deps.stateManager));
  const taskId = nonEmptyString(context.request.taskId);
  const goalId = nonEmptyString(context.request.goalId);
  const result = await retrieveGroundingMemory({
    target: context.request.surface,
    purpose: context.request.purpose,
    user_visible_sink: context.request.userVisibleSink ?? context.request.surface === "chat",
    scope_ref: taskId ?? goalId ?? nonEmptyString(context.request.query) ?? nonEmptyString(context.request.userMessage) ?? "grounding",
    requested_use: "runtime_grounding",
    query,
    workspace_root: context.request.workspaceRoot ?? process.cwd(),
    home_dir: homeDir,
    soil_root_dir: soilRootFromHome(homeDir),
    goal_id: goalId,
    task_id: taskId,
    max_hits: context.profile.budgets.maxKnowledgeHits,
    include_sensitive_relationship_profile: context.request.relationshipProfileRetrieval?.includeSensitive === true,
    soilQuery: context.profile.include.soil_knowledge ? context.request.soilQuery : async () => null,
    knowledgeQuery: context.profile.include.knowledge_query ? context.request.knowledgeQuery : undefined,
    knowledgeContext: context.profile.include.knowledge_query ? context.request.knowledgeContext : undefined,
    relationshipProfileContext: context.request.relationshipProfileContext,
  });
  setMemoryGatewayResult(context.runtime, result);
  return result;
}

export const knowledgeQueryProvider: GroundingProvider = {
  key: "knowledge_query",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!query?.trim()) {
      return null;
    }

    const result = await resolveGatewayResult(context);
    const items = result.selected_entries.filter((entry) => entry.section === "knowledge_query");
    if (items.length === 0) {
      return null;
    }
    context.runtime.set("knowledge_hit_count", items.length);
    const body = items.map((entry) => entry.content.text).join("\n");
    const content = [
      result.relationship_profile_prompt_context,
      body || "No broader knowledge results.",
    ].filter((part) => part.trim().length > 0).join("\n\n");

    return makeSection(
      "knowledge_query",
      content,
      [
        makeSource("knowledge_query", "knowledge query", {
          type: items.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: items.length > 0 ? result.retrieval_id : "none:knowledge_query",
          metadata: {
            memoryGateway: result,
            relationshipProfileContext: result.relationship_profile_metadata,
            ...(result.relationship_profile_surface_metadata
              ? { relationshipProfileSurface: result.relationship_profile_surface_metadata }
              : {}),
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          },
        }),
      ],
    );
  },
};
