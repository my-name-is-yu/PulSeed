import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../../base/state/state-manager.js";
import { createAttentionInput, ref } from "../../../../runtime/attention/index.js";
import { AttentionStateStore } from "../../../../runtime/store/attention-state-store.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { cmdRuntime } from "../runtime.js";

const NOW = "2026-05-12T00:00:00.000Z";

async function seedAttentionInput(baseDir: string): Promise<void> {
  const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
  await store.appendAttentionInputs([
    createAttentionInput({
      source_kind: "runtime_event",
      source_id: "runtime-event:cli-continuity",
      source_epoch: "runtime-event:epoch:1",
      high_watermark: "runtime-event:watermark:1",
      emitted_at: NOW,
      payload_class: "test.runtime",
      summary: "Seed runtime evidence for CLI continuity inspection.",
      runtime_state_refs: [ref("runtime_event", "runtime-event:cli-continuity")],
    }),
  ], NOW);
}

describe("runtime attention-continuity command", () => {
  it("prints a concise human inspection view", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-attention-continuity-cli-");
    try {
      await seedAttentionInput(tmpDir);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await cmdRuntime(new StateManager(tmpDir), ["attention-continuity"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      expect(output).toContain("Attention continuity:");
      expect(output).toContain("Status:");
      expect(output).toContain("Attention inputs:1");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("returns the durable inspection contract as JSON", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-attention-continuity-json-");
    try {
      await seedAttentionInput(tmpDir);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await cmdRuntime(new StateManager(tmpDir), ["attention-continuity", "--json"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      const parsed = JSON.parse(output) as {
        schema_version: string;
        summary: { attention_input_count: number };
      };
      expect(parsed.schema_version).toBe("attention-continuity-inspection-v1");
      expect(parsed.summary.attention_input_count).toBe(1);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed on schema-invalid durable attention rows", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-attention-continuity-invalid-row-");
    try {
      const store = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
      await store.ensureReady();
      const db = new Database(path.join(tmpDir, "state", "pulseed-control.sqlite"));
      db.prepare(`
        INSERT INTO attention_inputs (
          attention_input_id,
          source_kind,
          source_id,
          source_epoch,
          high_watermark,
          replay_key,
          emitted_at,
          replay_disposition,
          lifecycle,
          suppressed_at,
          cooldown_until,
          revisit_due_at,
          stale_ref_count,
          invalidation_ref_count,
          audit_ref_count,
          input_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
      `).run(
        "attention-input:invalid-row",
        "runtime_event",
        "runtime-event:invalid-row",
        "runtime-event:epoch:invalid-row",
        "runtime-event:watermark:invalid-row",
        "runtime-event:invalid-row",
        NOW,
        "accepted",
        "active",
        null,
        null,
        null,
        0,
        0,
        0,
        JSON.stringify({ schema_version: "attention-input-v1" })
      );
      db.close();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const code = await cmdRuntime(new StateManager(tmpDir), ["attention-continuity", "--json"]);
      const output = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      errorSpy.mockRestore();

      expect(code).toBe(1);
      expect(output).toContain("invalid durable attention state row");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
