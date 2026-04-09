import type { ScrollRequest } from "./types.js";

const SGR_MOUSE_SEQUENCE = /(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])/g;

type ScrollKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};

export function getScrollRequest(
  inputChar: string,
  key: ScrollKey,
): ScrollRequest | null {
  const sgrMouseMatch = SGR_MOUSE_SEQUENCE.exec(inputChar);
  SGR_MOUSE_SEQUENCE.lastIndex = 0;
  if (sgrMouseMatch) {
    const buttonCode = Number.parseInt(sgrMouseMatch[1] ?? "", 10);
    if (Number.isFinite(buttonCode) && buttonCode >= 64) {
      const wheelButton = buttonCode & 0b11;
      if (wheelButton === 0) {
        return { direction: "up", kind: "line" };
      }
      if (wheelButton === 1) {
        return { direction: "down", kind: "line" };
      }
    }
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

export function stripMouseEscapeSequences(input: string): string {
  return input.replace(SGR_MOUSE_SEQUENCE, "");
}
