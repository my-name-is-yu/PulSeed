import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

export interface WALIntent {
  op: string;
  data: unknown;
  ts: string;
}

export interface WALCommit {
  op: "commit";
  ref_ts: string;
  ts: string;
}

export interface WALCompactionStart {
  op: "compaction_start";
  ts: string;
}

export interface WALCompactionComplete {
  op: "compaction_complete";
  ref_ts: string;
  ts: string;
}

type WALRecord = WALIntent | WALCommit | WALCompactionStart | WALCompactionComplete;

const WALTimestampSchema = z.string().min(1);
const WALControlOps = new Set(["commit", "compaction_start", "compaction_complete"]);
const WALIntentSchema = z.object({
  op: z.string().min(1).refine((op) => !WALControlOps.has(op)),
  data: z.unknown().optional(),
  ts: WALTimestampSchema,
}).superRefine((record, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(record, "data")) {
    ctx.addIssue({
      code: "custom",
      message: "WAL intent data is required",
      path: ["data"],
    });
  }
});
const WALCommitSchema = z.object({
  op: z.literal("commit"),
  ref_ts: WALTimestampSchema,
  ts: WALTimestampSchema,
});
const WALCompactionStartSchema = z.object({
  op: z.literal("compaction_start"),
  ts: WALTimestampSchema,
});
const WALCompactionCompleteSchema = z.object({
  op: z.literal("compaction_complete"),
  ref_ts: WALTimestampSchema,
  ts: WALTimestampSchema,
});
const WALRecordSchema = z.union([
  WALCommitSchema,
  WALCompactionStartSchema,
  WALCompactionCompleteSchema,
  WALIntentSchema,
]);

function walPath(goalId: string, baseDir: string): string {
  return path.join(baseDir, "goals", goalId, "wal.jsonl");
}

function parseWALLine(line: string): WALRecord | null {
  try {
    const parsed = WALRecordSchema.safeParse(JSON.parse(line) as unknown);
    return parsed.success ? parsed.data as WALRecord : null;
  } catch {
    return null;
  }
}

export async function appendWALRecord(
  goalId: string,
  baseDir: string,
  record: WALRecord
): Promise<void> {
  const filePath = walPath(goalId, baseDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}

export async function readWAL(
  goalId: string,
  baseDir: string
): Promise<WALRecord[]> {
  const filePath = walPath(goalId, baseDir);
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const record = parseWALLine(line);
      return record ? [record] : [];
    });
}

export async function replayWAL(
  goalId: string,
  baseDir: string,
  applyFn: (intent: WALIntent) => Promise<void>
): Promise<number> {
  const records = await readWAL(goalId, baseDir);
  const committed = new Set<string>();
  for (const r of records) {
    if (r.op === "commit") committed.add((r as WALCommit).ref_ts);
  }
  let count = 0;
  for (const r of records) {
    if (r.op !== "commit" && r.op !== "compaction_start" && r.op !== "compaction_complete") {
      const intent = r as WALIntent;
      if (!committed.has(intent.ts)) {
        await applyFn(intent);
        await appendWALRecord(goalId, baseDir, {
          op: "commit",
          ref_ts: intent.ts,
          ts: new Date().toISOString(),
        });
        count++;
      }
    }
  }
  return count;
}

export async function compactWAL(
  goalId: string,
  baseDir: string
): Promise<void> {
  const records = await readWAL(goalId, baseDir);
  const compactionStartTs = new Date().toISOString();
  await appendWALRecord(goalId, baseDir, {
    op: "compaction_start",
    ts: compactionStartTs,
  });
  const committed = new Set<string>();
  for (const r of records) {
    if (r.op === "commit") committed.add((r as WALCommit).ref_ts);
  }
  const remaining: WALRecord[] = [];
  for (const r of records) {
    if (r.op === "compaction_start" || r.op === "compaction_complete" || r.op === "commit") continue;
    const intent = r as WALIntent;
    if (!committed.has(intent.ts)) remaining.push(intent);
  }
  const filePath = walPath(goalId, baseDir);
  const body = remaining.map((r) => JSON.stringify(r)).join("\n");
  const tmpPath = filePath + ".tmp";
  await fsp.writeFile(tmpPath, remaining.length > 0 ? body + "\n" : "", "utf-8");
  await fsp.rename(tmpPath, filePath);
  await appendWALRecord(goalId, baseDir, {
    op: "compaction_complete",
    ref_ts: compactionStartTs,
    ts: new Date().toISOString(),
  });
}

export async function truncateWAL(
  goalId: string,
  baseDir: string
): Promise<void> {
  const filePath = walPath(goalId, baseDir);
  try {
    await fsp.writeFile(filePath, "", "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
