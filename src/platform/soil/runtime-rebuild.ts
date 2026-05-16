import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v3";
import { ReportSchema } from "../../base/types/report.js";
import { DecisionRecordSchema } from "../../base/types/knowledge.js";
import { readJsonFileOrNull } from "../../base/utils/json-io.js";
import { ScheduleEntryStore } from "../../runtime/schedule/entry-store.js";
import { KnowledgeMemoryStateStore } from "../knowledge/knowledge-memory-state-store.js";
import { hasSharedKnowledgeTruth } from "../knowledge/memory-truth-adapter.js";
import type { SoilIndexSnapshot } from "./index-store.js";
import { rebuildSoilIndex } from "./index-store.js";
import { readSoilMarkdownFile } from "./io.js";
import { soilPageRelativePathFromAbsolute } from "./paths.js";
import { projectReportToSoil, projectSchedulesToSoil } from "./projections.js";
import { resolveLocalSoilSourcePath } from "./source-paths.js";
import {
  projectAgentMemoryToSoil,
  projectDecisionsToSoil,
  projectDomainKnowledgeToSoil,
  projectIdentityToSoil,
  projectSharedKnowledgeToSoil,
  projectSoilSystemPages,
} from "./content-projections.js";
import type { SoilPageFrontmatter } from "./types.js";

export interface SoilRuntimeRebuildInput {
  baseDir: string;
  rootDir?: string;
  clock?: () => Date;
}

export interface SoilRuntimeRebuildReport {
  baseDir: string;
  rootDir: string;
  projected: {
    reports: number;
    schedules: number;
    domainKnowledge: number;
    sharedKnowledge: number;
    agentMemory: number;
    decisions: number;
    identity: number;
    system: number;
  };
  skipped: Array<{ scope: string; reason: string }>;
  pruned: Array<{ soilId: string; relativePath: string; archivedPath: string; reason: string }>;
  index: SoilIndexSnapshot;
}

const RUNTIME_PROJECTION_RENDERERS = new Set([
  "reporting-engine",
  "schedule-engine",
  "knowledge-manager",
  "memory-store",
  "knowledge-decisions",
]);

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readJsonWithSchema<TSchema extends z.ZodTypeAny>(
  filePath: string,
  schema: TSchema
): Promise<z.infer<TSchema> | null> {
  const raw = await readJsonFileOrNull(filePath);
  if (raw === null) {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function localSourcePathsForPage(frontmatter: SoilPageFrontmatter, pagePath: string): string[] {
  const sourcePaths = new Set<string>();

  for (const sourceRef of frontmatter.source_refs ?? []) {
    if (sourceRef.source_path) {
      sourcePaths.add(sourceRef.source_path);
    }
  }

  if (frontmatter.generation_watermark?.source_path) {
    sourcePaths.add(frontmatter.generation_watermark.source_path);
  }
  for (const sourcePath of frontmatter.generation_watermark?.source_paths ?? []) {
    sourcePaths.add(sourcePath);
  }

  return [...sourcePaths]
    .map((sourcePath) => resolveLocalSoilSourcePath(pagePath, sourcePath))
    .filter((sourcePath): sourcePath is string => sourcePath !== null);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fsp.access(filePath).then(
    () => true,
    () => false
  );
}

function shouldPruneRuntimeProjection(frontmatter: SoilPageFrontmatter, sourcePaths: string[]): boolean {
  if (frontmatter.source_truth !== "runtime_json") {
    return false;
  }
  if (frontmatter.source !== "compiled") {
    return false;
  }
  if (!frontmatter.rendered_from || !RUNTIME_PROJECTION_RENDERERS.has(frontmatter.rendered_from)) {
    return false;
  }
  return sourcePaths.length > 0;
}

async function pruneDeletedRuntimeProjections(input: {
  rootDir: string;
  clock?: () => Date;
}): Promise<Array<{ soilId: string; relativePath: string; archivedPath: string; reason: string }>> {
  const pruned: Array<{ soilId: string; relativePath: string; archivedPath: string; reason: string }> = [];
  const archivedAt = (input.clock?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  for (const filePath of await listMarkdownFiles(input.rootDir)) {
    const page = await readSoilMarkdownFile(filePath).catch(() => null);
    if (page === null) {
      continue;
    }
    const sourcePaths = localSourcePathsForPage(page.frontmatter, filePath);
    if (!shouldPruneRuntimeProjection(page.frontmatter, sourcePaths)) {
      continue;
    }
    const sourceExists = await Promise.all(sourcePaths.map((sourcePath) => pathExists(sourcePath)));
    if (sourceExists.some(Boolean)) {
      continue;
    }

    const relativePath = soilPageRelativePathFromAbsolute(input.rootDir, filePath);
    const archivedPath = path.join(input.rootDir, ".stale", "pruned", relativePath.replace(/\.md$/, `.${archivedAt}.md`));
    await fsp.mkdir(path.dirname(archivedPath), { recursive: true });
    await fsp.rename(filePath, archivedPath);
    pruned.push({
      soilId: page.frontmatter.soil_id,
      relativePath,
      archivedPath,
      reason: "runtime source path is missing",
    });
  }
  return pruned;
}

export async function rebuildSoilFromRuntime(input: SoilRuntimeRebuildInput): Promise<SoilRuntimeRebuildReport> {
  const rootDir = input.rootDir ?? path.join(input.baseDir, "soil");
  const projected: SoilRuntimeRebuildReport["projected"] = {
    reports: 0,
    schedules: 0,
    domainKnowledge: 0,
    sharedKnowledge: 0,
    agentMemory: 0,
    decisions: 0,
    identity: 0,
    system: 0,
  };
  const skipped: SoilRuntimeRebuildReport["skipped"] = [];

  const projectionBase = { baseDir: input.baseDir, rootDir, clock: input.clock };

  for (const filePath of await listJsonFiles(path.join(input.baseDir, "reports"))) {
    const report = await readJsonWithSchema(filePath, ReportSchema);
    if (report === null) {
      skipped.push({ scope: path.relative(input.baseDir, filePath), reason: "invalid report JSON" });
      continue;
    }
    await projectReportToSoil({ ...projectionBase, report });
    projected.reports += 1;
  }

  const schedules = await new ScheduleEntryStore(input.baseDir, { warn: () => {} }).readEntries();
  if (schedules.length > 0) {
    await projectSchedulesToSoil({ ...projectionBase, entries: schedules });
    projected.schedules = schedules.length;
  }

  const knowledgeMemoryStore = new KnowledgeMemoryStateStore(input.baseDir);
  for (const goalId of await knowledgeMemoryStore.listDomainKnowledgeGoalIds()) {
    const domainKnowledge = await knowledgeMemoryStore.loadDomainKnowledge(goalId);
    await projectDomainKnowledgeToSoil({ ...projectionBase, goalId, domainKnowledge });
    projected.domainKnowledge += 1;
  }

  const shared = await knowledgeMemoryStore.loadSharedKnowledgeEntries();
  if (shared.length > 0 || await hasSharedKnowledgeTruth(input.baseDir)) {
    await projectSharedKnowledgeToSoil({ ...projectionBase, entries: shared });
    projected.sharedKnowledge = shared.length;
  }

  const agentMemory = await knowledgeMemoryStore.loadAgentMemoryStore();
  if (
    agentMemory.entries.length > 0
    || agentMemory.corrections.length > 0
    || agentMemory.last_consolidated_at !== null
  ) {
    await projectAgentMemoryToSoil({ ...projectionBase, store: agentMemory });
    projected.agentMemory = agentMemory.entries.length;
  }

  const decisionRecords = [];
  for (const filePath of await listJsonFiles(path.join(input.baseDir, "decisions"))) {
    const decision = await readJsonWithSchema(filePath, DecisionRecordSchema);
    if (decision === null) {
      skipped.push({ scope: path.relative(input.baseDir, filePath), reason: "invalid decision JSON" });
      continue;
    }
    decisionRecords.push(decision);
  }
  await projectDecisionsToSoil({ ...projectionBase, records: decisionRecords });
  projected.decisions = decisionRecords.length;

  await projectIdentityToSoil(projectionBase);
  projected.identity = 3;
  projected.system = await projectSoilSystemPages(projectionBase);

  const pruned = await pruneDeletedRuntimeProjections({ rootDir, clock: input.clock });
  const index = await rebuildSoilIndex({ rootDir }, { clock: input.clock });
  return {
    baseDir: input.baseDir,
    rootDir,
    projected,
    skipped,
    pruned,
    index,
  };
}
