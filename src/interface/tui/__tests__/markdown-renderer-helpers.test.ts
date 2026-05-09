import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { highlightCodeLine } from "../markdown-code-highlight.js";
import { parseInlineSegments } from "../markdown-inline.js";
import { theme } from "../theme.js";

describe("markdown inline helpers", () => {
  it("preserves formatting segment contracts", () => {
    expect(parseInlineSegments("Use **bold**, *italic*, and `code`")).toEqual([
      { text: "Use " },
      { text: "bold", bold: true },
      { text: ", " },
      { text: "italic", italic: true },
      { text: ", and " },
      { text: "code", code: true },
    ]);
  });

  it("shortens local absolute links with the existing home-relative display rule", () => {
    const localPath = path.join(process.cwd(), "src/interface/tui/markdown-renderer.ts");
    const expectedPath = `~/${localPath.slice(os.homedir().length + 1)}`;

    expect(parseInlineSegments(`See [renderer](${localPath})`)).toEqual([
      { text: "See " },
      { text: expectedPath, color: theme.info },
    ]);
  });
});

describe("markdown code highlighting helpers", () => {
  it("highlights language keywords and numbers", () => {
    const segments = highlightCodeLine("const value = 42", "ts");

    expect(segments).toContainEqual({ text: "const", color: theme.codeKeyword });
    expect(segments).toContainEqual({ text: "42", color: theme.codeNumber });
  });

  it("preserves comment-line highlighting with the renderer indent prefix", () => {
    expect(highlightCodeLine("// note", "ts")).toEqual([
      { text: "  // note", color: theme.codeComment },
    ]);
  });
});
