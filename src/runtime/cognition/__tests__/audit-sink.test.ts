import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileCognitionAuditSink,
  createCognitionReplayRecord,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";

function replayRecord(index: number) {
  const cognitionId = `cognition:resident:gate:${index}:evaluation:${index}`;
  return createCognitionReplayRecord({
    recordId: `${cognitionId}:replay`,
    createdAt: NOW,
    input: {
      cognition_id: cognitionId,
      caller_path: "resident_proactive_check",
      event_refs: [{
        ref: `gate:${index}`,
        source_store: "attention_ledger" as const,
        source_event_type: "resident_attention_admission" as const,
        schema_version: 1,
        source_epoch: `gate:${index}`,
        redaction_policy: "metadata_only" as const,
      }],
    },
    failure: { message: "stable output intentionally absent in audit sink concurrency test" },
  });
}

describe("file cognition audit sink", () => {
  it("serializes concurrent replay writes so records are not lost", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cognition-audit-concurrent-"));
    const sink = new FileCognitionAuditSink(baseDir);
    const records = Array.from({ length: 16 }, (_, index) => replayRecord(index));

    await Promise.all(records.map((record) => sink.recordCognition(record)));

    expect((await sink.list()).map((record) => record.record_id).sort()).toEqual(
      records.map((record) => record.record_id).sort(),
    );
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
