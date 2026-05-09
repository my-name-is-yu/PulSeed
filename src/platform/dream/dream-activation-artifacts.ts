import { StrategyDreamStateStore } from "../../runtime/store/strategy-dream-state-store.js";
import {
  DreamActivationArtifactSchema,
  type DreamActivationArtifact,
} from "./dream-types.js";

export async function loadDreamActivationArtifacts(baseDir: string): Promise<DreamActivationArtifact[]> {
  return new StrategyDreamStateStore(baseDir).loadActivationArtifacts();
}

export async function replaceDreamActivationArtifacts(
  baseDir: string,
  artifacts: DreamActivationArtifact[],
  generatedAt: string = new Date().toISOString()
): Promise<void> {
  const unique = new Map<string, DreamActivationArtifact>();
  for (const artifact of artifacts) {
    unique.set(artifact.artifact_id, DreamActivationArtifactSchema.parse(artifact));
  }
  await new StrategyDreamStateStore(baseDir).replaceActivationArtifacts(
    [...unique.values()].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
    generatedAt,
  );
}

export async function upsertDreamActivationArtifacts(
  baseDir: string,
  artifacts: DreamActivationArtifact[],
  generatedAt: string = new Date().toISOString()
): Promise<DreamActivationArtifact[]> {
  const existing = await loadDreamActivationArtifacts(baseDir);
  const byId = new Map(existing.map((artifact) => [artifact.artifact_id, artifact]));
  for (const artifact of artifacts) {
    byId.set(artifact.artifact_id, DreamActivationArtifactSchema.parse(artifact));
  }
  const next = [...byId.values()].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  await replaceDreamActivationArtifacts(baseDir, next, generatedAt);
  return next;
}
