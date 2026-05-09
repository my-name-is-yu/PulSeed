import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { AgentMemoryEntrySchema, type AgentMemoryEntry } from "../../knowledge/types/agent-memory.js";
import {
  agentMemoryEvidenceRef,
  duplicateAgentMemoryGroups,
  isLatentFactEvidenceEntry,
  isLessonEvidenceEntry,
  listFilesRecursive,
  sourceLineRef,
} from "../dream-consolidator/evidence-helpers.js";

describe("dream consolidator evidence helpers", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("lists matching files recursively and returns an empty list for missing roots", async () => {
    tmpDir = makeTempDir("dream-evidence-helpers-");
    await fs.mkdir(path.join(tmpDir, "runtime", "nested"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "runtime", "nested", "evidence.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "runtime", "nested", "ignored.txt"), "x", "utf8");

    expect(await listFilesRecursive(path.join(tmpDir, "runtime"), (filePath) => filePath.endsWith(".jsonl"))).toEqual([
      path.join(tmpDir, "runtime", "nested", "evidence.jsonl"),
    ]);
    expect(await listFilesRecursive(path.join(tmpDir, "missing"), () => true)).toEqual([]);
  });

  it("classifies runtime evidence entries without parsing caller context", () => {
    expect(isLatentFactEvidenceEntry({ summary: "operator prefers concise reports" })).toBe(true);
    expect(isLatentFactEvidenceEntry({ metrics: [] })).toBe(false);
    expect(isLessonEvidenceEntry({ outcome: "improved" })).toBe(true);
    expect(isLessonEvidenceEntry({ verification: { status: "passed" } })).toBe(true);
    expect(isLessonEvidenceEntry({ outcome: "unchanged" })).toBe(false);
  });

  it("groups duplicate agent memories by normalized key, value, and type", () => {
    const entries = [
      memoryEntry({ id: "memory-1", key: " Status ", value: " Use brief replies ", memory_type: "preference" }),
      memoryEntry({ id: "memory-2", key: "status", value: "use brief replies", memory_type: "preference" }),
      memoryEntry({ id: "memory-3", key: "status", value: "use brief replies", memory_type: "fact" }),
      memoryEntry({ id: "memory-4", key: "status", value: "use brief replies", memory_type: "preference", status: "forgotten" }),
    ];

    const groups = duplicateAgentMemoryGroups(entries);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(["memory-1", "memory-2"]);
    expect(agentMemoryEvidenceRef(entries[0]!)).toBe("memory/agent-memory/entries.json#memory-1");
  });

  it("formats source line refs relative to the Dream base dir", () => {
    expect(sourceLineRef("/tmp/pulseed", "/tmp/pulseed/runtime/evidence.jsonl", 7)).toBe("runtime/evidence.jsonl#L7");
  });
});

function memoryEntry(input: Partial<AgentMemoryEntry> & Pick<AgentMemoryEntry, "id" | "key" | "value">): AgentMemoryEntry {
  return AgentMemoryEntrySchema.parse({
    memory_type: "fact",
    status: "raw",
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
    ...input,
  });
}
