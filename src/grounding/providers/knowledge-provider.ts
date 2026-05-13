import {
  loadRelationshipProfileRetrievalContext,
  summarizeRelationshipProfileRetrievalContext,
} from "../../platform/profile/retrieval-context.js";
import {
  contextFromRelationshipProfileSurfaceProjection,
  formatRelationshipProfileSurfaceContext,
  buildRelationshipProfileSurfaceProjection,
  relationshipProfileSurfaceInspectionMetadata,
} from "../profile-surface.js";
import type {
  GroundingKnowledgeResult,
  GroundingProvider,
} from "../contracts.js";
import { makeSection, makeSource, resolveHomeDir, resolveStateManagerBaseDir } from "./helpers.js";

async function buildRelationshipProfileRetrievalContext(
  context: Parameters<GroundingProvider["build"]>[0]
): ReturnType<typeof loadRelationshipProfileRetrievalContext> {
  const baseDir = resolveHomeDir(context.request.homeDir ?? resolveStateManagerBaseDir(context.deps.stateManager));
  return loadRelationshipProfileRetrievalContext({
    baseDir,
    includeSensitive: context.request.relationshipProfileRetrieval?.includeSensitive,
  });
}

export const knowledgeQueryProvider: GroundingProvider = {
  key: "knowledge_query",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!query?.trim()) {
      return null;
    }
    const userVisibleSink = context.request.userVisibleSink ?? context.request.surface === "chat";
    const soilHitCount = Number(context.runtime.get("soil_hit_count") ?? 0);
    if (soilHitCount > 0 && !context.request.knowledgeContext?.trim()) {
      return null;
    }
    if (userVisibleSink) {
      context.runtime.set("knowledge_hit_count", 0);
      return null;
    }

    let result: GroundingKnowledgeResult | null = null;
    const rawRelationshipProfileContext = context.request.relationshipProfileContext
      ?? await buildRelationshipProfileRetrievalContext(context);
    const relationshipProfileSurface = buildRelationshipProfileSurfaceProjection({
      context: rawRelationshipProfileContext,
      target: context.request.surface,
      scopeRef: context.request.taskId ?? context.request.goalId ?? context.request.query ?? context.request.userMessage ?? "grounding",
      purpose: context.request.purpose,
      now: new Date().toISOString(),
    });
    const relationshipProfileContext = contextFromRelationshipProfileSurfaceProjection(
      rawRelationshipProfileContext,
      relationshipProfileSurface,
    );
    const relationshipProfileBlock = formatRelationshipProfileSurfaceContext(relationshipProfileSurface);
    if (context.request.knowledgeContext?.trim()) {
      result = {
        retrievalId: "knowledge:prefetched",
        warnings: relationshipProfileContext.items.length > 0
          ? [`relationship_profile_context_items:${relationshipProfileContext.items.length}`]
          : undefined,
        items: [
          {
            id: "knowledge:prefetched",
            content: context.request.knowledgeContext.trim(),
            source: "request.knowledgeContext",
          },
        ],
      };
    } else if (context.request.knowledgeQuery) {
      result = await context.request.knowledgeQuery({
        query,
        goalId: context.request.goalId,
        limit: context.profile.budgets.maxKnowledgeHits,
        relationshipProfileContext,
        relationshipProfilePromptContext: relationshipProfileBlock,
      });
    }

    const items = result?.items ?? [];
    context.runtime.set("knowledge_hit_count", items.length);
    const relationshipProfileMetadata = summarizeRelationshipProfileRetrievalContext(relationshipProfileContext);
    const relationshipProfileSurfaceMetadata = relationshipProfileSurfaceInspectionMetadata(
      relationshipProfileSurface,
      context.request.surface,
    );
    return makeSection(
      "knowledge_query",
      items.length > 0
        ? [
          relationshipProfileBlock,
          items.slice(0, context.profile.budgets.maxKnowledgeHits).map((item) => `- ${item.content}`).join("\n"),
        ].filter((part) => part.trim().length > 0).join("\n\n")
        : "No broader knowledge results.",
      [
        makeSource("knowledge_query", "knowledge query", {
          type: items.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: items.length > 0 ? result?.retrievalId ?? "knowledge:query" : "none:knowledge_query",
          metadata: {
            ...(result?.warnings ? { warnings: result.warnings } : {}),
            relationshipProfileContext: relationshipProfileMetadata,
            ...(relationshipProfileSurfaceMetadata ? { relationshipProfileSurface: relationshipProfileSurfaceMetadata } : {}),
          },
        }),
      ],
    );
  },
};
