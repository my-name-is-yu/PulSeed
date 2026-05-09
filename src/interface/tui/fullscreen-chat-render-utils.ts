import { theme } from "./theme.js";
import { measureCharWidth, measureTextWidth } from "./text-width.js";
import type { RenderSegment } from "./fullscreen-chat-render-types.js";

export const SELECTION_BACKGROUND = theme.text;
export const SELECTION_FOREGROUND = "#1F2329";
export const FAKE_CURSOR_GLYPH = "▌";

export function charWidth(ch: string): number {
  return measureCharWidth(ch);
}

export function stringWidth(text: string): number {
  return measureTextWidth(text);
}

export function trimToWidth(text: string, width: number): string {
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

export function padToWidth(text: string, width: number): string {
  const trimmed = trimToWidth(text, width);
  const padding = Math.max(0, width - stringWidth(trimmed));
  return trimmed + " ".repeat(padding);
}

export function pushSegment(
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
