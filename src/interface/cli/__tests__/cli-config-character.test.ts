import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { StateManager } from "../../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { DEFAULT_CHARACTER_CONFIG } from "../../../base/types/character.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

const { cliLoggerMock } = vi.hoisted(() => ({
  cliLoggerMock: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../cli-logger.js", () => ({
  getCliLogger: vi.fn(() => cliLoggerMock),
}));

import { cmdConfigCharacter } from "../commands/config.js";

describe("cmdConfigCharacter", () => {
  let tmpDir: string;
  let manager: CharacterConfigManager;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-config-character-");
    manager = new CharacterConfigManager(new StateManager(tmpDir));
    cliLoggerMock.error.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDir(tmpDir);
  });

  it("persists exact character level flags", async () => {
    const code = await cmdConfigCharacter(manager, [
      "--caution-level",
      "4",
      "--proactivity-level",
      "5",
    ]);

    expect(code).toBe(0);
    await expect(manager.load()).resolves.toMatchObject({
      caution_level: 4,
      proactivity_level: 5,
    });
  });

  it.each([
    ["partial numeric token", ["--caution-level", "3abc"], "3abc"],
    ["decimal value", ["--stall-flexibility", "1.5"], "1.5"],
    ["zero", ["--communication-directness", "0"], "0"],
    ["above range", ["--proactivity-level", "6"], "6"],
  ])("rejects invalid character level before persisting: %s", async (_label, argv, raw) => {
    const code = await cmdConfigCharacter(manager, argv);

    expect(code).toBe(1);
    expect(cliLoggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining(`must be an integer between 1 and 5 (got: ${raw})`)
    );
    expect(fs.existsSync(path.join(tmpDir, "character-config.json"))).toBe(false);
    await expect(manager.load()).resolves.toEqual(DEFAULT_CHARACTER_CONFIG);
  });

  it("returns 1 for a bare level flag instead of falling back to usage", async () => {
    const code = await cmdConfigCharacter(manager, ["--caution-level"]);

    expect(code).toBe(1);
    expect(cliLoggerMock.error).toHaveBeenCalledWith(
      "Error: --caution-level must be an integer between 1 and 5 (got: )"
    );
    expect(fs.existsSync(path.join(tmpDir, "character-config.json"))).toBe(false);
  });
});
