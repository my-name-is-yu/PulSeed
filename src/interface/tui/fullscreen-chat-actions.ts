import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { ClipboardResult } from "./clipboard.js";
import type { ChatMessage } from "./chat/types.js";
import { writeTrustedTuiControl } from "./terminal-output.js";
import {
  CURSOR_HOME,
  ENTER_ALT_SCREEN,
  ERASE_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./flicker/dec.js";
import { formatTranscript } from "./fullscreen-chat-render.js";

export function getPreviousOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = offset - 1;
  const previousCode = text.charCodeAt(previous);
  if (
    previous > 0 &&
    previousCode >= 0xdc00 &&
    previousCode <= 0xdfff
  ) {
    const lead = text.charCodeAt(previous - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) {
      return previous - 1;
    }
  }
  return previous;
}

export function getNextOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const code = text.charCodeAt(offset);
  if (
    offset + 1 < text.length &&
    code >= 0xd800 &&
    code <= 0xdbff
  ) {
    const trail = text.charCodeAt(offset + 1);
    if (trail >= 0xdc00 && trail <= 0xdfff) {
      return offset + 2;
    }
  }
  return offset + 1;
}

export function isBackspaceInput(
  inputChar: string,
  key: { backspace?: boolean; delete?: boolean; ctrl?: boolean },
): boolean {
  return (
    key.backspace === true ||
    inputChar === "\u007f" ||
    inputChar === "\b" ||
    (key.ctrl === true && inputChar === "h") ||
    (key.delete === true && inputChar === "")
  );
}

export function isDeleteInput(inputChar: string, _key: { delete?: boolean }): boolean {
  return inputChar === "[3~" || inputChar === "\u001b[3~";
}

export function summarizeKey(key: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(key).filter(([, value]) => value === true),
  );
}

export function openClickableTarget(target: string): boolean {
  if (/^https?:\/\//.test(target)) {
    if (process.platform === "darwin") {
      return spawnSync("open", [target], { stdio: "ignore" }).status === 0;
    }
    if (process.platform === "linux") {
      return spawnSync("xdg-open", [target], { stdio: "ignore" }).status === 0;
    }
    return false;
  }

  const [filePart, linePart] = target.split(/:(\d+)$/);
  const resolvedPath = path.resolve(process.cwd(), filePart || target);
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    const editorTarget = linePart ? `${resolvedPath}:${linePart}` : resolvedPath;
    return spawnSync(editor, [editorTarget], { stdio: "ignore", shell: true }).status === 0;
  }
  if (process.platform === "darwin") {
    return spawnSync("open", [resolvedPath], { stdio: "ignore" }).status === 0;
  }
  if (process.platform === "linux") {
    return spawnSync("xdg-open", [resolvedPath], { stdio: "ignore" }).status === 0;
  }
  return false;
}

export function writeTranscriptToNativeScrollback(messages: ChatMessage[]): void {
  const transcript = formatTranscript(messages);
  writeTrustedTuiControl(
    SHOW_CURSOR +
      EXIT_ALT_SCREEN +
      `\n${transcript}\n` +
      ENTER_ALT_SCREEN +
      ERASE_SCREEN +
      CURSOR_HOME +
      HIDE_CURSOR,
  );
}

export function openTranscriptInEditor(messages: ChatMessage[]): ClipboardResult {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    return { ok: false };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "pulseed-transcript-"));
  const filePath = path.join(dir, "transcript.md");
  writeFileSync(filePath, formatTranscript(messages), "utf8");
  writeTrustedTuiControl(SHOW_CURSOR + EXIT_ALT_SCREEN);
  const result = spawnSync(editor, [filePath], { stdio: "inherit", shell: true });
  writeTrustedTuiControl(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME + HIDE_CURSOR);
  return result.status === 0 ? { ok: true, method: "osc52" } : { ok: false };
}
