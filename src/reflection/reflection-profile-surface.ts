import {
  buildRelationshipProfileSurfaceProjection,
  formatRelationshipProfileSurfaceContext,
  loadRelationshipProfileSurfaceContext,
} from "../grounding/profile-surface.js";
import {
  normalSourceEventRef,
  projectMemorySummarySurface,
  projectionRefFromGroundingSurface,
  type SurfaceProjection,
} from "../runtime/surface-projection-protocol.js";

export async function buildReflectionRelationshipProfileSurfaceContext(params: {
  baseDir: string;
  scopeRef: string;
  purpose: string;
  title: string;
  now?: string;
}): Promise<string> {
  const surface = await buildReflectionRelationshipProfileMemorySurface(params);
  return surface?.memory_summary?.normal_text ?? "";
}

export async function buildReflectionRelationshipProfileMemorySurface(params: {
  baseDir: string;
  scopeRef: string;
  purpose: string;
  title: string;
  now?: string;
}): Promise<SurfaceProjection | null> {
  const now = params.now ?? new Date().toISOString();
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
    now,
  });
  const normalText = formatRelationshipProfileSurfaceContext(projection, {
    title: params.title,
  });
  if (!projection || normalText.length === 0) {
    return null;
  }
  return projectMemorySummarySurface({
    summary: {
      summary_id: `reflection-relationship-profile:${params.scopeRef}`,
      projection_ref: projection.id,
      title: params.title,
      included_count: projection.included_context.length,
      withheld_count: projection.excluded_context.length,
      normal_text: normalText,
      redaction_applied: projection.excluded_context.length > 0,
    },
    purpose: params.purpose,
    projectedAt: now,
    replayKey: `reflection-relationship-profile:${params.scopeRef}:${projection.id}`,
    sourceEventRefs: [
      normalSourceEventRef({
        kind: "relationship_profile_surface",
        ref: projection.id,
        event_type: "memory_profile_summary",
        occurred_at: now,
        replay_key: `reflection-relationship-profile:${params.scopeRef}`,
      }),
    ],
    projectionRefs: [projectionRefFromGroundingSurface(projection)],
  });
}
