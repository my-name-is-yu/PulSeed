import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFrameWriter } from "../flicker/frame-writer.js";
import { BSU, ESU, CURSOR_HOME, ERASE_SCREEN } from "../flicker/dec.js";

// Mock terminal-detect to control sync support
vi.mock("../flicker/terminal-detect.js", () => ({
  isSynchronizedOutputSupported: vi.fn(() => true),
}));

import { isSynchronizedOutputSupported } from "../flicker/terminal-detect.js";

function createMockStream(rows = 24): NodeJS.WriteStream {
  const written: string[] = [];
  return {
    rows,
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    _written: written,
  } as unknown as NodeJS.WriteStream & { _written: string[] };
}

describe("frame-writer", () => {
  beforeEach(() => {
    vi.mocked(isSynchronizedOutputSupported).mockReturnValue(true);
  });

  it("wraps frame with BSU + CURSOR_HOME + frame + parkCursor + ESU", () => {
    const stream = createMockStream(24);
    const fw = createFrameWriter(stream);

    fw.write("hello");

    expect(stream.write).toHaveBeenCalledTimes(1);
    const output = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(output).toBe(BSU + CURSOR_HOME + "hello" + "[24;1H" + ESU);
  });

  it("includes ERASE_SCREEN after requestErase()", () => {
    const stream = createMockStream(24);
    const fw = createFrameWriter(stream);

    fw.requestErase();
    fw.write("content");

    const output = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(output).toBe(BSU + ERASE_SCREEN + CURSOR_HOME + "content" + "[24;1H" + ESU);
  });

  it("clears needsErase after one write", () => {
    const stream = createMockStream(24);
    const fw = createFrameWriter(stream);

    fw.requestErase();
    fw.write("first");
    fw.write("second");

    const first = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const second = (stream.write as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(first).toContain(ERASE_SCREEN);
    expect(second).not.toContain(ERASE_SCREEN);
  });

  it("omits BSU/ESU when sync not supported", () => {
    vi.mocked(isSynchronizedOutputSupported).mockReturnValue(false);
    const stream = createMockStream(24);
    const fw = createFrameWriter(stream);

    fw.write("hello");

    const output = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(output).toBe(CURSOR_HOME + "hello" + "[24;1H");
    expect(output).not.toContain(BSU);
    expect(output).not.toContain(ESU);
  });

  it("uses stream.rows for park cursor position", () => {
    const stream = createMockStream(40);
    const fw = createFrameWriter(stream);

    fw.write("x");

    const output = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(output).toContain("[40;1H");
  });

  it("does nothing after destroy()", () => {
    const stream = createMockStream(24);
    const fw = createFrameWriter(stream);

    fw.destroy();
    fw.write("should not appear");

    expect(stream.write).not.toHaveBeenCalled();
  });

  it("defaults to 24 rows when stream.rows is undefined", () => {
    const stream = createMockStream(undefined as unknown as number);
    (stream as any).rows = undefined;
    const fw = createFrameWriter(stream);

    fw.write("x");

    const output = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(output).toContain("[24;1H");
  });
});
