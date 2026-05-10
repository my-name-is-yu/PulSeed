import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as InkModule from "ink";
import { FlickerOverlay } from "../flicker-overlay.js";
import { SettingsOverlay } from "../settings-overlay.js";

const originalPulseedHome = process.env["PULSEED_HOME"];

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof InkModule>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
  };
});

async function withUnreadableConfig<T>(run: () => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-tui-config-"));
  process.env["PULSEED_HOME"] = tmpDir;
  try {
    await fs.mkdir(path.join(tmpDir, "config.json"));
    return await run();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createCapturedStdout(): NodeJS.WriteStream & { readOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream & { readOutput: () => string };

  stream.columns = 80;
  stream.rows = 24;
  stream.isTTY = true;
  stream.readOutput = () => output;
  return stream;
}

afterEach(() => {
  if (originalPulseedHome === undefined) {
    delete process.env["PULSEED_HOME"];
  } else {
    process.env["PULSEED_HOME"] = originalPulseedHome;
  }
  vi.restoreAllMocks();
});

describe("settings overlays", () => {
  it("keeps the flicker overlay renderable when config reads fail", async () => {
    await withUnreadableConfig(async () => {
      const stdout = createCapturedStdout();
      const screen = render(React.createElement(FlickerOverlay, { onClose: vi.fn() }), {
        patchConsole: false,
        debug: true,
        stdout,
        stderr: process.stderr,
      });

      await flush();
      const output = stdout.readOutput();

      expect(output).toContain("No-Flicker Mode");
      expect(output).toContain("On");
      expect(output).toContain("✓");

      screen.unmount();
    });
  });

  it("keeps the settings overlay renderable when config reads fail", async () => {
    await withUnreadableConfig(async () => {
      const stdout = createCapturedStdout();
      const screen = render(React.createElement(SettingsOverlay, { onClose: vi.fn() }), {
        patchConsole: false,
        debug: true,
        stdout,
        stderr: process.stderr,
      });

      await flush();
      const output = stdout.readOutput();

      expect(output).toContain("Settings");
      expect(output).toContain("Background Mode");
      expect(output).toContain("Keep PulSeed working in the background");
      expect(output).toContain("[OFF]");
      expect(output).not.toContain("Daemon Mode");
      expect(output).not.toContain("CoreLoop");

      screen.unmount();
    });
  });
});
