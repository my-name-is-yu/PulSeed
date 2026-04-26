import * as fsp from "node:fs/promises";
import type { IndexedFile, IndexedSymbol, SymbolKind } from "../contracts.js";

const SYMBOL_PATTERNS: Array<{ kind: SymbolKind; pattern: RegExp }> = [
  { kind: "class", pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/ },
  { kind: "method", pattern: /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/ },
  { kind: "test", pattern: /^\s*(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/ },
];

function estimateEndLine(lines: string[], startIndex: number): number {
  let depth = 0;
  let sawBrace = false;
  const maxEnd = Math.min(lines.length - 1, startIndex + 160);
  for (let i = startIndex; i <= maxEnd; i += 1) {
    const line = lines[i] ?? "";
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        sawBrace = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (sawBrace && depth <= 0 && i > startIndex) return i + 1;
    if (!sawBrace && i > startIndex && /^\s*(?:export\s+)?(?:class|interface|type|function|const)\s+/.test(line)) {
      return i;
    }
  }
  return Math.min(lines.length, startIndex + 80);
}

export async function buildSymbolIndex(files: IndexedFile[]): Promise<IndexedSymbol[]> {
  const symbols: IndexedSymbol[] = [];
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
    let content = "";
    try {
      content = await fsp.readFile(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }

    const enclosing: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const { kind, pattern } of SYMBOL_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        const name = match[1];
        const endLine = estimateEndLine(lines, i);
        const stableKey = `${file.path}#${kind}:${name}`;
        symbols.push({
          name,
          kind,
          signature: line.trim(),
          file: file.path,
          startLine: i + 1,
          endLine,
          startByte: offsets[i],
          endByte: offsets[Math.min(endLine, offsets.length - 1)],
          stableKey,
          enclosing: [...enclosing],
        });
        if (kind === "class" || kind === "function") enclosing.push(name);
        break;
      }
    }
  }
  return symbols;
}
