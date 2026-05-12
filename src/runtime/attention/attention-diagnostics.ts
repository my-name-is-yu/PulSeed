import { z } from "zod";
import type {
  AgendaDecomposition,
  AttentionCluster,
  AttentionScope,
} from "../types/companion-autonomy.js";

export const AttentionDiagnosticViewSchema = z.enum([
  "operator_safe",
  "same_user_detail",
  "debug_refs",
]);
export type AttentionDiagnosticView = z.infer<typeof AttentionDiagnosticViewSchema>;

export const AttentionConcernDiagnosticSchema = z.object({
  cluster_id: z.string().min(1),
  lifecycle: z.string().min(1),
  safe_label: z.string().min(1),
  member_count: z.number().int().nonnegative(),
  agenda_count: z.number().int().nonnegative(),
  child_count: z.number().int().nonnegative(),
  why_silent: z.array(z.string().min(1)).default([]),
  suppressed_by: z.string().nullable().default(null),
  sensitive: z.boolean(),
  refs: z.array(z.string().min(1)).default([]),
}).strict();
export type AttentionConcernDiagnostic = z.infer<typeof AttentionConcernDiagnosticSchema>;

export const AttentionDiagnosticsSchema = z.object({
  schema_version: z.literal("attention-diagnostics-v1"),
  generated_at: z.string().datetime(),
  view: AttentionDiagnosticViewSchema,
  concern_count: z.number().int().nonnegative(),
  concerns: z.array(AttentionConcernDiagnosticSchema),
}).strict();
export type AttentionDiagnostics = z.infer<typeof AttentionDiagnosticsSchema>;

export function createAttentionDiagnostics(input: {
  clusters: readonly AttentionCluster[];
  decompositions: readonly AgendaDecomposition[];
  viewerScope: AttentionScope;
  view: AttentionDiagnosticView;
  generatedAt: string;
}): AttentionDiagnostics {
  const visibleClusters = input.clusters.filter((cluster) =>
    sameDiagnosticScope(cluster.scope, input.viewerScope)
  );
  const decompositionsByCluster = new Map<string, AgendaDecomposition[]>();
  for (const decomposition of input.decompositions) {
    if (!sameDiagnosticScope(decomposition.scope, input.viewerScope)) continue;
    const list = decompositionsByCluster.get(decomposition.clusterRef.id) ?? [];
    list.push(decomposition);
    decompositionsByCluster.set(decomposition.clusterRef.id, list);
  }

  const concerns = visibleClusters.map((cluster) => {
    const decompositions = decompositionsByCluster.get(cluster.id) ?? [];
    const highSensitivity = cluster.scope.sensitivity === "high";
    const canShowDetail = input.view === "debug_refs"
      || (input.view === "same_user_detail" && input.viewerScope.userId === cluster.scope.userId);
    const showRefs = canShowDetail && !highSensitivity;
    const label = highSensitivity && input.view === "operator_safe"
      ? "High-sensitivity attention concern"
      : cluster.theme.label;

    return AttentionConcernDiagnosticSchema.parse({
      cluster_id: cluster.id,
      lifecycle: cluster.lifecycle,
      safe_label: label,
      member_count: cluster.memberUrgeRefs.length,
      agenda_count: decompositions.length,
      child_count: decompositions.reduce((total, decomposition) => total + decomposition.children.length, 0),
      why_silent: whySilent(cluster, decompositions),
      suppressed_by: cluster.suppression?.reason ?? null,
      sensitive: highSensitivity,
      refs: showRefs
        ? [
            ...cluster.memberUrgeRefs.map((ref) => `${ref.kind}:${ref.id}`),
            ...cluster.signalRefs.map((ref) => `${ref.ref.kind}:${ref.ref.id}`),
          ]
        : [],
    });
  });

  return AttentionDiagnosticsSchema.parse({
    schema_version: "attention-diagnostics-v1",
    generated_at: input.generatedAt,
    view: input.view,
    concern_count: concerns.length,
    concerns,
  });
}

function whySilent(cluster: AttentionCluster, decompositions: readonly AgendaDecomposition[]): string[] {
  const reasons = new Set<string>();
  if (cluster.lifecycle === "needs_regrounding") reasons.add("cluster needs regrounding");
  if (cluster.lifecycle === "split_pending") reasons.add("cluster has unresolved split/conflict");
  if (cluster.lifecycle === "suppressed") reasons.add("cluster is suppressed");
  for (const decomposition of decompositions) {
    if (decomposition.status === "needs_regrounding") reasons.add("decomposition needs regrounding");
    if (decomposition.status === "suppressed") reasons.add("decomposition is suppressed");
    for (const child of decomposition.children) {
      if (child.admissionState === "needs_approval") reasons.add("child needs approval");
      if (child.admissionState === "rejected") reasons.add("child admission was rejected");
      if (child.stalenessSnapshot.state !== "fresh") reasons.add("child staleness blocks admission");
    }
  }
  if (reasons.size === 0) reasons.add("no outward-capable child has been admitted");
  return [...reasons];
}

function sameDiagnosticScope(left: AttentionScope, right: AttentionScope): boolean {
  return left.userId === right.userId
    && (left.workspaceId ?? null) === (right.workspaceId ?? null)
    && left.surfaceClass === right.surfaceClass;
}
