import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig } from "../../../base/config/global-config.js";
import { cmdConfigSet } from "../commands/config.js";

describe("cmdConfigSet", () => {
  const originalPulseedHome = process.env["PULSEED_HOME"];
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-cli-config-set-"));
    process.env["PULSEED_HOME"] = tmpDir;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts the documented JSON object form for interactive automation", async () => {
    await expect(cmdConfigSet(["interactive_automation", '{"enabled":false,"require_approval":"write"}'])).resolves.toBe(0);

    await expect(loadGlobalConfig()).resolves.toMatchObject({
      interactive_automation: {
        enabled: false,
        require_approval: "write",
        default_desktop_provider: "codex_app",
        default_browser_provider: "manus_browser",
        default_research_provider: "perplexity_research",
      },
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Set interactive_automation ="));
  });

  it("rejects non-object values for object config keys without writing config", async () => {
    await expect(cmdConfigSet(["interactive_automation", "false"])).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith("Error: interactive_automation must be a JSON object");
    await expect(loadGlobalConfig()).resolves.toMatchObject({
      interactive_automation: { enabled: false, require_approval: "always" },
    });
  });

  it("rejects non-boolean values for boolean config keys", async () => {
    await expect(cmdConfigSet(["daemon_mode", "1"])).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith("Error: daemon_mode must be true or false");
    await expect(loadGlobalConfig()).resolves.toMatchObject({ daemon_mode: false });
  });

  it("keeps string config values as strings even when they look numeric", async () => {
    await expect(cmdConfigSet(["workspace_root", "12345"])).resolves.toBe(0);

    await expect(loadGlobalConfig()).resolves.toMatchObject({ workspace_root: "12345" });
  });
});
