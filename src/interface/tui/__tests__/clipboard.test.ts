import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";
import { copyToClipboard } from "../clipboard.js";
import { setTrustedTuiControlStream } from "../terminal-output.js";

function makeFakeProc(exitCode: number) {
  const proc = new EventEmitter() as any;
  proc.stdin = { end: vi.fn() };
  setTimeout(() => proc.emit("close", exitCode), 0);
  return proc;
}

describe("copyToClipboard", () => {
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  const originalPlatform = process.platform;
  const originalTmux = process.env.TMUX;

  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env.TMUX;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
    setTrustedTuiControlStream(null);
  });

  it("macOS: calls pbcopy and reports the copy method on success", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    spawnMock.mockReturnValue(makeFakeProc(0));

    const result = await copyToClipboard("hello");

    expect(result).toEqual({ ok: true, method: "pbcopy" });
    expect(spawnMock).toHaveBeenCalledWith("pbcopy", [], expect.any(Object));
  });

  it("Linux: calls xclip and reports the copy method on success", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    spawnMock.mockReturnValue(makeFakeProc(0));

    const result = await copyToClipboard("hello");

    expect(result).toEqual({ ok: true, method: "xclip" });
    expect(spawnMock).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], expect.any(Object));
  });

  it("Linux: falls back to xsel when xclip fails", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    spawnMock
      .mockReturnValueOnce(makeFakeProc(1))
      .mockReturnValueOnce(makeFakeProc(0));

    const result = await copyToClipboard("hello");

    expect(result).toEqual({ ok: true, method: "xsel" });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "xsel", ["--clipboard", "--input"], expect.any(Object));
  });

  it("Linux: falls back to OSC52 when xclip and xsel fail", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    spawnMock
      .mockReturnValueOnce(makeFakeProc(1))
      .mockReturnValueOnce(makeFakeProc(1));
    const write = vi.fn(() => true);
    setTrustedTuiControlStream({ write } as any);

    const result = await copyToClipboard("hello");

    expect(result).toEqual({ ok: true, method: "osc52" });
    expect(write).toHaveBeenCalledWith("\u001b]52;c;aGVsbG8=\u0007");
  });

  it("tmux: writes to the tmux paste buffer before platform clipboards", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.TMUX = "/tmp/tmux-501/default,12345,0";
    spawnMock.mockReturnValue(makeFakeProc(0));

    const result = await copyToClipboard("test");

    expect(result).toEqual({ ok: true, method: "tmux" });
    expect(spawnMock).toHaveBeenCalledWith("tmux", ["load-buffer", "-"], expect.any(Object));
  });

  it("fallback: writes a complete OSC52 clipboard sequence", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const write = vi.fn(() => true);
    setTrustedTuiControlStream({ write } as any);

    const result = await copyToClipboard("hello");

    expect(result).toEqual({ ok: true, method: "osc52" });
    expect(write).toHaveBeenCalledWith("\u001b]52;c;aGVsbG8=\u0007");
  });
});
