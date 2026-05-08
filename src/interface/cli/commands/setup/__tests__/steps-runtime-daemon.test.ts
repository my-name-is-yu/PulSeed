import { beforeEach, describe, expect, it, vi } from "vitest";

const confirmMock = vi.fn();
const selectMock = vi.fn();
const textMock = vi.fn();
const logWarnMock = vi.fn();
const isDaemonRunningMock = vi.fn();
const isPortAvailableMock = vi.fn();
const findAvailablePortMock = vi.fn();
const getProcessOnPortMock = vi.fn();

vi.mock("@clack/prompts", () => ({
  confirm: confirmMock,
  select: selectMock,
  text: textMock,
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: logWarnMock,
  },
}));

vi.mock("../../../../../runtime/daemon/client.js", () => ({
  isDaemonRunning: isDaemonRunningMock,
}));

vi.mock("../../../../../runtime/port-utils.js", () => ({
  DEFAULT_PORT: 41700,
  findAvailablePort: findAvailablePortMock,
  getProcessOnPort: getProcessOnPortMock,
  isPortAvailable: isPortAvailableMock,
}));

vi.mock("../../../../../runtime/pid-manager.js", () => ({
  PIDManager: vi.fn().mockImplementation(() => ({
    stopRuntime: vi.fn(async () => ({ stopped: true })),
  })),
}));

describe("stepDaemon custom port selection", () => {
  beforeEach(() => {
    vi.resetModules();
    confirmMock.mockReset();
    selectMock.mockReset();
    textMock.mockReset();
    logWarnMock.mockReset();
    isDaemonRunningMock.mockReset();
    isPortAvailableMock.mockReset();
    findAvailablePortMock.mockReset();
    getProcessOnPortMock.mockReset();

    isDaemonRunningMock.mockResolvedValue({ running: false, port: 41700 });
    confirmMock.mockResolvedValue(true);
    selectMock.mockResolvedValue("custom");
    isPortAvailableMock.mockResolvedValue(true);
  });

  it("retries partial numeric custom ports instead of truncating them", async () => {
    textMock.mockImplementationOnce(async (options: { validate?: (value: string) => string | undefined }) => {
      return options.validate?.("41700abc") === undefined ? "41700abc" : "41701";
    });
    const { stepDaemon } = await import("../steps-runtime.js");

    const result = await stepDaemon();

    expect(result).toEqual({ start: true, port: 41701 });
    expect(isPortAvailableMock).toHaveBeenCalledWith(41701);
    expect(isPortAvailableMock).not.toHaveBeenCalledWith(Number.NaN);
  });

  it("parses only exact daemon setup ports in the valid range", async () => {
    const { parseSetupDaemonPort } = await import("../steps-runtime.js");

    expect(parseSetupDaemonPort("41700")).toBe(41700);
    expect(parseSetupDaemonPort(" 41700 ")).toBe(41700);
    expect(parseSetupDaemonPort("41700abc")).toBeUndefined();
    expect(parseSetupDaemonPort("41700.5")).toBeUndefined();
    expect(parseSetupDaemonPort("1023")).toBeUndefined();
    expect(parseSetupDaemonPort("65536")).toBeUndefined();
  });
});
