import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  createFeedbackIngestion,
  feedbackIngestionToAttentionInput,
} from "../../attention/index.js";
import {
  CONTROL_DB_SCHEMA_VERSION,
  openControlDatabase,
} from "../control-db/index.js";
import { FeedbackIngestionStore } from "../feedback-ingestion-store.js";

const NOW = "2026-05-12T07:00:00.000Z";

describe("FeedbackIngestionStore", () => {
  it("migrates the control DB to durable feedback ingestion tables", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-migration-");
    try {
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        expect(CONTROL_DB_SCHEMA_VERSION).toBe(29);
        expect(db.schemaVersion()).toBe(29);
        const tables = db.read((sqlite) =>
          sqlite.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'feedback_ingestion_%'
            ORDER BY name
          `).all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(tables).toEqual([
          "feedback_ingestion_effects",
          "feedback_ingestion_records",
        ]);
      } finally {
        db.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when the control DB schema is ahead of this code", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-ahead-");
    try {
      const dbPath = path.join(tmpDir, "state", "pulseed-control.sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.pragma("user_version = 999");
      db.close();

      const store = new FeedbackIngestionStore(path.join(tmpDir, "runtime"));
      await expect(store.ensureReady()).rejects.toThrow("newer than supported version");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("persists feedback records and effects across restart", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-restart-");
    try {
      const firstDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const store = new FeedbackIngestionStore(path.join(tmpDir, "runtime"), { controlDb: firstDb });
        const result = await store.ingest({
          source: "cli",
          feedback_kind: "proactive_feedback",
          outcome: "overreach",
          target: {
            kind: "intervention",
            id: "intervention:too-frequent",
          },
          recorded_at: NOW,
          proactive_event_ref: "proactive-event:1",
          overreach_indicators: ["too_frequent"],
          reason: "Too many suggestions.",
          profile_proposal_refs: ["profile-proposal:reduce-frequency"],
        });
        expect(result.record.feedback_id).toMatch(/^feedback-ingestion:/);
        expect(result.effects.map((effect) => effect.effect_kind)).toEqual(expect.arrayContaining([
          "autonomy_feedback_signal",
          "attention_cooldown",
          "profile_proposal_recommendation",
          "proactive_intervention_feedback",
        ]));
      } finally {
        firstDb.close();
      }

      const secondDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const restarted = new FeedbackIngestionStore(path.join(tmpDir, "runtime"), { controlDb: secondDb });
        const records = await restarted.listRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          source: "cli",
          feedback_kind: "proactive_feedback",
          outcome: "overreach",
          target: {
            kind: "intervention",
            id: "intervention:too-frequent",
          },
        });
        const effects = await restarted.listEffects(records[0]!.feedback_id);
        expect(effects.length).toBeGreaterThanOrEqual(5);
        expect(feedbackIngestionToAttentionInput({
          schema_version: "feedback-ingestion-result-v1",
          record: records[0]!,
          effects,
        }).effect_policy).toEqual({
          wake: true,
          notify: false,
          speak: false,
          act: false,
        });
      } finally {
        secondDb.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("can append an already-built ingestion result idempotently", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-append-");
    try {
      const store = new FeedbackIngestionStore(path.join(tmpDir, "runtime"));
      const result = createFeedbackIngestion({
        source: "runtime",
        feedback_kind: "runtime_outcome",
        outcome: "runtime_failure",
        target: {
          kind: "runtime_operation",
          id: "runtime-item:failed",
        },
        runtime_ref: "runtime-item:failed",
        recorded_at: NOW,
        reason: "The runtime operation failed.",
      });

      await store.append(result);
      await store.append(result);

      expect(await store.listRecords()).toHaveLength(1);
      expect(await store.listEffects(result.record.feedback_id)).toHaveLength(result.effects.length);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects divergent replay for an existing feedback id without leaving stale effects", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-divergent-");
    try {
      const store = new FeedbackIngestionStore(path.join(tmpDir, "runtime"));
      const first = createFeedbackIngestion({
        feedback_id: "feedback-ingestion:fixed",
        source: "gateway",
        feedback_kind: "surface_dismissal",
        outcome: "dismissed",
        target: {
          kind: "surface",
          id: "telegram-thread",
        },
        recorded_at: NOW,
        reason: "Dismissed as too frequent.",
      });
      const divergent = createFeedbackIngestion({
        feedback_id: "feedback-ingestion:fixed",
        source: "gateway",
        feedback_kind: "surface_dismissal",
        outcome: "accepted",
        target: {
          kind: "surface",
          id: "telegram-thread",
        },
        recorded_at: NOW,
        reason: "Actually useful.",
      });

      await store.append(first);
      await expect(store.append(divergent)).rejects.toThrow("already exists with different durable content");

      const records = await store.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBe("dismissed");
      expect((await store.listEffects(first.record.feedback_id)).map((effect) => effect.effect_kind)).toContain("attention_cooldown");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed on JSON-valid but schema-invalid durable feedback rows", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-corrupt-");
    try {
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        db.transaction((sqlite) => {
          sqlite.prepare(`
            INSERT INTO feedback_ingestion_records (
              feedback_id,
              source,
              outcome,
              recorded_at,
              target_kind,
              target_id,
              feedback_json
            )
            VALUES (?, ?, ?, ?, ?, ?, json(?))
          `).run(
            "feedback-ingestion:corrupt",
            "gateway",
            "dismissed",
            NOW,
            "surface",
            "telegram-thread",
            JSON.stringify({
              schema_version: "feedback-ingestion-record-v1",
              feedback_id: "feedback-ingestion:corrupt",
            })
          );
        });
      } finally {
        db.close();
      }

      const store = new FeedbackIngestionStore(path.join(tmpDir, "runtime"));
      await expect(store.listRecords()).rejects.toThrow("invalid durable feedback ingestion record");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed on JSON-valid but schema-invalid durable feedback effect rows", async () => {
    const tmpDir = makeTempDir("pulseed-feedback-ingestion-corrupt-effect-");
    try {
      const store = new FeedbackIngestionStore(path.join(tmpDir, "runtime"));
      const result = await store.ingest({
        source: "gateway",
        feedback_kind: "surface_dismissal",
        outcome: "dismissed",
        target: {
          kind: "surface",
          id: "telegram-thread",
        },
        recorded_at: NOW,
        reason: "Dismissed.",
      });
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        db.transaction((sqlite) => {
          sqlite.prepare(`
            INSERT INTO feedback_ingestion_effects (
              effect_id,
              feedback_id,
              effect_kind,
              target_ref,
              created_at,
              effect_json
            )
            VALUES (?, ?, ?, ?, ?, json(?))
          `).run(
            "feedback-effect:corrupt",
            result.record.feedback_id,
            "attention_cooldown",
            "surface:telegram-thread:",
            NOW,
            JSON.stringify({
              schema_version: "feedback-ingestion-effect-v1",
              effect_id: "feedback-effect:corrupt",
              feedback_id: result.record.feedback_id,
              effect_kind: "attention_cooldown",
            })
          );
        });
      } finally {
        db.close();
      }

      await expect(store.listEffects(result.record.feedback_id)).rejects.toThrow("invalid durable feedback ingestion effect");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
