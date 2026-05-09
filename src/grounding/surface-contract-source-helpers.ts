import type { RefinementCtx } from "zod";
import {
  GovernedMemoryForbiddenUseClassSchema,
  type GovernedMemoryBlockedUseClass,
  type GovernedMemoryLifecycle,
  type GovernedMemoryRole,
} from "../platform/profile/governed-memory.js";

type SurfaceLane = "knowledge" | "work_memory" | "relationship" | "boundary" | "promise" | "tension" | "anti_memory" | "exclusion";

type SurfaceMemorySourceRefLike = {
  memory_id: string;
  owning_store_ref: unknown;
};

type RelationshipPermissionSourceRefLike = {
  memory_id: string;
  owning_store_ref: unknown;
};

type SurfaceContextWithSource = {
  source_ref: SurfaceMemorySourceRefLike;
};

type SurfaceProjectionRationaleEntryLike = {
  source_ref: SurfaceMemorySourceRefLike;
  decision: "included" | "excluded";
  reason_ref: string;
};

type SurfaceProjectionLike = {
  id: string;
  rationale_entries: SurfaceProjectionRationaleEntryLike[];
};

export function surfaceMemorySourceMatches(left: SurfaceMemorySourceRefLike, right: SurfaceMemorySourceRefLike): boolean {
  return left.memory_id === right.memory_id
    && JSON.stringify(left.owning_store_ref) === JSON.stringify(right.owning_store_ref);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function uniqueBlockedUseClasses(
  values: GovernedMemoryBlockedUseClass[]
): GovernedMemoryBlockedUseClass[] {
  return [...new Set(values)];
}

export function surfaceSourceRefKey(source: SurfaceMemorySourceRefLike): string {
  return JSON.stringify(source);
}

export function isSurfaceProjectableLifecycle(lifecycle: GovernedMemoryLifecycle): boolean {
  return lifecycle === "active" || lifecycle === "matured";
}

export function expectedLaneForRole(role: GovernedMemoryRole): SurfaceLane {
  return role === "seed" ? "knowledge" : role;
}

export function isForbiddenRequestedUse(use: unknown): boolean {
  return GovernedMemoryForbiddenUseClassSchema.safeParse(use).success;
}

export function relationshipPermissionSourceMatches(
  permissionSource: RelationshipPermissionSourceRefLike,
  memorySource: SurfaceMemorySourceRefLike,
): boolean {
  return permissionSource.memory_id === memorySource.memory_id
    && JSON.stringify(permissionSource.owning_store_ref) === JSON.stringify(memorySource.owning_store_ref);
}

export function validateContextSourcesSelected(
  contexts: readonly SurfaceContextWithSource[],
  selectedSourceKeys: Set<string>,
  path: "included_context" | "excluded_context",
  ctx: RefinementCtx,
): void {
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    if (context && !selectedSourceKeys.has(surfaceSourceRefKey(context.source_ref))) {
      ctx.addIssue({
        code: "custom",
        path: [path, index, "source_ref"],
        message: `${path} source_ref must be selected in source_refs`,
      });
    }
  }
}

export function validateRationaleSourcesSelected(
  entries: readonly SurfaceProjectionRationaleEntryLike[],
  selectedSourceKeys: Set<string>,
  ctx: RefinementCtx,
): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry && !selectedSourceKeys.has(surfaceSourceRefKey(entry.source_ref))) {
      ctx.addIssue({
        code: "custom",
        path: ["rationale_entries", index, "source_ref"],
        message: "rationale entry source_ref must be selected in source_refs",
      });
    }
  }
}

export function rationaleRefForSource(
  projection: SurfaceProjectionLike,
  source: SurfaceMemorySourceRefLike,
  decision: "included" | "excluded",
): string {
  return projection.rationale_entries.find((entry) =>
    entry.decision === decision && surfaceSourceRefKey(entry.source_ref) === surfaceSourceRefKey(source)
  )?.reason_ref ?? `surface:${projection.id}:rationale:${source.memory_id}:${decision}`;
}

export function hasRationaleForSource(
  projection: SurfaceProjectionLike,
  source: SurfaceMemorySourceRefLike,
  decision: "included" | "excluded",
): boolean {
  return projection.rationale_entries.some((entry) =>
    entry.decision === decision && surfaceSourceRefKey(entry.source_ref) === surfaceSourceRefKey(source)
  );
}
