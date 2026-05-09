import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  RuntimeEventSchema,
  type RuntimeEvent,
} from "../../types/companion-state.js";
import {
  RuntimeControlOperationSchema,
  type RuntimeControlOperation,
} from "../runtime-operation-schemas.js";
import { runtimeEventFromOperationTransition } from "../runtime-operation-companion.js";
import {
  RuntimeDaemonHealthSchema,
  RuntimeComponentsHealthSchema,
} from "../runtime-schemas.js";
import { BackgroundRunSchema, type BackgroundRun } from "../../session-registry/types.js";
import {
  BackgroundRunLedger,
  RuntimeHealthStore,
  RuntimeOperationStore,
  createRuntimeStorePaths,
  importLegacyRuntimeControlStores,
  openControlDatabase,
  saveRuntimeJson,
} from "../index.js";
import { encodeRuntimePathSegment } from "../runtime-paths.js";

const RuntimeEventJournalSchema = RuntimeEventSchema as z.ZodType<RuntimeEvent>;

describe("importLegacyRuntimeControlStores", () => {
  let tmpDir: string;
  let runtimeRoot: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-runtime-control-store-migration-");
    runtimeRoot = path.join(tmpDir, "runtime");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("imports legacy runtime control JSON into SQLite without enabling normal fallback reads", async () => {
    const paths = createRuntimeStorePaths(runtimeRoot);
    const operation = makeRuntimeOperation();
    const event = runtimeEventFromOperationTransition(operation, null);
    if (!event) throw new Error("expected runtime operation event");
    const run = makeBackgroundRun();

    await saveRuntimeJson(
      path.join(runtimeRoot, "operations", "pending", `${encodeRuntimePathSegment(operation.operation_id)}.json`),
      RuntimeControlOperationSchema,
      operation,
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "operations", "events", `${encodeRuntimePathSegment(event.event_id)}.json`),
      RuntimeEventJournalSchema,
      event,
    );
    await saveRuntimeJson(
      paths.backgroundRunPath(run.id),
      BackgroundRunSchema,
      run,
    );
    await saveRuntimeJson(
      paths.daemonHealthPath,
      RuntimeDaemonHealthSchema,
      {
        status: "ok",
        leader: true,
        checked_at: 100,
      },
    );
    await saveRuntimeJson(
      paths.componentsHealthPath,
      RuntimeComponentsHealthSchema,
      {
        checked_at: 101,
        components: { gateway: "ok", queue: "ok" },
      },
    );

    await expect(new RuntimeOperationStore(runtimeRoot).load(operation.operation_id)).resolves.toBeNull();
    await expect(new BackgroundRunLedger(runtimeRoot).load(run.id)).resolves.toBeNull();
    await expect(new RuntimeHealthStore(runtimeRoot).loadSnapshot()).resolves.toBeNull();

    const result = await importLegacyRuntimeControlStores({
      runtimeRootOrPaths: runtimeRoot,
      importedAt: "2026-05-09T00:00:00.000Z",
    });

    expect(result.operations.pending).toBe(1);
    expect(result.operationEvents).toBe(1);
    expect(result.backgroundRuns).toBe(1);
    expect(result.healthRecords).toBe(2);

    await expect(new RuntimeOperationStore(runtimeRoot).load(operation.operation_id))
      .resolves.toMatchObject({ operation_id: operation.operation_id, state: "pending" });
    await expect(new RuntimeOperationStore(runtimeRoot).listRuntimeEvents())
      .resolves.toMatchObject([{ event_id: event.event_id }]);
    await expect(new BackgroundRunLedger(runtimeRoot).load(run.id))
      .resolves.toMatchObject({ id: run.id, status: "running" });
    await expect(new RuntimeHealthStore(runtimeRoot).loadSnapshot())
      .resolves.toMatchObject({ status: "ok", checked_at: 101 });

    expect(fs.existsSync(paths.backgroundRunPath(run.id))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
    expect(result.legacyImports.map((record) => record.source_kind)).toEqual([
      "runtime-operation-json",
      "runtime-operation-json",
      "runtime-operation-event-json",
      "background-run-json",
      "runtime-health-json",
      "runtime-health-json",
    ]);
  });

  it("records idempotent import bookkeeping for legacy runtime control sources", async () => {
    const paths = createRuntimeStorePaths(runtimeRoot);
    const operation = makeRuntimeOperation({ operation_id: "op-idempotent" });
    await saveRuntimeJson(
      path.join(runtimeRoot, "operations", "pending", `${encodeRuntimePathSegment(operation.operation_id)}.json`),
      RuntimeControlOperationSchema,
      operation,
    );

    await importLegacyRuntimeControlStores({ runtimeRootOrPaths: runtimeRoot });
    await importLegacyRuntimeControlStores({ runtimeRootOrPaths: runtimeRoot });

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      const imports = controlDb.listLegacyImports();
      expect(imports.map((record) => record.source_id).sort()).toEqual([
        "runtime-operations:pending",
        "runtime-operations:completed",
        "runtime-operation-events",
        "background-runs",
        "runtime-health:daemon",
        "runtime-health:components",
      ].sort());
      expect(imports.find((record) => record.source_id === "runtime-operations:pending")?.details)
        .toEqual({ row_count: 1 });
    } finally {
      controlDb.close();
    }

    await expect(new RuntimeOperationStore(paths).listPending()).resolves.toHaveLength(1);
  });

  it("keeps runtime control ownership in the state base when the runtime root is configured elsewhere", async () => {
    const configuredRuntimeRoot = path.join(tmpDir, "configured-runtime-root");
    const operation = makeRuntimeOperation({ operation_id: "op-configured-runtime-root" });

    await new RuntimeOperationStore(
      configuredRuntimeRoot,
      { controlBaseDir: tmpDir },
    ).save(operation);

    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(configuredRuntimeRoot, "state", "pulseed-control.sqlite"))).toBe(false);

    await expect(new RuntimeOperationStore(
      path.join(tmpDir, "runtime"),
      { controlBaseDir: tmpDir },
    ).load(operation.operation_id)).resolves.toMatchObject({
      operation_id: operation.operation_id,
    });
  });
});

function makeRuntimeOperation(
  overrides: Partial<RuntimeControlOperation> = {}
): RuntimeControlOperation {
  return {
    operation_id: "op-import-1",
    kind: "restart_daemon",
    state: "pending",
    requested_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:00:00.000Z",
    requested_by: {
      surface: "gateway",
      platform: "slack",
      conversation_id: "C123",
      identity_key: "user:1",
    },
    reply_target: {
      surface: "gateway",
      channel: "plugin_gateway",
      platform: "slack",
      conversation_id: "C123",
      message_id: "1700000000.000100",
    },
    reason: "operator requested restart",
    expected_health: {
      daemon_ping: true,
      gateway_acceptance: true,
    },
    ...overrides,
  };
}

function makeBackgroundRun(): BackgroundRun {
  return {
    schema_version: "background-run-v1",
    id: "run:agent:legacy",
    kind: "agent_run",
    parent_session_id: "session:conversation:legacy",
    child_session_id: "session:agent:legacy",
    process_session_id: null,
    goal_id: null,
    status: "running",
    notify_policy: "silent",
    reply_target_source: "none",
    pinned_reply_target: null,
    title: "Legacy run",
    workspace: "/repo",
    created_at: "2026-05-09T00:00:00.000Z",
    started_at: "2026-05-09T00:01:00.000Z",
    updated_at: "2026-05-09T00:01:00.000Z",
    completed_at: null,
    summary: null,
    error: null,
    artifacts: [],
    source_refs: [],
  };
}
