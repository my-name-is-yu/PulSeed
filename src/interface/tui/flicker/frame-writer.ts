import {
  BSU,
  ESU,
  CURSOR_HOME,
  ERASE_LINE,
  ERASE_SCREEN,
  cursorTo,
  parkCursor,
} from "./dec.js";
import { isSynchronizedOutputSupported } from "./terminal-detect.js";

export interface FrameWriter {
  /** Write a frame to the terminal, wrapped in BSU/ESU with cursor-home */
  write(frame: string, cursorEscape?: string): void;
  /** Request an erase-screen on the next write (deferred into BSU/ESU block) */
  requestErase(): void;
  /** Clean up resources */
  destroy(): void;
}

/**
 * Create a FrameWriter that wraps Ink's stdout output with the
 * BSU/ESU + cursor-home + deferred-erase sequence.
 *
 * Reference: Claude Code src/ink/ink.tsx render loop
 */
export function createFrameWriter(stream: NodeJS.WriteStream): FrameWriter {
  const syncSupported = isSynchronizedOutputSupported();
  // Capture raw write BEFORE any monkey-patching to avoid infinite recursion:
  // entry.ts patches process.stdout.write -> frameWriter.write -> stream.write
  // If stream.write is the patched version, it loops forever.
  const rawWrite = stream.write.bind(stream) as (s: string) => boolean;
  let needsErase = false;
  let destroyed = false;
  let lastLines: string[] | null = null;
  let lastCursorEscape: string | null = null;

  function getTermRows(): number {
    return stream.rows ?? 24;
  }

  function buildFullFrame(frame: string, finalCursor: string): string {
    const prefix = syncSupported ? BSU : "";
    const suffix = syncSupported ? ESU : "";
    const erase = needsErase ? ERASE_SCREEN : "";
    return prefix + erase + CURSOR_HOME + frame + finalCursor + suffix;
  }

  function splitFrame(frame: string): string[] {
    return frame.split("\n");
  }

  function buildDiffFrame(nextLines: string[], finalCursor: string): string {
    const prefix = syncSupported ? BSU : "";
    const suffix = syncSupported ? ESU : "";
    const previousLines = lastLines ?? [];
    const maxLines = Math.max(previousLines.length, nextLines.length);
    let output = "";

    for (let index = 0; index < maxLines; index += 1) {
      const row = index + 1;
      const previousLine = previousLines[index] ?? "";
      const nextLine = nextLines[index] ?? "";

      if (previousLine === nextLine) {
        continue;
      }

      output += cursorTo(row) + ERASE_LINE;
      if (nextLine.length > 0) {
        output += nextLine;
      }
    }

    if (output.length === 0 && lastCursorEscape === finalCursor) {
      return "";
    }

    return prefix + output + finalCursor + suffix;
  }

  return {
    write(frame: string, cursorEscape?: string): void {
      if (destroyed) return;

      const rows = getTermRows();
      const finalCursor = cursorEscape ?? parkCursor(rows);
      const nextLines = splitFrame(frame);
      const shouldRenderFullFrame = needsErase || lastLines === null;
      const output = shouldRenderFullFrame
        ? buildFullFrame(frame, finalCursor)
        : buildDiffFrame(nextLines, finalCursor);

      if (output.length > 0) {
        // Single rawWrite() call for atomicity — bypasses any stdout patches
        rawWrite(output);
      }

      needsErase = false;
      lastLines = nextLines;
      lastCursorEscape = finalCursor;
    },

    requestErase(): void {
      needsErase = true;
      lastLines = null;
      lastCursorEscape = null;
    },

    destroy(): void {
      destroyed = true;
      lastLines = null;
      lastCursorEscape = null;
    },
  };
}
