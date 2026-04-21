import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const multiselectMock = vi.fn();
const textMock = vi.fn();
const confirmMock = vi.fn();
const noteMock = vi.fn();
const introMock = vi.fn();
const outroMock = vi.fn();
const cancelMock = vi.fn();
const logInfoMock = vi.fn();
const logSuccessMock = vi.fn();
const logWarnMock = vi.fn();

const isDaemonRunningMock = vi.fn(async () => ({ running: false, port: 41700 }));

vi.mock("@clack/prompts", () => ({
  multiselect: multiselectMock,
  text: textMock,
  confirm: confirmMock,
  note: noteMock,
  intro: introMock,
  outro: outroMock,
  cancel: cancelMock,
  log: {
    info: logInfoMock,
    success: logSuccessMock,
    warn: logWarnMock,
  },
  isCancel: vi.fn(() => false),
}));

vi.mock("../../../runtime/daemon/client.js", () => ({
  isDaemonRunning: isDaemonRunningMock,
}));

vi.mock("../../../runtime/pid-manager.js", () => ({
  PIDManager: vi.fn().mockImplementation(() => ({
    stopRuntime: vi.fn(async () => ({ stopped: true })),
  })),
}));

describe("cmdGatewaySetup", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-gateway-setup-test-"));
    process.env["PULSEED_HOME"] = tmpDir;
    multiselectMock.mockReset();
    textMock.mockReset();
    confirmMock.mockReset();
    noteMock.mockReset();
    introMock.mockReset();
    outroMock.mockReset();
    cancelMock.mockReset();
    logInfoMock.mockReset();
    logSuccessMock.mockReset();
    logWarnMock.mockReset();
    isDaemonRunningMock.mockClear();
    fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 42, first_name: "PulSeed", username: "pulseed_bot" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env["PULSEED_HOME"];
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes selected Telegram and Signal core gateway configs", async () => {
    multiselectMock.mockResolvedValue(["telegram-bot", "signal-bridge"]);
    textMock
      .mockResolvedValueOnce("test-token")
      .mockResolvedValueOnce("777,888")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("personal")
      .mockResolvedValueOnce("http://127.0.0.1:8080")
      .mockResolvedValueOnce("+15550001111")
      .mockResolvedValueOnce("+15550001111")
      .mockResolvedValueOnce("+15550002222,+15550003333")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("personal")
      .mockResolvedValueOnce("5000")
      .mockResolvedValueOnce("2000");

    const { cmdGatewaySetup } = await import("../commands/gateway.js");
    const code = await cmdGatewaySetup([]);

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottest-token/getMe");

    const telegramConfig = JSON.parse(
      await fsp.readFile(path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(telegramConfig).toMatchObject({
      bot_token: "test-token",
      allowed_user_ids: [777, 888],
      runtime_control_allowed_user_ids: [777, 888],
      allow_all: false,
      polling_timeout: 30,
      identity_key: "personal",
    });
    expect(telegramConfig.chat_id).toBeUndefined();

    const signalConfig = JSON.parse(
      await fsp.readFile(path.join(tmpDir, "gateway", "channels", "signal-bridge", "config.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(signalConfig).toMatchObject({
      bridge_url: "http://127.0.0.1:8080",
      account: "+15550001111",
      recipient_id: "+15550001111",
      allowed_sender_ids: ["+15550002222", "+15550003333"],
      runtime_control_allowed_sender_ids: ["+15550002222", "+15550003333"],
      allowed_conversation_ids: [],
      identity_key: "personal",
      poll_interval_ms: 5000,
      receive_timeout_ms: 2000,
    });
    expect(logInfoMock).toHaveBeenCalledWith(
      "Gateway configs were saved. Run `pulseed setup` or `pulseed daemon start` when you are ready."
    );
  }, 15000);

  it("exits cleanly when no platform is selected", async () => {
    multiselectMock.mockResolvedValue([]);

    const { cmdGatewaySetup } = await import("../commands/gateway.js");
    const code = await cmdGatewaySetup([]);

    expect(code).toBe(0);
    expect(textMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, "gateway", "channels"))).toBe(false);
    expect(outroMock).toHaveBeenCalledWith("No gateway changes made.");
  }, 15000);
});
