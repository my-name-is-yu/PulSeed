import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchCommand } from "../cli-command-registry.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import type { CoreLoop } from "../../../orchestrator/loop/durable-loop.js";

describe("cron command dispatch", () => {
  let tmpDir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cli-cron-test-"));
    process.env["PULSEED_HOME"] = tmpDir;
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message ?? ""));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["PULSEED_HOME"];
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  function dispatch(args: string[]): Promise<number> {
    return dispatchCommand(
      args,
      false,
      {} as StateManager,
      {} as CharacterConfigManager,
      { value: null } as { value: CoreLoop | null },
      tmpDir,
    );
  }

  it("emits top-level cron entries for exact positive integer intervals", async () => {
    const code = await dispatch(["cron", "--goal", "goal-1", "--interval", "15"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("*/15 * * * * /usr/bin/env pulseed run --goal goal-1");
    expect(errors).toEqual([]);
  });

  it("rejects partially parsed top-level cron intervals", async () => {
    const code = await dispatch(["cron", "--goal", "goal-1", "--interval", "15abc"]);

    expect(code).toBe(1);
    expect(logs.join("\n")).not.toContain("pulseed run --goal");
    expect(errors.join("\n")).toContain("--interval must be a positive integer");
  });

  it("propagates invalid daemon cron intervals as a failed command", async () => {
    const code = await dispatch(["daemon", "cron", "--goal", "goal-1", "--interval", "15abc"]);

    expect(code).toBe(1);
    expect(logs.join("\n")).not.toContain("pulseed run --goal");
    expect(errors.join("\n")).toContain("--interval must be a positive integer");
  });

  it("returns a failed command for missing goals without exiting the process", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`unexpected process.exit(${code ?? ""})`);
    }) as never);

    const code = await dispatch(["cron", "--interval", "15"]);

    expect(code).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("at least one --goal is required");
  });
});
