import {
  buildRelationshipProfileSurfaceProjection,
  formatRelationshipProfileSurfaceContext,
  loadRelationshipProfileSurfaceContext,
} from "../grounding/profile-surface.js";

export async function buildReflectionRelationshipProfileSurfaceContext(params: {
  baseDir: string;
  scopeRef: string;
  purpose: string;
  title: string;
  now?: string;
}): Promise<string> {
  const context = await loadRelationshipProfileSurfaceContext({
    baseDir: params.baseDir,
    scope: "local_planning",
    includeSensitive: false,
  });
  const projection = buildRelationshipProfileSurfaceProjection({
    context,
    target: "daemon",
    scopeRef: params.scopeRef,
    purpose: params.purpose,
    requestedUse: "goal_planning",
    now: params.now ?? new Date().toISOString(),
  });
  return formatRelationshipProfileSurfaceContext(projection, {
    title: params.title,
  });
}
