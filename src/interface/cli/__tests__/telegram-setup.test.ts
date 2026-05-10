import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const readlineState = vi.hoisted(() => ({
  answers: [] as string[],
  close: vi.fn(),
}));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_question: string, callback: (answer: string) => void) => {
      callback(readlineState.answers.shift() ?? "");
    }),
    close: readlineState.close,
  })),
}));

describe("cmdTelegramSetup", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-telegram-setup-test-"));
    process.env["PULSEED_HOME"] = tmpDir;
    fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 42, first_name: "PulSeed", username: "pulseed_bot" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    readlineState.close.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env["PULSEED_HOME"];
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("prints parent command help without launching setup", async () => {
    const { cmdTelegram } = await import("../commands/telegram.js");

    const result = await cmdTelegram(["--help"]);
    const output = vi.mocked(console.log).mock.calls.map((call) => call.join(" ")).join("\n");

    expect(result).toBe(0);
    expect(output).toContain("Usage: pulseed telegram <command>");
    expect(output).toContain("pulseed telegram setup");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readlineState.close).not.toHaveBeenCalled();
  });

  it("prints setup help without prompting or verifying a token", async () => {
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const flagResult = await cmdTelegramSetup(["--help"]);
    const subcommandResult = await cmdTelegramSetup(["help"]);
    const output = vi.mocked(console.log).mock.calls.map((call) => call.join(" ")).join("\n");

    expect(flagResult).toBe(0);
    expect(subcommandResult).toBe(0);
    expect(output).toContain("Usage: pulseed telegram setup");
    expect(output).toContain("Bot token from @BotFather");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readlineState.close).not.toHaveBeenCalled();
  });

  it("writes optional identity_key for cross-platform continuation", async () => {
    readlineState.answers = ["test-token", "777,888", "999", "", "personal"];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottest-token/getMe");
    expect(readlineState.close).toHaveBeenCalledTimes(1);

    const configPath = path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json");
    const config = JSON.parse(await fsp.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      bot_token: "test-token",
      allowed_user_ids: [777, 888],
      runtime_control_allowed_user_ids: [999],
      allow_all: false,
      polling_timeout: 30,
      identity_key: "personal",
    });
    expect(config.chat_id).toBeUndefined();
  });

  it("requires explicit unrestricted-mode confirmation when allowed users are blank", async () => {
    readlineState.answers = ["test-token", "", "ALLOW ALL", "", "", ""];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(0);
    const configPath = path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json");
    const config = JSON.parse(await fsp.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      allowed_user_ids: [],
      runtime_control_allowed_user_ids: [],
      allow_all: true,
    });
  });

  it("keeps access closed for first-use /sethome binding when unrestricted mode is not confirmed", async () => {
    readlineState.answers = ["test-token", "", "", "", "", ""];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(0);
    const configPath = path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json");
    const config = JSON.parse(await fsp.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      allowed_user_ids: [],
      runtime_control_allowed_user_ids: [],
      allow_all: false,
    });
  });

  it("rejects partially parsed allowed user IDs before writing config", async () => {
    readlineState.answers = ["test-token", "777abc"];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(1);
    expect(readlineState.close).toHaveBeenCalledTimes(1);
    const configPath = path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("rejects partially parsed runtime-control user IDs before writing config", async () => {
    readlineState.answers = ["test-token", "777", "999abc"];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(1);
    expect(readlineState.close).toHaveBeenCalledTimes(1);
    const configPath = path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("rejects partially parsed home chat IDs before writing config", async () => {
    readlineState.answers = ["test-token", "777", "999", "123abc"];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(1);
    expect(readlineState.close).toHaveBeenCalledTimes(1);
    const configPath = path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
