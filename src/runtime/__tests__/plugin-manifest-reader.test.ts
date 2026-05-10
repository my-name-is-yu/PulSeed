import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readPluginManifest,
  readPluginManifestSync,
  readRawPluginManifest,
} from "../plugin-manifest-reader.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-plugin-manifest-reader-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("plugin manifest reader", () => {
  it("preserves YAML date-like scalars as JSON-compatible strings", async () => {
    const pluginDir = path.join(tmpDir, "date-like-description");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: date-like-description",
        "version: 1.0.0",
        "type: notifier",
        "capabilities:",
        "  - notify",
        "description: 2026-05-10",
        "permissions:",
        "  shell: false",
        "",
      ].join("\n"),
      "utf-8"
    );

    const raw = await readRawPluginManifest(pluginDir);
    expect(raw).toMatchObject({ ok: true, filename: "plugin.yaml" });
    expect(raw.ok ? raw.value : undefined).toMatchObject({ description: "2026-05-10" });
    expect(raw.ok ? (raw.value as { description: unknown }).description : undefined).not.toBeInstanceOf(Date);

    const asyncManifest = await readPluginManifest(pluginDir);
    expect(asyncManifest).toMatchObject({ ok: true });
    expect(asyncManifest.ok ? asyncManifest.data.description : undefined).toBe("2026-05-10");

    const syncManifest = readPluginManifestSync(pluginDir);
    expect(syncManifest).toMatchObject({ ok: true });
    expect(syncManifest.ok ? syncManifest.data.description : undefined).toBe("2026-05-10");
  });

  it("reports the first manifest parse failure instead of falling through to another file", async () => {
    const pluginDir = path.join(tmpDir, "invalid-yaml-with-json-fallback");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "plugin.yaml"), "{", "utf-8");
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "valid-json",
        version: "1.0.0",
        type: "notifier",
        capabilities: ["notify"],
        description: "valid fallback",
      }),
      "utf-8"
    );

    const result = await readPluginManifest(pluginDir);
    expect(result).toMatchObject({
      ok: false,
      failure: "parse",
      filename: "plugin.yaml",
    });
  });
});
