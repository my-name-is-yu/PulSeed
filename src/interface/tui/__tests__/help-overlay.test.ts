import React from "react";
import { Writable } from "node:stream";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpOverlay } from "../help-overlay.js";

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
  };
});

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

describe("HelpOverlay natural-language section", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows natural-language examples before the command catalog", async () => {
    const stdout = createCapturedStdout();

    const screen = render(React.createElement(HelpOverlay, { onDismiss: vi.fn() }), {
      patchConsole: false,
      debug: true,
      stdout,
      stderr: process.stderr,
    });

    await flush();
    const frame = stdout.readOutput();

    expect(frame).toContain("START NATURALLY");
    expect(frame).toContain("Describe the outcome you want");
    expect(frame).toContain("COMMANDS FOR EXACT CONTROL");
    expect(frame.indexOf("START NATURALLY")).toBeLessThan(frame.indexOf("COMMANDS FOR EXACT CONTROL"));

    screen.unmount();
  });
});
