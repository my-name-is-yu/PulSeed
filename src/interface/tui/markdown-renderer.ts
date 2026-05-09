// ─── Markdown Renderer ───
//
// Simple markdown-to-plain-text conversion for Ink's <Text> component.
// We intentionally avoid marked-terminal because its ANSI escape codes
// with embedded newlines conflict with Ink's layout engine, causing
// text overlap and incorrect line-height calculations.
//
// Instead, we do lightweight manual conversion that produces clean text
// which Ink can properly measure and render.

import { highlightCodeLine } from "./markdown-code-highlight.js";
import {
  flattenMarkdownSegments,
  parseInlineSegments,
  prependMarkdownText,
} from "./markdown-inline.js";
import type { MarkdownLine, MarkdownSegment } from "./markdown-renderer-types.js";
import { measureCharWidth, measureTextWidth } from "./text-width.js";

export { highlightCodeLine } from "./markdown-code-highlight.js";
export { parseInlineSegments } from "./markdown-inline.js";
export type { MarkdownLine, MarkdownSegment } from "./markdown-renderer-types.js";

const WORD_SEGMENTER =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "word" })
    : null;

function splitTextToWidth(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const ch of text) {
    const charWidth = measureCharWidth(ch);
    if (current && currentWidth + charWidth > safeWidth) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += charWidth;
  }

  if (current) {
    rows.push(current);
  }
  return rows;
}

/**
 * Wrap plain text to terminal rows at the given width.
 * This is intentionally lightweight and shared by the TUI viewport logic.
 */
export function wrapTextToRows(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const paragraphs = text.split("\n");
  const rows: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      rows.push("");
      continue;
    }

    const pieces = WORD_SEGMENTER
      ? Array.from(WORD_SEGMENTER.segment(paragraph), (segment) => segment.segment)
      : paragraph.match(/\S+\s*|\s+/g) ?? [paragraph];

    let current = "";
    let currentWidth = 0;

    for (const piece of pieces) {
      if (!piece) continue;

      const pieceWidth = measureTextWidth(piece);

      if (pieceWidth > safeWidth) {
        if (current) {
          rows.push(current);
          current = "";
          currentWidth = 0;
        }
        rows.push(...splitTextToWidth(piece, safeWidth));
        continue;
      }

      if (currentWidth + pieceWidth <= safeWidth) {
        current += piece;
        currentWidth += pieceWidth;
        continue;
      }

      if (current) {
        rows.push(current);
      }
      current = piece.trimStart();
      currentWidth = measureTextWidth(current);
    }

    if (current) {
      rows.push(current);
    }
  }

  return rows.length > 0 ? rows : [""];
}

/**
 * Estimate how many terminal rows a plain text line will occupy at the given width.
 * This is intentionally approximate but good enough for TUI window sizing.
 */
export function estimateWrappedLineCount(text: string, width: number): number {
  return wrapTextToRows(text, width).length;
}

/**
 * Expand a rendered markdown line into terminal rows at the given width.
 * Inline segment styling is preserved on wrapped rows.
 */
export function splitMarkdownLineToRows(line: MarkdownLine, width: number): MarkdownLine[] {
  if (!line.segments || line.segments.length === 0) {
    return wrapTextToRows(line.text, width).map((text) => ({
      text,
      bold: line.bold,
      dim: line.dim,
      italic: line.italic,
    }));
  }

  const safeWidth = Math.max(1, Math.floor(width));
  const rows: MarkdownLine[] = [];
  let currentSegments: MarkdownSegment[] = [];
  let currentText = "";
  let currentWidth = 0;
  let trimLeadingPlainText = false;

  const pushRow = (): void => {
    rows.push({
      text: currentText,
      bold: line.bold,
      dim: line.dim,
      italic: line.italic,
      segments: currentSegments.length > 0 ? currentSegments : undefined,
      language: line.language,
    });
    currentSegments = [];
    currentText = "";
    currentWidth = 0;
    trimLeadingPlainText = true;
  };

  const appendPiece = (piece: string, segment: MarkdownSegment): void => {
    if (!piece) return;
    const last = currentSegments[currentSegments.length - 1];
    if (
      last &&
      last.bold === segment.bold &&
      last.code === segment.code &&
      last.italic === segment.italic &&
      last.color === segment.color
    ) {
      last.text += piece;
      currentText += piece;
      return;
    }

    const nextSegment: MarkdownSegment = { ...segment, text: piece };
    currentSegments.push(nextSegment);
    currentText += piece;
  };

  const pushSegmentPiece = (piece: string, segment: MarkdownSegment): void => {
    appendPiece(piece, segment);
    currentWidth += measureTextWidth(piece);
  };

  const piecesFor = (text: string): string[] => {
    if (text === "") {
      return [""];
    }
    return WORD_SEGMENTER
      ? Array.from(WORD_SEGMENTER.segment(text), (segment) => segment.segment)
      : text.match(/\S+\s*|\s+/g) ?? [text];
  };

  for (const segment of line.segments) {
    const pieces = piecesFor(segment.text);
    for (const piece of pieces) {
      if (!piece) continue;

      const pieceWidth = measureTextWidth(piece);

      if (pieceWidth > safeWidth) {
        if (currentWidth > 0) {
          pushRow();
        }
        for (const wrappedPiece of splitTextToWidth(piece, safeWidth)) {
          rows.push({
            text: wrappedPiece,
            bold: line.bold,
            dim: line.dim,
            italic: line.italic,
            segments: [{ ...segment, text: wrappedPiece }],
            language: line.language,
          });
        }
        continue;
      }

      if (currentWidth + pieceWidth > safeWidth && currentWidth > 0) {
        pushRow();
      }

      const rowPiece = trimLeadingPlainText && !segment.code ? piece.trimStart() : piece;
      if (!rowPiece) {
        continue;
      }
      trimLeadingPlainText = false;

      pushSegmentPiece(rowPiece, segment);

      if (currentWidth >= safeWidth) {
        pushRow();
      }
    }
  }

  if (currentWidth > 0 || rows.length === 0) {
    rows.push({
      text: currentText,
      bold: line.bold,
      dim: line.dim,
      italic: line.italic,
      segments: currentSegments.length > 0 ? currentSegments : undefined,
      language: line.language,
    });
  }

  return rows;
}

/**
 * Estimate how many terminal rows a rendered markdown block will occupy.
 */
export function estimateMarkdownHeight(text: string, width: number): number {
  const lines = renderMarkdownLines(text);
  return lines.reduce((total, line) => total + splitMarkdownLineToRows(line, width).length, 0);
}

/**
 * Clamp rendered markdown lines to a maximum number of rows.
 * If the content overflows, the tail is replaced with a truncation note.
 */
export function clampMarkdownLines(lines: MarkdownLine[], maxLines: number): MarkdownLine[] {
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines;
  }

  const keptCount = Math.max(1, maxLines - 1);
  const truncatedCount = lines.length - keptCount;
  return [
    ...lines.slice(0, keptCount),
    { text: `... ${truncatedCount} more line${truncatedCount === 1 ? "" : "s"}`, dim: true },
  ];
}

/**
 * Convert markdown text to an array of MarkdownLine objects.
 * Each line represents a visual line in the output.
 * Ink will render each as a separate <Text> element inside a vertical <Box>.
 */
export function renderMarkdownLines(text: string): MarkdownLine[] {
  const lines = text.split('\n');
  const result: MarkdownLine[] = [];

  let inCodeBlock = false;
  let codeLanguage = '';

  for (const line of lines) {
    // Code block toggle
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        // Extract language from opening fence (e.g. ```ts -> "ts")
        const fenceMatch = line.trim().match(/^```(\w+)?/);
        codeLanguage = fenceMatch?.[1] ?? '';
      } else {
        codeLanguage = '';
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      const codeLine = '  ' + line;
      const segs = codeLanguage
        ? highlightCodeLine(line, codeLanguage)
        : undefined;
      result.push({ text: codeLine, dim: true, language: codeLanguage, segments: segs });
      continue;
    }

    const trimmed = line.trim();

    // Empty line -> blank separator
    if (trimmed === '') {
      result.push({ text: '' });
      continue;
    }

    // Headers -> bold text (strip # markers)
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      result.push({ text: headerMatch[2], bold: true });
      continue;
    }

    // Unordered list items -> bullet points
    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      const prefix = '  \u2022 ';
      const segs = parseInlineSegments(listMatch[1]);
      result.push({ text: prefix + flattenMarkdownSegments(segs), segments: prependMarkdownText(prefix, segs) });
      continue;
    }

    // Ordered list items -> numbered
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      const prefix = '  ' + orderedMatch[1] + '. ';
      const segs = parseInlineSegments(orderedMatch[2]);
      result.push({ text: prefix + flattenMarkdownSegments(segs), segments: prependMarkdownText(prefix, segs) });
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      result.push({ text: '\u2500'.repeat(40), dim: true });
      continue;
    }

    // Normal text -> parse inline segments
    const segs = parseInlineSegments(trimmed);
    const hasFormatting = segs.some((s) => s.bold || s.code || s.italic || s.color);
    if (hasFormatting) {
      result.push({ text: flattenMarkdownSegments(segs), segments: segs });
    } else {
      result.push({ text: flattenMarkdownSegments(segs) });
    }
  }

  return result;
}
