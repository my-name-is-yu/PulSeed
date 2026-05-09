import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { builtinIntegrationToAssetRecord } from "../../builtin-integrations.js";
import { AssetRegistry } from "../registry.js";
import {
  createAssetRecord,
  toAssetView,
  toAssetId,
  type AssetRecordInput,
} from "../types.js";

describe("AssetRegistry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-assets-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("keeps asset presence non-executable on list and show surfaces", async () => {
    const registry = new AssetRegistry({ baseDir: tmpDir });

    const recorded = await registry.record({
      id: toAssetId("skill_bundle", ["imported", "review"]),
      kind: "skill_bundle",
      label: "Review",
      source_agent: "codex",
      imported_path: "/tmp/skills/review",
      checksum: "sha256:abc",
      status: "imported",
    });
    const shown = await registry.get(recorded.id);
    const listed = await registry.list();

    expect(recorded.execution).toEqual({
      executable: false,
      reason: "asset_record_only",
    });
    expect(shown?.execution.executable).toBe(false);
    expect(listed[0]?.execution.reason).toBe("asset_record_only");
  });

  it("preserves imported provenance across list, show, and search", async () => {
    const registry = new AssetRegistry({ baseDir: tmpDir });
    const input = createAssetRecord({
      id: toAssetId("skill_bundle", ["openclaw", "release-review"]),
      kind: "skill_bundle",
      label: "Release Review",
      source_agent: "openclaw",
      source_path: "/source/openclaw/skills/release-review",
      imported_path: "/pulseed/skills/imported/openclaw/release-review",
      checksum: "sha256:source",
      version: "1.0.0",
      compatibility_report_ref: "/pulseed/imports/openclaw/report.json",
      readiness_ref: "readiness:deferred",
      status: "imported",
      provenance: {
        source_label: "OpenClaw",
        import_batch_id: "2026-05-09T14:30:00.000Z",
        evidence_refs: ["openclaw:skill:release-review"],
      },
      metadata: {
        description: "Reviews releases.",
      },
    }, "2026-05-09T14:30:00.000Z");

    await registry.record(input);

    const listed = await registry.list();
    const shown = await registry.get(input.id);
    const searched = await registry.search("OpenClaw");

    expect(listed[0]).toMatchObject({
      id: input.id,
      source_agent: "openclaw",
      source_path: input.source_path,
      imported_path: input.imported_path,
      checksum: "sha256:source",
    });
    expect(shown?.provenance?.import_batch_id).toBe("2026-05-09T14:30:00.000Z");
    expect(searched.map((asset) => asset.id)).toEqual([input.id]);
    expect(searched[0]?.execution.executable).toBe(false);
  });

  it("keeps re-imported assets as new records instead of overwriting provenance", async () => {
    const registry = new AssetRegistry({ baseDir: tmpDir });
    const baseInput: AssetRecordInput = {
      id: toAssetId("skill_bundle", ["openclaw", "review"]),
      kind: "skill_bundle",
      label: "Review",
      source_agent: "openclaw",
      source_path: "/source/openclaw/skills/review",
      imported_path: "/pulseed/skills/imported/openclaw/review",
      checksum: "sha256:first",
      status: "imported",
      provenance: {
        source_label: "OpenClaw",
        import_batch_id: "2026-05-09T14:30:00.000Z",
      },
    };

    await registry.record(baseInput);
    await registry.record({
      ...baseInput,
      checksum: "sha256:second",
      provenance: {
        source_label: "OpenClaw",
        import_batch_id: "2026-05-09T14:31:00.000Z",
      },
    });

    const listed = await registry.list();

    expect(listed).toHaveLength(2);
    expect(listed.map((asset) => asset.checksum).sort()).toEqual([
      "sha256:first",
      "sha256:second",
    ]);
    expect(listed[1]?.id).not.toBe(listed[0]?.id);
    expect(listed[1]?.metadata?.["logical_asset_id"]).toBe(baseInput.id);
  });

  it("treats builtin available state as asset evidence only", () => {
    const asset = builtinIntegrationToAssetRecord({
      id: "mcp-bridge",
      kind: "bridge",
      title: "MCP Bridge",
      description: "Imports MCP servers.",
      source: "builtin",
      status: "available",
      capabilities: ["mcp_server_import"],
    }, "2026-05-09T14:30:00.000Z");

    expect(asset).toMatchObject({
      kind: "builtin_integration",
      status: "recorded",
      metadata: {
        legacy_status: "available",
      },
    });
    expect(toAssetView(asset).execution).toEqual({
      executable: false,
      reason: "asset_record_only",
    });
  });

  it("fails closed for unknown asset kinds", async () => {
    const registry = new AssetRegistry({ baseDir: tmpDir });
    const invalid = {
      id: "unsupported:thing",
      kind: "unsupported",
      label: "Unsupported",
      source_agent: "unknown",
      status: "imported",
    } as unknown as AssetRecordInput;

    await expect(registry.record(invalid)).rejects.toThrow();
    await expect(registry.list()).resolves.toEqual([]);
  });
});
