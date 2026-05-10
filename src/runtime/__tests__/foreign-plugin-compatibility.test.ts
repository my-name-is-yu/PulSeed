import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeForeignPluginDirectory,
  analyzeForeignPluginManifest,
  createPendingCompatibilityReviewRecord,
  FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME,
  FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME,
  readForeignPluginCompatibilityArtifact,
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

  it("parses YAML manifests with date-like descriptions as JSON-compatible strings", async () => {
    const pluginDir = path.join(tmpDir, "yaml-date-like-description");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: yaml-date-like-description",
        "version: 1.0.0",
        "type: notifier",
        "capabilities:",
        "  - notify",
        "description: 2026-05-10",
        "",
      ].join("\n"),
      "utf-8"
    );

    const report = analyzeForeignPluginDirectory("hermes", pluginDir);

    expect(report.status).toBe("convertible");
    expect(report.manifest?.description).toBe("2026-05-10");
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

  it("writes durable compatibility and pending review records to sqlite", async () => {
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

    expect(artifact.reportPath).toMatch(/^sqlite:\/\/pulseed-control\/foreign-plugin-compatibility\//);
    expect(artifact.reviewRecordPath).toMatch(/^sqlite:\/\/pulseed-control\/foreign-plugin-review\//);
    expect(await fileExists(path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME))).toBe(false);
    expect(await fileExists(path.join(pluginDir, FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME))).toBe(false);
    expect(artifact.reviewRecord).toMatchObject({
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
    await expect(readForeignPluginCompatibilityArtifact(pluginDir)).resolves.toMatchObject({
      schema_version: "foreign-plugin-compatibility/v1",
      status: "quarantined",
      runtime_loadable: false,
    });
  });

  it("rejects invalid persisted compatibility artifacts at the read boundary", async () => {
    const pluginDir = path.join(tmpDir, "invalid-artifact");
    await writeJson(path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME), {
      schema_version: "foreign-plugin-compatibility/v1",
      source: "openclaw",
      status: "convertible",
      runtime_loadable: true,
      issues: ["malformed artifact should not be trusted"],
      permissions: {
        network: false,
        file_read: false,
        file_write: false,
        shell: false,
      },
      execution_blockers: ["foreign_plugin_imported_disabled"],
      adapter_requirements: [],
      smoke_requirements: [],
    });

    await expect(readForeignPluginCompatibilityArtifact(pluginDir)).resolves.toBeNull();
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

  it("classifies manifest parse failures separately from read failures", async () => {
    const malformedDir = path.join(tmpDir, "malformed");
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, "plugin.json"), "{not-json", "utf-8");

    const malformed = analyzeForeignPluginDirectory("openclaw", malformedDir);

    expect(malformed.status).toBe("incompatible");
    expect(malformed.issues).toContain("failed to parse manifest: plugin.json");

    const unreadableDir = path.join(tmpDir, "unreadable");
    const unreadableManifestPath = path.join(unreadableDir, "plugin.json");
    await fs.mkdir(unreadableManifestPath, { recursive: true });

    const unreadable = analyzeForeignPluginDirectory("openclaw", unreadableDir);

    expect(unreadable.status).toBe("incompatible");
    expect(unreadable.issues).toContain("failed to read manifest: plugin.json");
    expect(unreadable.manifestPath).toBe(unreadableManifestPath);
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
