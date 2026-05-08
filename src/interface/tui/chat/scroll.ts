import type { ScrollRequest } from "./types.js";

const SGR_MOUSE_SEQUENCE = /(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])/;
const SGR_MOUSE_SEQUENCE_GLOBAL = /(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])/g;
const ESC_SHIFT_ENTER_SEQUENCE_GLOBAL = /\u001b\[27;2;13~/g;
const ESC_BRACKETED_PASTE_OPEN_GLOBAL = /\u001b\[200~/g;
const ESC_BRACKETED_PASTE_CLOSE_GLOBAL = /\u001b\[201~/g;
const RAW_SHIFT_ENTER_SEQUENCE = "[27;2;13~";
const RAW_BRACKETED_PASTE_WRAPPER = /^\[200~([\s\S]*)\[201~$/;
const SGR_MOUSE_INTEGER_TOKEN = /^\d+$/;

type ScrollKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
};

export type ParsedMouseEvent =
  | {
      kind: "wheel";
      direction: "up" | "down";
      x: number;
      y: number;
    }
  | {
      kind: "press" | "drag" | "release";
      button: "left" | "middle" | "right" | "other";
      x: number;
      y: number;
    };

export function parseMouseEvent(input: string): ParsedMouseEvent | null {
  const sgrMouseMatch = SGR_MOUSE_SEQUENCE.exec(input);
  if (!sgrMouseMatch) {
    return null;
  }

  const buttonCode = parseSgrMouseInteger(sgrMouseMatch[1]);
  const x = parseSgrMouseInteger(sgrMouseMatch[2]);
  const y = parseSgrMouseInteger(sgrMouseMatch[3]);
  const suffix = sgrMouseMatch[4];
  if (
    buttonCode === null ||
    x === null ||
    y === null ||
    !suffix
  ) {
    return null;
  }

  if (buttonCode >= 64) {
    const wheelButton = buttonCode & 0b11;
    if (wheelButton === 0) {
      return { kind: "wheel", direction: "up", x, y };
    }
    if (wheelButton === 1) {
      return { kind: "wheel", direction: "down", x, y };
    }
    return null;
  }

  const button = (() => {
    switch (buttonCode & 0b11) {
      case 0:
        return "left";
      case 1:
        return "middle";
      case 2:
        return "right";
      default:
        return "other";
    }
  })();

  if (suffix === "m") {
    return { kind: "release", button, x, y };
  }

  if ((buttonCode & 0b100000) !== 0) {
    return { kind: "drag", button, x, y };
  }

  return { kind: "press", button, x, y };
}

function parseSgrMouseInteger(value: string | undefined): number | null {
  if (value === undefined || !SGR_MOUSE_INTEGER_TOKEN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function getScrollRequest(
  inputChar: string,
  key: ScrollKey,
): ScrollRequest | null {
  const mouseEvent = parseMouseEvent(inputChar);
  if (mouseEvent?.kind === "wheel") {
    return { direction: mouseEvent.direction, kind: "line" };
  }
  if (key.pageUp || inputChar === "[5~") {
    return { direction: "up", kind: "page" };
  }
  if (key.pageDown || inputChar === "[6~") {
    return { direction: "down", kind: "page" };
  }
  if (key.ctrl && (inputChar === "u" || inputChar === "U")) {
    return { direction: "up", kind: "page" };
  }
  if (key.ctrl && (inputChar === "d" || inputChar === "D")) {
    return { direction: "down", kind: "page" };
  }
  if (key.ctrl && key.home) {
    return { direction: "up", kind: "top" };
  }
  if (key.ctrl && key.end) {
    return { direction: "down", kind: "bottom" };
  }
  if (key.meta && key.upArrow) {
    return { direction: "up", kind: "line" };
  }
  if (key.meta && key.downArrow) {
    return { direction: "down", kind: "line" };
  }
  if (key.shift && key.upArrow) {
    return { direction: "up", kind: "line" };
  }
  if (key.shift && key.downArrow) {
    return { direction: "down", kind: "line" };
  }
  return null;
}

export function getScrollLineStep(): number {
  const raw = process.env.PULSEED_SCROLL_SPEED;
  if (!raw) return 1;
  const normalized = raw.trim();
  if (!/^[0-9]+$/.test(normalized)) return 1;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return 1;
  return Math.max(1, Math.min(20, parsed));
}

export function stripMouseEscapeSequences(input: string): string {
  return input
    .replace(ESC_SHIFT_ENTER_SEQUENCE_GLOBAL, "\n")
    .replace(ESC_BRACKETED_PASTE_OPEN_GLOBAL, "")
    .replace(ESC_BRACKETED_PASTE_CLOSE_GLOBAL, "")
    .replace(SGR_MOUSE_SEQUENCE_GLOBAL, "");
}

export function normalizeTerminalInputChunk(input: string): string {
  if (input === RAW_SHIFT_ENTER_SEQUENCE) {
    return "\n";
  }

  const bracketedPasteMatch = RAW_BRACKETED_PASTE_WRAPPER.exec(input);
  if (bracketedPasteMatch) {
    return bracketedPasteMatch[1] ?? "";
  }

  return stripMouseEscapeSequences(input);
}
