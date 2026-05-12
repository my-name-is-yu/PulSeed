import { theme } from "./theme.js";
import {
  SELECTION_BACKGROUND,
  SELECTION_FOREGROUND,
  charWidth,
  padToWidth,
  pushSegment,
} from "./fullscreen-chat-render-utils.js";
import type { buildChatViewport } from "./chat/viewport.js";
import type { ChatMessage, ChatDisplayRow } from "./chat/types.js";
import {
  projectSurfaceDelivery,
  renderSurfaceDeliveryProjection,
} from "../../runtime/attention/index.js";
import type {
  ExpressionDecision,
  ExpressionSurfaceClass,
  OutcomeDecision,
  VisibilityPolicy,
} from "../../runtime/types/companion-autonomy.js";
import type {
  BodySelectionPoint,
  BodySelectionRange,
  BodySelectionState,
  RenderLine,
  RenderSegment,
  SelectionRange,
} from "./fullscreen-chat-render-types.js";

export {
  buildCollapsedPasteRange,
  buildComposerLines,
  copySelectedInputText,
  formatCopyToast,
  getCursorPositionFromComposerLayout,
  getMouseOffsetFromComposer,
  getSelectedInputText,
  getSuggestions,
  normalizeSelection,
  shouldCollapsePastedText,
} from "./fullscreen-chat-composer.js";
export type {
  BodySelectionPoint,
  BodySelectionRange,
  BodySelectionState,
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

export type TuiExpressionDecisionRenderInput = {
  renderId: string;
  renderedAt: string;
  surfaceClass?: Extract<ExpressionSurfaceClass, "tui" | "cli">;
  outcomeDecision: OutcomeDecision;
  expressionDecision?: ExpressionDecision | null;
  visibilityPolicy: VisibilityPolicy;
};

export function renderTuiExpressionDecision(input: TuiExpressionDecisionRenderInput): RenderLine | null {
  const delivery = projectSurfaceDelivery({
    renderId: input.renderId,
    renderedAt: input.renderedAt,
    surfaceClass: input.surfaceClass ?? "tui",
    outcomeDecision: input.outcomeDecision,
    expressionDecision: input.expressionDecision,
    visibilityPolicy: input.visibilityPolicy,
  });
  const renderedText = renderSurfaceDeliveryProjection(delivery);
  if (!delivery || !renderedText) return null;

  return {
    key: delivery.delivery_id,
    text: renderedText,
    dim: delivery.delivery_mode === "digest_item",
    bold: delivery.delivery_mode === "approval_request" || delivery.delivery_mode === "urgent_alert",
    protected: true,
  };
}

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

function compareBodySelectionPoints(a: BodySelectionPoint, b: BodySelectionPoint): number {
  if (a.rowIndex !== b.rowIndex) {
    return a.rowIndex - b.rowIndex;
  }
  return a.offset - b.offset;
}

export function normalizeBodySelection(selection: BodySelectionState | null): BodySelectionRange | null {
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

export function buildTranscriptRows(messages: ChatMessage[], cols: number): string[] {
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

export function getMousePositionFromBody(
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
