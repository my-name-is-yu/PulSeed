import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeForeignPluginDirectory,
  analyzeForeignPluginManifest,
  createPendingCompatibilityReviewRecord,
  writeForeignPluginCompatibilityArtifacts,
} from "../foreign-plugins/compatibility.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-foreign-plugin-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("foreign plugin compatibility", () => {
  it("classifies a safe manifest as convertible", async () => {
    const pluginDir = path.join(tmpDir, "convertible");
    await writeJson(path.join(pluginDir, "plugin.json"), {
      name: "convertible",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "safe manifest",
      permissions: {
        network: false,
        file_read: false,
        file_write: false,
        shell: false,
      },
    });

    const report = analyzeForeignPluginDirectory("hermes", pluginDir);
    expect(report.status).toBe("convertible");
    expect(report.runtime_loadable).toBe(false);
    expect(report.execution_blockers).toEqual(expect.arrayContaining([
      "foreign_plugin_imported_disabled",
      "operator_review_required",
      "adapter_required",
      "smoke_verification_required",
    ]));
    expect(report.adapter_requirements.map((requirement) => requirement.kind)).toEqual([
      "native_plugin_conversion",
      "compatibility_adapter",
      "mcp_or_cli_bridge",
    ]);
    expect(report.smoke_requirements[0]).toMatchObject({
      operation_kind: "notifier",
      payload_class: "foreign_plugin_manifest",
      side_effect_profile: "send",
      required: true,
    });
    expect(report.source_provenance?.source_path).toBe(pluginDir);
    expect(report.permissions).toEqual({
      network: false,
      file_read: false,
      file_write: false,
      shell: false,
    });
    expect(report.manifest?.name).toBe("convertible");
    expect(report.manifest?.entry_point).toBe("dist/index.js");
  });

  it("classifies a manifest with elevated permissions as quarantined", () => {
    const report = analyzeForeignPluginManifest("hermes", {
      name: "riskier",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "needs review",
      permissions: {
        network: true,
        file_read: false,
        file_write: false,
        shell: true,
      },
    });

    expect(report.status).toBe("quarantined");
    expect(report.runtime_loadable).toBe(false);
    expect(report.execution_blockers).toEqual(expect.arrayContaining([
      "requested_network_permission",
      "requested_shell_permission",
    ]));
    expect(report.permissions).toEqual({
      network: true,
      file_read: false,
      file_write: false,
      shell: true,
    });
    expect(report.issues[0]).toContain("network");
    expect(report.manifest?.name).toBe("riskier");
  });

  it("writes durable compatibility and pending review records beside an imported plugin", async () => {
    const pluginDir = path.join(tmpDir, "imported-disabled");
    const report = analyzeForeignPluginManifest("openclaw", {
      name: "review-me",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify"],
      description: "needs review",
      permissions: {
        network: true,
        file_read: false,
        file_write: false,
        shell: false,
      },
    });
    const artifact = await writeForeignPluginCompatibilityArtifacts(pluginDir, report, {
      createdAt: "2026-05-09T00:00:00.000Z",
    });

    const writtenReport = JSON.parse(await fs.readFile(artifact.reportPath, "utf-8"));
    const writtenReview = JSON.parse(await fs.readFile(artifact.reviewRecordPath, "utf-8"));
    expect(writtenReport).toMatchObject({
      schema_version: "foreign-plugin-compatibility/v1",
      status: "quarantined",
      runtime_loadable: false,
    });
    expect(writtenReview).toMatchObject({
      schema_version: "foreign-plugin-review/v1",
      status: "pending_operator_review",
      runtime_loadable: false,
      load_authority: "not_granted",
      report_ref: artifact.reportPath,
    });
    expect(createPendingCompatibilityReviewRecord(report, { reportRef: "report.json" })).toMatchObject({
      plugin_name: "review-me",
      status: "pending_operator_review",
    });
  });

  it("classifies an invalid manifest as incompatible", () => {
    const report = analyzeForeignPluginManifest("hermes", {
      name: "Bad Name",
      version: "1.0",
      type: "custom",
      capabilities: [],
      description: "",
    });

    expect(report.status).toBe("incompatible");
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("rejects persisted manifests with invalid capability or entry point contracts", async () => {
    const pluginDir = path.join(tmpDir, "bad-contract");
    await writeJson(path.join(pluginDir, "plugin.json"), {
      name: "bad-contract",
      version: "1.0.0",
      type: "notifier",
      capabilities: ["notify", 123],
      description: "bad manifest",
      entry_point: "",
    });

    const report = analyzeForeignPluginDirectory("openclaw", pluginDir);

    expect(report.status).toBe("incompatible");
    expect(report.manifest).toBeUndefined();
    expect(report.issues).toContain("capabilities must be a non-empty array of strings");
    expect(report.issues).toContain("entry_point must be a non-empty string");
  });
});
