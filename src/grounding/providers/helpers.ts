import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import type { GroundingSection, GroundingSectionKey, GroundingSourceRef } from "../contracts.js";

const SECTION_TITLES: Record<GroundingSectionKey, string> = {
  identity: "Identity",
  execution_policy: "Execution Policy",
  approval_policy: "Approval Policy",
  trust_state: "Trust State",
  repo_instructions: "Repository Instructions",
  goal_state: "Goal State",
  task_state: "Task State",
  progress_history: "Progress History",
  session_history: "Session History",
  soil_knowledge: "Soil Knowledge",
  knowledge_query: "Knowledge Query",
  lessons: "Lessons",
  provider_state: "Provider State",
  plugins: "Plugins",
  workspace_facts: "Workspace Facts",
};

const SECTION_PRIORITIES: Record<GroundingSectionKey, number> = {
  identity: 10,
  execution_policy: 20,
  approval_policy: 30,
  repo_instructions: 40,
  trust_state: 50,
  provider_state: 60,
  plugins: 70,
  goal_state: 80,
  task_state: 90,
  session_history: 100,
  progress_history: 110,
  workspace_facts: 120,
  soil_knowledge: 130,
  knowledge_query: 140,
  lessons: 150,
};

const JsonRecordSchema = z.record(z.string(), z.unknown());
export const GROUNDING_PROVIDER_JSON_MAX_BYTES = 1024 * 1024;
const GROUNDING_PROVIDER_JSON_READ_CHUNK_BYTES = 64 * 1024;

export type JsonRecord = z.infer<typeof JsonRecordSchema>;

export function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

export function makeSection(
  key: GroundingSectionKey,
  content: string,
  sources: GroundingSourceRef[],
  overrides: Partial<Pick<GroundingSection, "title" | "priority">> = {},
): GroundingSection {
  return {
    key,
    title: overrides.title ?? SECTION_TITLES[key],
    priority: overrides.priority ?? SECTION_PRIORITIES[key],
    estimatedTokens: estimateTokens(content),
    content,
    sources,
  };
}

export function makeSource(
  sectionKey: GroundingSectionKey,
  label: string,
  overrides: Partial<GroundingSourceRef> = {},
): GroundingSourceRef {
  return {
    sectionKey,
    type: overrides.type ?? "derived",
    label,
    ...(overrides.path ? { path: overrides.path } : {}),
    ...(overrides.trusted !== undefined ? { trusted: overrides.trusted } : {}),
    ...(overrides.accepted !== undefined ? { accepted: overrides.accepted } : {}),
    ...(overrides.retrievalId ? { retrievalId: overrides.retrievalId } : {}),
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
}

export function sortSections<T extends GroundingSection>(sections: T[]): T[] {
  return [...sections].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}

export function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? getPulseedDirPath();
}

export function resolveStateManagerBaseDir(stateManager?: { getBaseDir?: () => string }): string | undefined {
  return typeof stateManager?.getBaseDir === "function" ? stateManager.getBaseDir() : undefined;
}

export async function readJsonFile(filePath: string): Promise<JsonRecord | null> {
  try {
    const raw = await readTextFileWithinLimit(filePath, GROUNDING_PROVIDER_JSON_MAX_BYTES);
    if (raw === null) {
      return null;
    }
    const parsed = JsonRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readTextFileWithinLimit(filePath: string, maxBytes: number): Promise<string | null> {
  const handle = await fsp.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(GROUNDING_PROVIDER_JSON_READ_CHUNK_BYTES, maxBytes + 1));
    let totalBytes = 0;

    while (true) {
      const remainingBytes = maxBytes + 1 - totalBytes;
      if (remainingBytes <= 0) {
        return null;
      }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, remainingBytes), null);
      if (bytesRead === 0) break;

      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        return null;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks, totalBytes).toString("utf-8");
  } finally {
    await handle.close();
  }
}

export async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function soilRootFromHome(homeDir: string): string {
  return path.join(homeDir, "soil");
}
