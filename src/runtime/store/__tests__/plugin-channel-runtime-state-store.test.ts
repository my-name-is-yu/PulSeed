import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginStateSchema } from "../../types/plugin.js";
import { createAssetRecord } from "../../assets/types.js";
import {
  analyzeForeignPluginManifest,
  createPendingCompatibilityReviewRecord,
  FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME,
  FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME,
} from "../../foreign-plugins/compatibility.js";
import { PluginChannelRuntimeStateStore } from "../plugin-channel-runtime-state-store.js";
import { importLegacyPluginChannelRuntimeState } from "../plugin-channel-runtime-state-migration.js";

describe("PluginChannelRuntimeStateStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-plugin-channel-store-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("stores plugin state, channel health, bindings, foreign reviews, and assets in sqlite", async () => {
    const store = new PluginChannelRuntimeStateStore(tmpDir);
    const pluginState = PluginStateSchema.parse({
      name: "demo-plugin",
      manifest: {
        name: "demo-plugin",
        version: "1.0.0",
        type: "notifier",
        capabilities: ["notify"],
        description: "Demo",
      },
      status: "loaded",
      loaded_at: "2026-05-09T00:00:00.000Z",
      trust_score: 11,
      usage_count: 2,
      success_count: 1,
      failure_count: 0,
    });
    await store.savePluginState(pluginState);
    await store.saveChannelHealth("telegram-bot", {
      last_inbound_at: "2026-05-09T00:01:00.000Z",
      last_outbound_at: "2026-05-09T00:02:00.000Z",
      last_error: null,
    });
    await store.saveChannelBinding("telegram-bot", {
      home_target_id: "12345",
      first_bound_actor_id: "67890",
    });
    const report = analyzeForeignPluginManifest("openclaw", {
      name: "foreign-demo",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "Demo",
      permissions: { network: true, file_read: false, file_write: false, shell: false },
    });
    const review = createPendingCompatibilityReviewRecord(report, {
      reportRef: "legacy-report.json",
      createdAt: "2026-05-09T00:03:00.000Z",
    });
    await store.saveForeignPluginCompatibility(path.join(tmpDir, "plugins-imported-disabled", "openclaw", "foreign-demo"), report, review);
    await store.saveAssetRecords([
      createAssetRecord({
        id: "foreign_plugin:openclaw/foreign-demo",
        kind: "foreign_plugin",
        label: "foreign-demo",
        source_agent: "openclaw",
        status: "quarantined",
      }, "2026-05-09T00:04:00.000Z"),
    ]);

    await expect(store.loadPluginState("demo-plugin")).resolves.toMatchObject({ trust_score: 11 });
    await expect(store.loadChannelHealth("telegram-bot")).resolves.toMatchObject({ last_inbound_at: "2026-05-09T00:01:00.000Z" });
    await expect(store.loadChannelBinding("telegram-bot")).resolves.toMatchObject({ home_target_id: "12345" });
    await expect(store.loadForeignPluginCompatibility(path.join(tmpDir, "plugins-imported-disabled", "openclaw", "foreign-demo"))).resolves.toMatchObject({
      status: "quarantined",
    });
    await expect(store.loadAssetRecords()).resolves.toHaveLength(1);
  });

  it("imports legacy plugin/channel runtime JSON through an explicit migration boundary", async () => {
    const pluginState = PluginStateSchema.parse({
      name: "legacy-plugin",
      manifest: {
        name: "legacy-plugin",
        version: "1.0.0",
        type: "notifier",
        capabilities: ["notify"],
        description: "Legacy",
      },
      status: "loaded",
      loaded_at: "2026-05-09T00:00:00.000Z",
      trust_score: 9,
      usage_count: 1,
      success_count: 1,
      failure_count: 0,
    });
    await writeJson(path.join(tmpDir, "plugins", "legacy-plugin", "state.json"), pluginState);
    await writeJson(path.join(tmpDir, "gateway", "channels", "telegram-bot", "health.json"), {
      last_inbound_at: "2026-05-09T00:01:00.000Z",
      last_outbound_at: "2026-05-09T00:02:00.000Z",
      last_error: null,
    });
    const report = analyzeForeignPluginManifest("openclaw", {
      name: "legacy-foreign",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "Legacy foreign",
      permissions: { network: true, file_read: false, file_write: false, shell: false },
    });
    const pluginDir = path.join(tmpDir, "plugins-imported-disabled", "openclaw", "legacy-foreign");
    await writeJson(path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME), report);
    await writeJson(path.join(pluginDir, FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME), createPendingCompatibilityReviewRecord(report, {
      reportRef: path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME),
      createdAt: "2026-05-09T00:03:00.000Z",
    }));
    await writeJson(path.join(tmpDir, "runtime", "assets", "registry.json"), {
      version: 1,
      updated_at: "2026-05-09T00:04:00.000Z",
      assets: [
        createAssetRecord({
          id: "foreign_plugin:openclaw/legacy-foreign",
          kind: "foreign_plugin",
          label: "legacy-foreign",
          source_agent: "openclaw",
          status: "quarantined",
        }, "2026-05-09T00:04:00.000Z"),
      ],
    });

    const migration = await importLegacyPluginChannelRuntimeState(tmpDir);
    expect(migration).toMatchObject({
      pluginStates: 1,
      channelHealth: 1,
      importedPluginReviews: 1,
      assetRecords: 1,
      blockedSources: [],
    });
    await fsp.rm(path.join(tmpDir, "plugins"), { recursive: true, force: true });
    await fsp.rm(path.join(tmpDir, "gateway", "channels", "telegram-bot", "health.json"), { force: true });
    await fsp.rm(path.join(tmpDir, "plugins-imported-disabled"), { recursive: true, force: true });
    await fsp.rm(path.join(tmpDir, "runtime", "assets", "registry.json"), { force: true });

    const store = new PluginChannelRuntimeStateStore(tmpDir);
    await expect(store.loadPluginState("legacy-plugin")).resolves.toMatchObject({ trust_score: 9 });
    await expect(store.loadChannelHealth("telegram-bot")).resolves.toMatchObject({ last_outbound_at: "2026-05-09T00:02:00.000Z" });
    await expect(store.loadForeignPluginCompatibility(pluginDir)).resolves.toMatchObject({ status: "quarantined" });
    await expect(store.loadAssetRecords()).resolves.toHaveLength(1);
  });

  it("merges channel timing updates without dropping existing health fields", async () => {
    const store = new PluginChannelRuntimeStateStore(tmpDir);
    await store.saveChannelHealth("telegram-bot", {
      last_inbound_at: "2026-05-09T00:01:00.000Z",
      last_outbound_at: "2026-05-09T00:02:00.000Z",
      last_error: null,
    });
    await store.saveChannelHealth("telegram-bot", {
      last_timing: {
        schema_version: "gateway-channel-timing-v1",
        channel: "telegram",
        poll: {
          started_at: "2026-05-09T00:02:01.000Z",
          completed_at: "2026-05-09T00:02:02.000Z",
          duration_ms: 1000,
          offset: 10,
          timeout_seconds: 30,
          update_count: 1,
          ok: true,
        },
      },
    });

    await expect(store.loadChannelHealth("telegram-bot")).resolves.toMatchObject({
      last_inbound_at: "2026-05-09T00:01:00.000Z",
      last_outbound_at: "2026-05-09T00:02:00.000Z",
      last_error: null,
      last_timing: {
        schema_version: "gateway-channel-timing-v1",
        channel: "telegram",
        poll: {
          offset: 10,
          ok: true,
        },
      },
    });
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
