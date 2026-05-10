import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AgentMemoryEntry } from "../../knowledge/types/agent-memory.js";

export async function listFilesRecursive(root: string, include: (filePath: string) => boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(filePath, include));
      continue;
    }
    if (entry.isFile() && include(filePath)) files.push(filePath);
  }
  return files;
}

export function sourceLineRef(baseDir: string, filePath: string, line: number): string {
  return `${path.relative(baseDir, filePath)}#L${line}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isLatentFactEvidenceEntry(entry: Record<string, unknown>): boolean {
  return nonEmptyString(entry["summary"])
    || nonEmptyArray(entry["metrics"])
    || nonEmptyArray(entry["research"])
    || nonEmptyArray(entry["dream_checkpoints"]);
}

export function isLessonEvidenceEntry(entry: Record<string, unknown>): boolean {
  return entry["outcome"] === "improved"
    || entry["outcome"] === "failed"
    || entry["outcome"] === "regressed"
    || isRecord(entry["verification"])
    || nonEmptyArray(entry["dream_checkpoints"])
    || nonEmptyArray(entry["divergent_exploration"]);
}

export function agentMemoryEvidenceRef(entry: AgentMemoryEntry): string {
  return `soil-sqlite://memory/agent#${entry.id}`;
}

export function duplicateAgentMemoryGroups(
  entries: AgentMemoryEntry[]
): Array<{ key: string; entries: AgentMemoryEntry[] }> {
  const byFingerprint = new Map<string, AgentMemoryEntry[]>();
  for (const entry of entries) {
    if (entry.status === "forgotten" || entry.status === "retracted" || entry.status === "quarantined") continue;
    const fingerprint = [
      normalizeMemoryText(entry.key),
      normalizeMemoryText(entry.value),
      entry.memory_type,
    ].join("\u0000");
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), entry]);
  }
  return [...byFingerprint.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, entries: group }));
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}
