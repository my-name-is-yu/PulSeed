#!/usr/bin/env node

import os from "os";
import { execFileSync } from "node:child_process";
import React from "react";
import { render } from "ink";
import { TUITestApp } from "./test-app.js";
import { buildCursorEscapeFromPromptAnchor, buildHiddenCursorEscapeFromCaretMarker, getActiveCursorEscape } from "./cursor-tracker.js";
import { resetTuiDebugLog, getTuiDebugLogPath, logTuiDebug } from "./debug-log.js";
import {
  MouseTracking,
  createFrameWriter,
  isNoFlickerEnabled,
  type FrameWriter,
} from "./flicker/index.js";
import { DEFAULT_CURSOR_STYLE, HIDE_CURSOR, SHOW_CURSOR, STEADY_BAR_CURSOR } from "./flicker/dec.js";
import { isRenderableFrameChunk } from "./render-output.js";

function getCwd(): string {
  const raw = process.cwd();
  const home = os.homedir();
  return raw.startsWith(home) ? "~" + raw.slice(home.length) : raw;
}

function getGitBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

export async function startTUITest(): Promise<void> {
  if (!process.env.PULSEED_TUI_DEBUG_LOG) {
    process.env.PULSEED_TUI_DEBUG_LOG = "1";
  }
  resetTuiDebugLog();
  logTuiDebug("test-entry", "start", { logPath: getTuiDebugLogPath() });

  const noFlicker = await isNoFlickerEnabled();
  let frameWriter: FrameWriter | undefined;

  if (noFlicker) {
    frameWriter = createFrameWriter(process.stdout);
    frameWriter.requestErase();
    process.stdout.write(STEADY_BAR_CURSOR + HIDE_CURSOR);
    process.stdout.on("resize", () => frameWriter?.requestErase());

    const rawWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk: any, ...args: any[]) {
      if (typeof chunk === "string" && isRenderableFrameChunk(chunk)) {
        const cursorEscape =
          buildHiddenCursorEscapeFromCaretMarker(chunk) ??
          buildCursorEscapeFromPromptAnchor(chunk) ??
          getActiveCursorEscape() ??
          HIDE_CURSOR;
        frameWriter!.write(chunk, cursorEscape);
        return true;
      }

      return (rawWrite as any)(chunk, ...args);
    } as typeof process.stdout.write;
  }

  const appElement = React.createElement(TUITestApp, {
    cwd: getCwd(),
    gitBranch: getGitBranch(),
    noFlicker,
  });

  const { waitUntilExit } = render(
    React.createElement(
      MouseTracking,
      null,
      appElement,
    ),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  if (noFlicker) {
    process.stdout.write(DEFAULT_CURSOR_STYLE + SHOW_CURSOR);
  }
  frameWriter?.destroy();
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("test-entry.js") ||
    process.argv[1].endsWith("test-entry.ts"));

if (isMain) {
  startTUITest().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
