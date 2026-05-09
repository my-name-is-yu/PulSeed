import * as os from "node:os";
import * as path from "node:path";
import { theme } from "./theme.js";
import type { MarkdownSegment } from "./markdown-renderer-types.js";

export function flattenMarkdownSegments(segs: MarkdownSegment[]): string {
  return segs.map((s) => s.text).join("");
}

export function prependMarkdownText(prefix: string, segs: MarkdownSegment[]): MarkdownSegment[] {
  return [{ text: prefix }, ...segs];
}

/**
 * Parse inline markdown formatting into segments.
 * Handles: **bold**, __bold__, *italic*, _italic_, `code`, [links](url)
 */
export function parseInlineSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const pattern = /(\*{3}.+?\*{3}|\*{2}.+?\*{2}|_{2}.+?_{2}|\*.+?\*|_.+?_|`[^`]+`|\[[^\]]+\]\((?:[^()]|\([^)]*\))+(?:\s+"[^"]*")?\))/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, m.index) });
    }

    const raw = m[0];

    if (raw.startsWith("***") && raw.endsWith("***")) {
      segments.push({ text: raw.slice(3, -3), bold: true, italic: true });
    } else if (
      (raw.startsWith("**") && raw.endsWith("**")) ||
      (raw.startsWith("__") && raw.endsWith("__"))
    ) {
      segments.push({ text: raw.slice(2, -2), bold: true });
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      segments.push({ text: raw.slice(1, -1), code: true });
    } else if (
      (raw.startsWith("*") && raw.endsWith("*")) ||
      (raw.startsWith("_") && raw.endsWith("_"))
    ) {
      segments.push({ text: raw.slice(1, -1), italic: true });
    } else if (raw.startsWith("[")) {
      const linkMatch = raw.match(/^\[(.+?)\]\(((?:[^()]|\([^)]*\))+?)(?:\s+"[^"]*")?\)$/);
      const label = linkMatch?.[1] ?? raw;
      const destination = linkMatch?.[2] ?? "";
      segments.push({
        text: renderMarkdownLinkText(label, destination),
        color: theme.info,
      });
    } else {
      segments.push({ text: raw });
    }

    lastIndex = m.index + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text }];
}

function renderMarkdownLinkText(label: string, destination: string): string {
  if (!destination || !isLocalPathLikeLink(destination)) {
    return label;
  }

  return shortenLocalPath(destination.replace(/^file:\/\//, ""));
}

function isLocalPathLikeLink(destination: string): boolean {
  return destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    destination.startsWith("~/") ||
    destination.startsWith("file://");
}

function shortenLocalPath(destination: string): string {
  if (destination.startsWith("~/")) {
    return destination;
  }

  const homeDir = os.homedir();
  if (destination.startsWith(homeDir)) {
    return `~/${destination.slice(homeDir.length + 1)}`;
  }

  if (path.isAbsolute(destination)) {
    const relative = path.relative(process.cwd(), destination);
    if (relative && !relative.startsWith("..")) {
      return relative;
    }
  }

  return destination;
}
