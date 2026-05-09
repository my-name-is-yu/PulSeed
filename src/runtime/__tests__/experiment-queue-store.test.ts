import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeExperimentQueueStore } from "../store/experiment-queue-store.js";
import { createRuntimeStorePaths } from "../store/runtime-paths.js";

describe("RuntimeExperimentQueueStore", () => {
  let tmpDir: string;
  let store: RuntimeExperimentQueueStore;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-experiment-queue-"));
    store = new RuntimeExperimentQueueStore(path.join(tmpDir, "runtime"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("resumes frozen queue execution after a restart without reselecting completed items", async () => {
    await store.create({
      queue_id: "queue-a",
      goal_id: "goal-a",
      run_id: "run:coreloop:goal-a",
      title: "Ablation queue",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [
        item("exp-a", { model: "catboost", seed: 1 }),
        item("exp-b", { model: "catboost", seed: 2 }),
      ],
    });
    await store.freeze("queue-a", "2026-05-01T00:01:00.000Z");
    await store.recordItemResult("queue-a", {
      item_id: "exp-a",
      status: "succeeded",
      completed_at: "2026-05-01T00:05:00.000Z",
      output_artifacts: [{ label: "exp-a metrics", state_relative_path: "runs/exp-a/metrics.json", kind: "metrics" }],
      metrics: [{ label: "cv", value: 0.842, direction: "maximize" }],
    });

    const restarted = new RuntimeExperimentQueueStore(path.join(tmpDir, "runtime"));
    const directive = await restarted.nextExecutionDirective("queue-a");

    expect(directive).toMatchObject({
      mode: "execute_frozen_queue_item",
      queue_id: "queue-a",
      version: 1,
      phase: "executing_frozen_queue",
      item: { item_id: "exp-b", status: "pending" },
    });
    const queue = await restarted.load("queue-a");
    const revision = queue?.revisions.find((candidate) => candidate.version === 1);
    expect(revision?.items.find((candidate) => candidate.item_id === "exp-a")).toMatchObject({
      status: "succeeded",
      output_artifacts: [expect.objectContaining({ state_relative_path: "runs/exp-a/metrics.json" })],
    });
  });

  it("rejects duplicate queue materialization so revisions cannot be overwritten silently", async () => {
    await store.create({
      queue_id: "queue-duplicate",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [item("exp-a", { seed: 1 })],
    });
    await store.freeze("queue-duplicate", "2026-05-01T00:01:00.000Z");
    await store.recordItemResult("queue-duplicate", {
      item_id: "exp-a",
      status: "succeeded",
      completed_at: "2026-05-01T00:02:00.000Z",
    });

    await expect(store.create({
      queue_id: "queue-duplicate",
      created_at: "2026-05-01T00:03:00.000Z",
      provenance: provenance("accidental-rerun"),
      items: [item("exp-b", { seed: 2 })],
    })).rejects.toThrow("use appendRevision");

    const queue = await store.load("queue-duplicate");
    expect(queue?.revisions).toHaveLength(1);
    expect(queue?.revisions[0].items).toContainEqual(expect.objectContaining({
      item_id: "exp-a",
      status: "succeeded",
    }));
  });

  it("resumes a running frozen item after restart using the same idempotency key", async () => {
    await store.create({
      queue_id: "queue-running-resume",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [item("exp-a", { fold: 1 })],
    });
    await store.freeze("queue-running-resume", "2026-05-01T00:01:00.000Z");
    await store.markItemRunning("queue-running-resume", {
      item_id: "exp-a",
      claimed_by: "worker-a",
      started_at: "2026-05-01T00:02:00.000Z",
    });

    const restarted = new RuntimeExperimentQueueStore(path.join(tmpDir, "runtime"));
    const directive = await restarted.nextExecutionDirective("queue-running-resume");

    expect(directive).toMatchObject({
      mode: "execute_frozen_queue_item",
      queue_id: "queue-running-resume",
      resume: true,
      item: {
        item_id: "exp-a",
        status: "running",
      },
    });
    expect(directive?.summary).toContain("Resume frozen experiment queue");
  });

  it("requires explicit frozen execution before item execution and keeps terminal updates idempotent", async () => {
    await store.create({
      queue_id: "queue-idempotent",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("designer"),
      items: [item("exp-a", { depth: 8 })],
    });

    await expect(store.nextExecutionDirective("queue-idempotent")).rejects.toThrow("still in designing");
    await store.freeze("queue-idempotent", "2026-05-01T00:01:00.000Z");
    await store.recordItemResult("queue-idempotent", {
      item_id: "exp-a",
      status: "failed",
      completed_at: "2026-05-01T00:02:00.000Z",
      error: "training crashed",
    });
    await store.recordItemResult("queue-idempotent", {
      item_id: "exp-a",
      status: "failed",
      completed_at: "2026-05-01T00:03:00.000Z",
      error: "duplicate retry result",
    });

    const queue = await store.load("queue-idempotent");
    expect(queue?.revisions[0].items[0]).toMatchObject({
      status: "failed",
      completed_at: "2026-05-01T00:02:00.000Z",
      error: "training crashed",
    });
    await expect(store.recordItemResult("queue-idempotent", {
      item_id: "exp-a",
      status: "succeeded",
    })).rejects.toThrow("already finished as failed");
  });

  it("derives stable idempotency keys from nested item config", async () => {
    await store.create({
      queue_id: "queue-nested-config",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("designer"),
      items: [
        item("exp-a", { params: { depth: 8, learning_rate: 0.03 }, seed: 1 }),
        item("exp-b", { seed: 1, params: { learning_rate: 0.03, depth: 10 } }),
      ],
    });

    const queue = await store.load("queue-nested-config");
    const keys = queue?.revisions[0].items.map((candidate) => candidate.idempotency_key) ?? [];

    expect(keys[0]).toContain('"depth":8');
    expect(keys[1]).toContain('"depth":10');
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("appends explicit queue revisions while preserving previous frozen results", async () => {
    await store.create({
      queue_id: "queue-revision",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [item("exp-a", { features: ["base"] })],
    });
    await store.freeze("queue-revision", "2026-05-01T00:01:00.000Z");
    await store.recordItemResult("queue-revision", {
      item_id: "exp-a",
      status: "succeeded",
      completed_at: "2026-05-01T00:05:00.000Z",
      metrics: [{ label: "cv", value: 0.81, direction: "maximize" }],
    });

    await store.appendRevision("queue-revision", {
      reason: "Add missing seed coverage after reviewing v1 results",
      created_at: "2026-05-01T00:10:00.000Z",
      provenance: provenance("revision-plan"),
      items: [
        item("exp-a-seed2", { features: ["base"], seed: 2 }),
        item("exp-a-seed3", { features: ["base"], seed: 3 }),
      ],
    });

    const queue = await store.load("queue-revision");
    expect(queue).toMatchObject({
      current_version: 2,
      revisions: [
        expect.objectContaining({
          version: 1,
          phase: "executing_frozen_queue",
          items: [expect.objectContaining({
            item_id: "exp-a",
            status: "succeeded",
            metrics: [expect.objectContaining({ label: "cv", value: 0.81 })],
          })],
        }),
        expect.objectContaining({
          version: 2,
          phase: "designing",
          status: "draft",
          revision_of: 1,
          revision_reason: "Add missing seed coverage after reviewing v1 results",
          items: [
            expect.objectContaining({ item_id: "exp-a-seed2", status: "pending" }),
            expect.objectContaining({ item_id: "exp-a-seed3", status: "pending" }),
          ],
        }),
      ],
    });
  });

  it("rejects persisted queue records with unsafe current versions", async () => {
    await store.create({
      queue_id: "queue-unsafe-version",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [item("exp-a", { seed: 1 })],
    });

    const queuePath = createRuntimeStorePaths(path.join(tmpDir, "runtime")).experimentQueuePath("queue-unsafe-version");
    const persisted = JSON.parse(await fsp.readFile(queuePath, "utf-8")) as {
      current_version: number;
      revisions: Array<{ version: number }>;
    };
    persisted.current_version = Number.MAX_SAFE_INTEGER + 1;
    await fsp.writeFile(queuePath, JSON.stringify(persisted, null, 2), "utf-8");

    await expect(store.load("queue-unsafe-version")).resolves.toBeNull();
  });

  it("rejects persisted queue records with unsafe revision identifiers", async () => {
    await store.create({
      queue_id: "queue-unsafe-revision",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [item("exp-a", { seed: 1 })],
    });
    await store.appendRevision("queue-unsafe-revision", {
      reason: "Add another seed",
      created_at: "2026-05-01T00:10:00.000Z",
      provenance: provenance("revision-plan"),
      items: [item("exp-b", { seed: 2 })],
    });

    const queuePath = createRuntimeStorePaths(path.join(tmpDir, "runtime")).experimentQueuePath("queue-unsafe-revision");
    const persisted = JSON.parse(await fsp.readFile(queuePath, "utf-8")) as {
      current_version: number;
      revisions: Array<{ version: number }>;
    };
    persisted.current_version = 1;
    persisted.revisions[1]!.version = Number.MAX_SAFE_INTEGER + 1;
    await fsp.writeFile(queuePath, JSON.stringify(persisted, null, 2), "utf-8");

    await expect(store.load("queue-unsafe-revision")).resolves.toBeNull();
  });

  it("rejects persisted queue records with unsafe revision ancestry", async () => {
    await store.create({
      queue_id: "queue-unsafe-revision-of",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: provenance("experiment-bank-v1"),
      items: [item("exp-a", { seed: 1 })],
    });
    await store.appendRevision("queue-unsafe-revision-of", {
      reason: "Add another seed",
      created_at: "2026-05-01T00:10:00.000Z",
      provenance: provenance("revision-plan"),
      items: [item("exp-b", { seed: 2 })],
    });

    const queuePath = createRuntimeStorePaths(path.join(tmpDir, "runtime")).experimentQueuePath("queue-unsafe-revision-of");
    const persisted = JSON.parse(await fsp.readFile(queuePath, "utf-8")) as {
      revisions: Array<{ revision_of: number | null }>;
    };
    persisted.revisions[1]!.revision_of = Number.MAX_SAFE_INTEGER + 1;
    await fsp.writeFile(queuePath, JSON.stringify(persisted, null, 2), "utf-8");

    await expect(store.load("queue-unsafe-revision-of")).resolves.toBeNull();
  });
});

function provenance(source: string) {
  return {
    source,
    created_by: "test",
    evidence_refs: [`evidence:${source}`],
  };
}

function item(itemId: string, config: Record<string, unknown>) {
  return {
    item_id: itemId,
    title: itemId,
    config,
    provenance: provenance(`item:${itemId}`),
  };
}
