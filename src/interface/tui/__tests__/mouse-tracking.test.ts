import { describe, expect, it, vi } from "vitest";
import { attachMouseTracking, isMouseTrackingEnabled } from "../flicker/MouseTracking.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "../flicker/dec.js";

function createMockStream(): NodeJS.WriteStream & { _written: string[] } {
  const written: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    _written: written,
  } as unknown as NodeJS.WriteStream & { _written: string[] };
}

describe("mouse tracking", () => {
  it("enables mouse tracking by default for no-flicker fullscreen rendering", () => {
    const original = process.env.PULSEED_MOUSE_TRACKING;
    const originalDisable = process.env.PULSEED_DISABLE_MOUSE;
    delete process.env.PULSEED_MOUSE_TRACKING;
    delete process.env.PULSEED_DISABLE_MOUSE;

    try {
      expect(isMouseTrackingEnabled(true)).toBe(true);
      expect(isMouseTrackingEnabled(false)).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.PULSEED_MOUSE_TRACKING;
      } else {
        process.env.PULSEED_MOUSE_TRACKING = original;
      }
      if (originalDisable === undefined) {
        delete process.env.PULSEED_DISABLE_MOUSE;
      } else {
        process.env.PULSEED_DISABLE_MOUSE = originalDisable;
      }
    }
  });

  it("allows mouse tracking to be explicitly enabled", () => {
    const original = process.env.PULSEED_MOUSE_TRACKING;
    process.env.PULSEED_MOUSE_TRACKING = "1";

    try {
      expect(isMouseTrackingEnabled()).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.PULSEED_MOUSE_TRACKING;
      } else {
        process.env.PULSEED_MOUSE_TRACKING = original;
      }
    }
  });

  it("allows mouse capture to be explicitly disabled", () => {
    const original = process.env.PULSEED_MOUSE_TRACKING;
    const originalDisable = process.env.PULSEED_DISABLE_MOUSE;
    process.env.PULSEED_MOUSE_TRACKING = "1";
    process.env.PULSEED_DISABLE_MOUSE = "1";

    try {
      expect(isMouseTrackingEnabled(true)).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.PULSEED_MOUSE_TRACKING;
      } else {
        process.env.PULSEED_MOUSE_TRACKING = original;
      }
      if (originalDisable === undefined) {
        delete process.env.PULSEED_DISABLE_MOUSE;
      } else {
        process.env.PULSEED_DISABLE_MOUSE = originalDisable;
      }
    }
  });

  it("enables mouse tracking on attach and disables it on cleanup", () => {
    const stream = createMockStream();

    const cleanup = attachMouseTracking(stream);

    expect(stream.write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING);
    expect(stream._written).toContain(ENABLE_MOUSE_TRACKING);

    cleanup();

    expect(stream._written.at(-1)).toBe(DISABLE_MOUSE_TRACKING);
  });
});
