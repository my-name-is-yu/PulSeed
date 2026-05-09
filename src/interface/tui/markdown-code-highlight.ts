import { theme } from "./theme.js";
import type { MarkdownSegment } from "./markdown-renderer-types.js";

const JS_TS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "break", "continue", "switch", "case", "default", "new", "delete",
  "typeof", "instanceof", "in", "of", "import", "export", "from", "as",
  "class", "extends", "super", "this", "static", "get", "set", "async",
  "await", "try", "catch", "finally", "throw", "void", "null", "undefined",
  "true", "false", "type", "interface", "enum", "namespace", "implements",
  "abstract", "readonly", "public", "private", "protected", "declare",
]);

const PY_KEYWORDS = new Set([
  "def", "class", "return", "import", "from", "as", "if", "elif", "else",
  "for", "while", "break", "continue", "pass", "and", "or", "not", "in",
  "is", "lambda", "with", "yield", "raise", "try", "except", "finally",
  "global", "nonlocal", "del", "assert", "True", "False", "None", "async",
  "await",
]);

function getKeywords(language: string): Set<string> {
  const lang = language.toLowerCase();
  if (["js", "ts", "javascript", "typescript", "tsx", "jsx"].includes(lang)) {
    return JS_TS_KEYWORDS;
  }
  if (lang === "python" || lang === "py") {
    return PY_KEYWORDS;
  }
  return new Set([...JS_TS_KEYWORDS, ...PY_KEYWORDS]);
}

/**
 * Apply basic keyword-based syntax highlighting to a single code line.
 * Returns an array of MarkdownSegment with color hints.
 */
export function highlightCodeLine(line: string, language: string): MarkdownSegment[] {
  if (/^\s*(\/\/|#)/.test(line)) {
    return [{ text: "  " + line, color: theme.codeComment }];
  }

  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const content = line.slice(indent.length);

  if (content === "") {
    return [{ text: "  " + indent }];
  }

  const keywords = getKeywords(language);
  const segments: MarkdownSegment[] = [];

  segments.push({ text: "  " + indent });

  const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+\.?\d*\b|\b[A-Za-z_$][\w$]*\b|[^\w\s"'`]|\s+)/g;
  let tm: RegExpExecArray | null;

  while ((tm = tokenPattern.exec(content)) !== null) {
    const token = tm[0];

    if (/^["'`]/.test(token)) {
      segments.push({ text: token, color: theme.codeString });
    } else if (/^\d/.test(token)) {
      segments.push({ text: token, color: theme.codeNumber });
    } else if (/^[A-Za-z_$]/.test(token) && keywords.has(token)) {
      segments.push({ text: token, color: theme.codeKeyword });
    } else {
      segments.push({ text: token });
    }
  }

  return segments;
}
