import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const originalPulseedHome = process.env["PULSEED_HOME"];

async function withTempPulseedHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-config-"));
  process.env["PULSEED_HOME"] = tmpDir;
  try {
    return await run(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (originalPulseedHome === undefined) {
    delete process.env["PULSEED_HOME"];
  } else {
    process.env["PULSEED_HOME"] = originalPulseedHome;
  }
});

describe("loadGlobalConfig", () => {
  it("defaults no_flicker to true when config file is absent", async () => {
    await withTempPulseedHome(async () => {
      const { loadGlobalConfig } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({
        daemon_mode: false,
        no_flicker: true,
        workspace_root: expect.stringContaining("PulSeedWorkspaces"),
        interactive_automation: {
          enabled: false,
          default_desktop_provider: "codex_app",
          default_browser_provider: "manus_browser",
          default_research_provider: "perplexity_research",
          require_approval: "always",
        },
      });
    });
  });

  it("does not share nested default arrays across async loads", async () => {
    await withTempPulseedHome(async () => {
      const { loadGlobalConfig } = await import("../global-config.js");

      const first = await loadGlobalConfig();
      first.interactive_automation.allowed_apps.push("Mutated App");
      first.interactive_automation.denied_apps.push("Mutated Protected App");

      await expect(loadGlobalConfig()).resolves.toMatchObject({
        interactive_automation: {
          allowed_apps: [],
          denied_apps: [
            "Password Manager",
            "Banking",
            "System Settings",
          ],
        },
      });
    });
  });

  it("does not share nested default arrays across sync loads", async () => {
    await withTempPulseedHome(async () => {
      const { loadGlobalConfigSync } = await import("../global-config.js");

      const first = loadGlobalConfigSync();
      first.interactive_automation.allowed_apps.push("Mutated App");
      first.interactive_automation.denied_apps.push("Mutated Protected App");

      expect(loadGlobalConfigSync()).toMatchObject({
        interactive_automation: {
          allowed_apps: [],
          denied_apps: [
            "Password Manager",
            "Banking",
            "System Settings",
          ],
        },
      });
    });
  });

  it("preserves an explicit false no_flicker setting from config.json", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ no_flicker: false }, null, 2),
        "utf8",
      );

      const { loadGlobalConfig } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({
        daemon_mode: false,
        no_flicker: false,
        interactive_automation: {
          enabled: false,
        },
      });
    });
  });

  it("uses defaults for malformed JSON but surfaces real read errors", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(path.join(tmpDir, "config.json"), "{not json", "utf8");

      const { loadGlobalConfig, loadGlobalConfigSync } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({ no_flicker: true });
      expect(loadGlobalConfigSync()).toMatchObject({ no_flicker: true });

      await fs.rm(path.join(tmpDir, "config.json"));
      await fs.mkdir(path.join(tmpDir, "config.json"));

      await expect(loadGlobalConfig()).rejects.toMatchObject({ code: "EISDIR" });
      expect(() => loadGlobalConfigSync()).toThrow(/EISDIR/);
    });
  });

  it("rejects oversized config.json instead of replacing it with defaults", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      const {
        GLOBAL_CONFIG_MAX_BYTES,
        loadGlobalConfig,
        loadGlobalConfigSync,
      } = await import("../global-config.js");
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          no_flicker: false,
          padding: "x".repeat(GLOBAL_CONFIG_MAX_BYTES),
        }),
        "utf8",
      );

      await expect(loadGlobalConfig()).rejects.toMatchObject({
        code: "ERR_PULSEED_TEXT_FILE_SIZE_LIMIT",
      });
      expect(() => loadGlobalConfigSync()).toThrow(/exceeds/);
    });
  });

  it("rejects writes that would exceed the read limit", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      const { DEFAULT_CONFIG, GLOBAL_CONFIG_MAX_BYTES, saveGlobalConfig } = await import("../global-config.js");

      await expect(saveGlobalConfig({
        ...DEFAULT_CONFIG,
        interactive_automation: {
          ...DEFAULT_CONFIG.interactive_automation,
          allowed_apps: ["x".repeat(GLOBAL_CONFIG_MAX_BYTES)],
        },
      })).rejects.toMatchObject({
        code: "ERR_PULSEED_TEXT_FILE_SIZE_LIMIT",
      });
      await expect(fs.access(path.join(tmpDir, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves interactive automation settings from config.json", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            default_desktop_provider: "codex_app",
            require_approval: "write",
            denied_apps: ["Bank"],
          },
        }, null, 2),
        "utf8",
      );

      const { getConfigKeys, loadGlobalConfig } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({
        interactive_automation: {
          enabled: true,
          default_desktop_provider: "codex_app",
          default_browser_provider: "manus_browser",
          default_research_provider: "perplexity_research",
          require_approval: "write",
          denied_apps: ["Bank"],
        },
      });
      expect(getConfigKeys()).toContain("interactive_automation");
    });
  });

  it("loads interactive automation settings synchronously for tool registration", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            denied_apps: ["Protected App"],
          },
        }, null, 2),
        "utf8",
      );

      const { loadGlobalConfigSync } = await import("../global-config.js");
      expect(loadGlobalConfigSync()).toMatchObject({
        interactive_automation: {
          enabled: true,
          denied_apps: ["Protected App"],
        },
      });
    });
  });
});
