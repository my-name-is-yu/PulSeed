import { copyToClipboard, type ClipboardResult } from "./clipboard.js";
import {
  CARET_MARKER,
} from "./cursor-tracker.js";
import { getMatchingSuggestions, type Suggestion } from "./chat/suggestions.js";
import { theme } from "./theme.js";
import {
  FAKE_CURSOR_GLYPH,
  SELECTION_BACKGROUND,
  SELECTION_FOREGROUND,
  charWidth,
  padToWidth,
  pushSegment,
  stringWidth,
  trimToWidth,
} from "./fullscreen-chat-render-utils.js";
import type {
  CollapsedPasteRange,
  ComposerLayout,
  ComposerRender,
  InputCell,
  InputRow,
  RenderLine,
  RenderSegment,
  SelectionRange,
  SelectionState,
} from "./fullscreen-chat-render-types.js";

const DEFAULT_PROMPT = "◉";
const BASH_PROMPT = "!";
const SUGGESTION_HINT = " arrows to navigate, tab/enter to select, esc to dismiss";
const EMPTY_INPUT_HINT = " Describe what you want to do. Type / for commands.";
const INPUT_MARGIN = 4;
const COLLAPSED_PASTE_MIN_CHARS = 120;
const COLLAPSED_PASTE_MIN_MULTILINE_CHARS = 40;

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

export function normalizeSelection(selection: SelectionState | null): SelectionRange | null {
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

export function formatCopyToast(charCount: number, result: ClipboardResult): string {
  const suffix = result.method ? ` via ${result.method}` : "";
  return `copied ${charCount} chars${suffix}`;
}

function buildInputRows(
  input: string,
  cursorOffset: number,
  contentWidth: number,
  placeholder: string,
  selection: SelectionRange | null,
  collapsedPaste: CollapsedPasteRange | null,
): { rows: InputRow[] } {
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

export function getCursorPositionFromComposerLayout(
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
      text: padToWidth(EMPTY_INPUT_HINT, cols),
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

export function getMouseOffsetFromComposer(
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

export function getSuggestions(input: string, goalNames: string[]): Suggestion[] {
  return getMatchingSuggestions(input, goalNames);
}
