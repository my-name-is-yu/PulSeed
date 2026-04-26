import { describe, expect, it, vi } from "vitest";
import {
  buildChatViewport,
  estimateComposerHeight,
  formatSuggestionLabel,
  getInputPromptLabel,
  getMatchingSuggestions,
  normalizeTerminalInputChunk,
  parseMouseEvent,
  getScrollRequest,
  stripMouseEscapeSequences,
} from "../chat.js";
import {
  buildCollapsedPasteRange,
  buildComposerLines,
  buildFullscreenChatRenderLines,
  copySelectedInputText,
  getSelectedInputText,
  shouldCollapsePastedText,
} from "../fullscreen-chat.js";
import { estimateMarkdownHeight, estimateWrappedLineCount, wrapTextToRows } from "../markdown-renderer.js";
import { measureTextWidth } from "../text-width.js";
import { extractBashCommand, isBashModeInput, isSafeBashCommand, createShellApprovalTask, formatShellOutput } from "../bash-mode.js";
import {
  CARET_MARKER,
  INPUT_MARKER,
  buildCursorEscape,
  buildCursorEscapeFromCaretMarker,
  buildCursorEscapeFromInputMarker,
} from "../cursor-tracker.js";

describe("getMatchingSuggestions", () => {
  it("hides suggestions for an exact slash command so enter can submit", () => {
    expect(getMatchingSuggestions("/help", [])).toEqual([]);
    expect(getMatchingSuggestions("/config", [])).toEqual([]);
  });

  it("keeps suggestions for partial slash commands", () => {
    const matches = getMatchingSuggestions("/he", []);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.name).toBe("/help");
  });

  it("hides goal suggestions when a goal arg is fully typed", () => {
    expect(getMatchingSuggestions("/run improve-tests", ["improve-tests"])).toEqual([]);
    expect(getMatchingSuggestions("/start Improve-Tests", ["improve-tests"])).toEqual([]);
  });

  it("keeps goal suggestions for partial goal args", () => {
    const matches = getMatchingSuggestions("/run improve", ["improve-tests"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      name: "/run",
      description: "improve-tests",
      type: "goal",
    });
  });
});

describe("bash mode helpers", () => {
  it("detects bash mode input", () => {
    expect(isBashModeInput("!ls")).toBe(true);
    expect(isBashModeInput("  !ls")).toBe(true);
    expect(isBashModeInput("/help")).toBe(false);
  });

  it("extracts the shell command after !", () => {
    expect(extractBashCommand("!ls -la")).toBe("ls -la");
    expect(extractBashCommand("  !git status")).toBe("git status");
    expect(extractBashCommand("/help")).toBeNull();
  });

  it("builds an approval task for shell execution", () => {
    const task = createShellApprovalTask("ls -la", "/repo");
    expect(task.work_description).toContain("ls -la");
    expect(task.rationale).toContain("/repo");
    expect(task.reversibility).toBe("unknown");
  });

  it("recognizes safe shell commands", () => {
    expect(isSafeBashCommand("ls -la")).toBe(true);
    expect(isSafeBashCommand("git status")).toBe(true);
    expect(isSafeBashCommand("ps aux")).toBe(false);
  });

  it("formats shell output as markdown", () => {
    const text = formatShellOutput("echo hello", { stdout: "hello\n", stderr: "", exitCode: 0 });
    expect(text).toContain("```bash");
    expect(text).toContain("$ echo hello");
    expect(text).toContain("hello");
    expect(text).toContain("(exit 0)");
  });

  it("formats shell stderr directly", () => {
    const text = formatShellOutput("pws", { stdout: "", stderr: "zsh: command not found: pws\n", exitCode: 127 });
    expect(text).toContain("zsh: command not found: pws");
    expect(text).toContain("(exit 127)");
  });
});

describe("markdown sizing helpers", () => {
  it("estimates wrapped line count for narrow widths", () => {
    expect(estimateWrappedLineCount("abcdefghij", 5)).toBe(2);
    expect(estimateWrappedLineCount("a\nbcdef", 10)).toBe(2);
  });

  it("estimates markdown height", () => {
    expect(estimateMarkdownHeight("first\nsecond", 80)).toBe(2);
  });

  it("wraps plain text into terminal rows", () => {
    expect(wrapTextToRows("abcdefghij", 5)).toEqual(["abcde", "fghij"]);
  });

  it("wraps full-width unbroken text by terminal display width", () => {
    const rows = wrapTextToRows("これは改行のない長い日本語文章です".repeat(3), 20);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => measureTextWidth(row) <= 20)).toBe(true);
  });
});

describe("chat viewport", () => {
  it("keeps earlier rows available when scrolling back", () => {
    const messages = [
      {
        id: "m1",
        role: "pulseed" as const,
        text: [
          "line 1",
          "line 2",
          "line 3",
          "line 4",
          "line 5",
          "line 6",
          "line 7",
          "line 8",
          "line 9",
          "line 10",
        ].join("\n"),
        timestamp: new Date(),
      },
    ];

    const bottom = buildChatViewport(messages, 40, 8, 0);
    expect(bottom.totalRows).toBeGreaterThan(bottom.maxVisibleRows);
    expect(bottom.rows.some((row) => row.text.trim() === "line 10")).toBe(true);
    expect(bottom.rows.some((row) => row.text.trim() === "line 1")).toBe(false);

    const scrolled = buildChatViewport(messages, 40, 8, 3);
    expect(scrolled.hiddenAboveRows).toBe(0);
    expect(scrolled.rows.some((row) => row.text.trim() === "line 1")).toBe(true);
  });

  it("renders the processing row directly above the composer", () => {
    const messages = [
      {
        id: "m1",
        role: "pulseed" as const,
        text: "hello",
        timestamp: new Date(),
      },
    ];
    const viewport = buildChatViewport(messages, 40, 6, 0);

    const lines = buildFullscreenChatRenderLines({
      availableCols: 40,
      availableRows: 10,
      viewport,
      composerLines: [
        { key: "composer-helper", text: "helper" },
        { key: "composer-input", text: "input" },
      ],
      isProcessing: true,
      spinnerGlyph: "⠋",
      spinnerVerb: "Tiny-Blooming",
    });

    const keys = lines.map((line) => line.key);
    expect(keys.indexOf("indicator-bottom")).toBeLessThan(keys.indexOf("processing"));
    expect(keys.indexOf("processing")).toBeLessThan(keys.indexOf("composer-helper"));
  });

  it("keeps wrapped user rows within the terminal display width including the prompt", () => {
    const viewport = buildChatViewport([
      {
        id: "m1",
        role: "user" as const,
        text: "これは改行のない長い日本語文章です".repeat(3),
        timestamp: new Date(),
      },
    ], 32, 20, 0);

    const userRows = viewport.rows.filter((row) => row.kind === "user");

    expect(userRows.length).toBeGreaterThan(1);
    expect(userRows.every((row) => measureTextWidth(row.text) <= 26)).toBe(true);
  });
});

describe("composer sizing", () => {
  it("reserves extra height when input wraps inside the composer", () => {
    const singleLine = estimateComposerHeight({
      termCols: 40,
      input: "",
      bashMode: false,
      emptyHint: false,
      matches: [],
    });
    const wrappedInput = estimateComposerHeight({
      termCols: 20,
      input: "this is a deliberately long line that must wrap",
      bashMode: false,
      emptyHint: false,
      matches: [],
    });

    expect(wrappedInput).toBeGreaterThan(singleLine);
  });

  it("counts the trailing cursor cell when input exactly fills a line", () => {
    const exactFit = estimateComposerHeight({
      termCols: 10,
      input: "abcd",
      bashMode: false,
      emptyHint: false,
      matches: [],
    });

    expect(exactFit).toBe(5);
  });

  it("accounts for suggestions and helper text in composer height", () => {
    const base = estimateComposerHeight({
      termCols: 40,
      input: "/",
      bashMode: false,
      emptyHint: false,
      matches: [],
    });
    const matches = getMatchingSuggestions("/", []);
    const withMatches = estimateComposerHeight({
      termCols: 40,
      input: "/",
      bashMode: false,
      emptyHint: false,
      matches,
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(formatSuggestionLabel(matches[0]!).length).toBeGreaterThan(0);
    expect(withMatches).toBeGreaterThan(base);
  });
});

describe("chat scroll keys", () => {
  it("maps page and scrollback keys without touching arrow history keys", () => {
    expect(getScrollRequest("[5~", { pageUp: true })).toMatchObject({ direction: "up", kind: "page" });
    expect(getScrollRequest("[6~", { pageDown: true })).toMatchObject({ direction: "down", kind: "page" });
    expect(getScrollRequest("u", { ctrl: true })).toMatchObject({ direction: "up", kind: "page" });
    expect(getScrollRequest("d", { ctrl: true })).toMatchObject({ direction: "down", kind: "page" });
    expect(getScrollRequest("", { upArrow: true })).toBeNull();
    expect(getScrollRequest("", { downArrow: true })).toBeNull();
  });

  it("maps sgr mouse wheel sequences to line scroll requests", () => {
    expect(getScrollRequest("\u001b[<64;40;12M", {})).toMatchObject({ direction: "up", kind: "line" });
    expect(getScrollRequest("[<65;40;12M", {})).toMatchObject({ direction: "down", kind: "line" });
  });

  it("parses press, drag, and release mouse events for composer selection", () => {
    expect(parseMouseEvent("\u001b[<0;12;8M")).toEqual({
      kind: "press",
      button: "left",
      x: 12,
      y: 8,
    });
    expect(parseMouseEvent("\u001b[<32;16;8M")).toEqual({
      kind: "drag",
      button: "left",
      x: 16,
      y: 8,
    });
    expect(parseMouseEvent("\u001b[<0;16;8m")).toEqual({
      kind: "release",
      button: "left",
      x: 16,
      y: 8,
    });
  });

  it("strips sgr mouse sequences from input text", () => {
    expect(stripMouseEscapeSequences("hello\u001b[<64;40;12Mworld")).toBe("helloworld");
  });

  it("normalizes escape-prefixed shift-enter variants into newlines", () => {
    expect(stripMouseEscapeSequences("foo\u001b[27;2;13~bar")).toBe("foo\nbar");
    expect(stripMouseEscapeSequences("foo[27;2;13~bar")).toBe("foo[27;2;13~bar");
  });

  it("strips escape-prefixed bracketed-paste wrappers", () => {
    expect(stripMouseEscapeSequences("\u001b[200~hello\nworld\u001b[201~")).toBe("hello\nworld");
    expect(stripMouseEscapeSequences("[200~hello[201~")).toBe("[200~hello[201~");
  });

  it("normalizes raw terminal chunks without corrupting ordinary text", () => {
    expect(normalizeTerminalInputChunk("[27;2;13~")).toBe("\n");
    expect(normalizeTerminalInputChunk("[200~hello[201~")).toBe("hello");
    expect(normalizeTerminalInputChunk("foo[27;2;13~bar")).toBe("foo[27;2;13~bar");
    expect(normalizeTerminalInputChunk("notes [200~ literal")).toBe("notes [200~ literal");
  });
});

describe("composer clipboard selection", () => {
  it("extracts selected input text in drag direction order", () => {
    expect(getSelectedInputText("copy this text", { anchor: 0, focus: 4 })).toBe("copy");
    expect(getSelectedInputText("copy this text", { anchor: 9, focus: 5 })).toBe("this");
  });

  it("ignores empty composer selections", () => {
    expect(getSelectedInputText("copy", { anchor: 2, focus: 2 })).toBe("");
    expect(getSelectedInputText("copy", null)).toBe("");
  });

  it("copies the selected composer text through the clipboard boundary", async () => {
    const copy = vi.fn(async () => true);

    await expect(copySelectedInputText("copy this text", { anchor: 9, focus: 5 }, copy)).resolves.toBe(true);

    expect(copy).toHaveBeenCalledWith("this");
  });

  it("does not call the clipboard boundary for empty selections", async () => {
    const copy = vi.fn(async () => true);

    await expect(copySelectedInputText("copy", { anchor: 2, focus: 2 }, copy)).resolves.toBe(false);

    expect(copy).not.toHaveBeenCalled();
  });
});

describe("collapsed paste composer display", () => {
  it("detects long pasted chunks without collapsing short typing chunks", () => {
    expect(shouldCollapsePastedText("hello", "hello")).toBe(false);
    expect(shouldCollapsePastedText("a".repeat(120), "a".repeat(120))).toBe(true);
    expect(shouldCollapsePastedText("[200~line 1\nline 2\n".repeat(4) + "[201~", "line 1\nline 2\n".repeat(4))).toBe(true);
  });

  it("renders a collapsed paste label while preserving the original input range", () => {
    const pasted = "word ".repeat(40);
    const collapsedPaste = buildCollapsedPasteRange(pasted, 0);
    const composer = buildComposerLines({
      cols: 80,
      input: pasted,
      cursorOffset: pasted.length,
      bashMode: false,
      emptyHint: false,
      matches: [],
      selectedIdx: 0,
      copyToast: null,
      selection: null,
      collapsedPaste,
    });
    const rendered = composer.lines
      .flatMap((line) => line.segments?.map((segment) => segment.text) ?? [line.text ?? ""])
      .join("");

    expect(collapsedPaste.end).toBe(pasted.length);
    expect(rendered).toContain("[pasted 200 chars]");
    expect(rendered).not.toContain(pasted.slice(0, 40));
  });
});

describe("cursor tracker", () => {
  it("positions the caret from the marker column inside a bordered input box", () => {
    const frame = [
      "┌──────────────────┐",
      `│ \u001b[31m! \u001b[0m${INPUT_MARKER}hello │`,
      "└──────────────────┘",
    ].join("\n");

    expect(buildCursorEscape(frame, "abc")).toBe("\u001b[2;8H");
  });

  it("keeps the bash prompt label separate from the internal marker", () => {
    expect(getInputPromptLabel(true)).toBe("!");
    expect(getInputPromptLabel(false)).toBe("◉");
  });

  it("builds a cursor escape directly from the caret marker", () => {
    const frame = [
      "header",
      `│ ! abc${CARET_MARKER}def │`,
      "footer",
    ].join("\n");

    expect(buildCursorEscapeFromCaretMarker(frame)).toBe("\u001b[2;8H\u001b[?25h");
  });

  it("builds a cursor escape from the input marker and cursor column", () => {
    const frame = [
      "header",
      `│ ! ${INPUT_MARKER}abcdef │`,
      "footer",
    ].join("\n");

    expect(buildCursorEscapeFromInputMarker(frame, 3)).toBe("\u001b[2;8H\u001b[?25h");
  });
});
