import React, { useCallback, useState } from "react";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Box, Text, useInput } from "ink";
import { copyToClipboard, getClipboardContent, type ClipboardResult } from "./clipboard.js";
import { logTuiDebug } from "./debug-log.js";
import { theme } from "./theme.js";
import { pickSpinnerVerb } from "./spinner-verbs.js";
import {
  buildHiddenCursorEscapeFromPosition,
  CARET_MARKER,
  PROTECTED_ROW_MARKER,
  setActiveCursorEscape,
} from "./cursor-tracker.js";
import { measureCharWidth, measureTextWidth } from "./text-width.js";
import { isBashModeInput } from "./bash-mode.js";
import { buildChatViewport } from "./chat/viewport.js";
import {
  getScrollLineStep,
  getScrollRequest,
  normalizeTerminalInputChunk,
  parseMouseEvent,
} from "./chat/scroll.js";
import { getMatchingSuggestions, type Suggestion } from "./chat/suggestions.js";
import type { ChatMessage, ChatDisplayRow } from "./chat/types.js";
import { writeTrustedTuiControl } from "./terminal-output.js";
import {
  CURSOR_HOME,
  ENTER_ALT_SCREEN,
  ERASE_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./flicker/dec.js";

interface FullscreenChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  onClear?: () => void;
  isProcessing: boolean;
  goalNames?: string[];
  availableRows: number;
  availableCols: number;
  cursorOriginX?: number;
  cursorOriginY?: number;
}

const SCROLL_LINE_STEP = 1;
const SCROLL_ANIMATION_INTERVAL_MS = 16;
const DEFAULT_PROMPT = "◉";
const BASH_PROMPT = "!";
const SUGGESTION_HINT = " arrows to navigate, tab/enter to select, esc to dismiss";
const INPUT_MARGIN = 4;
const SELECTION_BACKGROUND = theme.text;
const SELECTION_FOREGROUND = "#1F2329";
const FAKE_CURSOR_GLYPH = "▌";
const PROCESSING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const PROCESSING_SPINNER_INTERVAL_MS = 80;
const COLLAPSED_PASTE_MIN_CHARS = 120;
const COLLAPSED_PASTE_MIN_MULTILINE_CHARS = 40;

export type RenderSegment = {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
};

export type RenderLine = {
  key: string;
  text?: string;
  segments?: RenderSegment[];
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  protected?: boolean;
};

export type FullscreenChatRenderLinesInput = {
  availableCols: number;
  availableRows: number;
  viewport: ReturnType<typeof buildChatViewport>;
  composerLines: RenderLine[];
  isProcessing: boolean;
  spinnerGlyph: string;
  spinnerVerb: string;
  bodySelection?: BodySelectionRange | null;
  transcriptStatus?: string | null;
};

export type SelectionState = {
  anchor: number;
  focus: number;
};

export type SelectionRange = {
  start: number;
  end: number;
};

export type CollapsedPasteRange = {
  start: number;
  end: number;
  label: string;
};

export type BodySelectionPoint = {
  rowIndex: number;
  offset: number;
};

export type BodySelectionState = {
  anchor: BodySelectionPoint;
  focus: BodySelectionPoint;
};

export type BodySelectionRange = {
  start: BodySelectionPoint;
  end: BodySelectionPoint;
};

export type InputCell = {
  text: string;
  width: number;
  offsetBefore: number;
  offsetAfter: number;
  selected?: boolean;
  placeholder?: boolean;
  dim?: boolean;
};

export type InputRow = {
  cells: InputCell[];
  startOffset: number;
  endOffset: number;
};

export type ComposerRender = {
  lines: RenderLine[];
  inputRows: InputRow[];
  inputRowStartIndex: number;
  contentStartCol: number;
};

type ComposerLayout = {
  startLine: number;
  contentStartCol: number;
  rows: InputRow[];
};

function charWidth(ch: string): number {
  return measureCharWidth(ch);
}

function stringWidth(text: string): number {
  return measureTextWidth(text);
}

function trimToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const next = charWidth(ch);
    if (used + next > width) break;
    out += ch;
    used += next;
  }
  return out;
}

function padToWidth(text: string, width: number): string {
  const trimmed = trimToWidth(text, width);
  const padding = Math.max(0, width - stringWidth(trimmed));
  return trimmed + " ".repeat(padding);
}

function getPreviousOffset(text: string, offset: number): number {
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

function getNextOffset(text: string, offset: number): number {
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

function isBackspaceInput(
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

function isDeleteInput(inputChar: string, key: { delete?: boolean }): boolean {
  return inputChar === "[3~" || inputChar === "\u001b[3~";
}

function summarizeKey(key: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(key).filter(([, value]) => value === true),
  );
}

function getPromptLabel(bashMode: boolean): string {
  return bashMode ? BASH_PROMPT : DEFAULT_PROMPT;
}

function getPlaceholder(bashMode: boolean): string {
  return bashMode ? "! for bash mode" : "/ for commands";
}

function formatSuggestionLabel(suggestion: Suggestion): string {
  return suggestion.type === "goal"
    ? `  ${suggestion.name} ${suggestion.description.padEnd(20)}  [goal]`
    : `  ${suggestion.name.padEnd(20)}${suggestion.description}`;
}

function countTextLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function shouldCollapsePastedText(rawInput: string, normalizedInput: string): boolean {
  const isBracketedPaste = rawInput.includes("[200~") || rawInput.includes("\u001b[200~");
  if (normalizedInput.length >= COLLAPSED_PASTE_MIN_CHARS) {
    return true;
  }
  if (normalizedInput.includes("\n") && normalizedInput.length >= COLLAPSED_PASTE_MIN_MULTILINE_CHARS) {
    return true;
  }
  return isBracketedPaste && normalizedInput.length >= COLLAPSED_PASTE_MIN_MULTILINE_CHARS;
}

export function buildCollapsedPasteRange(text: string, start: number): CollapsedPasteRange {
  const lineCount = countTextLines(text);
  const charCount = Array.from(text).length;
  const label = lineCount > 1
    ? `[pasted ${lineCount} lines, ${charCount} chars]`
    : `[pasted ${charCount} chars]`;
  return {
    start,
    end: start + text.length,
    label,
  };
}

function normalizeSelection(selection: SelectionState | null): SelectionRange | null {
  if (!selection || selection.anchor === selection.focus) {
    return null;
  }

  return {
    start: Math.min(selection.anchor, selection.focus),
    end: Math.max(selection.anchor, selection.focus),
  };
}

export function getSelectedInputText(input: string, selection: SelectionState | null): string {
  const range = normalizeSelection(selection);
  return range ? input.slice(range.start, range.end) : "";
}

export async function copySelectedInputText(
  input: string,
  selection: SelectionState | null,
  copy: (text: string) => Promise<ClipboardResult> = copyToClipboard,
): Promise<ClipboardResult> {
  const selectedText = getSelectedInputText(input, selection);
  if (!selectedText) {
    return { ok: false };
  }
  return copy(selectedText);
}

function formatCopyToast(charCount: number, result: ClipboardResult): string {
  const suffix = result.method ? ` via ${result.method}` : "";
  return `copied ${charCount} chars${suffix}`;
}

function pushSegment(
  segments: RenderSegment[],
  text: string,
  style: Omit<RenderSegment, "text"> = {},
): void {
  if (text.length === 0) return;

  const previous = segments[segments.length - 1];
  if (
    previous &&
    previous.color === style.color &&
    previous.backgroundColor === style.backgroundColor &&
    previous.bold === style.bold &&
    previous.dim === style.dim
  ) {
    previous.text += text;
    return;
  }

  segments.push({ text, ...style });
}

function buildInputRows(
  input: string,
  cursorOffset: number,
  contentWidth: number,
  placeholder: string,
  selection: SelectionRange | null,
  collapsedPaste: CollapsedPasteRange | null,
): {
  rows: InputRow[];
} {
  if (contentWidth <= 0) {
    return {
      rows: [{
        cells: [{
          text: CARET_MARKER,
          width: 0,
          offsetBefore: cursorOffset,
          offsetAfter: cursorOffset,
        }],
        startOffset: cursorOffset,
        endOffset: cursorOffset,
      }],
    };
  }

  if (input.length === 0) {
    const cells: InputCell[] = [{
      text: CARET_MARKER,
      width: 0,
      offsetBefore: 0,
      offsetAfter: 0,
    }];

    for (const ch of trimToWidth(placeholder, Math.max(0, contentWidth - 1))) {
      cells.push({
        text: ch,
        width: charWidth(ch),
        offsetBefore: 0,
        offsetAfter: 0,
        placeholder: true,
      });
    }

    return {
      rows: [{
        cells,
        startOffset: 0,
        endOffset: 0,
      }],
    };
  }

  const rows: InputRow[] = [];
  let currentCells: InputCell[] = [];
  let currentWidth = 0;
  let rowStartOffset = 0;
  let rowEndOffset = 0;
  const activeCollapsedPaste = collapsedPaste
    && !(cursorOffset > collapsedPaste.start && cursorOffset < collapsedPaste.end)
    && !(selection && selection.start < collapsedPaste.end && selection.end > collapsedPaste.start)
    ? collapsedPaste
    : null;
  const pushRow = () => {
    rows.push({
      cells: currentCells,
      startOffset: rowStartOffset,
      endOffset: rowEndOffset,
    });
    currentCells = [];
    currentWidth = 0;
  };

  let offset = 0;
  while (offset <= input.length) {
    if (offset === cursorOffset) {
      if (currentWidth >= contentWidth && currentCells.length > 0) {
        pushRow();
        rowStartOffset = offset;
        rowEndOffset = offset;
      }
      currentCells.push({
        text: CARET_MARKER,
        width: 0,
        offsetBefore: offset,
        offsetAfter: offset,
      });
    }

    if (offset === input.length) {
      break;
    }

    if (activeCollapsedPaste && offset === activeCollapsedPaste.start) {
      const label = stringWidth(activeCollapsedPaste.label) <= contentWidth
        ? activeCollapsedPaste.label
        : trimToWidth("[paste]", contentWidth);
      const labelWidth = stringWidth(label);
      if (currentWidth + labelWidth > contentWidth && currentCells.length > 0) {
        pushRow();
        rowStartOffset = offset;
        rowEndOffset = offset;
      }
      currentCells.push({
        text: label,
        width: labelWidth,
        offsetBefore: activeCollapsedPaste.start,
        offsetAfter: activeCollapsedPaste.end,
        dim: true,
      });
      currentWidth += labelWidth;
      rowEndOffset = activeCollapsedPaste.end;
      offset = activeCollapsedPaste.end;
      continue;
    }

    const codePoint = input.codePointAt(offset) ?? 0;
    const ch = String.fromCodePoint(codePoint);
    const nextOffset = offset + ch.length;

    if (ch === "\n") {
      pushRow();
      rowStartOffset = nextOffset;
      rowEndOffset = nextOffset;
      offset = nextOffset;
      continue;
    }

    const width = charWidth(ch);
    if (currentWidth + width > contentWidth && currentCells.length > 0) {
      pushRow();
      rowStartOffset = offset;
      rowEndOffset = offset;
    }

    currentCells.push({
      text: ch,
      width,
      offsetBefore: offset,
      offsetAfter: nextOffset,
      selected:
        selection !== null &&
        offset < selection.end &&
        nextOffset > selection.start,
    });
    currentWidth += width;
    rowEndOffset = nextOffset;
    offset = nextOffset;
  }

  rows.push({
    cells: currentCells,
    startOffset: rowStartOffset,
    endOffset: rowEndOffset,
  });

  return { rows };
}

function buildInputContentSegments(
  row: InputRow,
  contentWidth: number,
  bashMode: boolean,
): RenderSegment[] {
  const segments: RenderSegment[] = [];
  const defaultColor = bashMode ? theme.command : undefined;
  let usedWidth = 0;

  for (const cell of row.cells) {
    if (cell.text === CARET_MARKER) {
      pushSegment(segments, FAKE_CURSOR_GLYPH, {
        color: theme.text,
        bold: true,
      });
      usedWidth += 1;
      continue;
    }

    usedWidth += cell.width;

    if (cell.selected) {
      pushSegment(segments, cell.text, {
        color: SELECTION_FOREGROUND,
        backgroundColor: SELECTION_BACKGROUND,
      });
      continue;
    }

    pushSegment(segments, cell.text, {
      color: defaultColor,
      dim: cell.placeholder || cell.dim,
    });
  }

  if (usedWidth < contentWidth) {
    pushSegment(segments, " ".repeat(contentWidth - usedWidth), {
      color: defaultColor,
    });
  }

  return segments;
}

function compareBodySelectionPoints(a: BodySelectionPoint, b: BodySelectionPoint): number {
  if (a.rowIndex !== b.rowIndex) {
    return a.rowIndex - b.rowIndex;
  }
  return a.offset - b.offset;
}

function normalizeBodySelection(selection: BodySelectionState | null): BodySelectionRange | null {
  if (!selection || compareBodySelectionPoints(selection.anchor, selection.focus) === 0) {
    return null;
  }

  return compareBodySelectionPoints(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

function getBodySelectionForRow(
  selection: BodySelectionRange | null,
  rowIndex: number,
  textLength: number,
): SelectionRange | null {
  if (!selection || rowIndex < selection.start.rowIndex || rowIndex > selection.end.rowIndex) {
    return null;
  }

  const start = rowIndex === selection.start.rowIndex ? selection.start.offset : 0;
  const end = rowIndex === selection.end.rowIndex ? selection.end.offset : textLength;
  if (start === end) return null;
  return { start: Math.max(0, start), end: Math.min(textLength, end) };
}

function getDisplayOffsetForText(text: string, col: number): number {
  if (col <= 0) return 0;
  let usedWidth = 0;
  let offset = 0;
  for (const ch of text) {
    const width = charWidth(ch);
    const midpoint = usedWidth + width / 2;
    if (col <= midpoint) return offset;
    offset += ch.length;
    usedWidth += width;
    if (col <= usedWidth) return offset;
  }
  return text.length;
}

function applySelectionToTextSegments(
  text: string,
  selection: SelectionRange | null,
  style: Omit<RenderSegment, "text">,
): RenderSegment[] {
  if (!selection) {
    return [{ text, ...style }];
  }

  const segments: RenderSegment[] = [];
  const before = text.slice(0, selection.start);
  const selected = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  pushSegment(segments, before, style);
  pushSegment(segments, selected, {
    ...style,
    color: SELECTION_FOREGROUND,
    backgroundColor: SELECTION_BACKGROUND,
  });
  pushSegment(segments, after, style);
  return segments;
}

export function getSelectedBodyText(
  rows: ChatDisplayRow[],
  selection: BodySelectionState | null,
): string {
  const range = normalizeBodySelection(selection);
  if (!range) return "";

  const selectedRows: string[] = [];
  for (let rowIndex = range.start.rowIndex; rowIndex <= range.end.rowIndex; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.kind === "spacer") continue;
    const rowRange = getBodySelectionForRow(range, rowIndex, row.text.length);
    if (!rowRange) continue;
    selectedRows.push(row.text.slice(rowRange.start, rowRange.end).trimEnd());
  }

  return selectedRows.join("\n").trim();
}

export function extractClickableTargetAt(text: string, offset: number): string | null {
  const patterns = [
    /https?:\/\/[^\s)>\]}]+/g,
    /(?:\.{1,2}\/|\/)[^\s:]+(?::\d+)?/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      const start = match.index ?? 0;
      const end = start + value.length;
      if (offset >= start && offset <= end) {
        return value;
      }
    }
  }

  return null;
}

function openClickableTarget(target: string): boolean {
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

export function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const label = message.role === "user" ? "User" : "PulSeed";
      return `${label}:\n${message.text.trimEnd()}`;
    })
    .join("\n\n");
}

function wrapPlainTextToRows(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const sourceLine of text.split("\n")) {
    if (sourceLine.length === 0) {
      rows.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const ch of sourceLine) {
      const widthOfChar = charWidth(ch);
      if (currentWidth + widthOfChar > width && current.length > 0) {
        rows.push(current);
        current = "";
        currentWidth = 0;
      }
      current += ch;
      currentWidth += widthOfChar;
    }
    rows.push(current);
  }
  return rows;
}

function buildTranscriptRows(messages: ChatMessage[], cols: number): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    const label = message.role === "user" ? "User" : "PulSeed";
    rows.push(...wrapPlainTextToRows(`${label}:`, cols));
    rows.push(...wrapPlainTextToRows(message.text.trimEnd(), cols));
    rows.push("");
  }
  return rows;
}

export function buildTranscriptRenderLines(args: {
  messages: ChatMessage[];
  cols: number;
  rows: number;
  scrollOffset: number;
  searchQuery: string;
  searchMode: boolean;
  status?: string | null;
}): { lines: RenderLine[]; totalRows: number; maxScrollOffset: number } {
  const { messages, cols, rows, scrollOffset, searchQuery, searchMode, status } = args;
  const bodyRows = Math.max(1, rows - 2);
  const transcriptRows = buildTranscriptRows(messages, cols);
  const maxScrollOffset = Math.max(0, transcriptRows.length - bodyRows);
  const clampedOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset));
  const visibleRows = transcriptRows.slice(clampedOffset, clampedOffset + bodyRows);
  const lines: RenderLine[] = [{
    key: "transcript-header",
    text: padToWidth("transcript  / search  n/N next  [ write scrollback  v editor  Esc return", cols),
    color: theme.command,
  }];

  visibleRows.forEach((row, index) => {
    lines.push({
      key: `transcript-${clampedOffset + index}`,
      text: padToWidth(row, cols),
      backgroundColor:
        searchQuery.length > 0 && row.toLowerCase().includes(searchQuery.toLowerCase())
          ? "#3A3A22"
          : undefined,
    });
  });

  while (lines.length < rows - 1) {
    lines.push({ key: `transcript-filler-${lines.length}`, text: " ".repeat(cols) });
  }

  lines.push({
    key: "transcript-footer",
    text: padToWidth(
      searchMode
        ? `/${searchQuery}`
        : status
          ? status
        : `${clampedOffset + 1}-${Math.min(clampedOffset + bodyRows, transcriptRows.length)} / ${transcriptRows.length}`,
      cols,
    ),
    dim: !searchMode && !status,
    color: searchMode ? theme.command : undefined,
  });

  return { lines: lines.slice(0, rows), totalRows: transcriptRows.length, maxScrollOffset };
}

function writeTranscriptToNativeScrollback(messages: ChatMessage[]): void {
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

function openTranscriptInEditor(messages: ChatMessage[]): ClipboardResult {
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

function getCursorPositionFromComposerLayout(
  layout: ComposerLayout,
): { x: number; y: number } | null {
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    const row = layout.rows[rowIndex];
    if (!row) continue;

    let colOffset = 0;
    for (const cell of row.cells) {
      if (cell.text === CARET_MARKER) {
        return {
          x: layout.contentStartCol + colOffset - 1,
          y: layout.startLine + rowIndex - 1,
        };
      }
      colOffset += cell.width;
    }
  }

  return null;
}

export function buildComposerLines(args: {
  cols: number;
  input: string;
  cursorOffset: number;
  bashMode: boolean;
  emptyHint: boolean;
  matches: Suggestion[];
  selectedIdx: number;
  copyToast: string | null;
  selection: SelectionRange | null;
  collapsedPaste: CollapsedPasteRange | null;
}): ComposerRender {
  const {
    cols,
    input,
    cursorOffset,
    bashMode,
    emptyHint,
    matches,
    selectedIdx,
    copyToast,
    selection,
    collapsedPaste,
  } = args;

  const lines: RenderLine[] = [];
  lines.push({
    key: "copy-toast",
    text: padToWidth(copyToast ?? "", cols),
    color: copyToast ? "cyan" : undefined,
  });

  const innerWidth = Math.max(1, cols - 2);
  const promptLabel = getPromptLabel(bashMode);
  const prompt = `${promptLabel} `;
  const promptWidth = stringWidth(prompt);
  const contentWidth = Math.max(1, innerWidth - INPUT_MARGIN - promptWidth);
  const inputRender = buildInputRows(
    input,
    cursorOffset,
    contentWidth,
    getPlaceholder(bashMode),
    selection,
    collapsedPaste,
  );
  const inputRows = inputRender.rows;

  lines.push({
    key: "composer-top",
    text: padToWidth(`┌${"─".repeat(Math.max(0, cols - 2))}┐`, cols),
    color: bashMode ? theme.command : theme.border,
  });

  inputRows.forEach((row, index) => {
    const segments: RenderSegment[] = [];
    const borderColor = bashMode ? theme.command : undefined;
    const promptColor = bashMode ? theme.command : theme.userPrompt;

    pushSegment(segments, "│ ", { color: borderColor });
    if (index === 0) {
      pushSegment(segments, promptLabel, { color: promptColor, bold: true });
      pushSegment(segments, " ", { color: promptColor, bold: true });
    } else {
      pushSegment(segments, " ".repeat(promptWidth), { color: borderColor });
    }
    segments.push(...buildInputContentSegments(row, contentWidth, bashMode));
    pushSegment(segments, " │", { color: borderColor });

    lines.push({
      key: `composer-row-${index}`,
      segments,
      protected: true,
    });
  });

  lines.push({
    key: "composer-bottom",
    text: padToWidth(`└${"─".repeat(Math.max(0, cols - 2))}┘`, cols),
    color: bashMode ? theme.command : theme.border,
  });

  if (bashMode) {
    lines.push({
      key: "bash-hint",
      text: padToWidth("! for bash mode", cols),
      color: theme.command,
    });
  }

  if (emptyHint) {
    lines.push({
      key: "empty-hint",
      text: padToWidth(" Type a message or /help for commands", cols),
      dim: true,
    });
  }

  if (matches.length > 0) {
    matches.forEach((suggestion, index) => {
      lines.push({
        key: `suggestion-${index}`,
        text: padToWidth(formatSuggestionLabel(suggestion), cols),
        color: index === selectedIdx ? theme.selected : undefined,
        bold: index === selectedIdx,
        dim: index !== selectedIdx,
      });
    });
    lines.push({
      key: "suggestion-hint",
      text: padToWidth(SUGGESTION_HINT, cols),
      dim: true,
    });
  }

  return {
    lines,
    inputRows,
    inputRowStartIndex: 2,
    contentStartCol: 3 + promptWidth,
  };
}

function renderMessageRow(
  row: ChatDisplayRow,
  cols: number,
  rowIndex: number,
  bodySelection: BodySelectionRange | null,
): RenderLine {
  if (row.kind === "spacer") {
    return { key: row.key, text: " ".repeat(cols) };
  }

  const selection = getBodySelectionForRow(bodySelection, rowIndex, row.text.length);
  if (selection) {
    const text = padToWidth(row.text, cols);
    return {
      key: row.key,
      segments: applySelectionToTextSegments(text, selection, {
        color: row.color,
        backgroundColor: row.backgroundColor,
        bold: row.bold,
        dim: row.dim,
      }),
    };
  }

  return {
    key: row.key,
    text: padToWidth(row.text, cols),
    color: row.color,
    backgroundColor: row.backgroundColor,
    bold: row.bold,
    dim: row.dim,
  };
}

export function buildFullscreenChatRenderLines({
  availableCols,
  availableRows,
  viewport,
  composerLines,
  isProcessing,
  spinnerGlyph,
  spinnerVerb,
  bodySelection,
  transcriptStatus,
}: FullscreenChatRenderLinesInput): RenderLine[] {
  const lines: RenderLine[] = [];
  lines.push({
    key: "indicator-top",
    text: padToWidth(
      viewport.hiddenAboveRows > 0 ? `↑ ${viewport.hiddenAboveRows} earlier lines` : "",
      availableCols,
    ),
    dim: true,
  });

  const renderedRows = viewport.rows.map((row, index) => (
    renderMessageRow(row, availableCols, index, bodySelection ?? null)
  ));
  const fillerCount = Math.max(0, viewport.maxVisibleRows - renderedRows.length);
  for (let index = 0; index < fillerCount; index += 1) {
    lines.push({ key: `filler-${index}`, text: " ".repeat(availableCols) });
  }
  lines.push(...renderedRows);
  lines.push({
    key: "indicator-bottom",
    text: padToWidth(
      viewport.hiddenBelowRows > 0 ? `↓ ${viewport.hiddenBelowRows} newer lines` : "",
      availableCols,
    ),
    dim: true,
  });
  lines.push({
    key: "processing",
    text: padToWidth(transcriptStatus ?? (isProcessing ? `${spinnerGlyph} ${spinnerVerb}...` : ""), availableCols),
    color: isProcessing ? theme.command : undefined,
    dim: !isProcessing && !transcriptStatus,
  });
  lines.push(...composerLines);

  while (lines.length < availableRows) {
    lines.push({
      key: `tail-filler-${lines.length}`,
      text: " ".repeat(availableCols),
    });
  }

  return lines.slice(0, availableRows);
}

function getMouseOffsetFromComposer(
  layout: ComposerLayout,
  x: number,
  y: number,
  clampOutside: boolean,
): number | null {
  if (layout.rows.length === 0) {
    return null;
  }

  let rowIndex = y - layout.startLine;
  if (rowIndex < 0) {
    if (!clampOutside) return null;
    rowIndex = 0;
  }
  if (rowIndex >= layout.rows.length) {
    if (!clampOutside) return null;
    rowIndex = layout.rows.length - 1;
  }

  const row = layout.rows[rowIndex];
  if (!row) {
    return null;
  }

  if (row.startOffset === row.endOffset) {
    return row.startOffset;
  }

  const localCol = x - layout.contentStartCol;
  if (localCol <= 0) {
    return row.startOffset;
  }

  let usedWidth = 0;
  for (const cell of row.cells) {
    if (cell.placeholder || cell.width <= 0) {
      continue;
    }

    const midpoint = usedWidth + cell.width / 2;
    if (localCol <= midpoint) {
      return cell.offsetBefore;
    }

    usedWidth += cell.width;
    if (localCol <= usedWidth) {
      return cell.offsetAfter;
    }
  }

  return row.endOffset;
}

function getMousePositionFromBody(
  rows: ChatDisplayRow[],
  x: number,
  y: number,
  fillerRows: number,
): BodySelectionPoint | null {
  const rowIndex = y - 2 - fillerRows;
  if (rowIndex < 0 || rowIndex >= rows.length) {
    return null;
  }

  const row = rows[rowIndex];
  if (!row || row.kind === "spacer") {
    return null;
  }

  return {
    rowIndex,
    offset: getDisplayOffsetForText(row.text, x - 1),
  };
}

export function FullscreenChat({
  messages,
  onSubmit,
  onClear,
  isProcessing,
  goalNames = [],
  availableRows,
  availableCols,
  cursorOriginX = 0,
  cursorOriginY = 0,
}: FullscreenChatProps) {
  const [input, setInput] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [collapsedPaste, setCollapsedPaste] = useState<CollapsedPasteRange | null>(null);
  const selectionAnchor = React.useRef<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const justSelected = React.useRef(false);

  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [draft, setDraft] = React.useState("");

  const [emptyHint, setEmptyHint] = React.useState(false);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const emptyHintTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [targetScrollOffset, setTargetScrollOffset] = React.useState(0);
  const [bodySelection, setBodySelection] = React.useState<BodySelectionState | null>(null);
  const bodySelectionAnchor = React.useRef<BodySelectionPoint | null>(null);
  const [transcriptMode, setTranscriptMode] = React.useState(false);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = React.useState(0);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = React.useState("");
  const [transcriptSearchMode, setTranscriptSearchMode] = React.useState(false);
  const [spinnerVerb, setSpinnerVerb] = React.useState(() => pickSpinnerVerb());
  const [spinnerFrameIndex, setSpinnerFrameIndex] = React.useState(0);

  React.useEffect(() => {
    let lastClipboard = "";
    let mounted = true;

    getClipboardContent().then((content) => {
      if (mounted) lastClipboard = content;
    });

    const interval = setInterval(async () => {
      if (!mounted) return;
      const current = await getClipboardContent();
      if (current !== lastClipboard && current.length > 0) {
        lastClipboard = current;
        setCopyToast(`copied ${current.length} chars to clipboard`);
        setTimeout(() => {
          if (mounted) setCopyToast(null);
        }, 2000);
      }
    }, 500);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  React.useEffect(() => {
    if (!isProcessing) return;
    const interval = setInterval(() => {
      setSpinnerVerb(pickSpinnerVerb());
    }, 5000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  React.useEffect(() => {
    if (!isProcessing) {
      setSpinnerFrameIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setSpinnerFrameIndex((prev) => (prev + 1) % PROCESSING_SPINNER_FRAMES.length);
    }, PROCESSING_SPINNER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isProcessing]);

  const clearSelection = useCallback(() => {
    selectionAnchor.current = null;
    setSelection(null);
  }, []);

  const clearBodySelection = useCallback(() => {
    bodySelectionAnchor.current = null;
    setBodySelection(null);
  }, []);

  const replaceInputRange = useCallback((
    start: number,
    end: number,
    replacement: string,
    nextCollapsedPaste: CollapsedPasteRange | null = null,
  ) => {
    const next = input.slice(0, start) + replacement + input.slice(end);
    setInput(next);
    setCursorOffset(start + replacement.length);
    setCollapsedPaste(nextCollapsedPaste);
    clearSelection();
  }, [clearSelection, input]);

  const insertText = useCallback((text: string, options: { collapsePaste?: boolean } = {}) => {
    justSelected.current = false;
    const selectedRange = normalizeSelection(selection);
    const start = selectedRange ? selectedRange.start : cursorOffset;
    const nextCollapsedPaste = options.collapsePaste
      ? buildCollapsedPasteRange(text, start)
      : null;
    if (selectedRange) {
      replaceInputRange(selectedRange.start, selectedRange.end, text, nextCollapsedPaste);
      return;
    }

    const next = input.slice(0, cursorOffset) + text + input.slice(cursorOffset);
    setInput(next);
    setCursorOffset(cursorOffset + text.length);
    setCollapsedPaste(nextCollapsedPaste);
    clearSelection();
  }, [clearSelection, cursorOffset, input, replaceInputRange, selection]);

  const deleteSelection = useCallback(() => {
    const selectedRange = normalizeSelection(selection);
    if (!selectedRange) {
      return false;
    }

    replaceInputRange(selectedRange.start, selectedRange.end, "");
    return true;
  }, [replaceInputRange, selection]);

  const copySelectedInput = useCallback((nextSelection: SelectionState | null) => {
    const selectedText = getSelectedInputText(input, nextSelection);
    if (!selectedText) {
      return;
    }

    void copySelectedInputText(input, nextSelection).then((result) => {
      if (!result.ok) {
        return;
      }

      setCopyToast(formatCopyToast(selectedText.length, result));
      setTimeout(() => setCopyToast(null), 2000);
    });
  }, [input]);

  const matches = justSelected.current ? [] : getMatchingSuggestions(input, goalNames);
  const hasMatches = matches.length > 0;
  const bashMode = isBashModeInput(input);
  const normalizedSelection = normalizeSelection(selection);
  const composer = buildComposerLines({
    cols: availableCols,
    input,
    cursorOffset,
    bashMode,
    emptyHint,
    matches,
    selectedIdx,
    copyToast,
    selection: normalizedSelection,
    collapsedPaste,
  });

  const messageRows = Math.max(
    1,
    availableRows - composer.lines.length - 3,
  );
  const viewport = buildChatViewport(messages, availableCols, messageRows, scrollOffset);
  const maxScrollOffset = Math.max(
    0,
    viewport.totalRows - viewport.maxVisibleRows,
  );
  const bodySelectionRange = normalizeBodySelection(bodySelection);
  const viewportFillerRows = Math.max(0, viewport.maxVisibleRows - viewport.rows.length);
  const transcript = buildTranscriptRenderLines({
    messages,
    cols: availableCols,
    rows: availableRows,
    scrollOffset: transcriptScrollOffset,
    searchQuery: transcriptSearchQuery,
    searchMode: transcriptSearchMode,
    status: copyToast,
  });
  const composerLayout: ComposerLayout = {
    startLine: viewport.maxVisibleRows + 3 + composer.inputRowStartIndex + 1,
    contentStartCol: composer.contentStartCol,
    rows: composer.inputRows,
  };
  const cursorPosition = getCursorPositionFromComposerLayout(composerLayout);
  const absoluteCursorPosition = cursorPosition
    ? {
        x: cursorOriginX + cursorPosition.x,
        y: cursorOriginY + cursorPosition.y,
      }
    : null;

  React.useEffect(() => {
    setActiveCursorEscape(
      absoluteCursorPosition
        ? buildHiddenCursorEscapeFromPosition(absoluteCursorPosition)
        : null,
    );
    return () => {
      setActiveCursorEscape(null);
    };
  }, [absoluteCursorPosition]);

  React.useEffect(() => {
    setScrollOffset((prev) => Math.min(prev, maxScrollOffset));
    setTargetScrollOffset((prev) => Math.min(prev, maxScrollOffset));
  }, [maxScrollOffset]);

  React.useEffect(() => {
    setTranscriptScrollOffset((prev) => Math.min(prev, transcript.maxScrollOffset));
  }, [transcript.maxScrollOffset]);

  React.useEffect(() => {
    if (scrollOffset === targetScrollOffset) {
      return;
    }

    const interval = setInterval(() => {
      setScrollOffset((prev) => {
        if (prev === targetScrollOffset) {
          return prev;
        }

        const delta = targetScrollOffset - prev;
        const step = Math.max(
          1,
          Math.min(Math.abs(delta), Math.ceil(Math.abs(delta) * 0.35)),
        );
        return prev + Math.sign(delta) * step;
      });
    }, SCROLL_ANIMATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [scrollOffset, targetScrollOffset]);

  const applyScroll = useCallback((direction: "up" | "down", kind: "page" | "line" | "top" | "bottom") => {
    setTargetScrollOffset((prev) => {
      if (kind === "top") return maxScrollOffset;
      if (kind === "bottom") return 0;
      const amount = kind === "page" ? viewport.maxVisibleRows : SCROLL_LINE_STEP;
      const effectiveAmount = kind === "line" ? amount * getScrollLineStep() : amount;
      const delta = direction === "up" ? effectiveAmount : -effectiveAmount;
      return Math.max(0, Math.min(maxScrollOffset, prev + delta));
    });
  }, [maxScrollOffset, viewport.maxVisibleRows]);

  const applyTranscriptScroll = useCallback((direction: "up" | "down", kind: "page" | "line" | "top" | "bottom") => {
    setTranscriptScrollOffset((prev) => {
      if (kind === "top") return 0;
      if (kind === "bottom") return transcript.maxScrollOffset;
      const pageRows = Math.max(1, availableRows - 2);
      const amount = kind === "page" ? pageRows : getScrollLineStep();
      const delta = direction === "up" ? -amount : amount;
      return Math.max(0, Math.min(transcript.maxScrollOffset, prev + delta));
    });
  }, [availableRows, transcript.maxScrollOffset]);

  const jumpToTranscriptMatch = useCallback((direction: "next" | "previous") => {
    if (!transcriptSearchQuery) return;
    const rows = buildTranscriptRows(messages, availableCols);
    const query = transcriptSearchQuery.toLowerCase();
    const matches = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.toLowerCase().includes(query))
      .map(({ index }) => index);
    if (matches.length === 0) return;
    const current = direction === "next"
      ? matches.find((index) => index > transcriptScrollOffset)
      : [...matches].reverse().find((index) => index < transcriptScrollOffset);
    setTranscriptScrollOffset(current ?? (direction === "next" ? matches[0]! : matches[matches.length - 1]!));
  }, [availableCols, messages, transcriptScrollOffset, transcriptSearchQuery]);

  useInput((inputChar, key) => {
    if (transcriptMode) return;
    const scrollRequest = getScrollRequest(inputChar, key);
    if (!scrollRequest) return;
    logTuiDebug("fullscreen-chat", "processing-scroll-request", {
      direction: scrollRequest.direction,
      kind: scrollRequest.kind,
    });
    applyScroll(scrollRequest.direction, scrollRequest.kind);
  }, { isActive: isProcessing });

  const handleSubmit = useCallback((value: string) => {
    logTuiDebug("fullscreen-chat", "submit-attempt", {
      value,
      hasMatches,
      isProcessing,
    });
    if (hasMatches) return;
    if (!value.trim()) {
      setEmptyHint(true);
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
      emptyHintTimer.current = setTimeout(() => setEmptyHint(false), 1500);
      return;
    }

    const trimmed = value.trim();
    if (trimmed === "/clear") {
      onClear?.();
      setInput("");
      setCursorOffset(0);
      setCollapsedPaste(null);
      clearSelection();
      setHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
      setScrollOffset(0);
      setTargetScrollOffset(0);
      return;
    }

    onSubmit(value);
    setInput("");
    setCursorOffset(0);
    setCollapsedPaste(null);
    clearSelection();
    setHistory((prev) => [...prev, value]);
    setHistoryIdx(-1);
    setScrollOffset(0);
    setTargetScrollOffset(0);
  }, [clearSelection, hasMatches, isProcessing, onClear, onSubmit]);

  useInput((inputChar, key) => {
    if (key.ctrl && (inputChar === "o" || inputChar === "O")) {
      setTranscriptMode((prev) => !prev);
      setTranscriptSearchMode(false);
      return;
    }

    if (transcriptMode) {
      if (transcriptSearchMode) {
        if (key.escape) {
          setTranscriptSearchMode(false);
          return;
        }
        if (key.return) {
          setTranscriptSearchMode(false);
          jumpToTranscriptMatch("next");
          return;
        }
        if (isBackspaceInput(inputChar, key)) {
          setTranscriptSearchQuery((prev) => prev.slice(0, -1));
          return;
        }
        if (inputChar && !key.ctrl && !key.meta) {
          setTranscriptSearchQuery((prev) => prev + inputChar);
        }
        return;
      }

      if (key.escape || inputChar === "q") {
        setTranscriptMode(false);
        return;
      }
      if (inputChar === "/") {
        setTranscriptSearchMode(true);
        setTranscriptSearchQuery("");
        return;
      }
      if (inputChar === "n") {
        jumpToTranscriptMatch("next");
        return;
      }
      if (inputChar === "N") {
        jumpToTranscriptMatch("previous");
        return;
      }
      if (inputChar === "[") {
        writeTranscriptToNativeScrollback(messages);
        setCopyToast("wrote transcript to terminal scrollback");
        setTimeout(() => setCopyToast(null), 2000);
        return;
      }
      if (inputChar === "v") {
        const result = openTranscriptInEditor(messages);
        setCopyToast(result.ok ? "opened transcript in editor" : "set VISUAL or EDITOR to open transcript");
        setTimeout(() => setCopyToast(null), 2000);
        return;
      }
      if (inputChar === "g" || key.home) {
        applyTranscriptScroll("up", "top");
        return;
      }
      if (inputChar === "G" || key.end) {
        applyTranscriptScroll("down", "bottom");
        return;
      }
      if (inputChar === "j" || key.downArrow) {
        applyTranscriptScroll("down", "line");
        return;
      }
      if (inputChar === "k" || key.upArrow) {
        applyTranscriptScroll("up", "line");
        return;
      }
      const transcriptScrollRequest = getScrollRequest(inputChar, key);
      if (transcriptScrollRequest) {
        applyTranscriptScroll(transcriptScrollRequest.direction, transcriptScrollRequest.kind);
        return;
      }
      if (inputChar === " " || (key.ctrl && inputChar === "f")) {
        applyTranscriptScroll("down", "page");
        return;
      }
      if (inputChar === "b" || (key.ctrl && inputChar === "b")) {
        applyTranscriptScroll("up", "page");
        return;
      }
      return;
    }

    logTuiDebug("fullscreen-chat", "input-event", {
      inputChar,
      key: summarizeKey(key as Record<string, unknown>),
      input,
      cursorOffset,
      selection: normalizedSelection,
      historyIdx,
    });
    const scrollRequest = getScrollRequest(inputChar, key);
    if (scrollRequest) {
      logTuiDebug("fullscreen-chat", "scroll-request", {
        direction: scrollRequest.direction,
        kind: scrollRequest.kind,
      });
      if (!isProcessing) {
        applyScroll(scrollRequest.direction, scrollRequest.kind);
      }
      return;
    }

    const mouseEvent = parseMouseEvent(inputChar);
    if (mouseEvent && mouseEvent.kind !== "wheel" && mouseEvent.button === "left") {
      const localMouseX = mouseEvent.x - cursorOriginX;
      const localMouseY = mouseEvent.y - cursorOriginY;
      const offset = getMouseOffsetFromComposer(
        composerLayout,
        localMouseX,
        localMouseY,
        mouseEvent.kind !== "press" && selectionAnchor.current !== null,
      );

      if (mouseEvent.kind === "release" && offset === null) {
        selectionAnchor.current = null;
        return;
      }

      if (offset !== null) {
        justSelected.current = false;
        setCursorOffset(offset);

        if (mouseEvent.kind === "press") {
          selectionAnchor.current = offset;
          setSelection({ anchor: offset, focus: offset });
        } else if (mouseEvent.kind === "drag" && selectionAnchor.current !== null) {
          setSelection({ anchor: selectionAnchor.current, focus: offset });
        } else if (mouseEvent.kind === "release" && selectionAnchor.current !== null) {
          const nextSelection = { anchor: selectionAnchor.current, focus: offset };
          selectionAnchor.current = null;
          setSelection(nextSelection.anchor === nextSelection.focus ? null : nextSelection);
          copySelectedInput(nextSelection);
        }
        return;
      }

      const bodyPosition = getMousePositionFromBody(
        viewport.rows,
        localMouseX,
        localMouseY,
        viewportFillerRows,
      );
      if (bodyPosition !== null) {
        clearSelection();
        if (mouseEvent.kind === "press") {
          bodySelectionAnchor.current = bodyPosition;
          setBodySelection({ anchor: bodyPosition, focus: bodyPosition });
          return;
        }
        if (mouseEvent.kind === "drag" && bodySelectionAnchor.current !== null) {
          setBodySelection({ anchor: bodySelectionAnchor.current, focus: bodyPosition });
          return;
        }
        if (mouseEvent.kind === "release" && bodySelectionAnchor.current !== null) {
          const nextSelection = { anchor: bodySelectionAnchor.current, focus: bodyPosition };
          bodySelectionAnchor.current = null;
          setBodySelection(nextSelection);
          const selectedText = getSelectedBodyText(viewport.rows, nextSelection);
          if (selectedText) {
            void copyToClipboard(selectedText).then((result) => {
              if (!result.ok) return;
              setCopyToast(formatCopyToast(selectedText.length, result));
              setTimeout(() => setCopyToast(null), 2000);
            });
          } else {
            const row = viewport.rows[bodyPosition.rowIndex];
            const target = row ? extractClickableTargetAt(row.text, bodyPosition.offset) : null;
            if (target) {
              const opened = openClickableTarget(target);
              setCopyToast(opened ? `opened ${target}` : `could not open ${target}`);
              setTimeout(() => setCopyToast(null), 2000);
            }
          }
          return;
        }
      }
    }

    if (key.return && key.shift) {
      logTuiDebug("fullscreen-chat", "insert-newline", { cursorOffset });
      clearBodySelection();
      insertText("\n");
      return;
    }

    if (hasMatches) {
      if (key.upArrow) {
        setSelectedIdx((prev) => (prev <= 0 ? matches.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((prev) => (prev >= matches.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.tab || key.return) {
        const selected = matches[selectedIdx];
        if (selected) {
          const value =
            selected.type === "goal"
              ? `${selected.name} ${selected.description}`
              : selected.name;
          setInput(value);
          setCursorOffset(value.length);
          setCollapsedPaste(null);
          clearSelection();
          setSelectedIdx(0);
          justSelected.current = true;
        }
        return;
      }
      if (key.escape) {
        setSelectedIdx(0);
        setInput("");
        setCursorOffset(0);
        setCollapsedPaste(null);
        clearSelection();
        clearBodySelection();
        return;
      }
    }

    if (key.return) {
      handleSubmit(input);
      return;
    }

    if (key.leftArrow) {
      if (normalizedSelection) {
        setCursorOffset(normalizedSelection.start);
        clearSelection();
        return;
      }
      setCursorOffset((prev) => getPreviousOffset(input, prev));
      return;
    }
    if (key.rightArrow) {
      if (normalizedSelection) {
        setCursorOffset(normalizedSelection.end);
        clearSelection();
        return;
      }
      setCursorOffset((prev) => getNextOffset(input, prev));
      return;
    }
    if ((key.ctrl && inputChar === "a") || key.home) {
      setCursorOffset(0);
      clearSelection();
      return;
    }
    if ((key.ctrl && inputChar === "e") || key.end) {
      setCursorOffset(input.length);
      clearSelection();
      return;
    }
    if (isBackspaceInput(inputChar, key)) {
      logTuiDebug("fullscreen-chat", "backspace-detected", {
        inputChar,
        key: summarizeKey(key as Record<string, unknown>),
        cursorOffset,
        input,
        selection: normalizedSelection,
      });
      if (deleteSelection()) {
        logTuiDebug("fullscreen-chat", "backspace-delete-selection", {});
        return;
      }
      if (cursorOffset > 0) {
        const previousOffset = getPreviousOffset(input, cursorOffset);
        const next = input.slice(0, previousOffset) + input.slice(cursorOffset);
        setInput(next);
        setCursorOffset(previousOffset);
        setCollapsedPaste(null);
        logTuiDebug("fullscreen-chat", "backspace-applied", {
          previousOffset,
          next,
        });
      } else {
        logTuiDebug("fullscreen-chat", "backspace-at-start", {});
      }
      return;
    }
    if (isDeleteInput(inputChar, key)) {
      logTuiDebug("fullscreen-chat", "delete-detected", {
        inputChar,
        key: summarizeKey(key as Record<string, unknown>),
        cursorOffset,
        input,
        selection: normalizedSelection,
      });
      if (deleteSelection()) {
        logTuiDebug("fullscreen-chat", "delete-selection", {});
        return;
      }
      if (cursorOffset < input.length) {
        const nextOffset = getNextOffset(input, cursorOffset);
        const next = input.slice(0, cursorOffset) + input.slice(nextOffset);
        setInput(next);
        setCollapsedPaste(null);
        logTuiDebug("fullscreen-chat", "delete-applied", {
          nextOffset,
          next,
        });
      } else {
        logTuiDebug("fullscreen-chat", "delete-at-end", {});
      }
      return;
    }

    if (key.upArrow) {
      if (history.length > 0) {
        clearSelection();
        if (historyIdx === -1) {
          setDraft(input);
          const idx = history.length - 1;
          setHistoryIdx(idx);
          setInput(history[idx]!);
          setCursorOffset(history[idx]!.length);
          setCollapsedPaste(null);
        } else if (historyIdx > 0) {
          const idx = historyIdx - 1;
          setHistoryIdx(idx);
          setInput(history[idx]!);
          setCursorOffset(history[idx]!.length);
          setCollapsedPaste(null);
        }
      }
      return;
    }
    if (key.downArrow && historyIdx !== -1) {
      clearSelection();
      if (historyIdx < history.length - 1) {
        const idx = historyIdx + 1;
        setHistoryIdx(idx);
        setInput(history[idx]!);
        setCursorOffset(history[idx]!.length);
        setCollapsedPaste(null);
      } else {
        setHistoryIdx(-1);
        setInput(draft);
        setCursorOffset(draft.length);
        setCollapsedPaste(null);
      }
      return;
    }

    if (inputChar && !key.ctrl && !key.meta) {
      const clean = normalizeTerminalInputChunk(inputChar);
      if (clean.length === 0) return;
      clearBodySelection();
      insertText(clean, {
        collapsePaste: shouldCollapsePastedText(inputChar, clean),
      });
    }
  }, { isActive: true });

  React.useEffect(() => {
    setSelectedIdx(0);
  }, [matches.map((match) => match.name).join(",")]);

  React.useEffect(() => {
    return () => {
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
    };
  }, []);

  const spinnerGlyph = PROCESSING_SPINNER_FRAMES[spinnerFrameIndex] ?? PROCESSING_SPINNER_FRAMES[0];
  const visibleLines = transcriptMode
    ? transcript.lines
    : buildFullscreenChatRenderLines({
        availableCols,
        availableRows,
        viewport,
        composerLines: composer.lines,
        isProcessing,
        spinnerGlyph,
        spinnerVerb,
        bodySelection: bodySelectionRange,
        transcriptStatus: copyToast,
      });

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visibleLines.map((line) => (
        <Box key={line.key} height={1} overflow="hidden">
          {line.segments ? (
            line.segments.map((segment, index) => (
              <Text
                key={`${line.key}-${index}`}
                color={segment.color ?? line.color}
                backgroundColor={segment.backgroundColor ?? line.backgroundColor}
                bold={segment.bold ?? line.bold}
                dimColor={segment.dim ?? line.dim}
              >
                {index === 0 && line.protected
                  ? `${PROTECTED_ROW_MARKER}${segment.text}`
                  : segment.text}
              </Text>
            ))
          ) : (
            <Text
              color={line.color}
              backgroundColor={line.backgroundColor}
              bold={line.bold}
              dimColor={line.dim}
            >
              {line.protected
                ? `${PROTECTED_ROW_MARKER}${line.text ?? ""}`
                : (line.text ?? "")}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
