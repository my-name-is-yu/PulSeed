import { SqliteSoilRepository } from "../../platform/soil/sqlite-repository.js";
import type { GroundingProvider } from "../contracts.js";
import {
  retrieveGroundingMemory,
  setMemoryGatewayResult,
} from "../memory-gateway.js";
import { makeSection, makeSource, nonEmptyString, soilRootFromHome, resolveHomeDir } from "./helpers.js";

async function recordGroundingUsage(rootDir: string, recordIds: string[]): Promise<void> {
  const ids = [...new Set(recordIds.filter((recordId) => recordId.length > 0))];
  if (ids.length === 0) return;
  const repository = await SqliteSoilRepository.create({ rootDir });
  try {
    await repository.recordUsage(ids);
  } finally {
    repository.close();
  }
}

export const soilKnowledgeProvider: GroundingProvider = {
  key: "soil_knowledge",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    const homeDir = resolveHomeDir(context.request.homeDir ?? context.deps.stateManager?.getBaseDir?.());
    const soilRootDir = soilRootFromHome(homeDir);
    const userVisibleSink = context.request.userVisibleSink ?? context.request.surface === "chat";
    const taskId = nonEmptyString(context.request.taskId);
    const goalId = nonEmptyString(context.request.goalId);
    const result = await retrieveGroundingMemory({
      target: context.request.surface,
      purpose: context.request.purpose,
      user_visible_sink: userVisibleSink,
      scope_ref: taskId ?? goalId ?? nonEmptyString(context.request.query) ?? nonEmptyString(context.request.userMessage) ?? "grounding",
      requested_use: "runtime_grounding",
      query,
      workspace_root: context.request.workspaceRoot ?? process.cwd(),
      home_dir: homeDir,
      soil_root_dir: soilRootDir,
      goal_id: goalId,
      task_id: taskId,
      max_hits: context.profile.budgets.maxKnowledgeHits,
      include_sensitive_relationship_profile: context.request.relationshipProfileRetrieval?.includeSensitive === true,
      soilQuery: context.request.soilQuery,
      knowledgeQuery: context.profile.include.knowledge_query ? context.request.knowledgeQuery : undefined,
      knowledgeContext: context.profile.include.knowledge_query ? context.request.knowledgeContext : undefined,
      relationshipProfileContext: context.request.relationshipProfileContext,
    });
    setMemoryGatewayResult(context.runtime, result);
    const soilEntries = result.selected_entries.filter((entry) => entry.section === "soil_knowledge");
    context.runtime.set("soil_hit_count", soilEntries.length);
    if (result.soil_usage_record_ids.length > 0 && result.soil_root_dir) {
      await recordGroundingUsage(result.soil_root_dir, result.soil_usage_record_ids);
    }
    const consideredSoil = result.sources.some((source) => source.source_kind === "soil");
    if (result.selected_section !== "soil_knowledge" && !consideredSoil && (userVisibleSink || result.warnings.length === 0)) {
      return null;
    }
    const lines = soilEntries.map((entry) => entry.content.text);
    const warnings = result.warnings;
    const content = [
      lines.length > 0 ? lines.join("\n") : "No relevant Soil knowledge found.",
      warnings.length > 0 ? `Warnings: ${warnings.join("; ")}` : "",
    ].filter(Boolean).join("\n");

    return makeSection(
      "soil_knowledge",
      content,
      [
        makeSource("soil_knowledge", "soil_query", {
          type: lines.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? result.retrieval_id : "none:soil_knowledge",
          metadata: { warnings, memoryGateway: result },
        }),
      ],
    );
  },
};
