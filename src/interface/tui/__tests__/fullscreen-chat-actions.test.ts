import { describe, expect, it } from "vitest";
import {
  getNextOffset,
  getPreviousOffset,
  isBackspaceInput,
  isDeleteInput,
  summarizeKey,
} from "../fullscreen-chat-actions.js";

describe("fullscreen chat action helpers", () => {
  it("moves cursor offsets across surrogate pairs as one character", () => {
    const text = "A😀B";

    expect(getNextOffset(text, 0)).toBe(1);
    expect(getNextOffset(text, 1)).toBe(3);
    expect(getNextOffset(text, 3)).toBe(4);
    expect(getNextOffset(text, 4)).toBe(4);

    expect(getPreviousOffset(text, 4)).toBe(3);
    expect(getPreviousOffset(text, 3)).toBe(1);
    expect(getPreviousOffset(text, 1)).toBe(0);
    expect(getPreviousOffset(text, 0)).toBe(0);
  });

  it("recognizes terminal backspace and delete inputs without broadening text handling", () => {
    expect(isBackspaceInput("", { backspace: true })).toBe(true);
    expect(isBackspaceInput("\u007f", {})).toBe(true);
    expect(isBackspaceInput("\b", {})).toBe(true);
    expect(isBackspaceInput("h", { ctrl: true })).toBe(true);
    expect(isBackspaceInput("", { delete: true })).toBe(true);
    expect(isBackspaceInput("x", {})).toBe(false);

    expect(isDeleteInput("[3~", {})).toBe(true);
    expect(isDeleteInput("\u001b[3~", {})).toBe(true);
    expect(isDeleteInput("", { delete: true })).toBe(false);
  });

  it("summarizes only truthy key flags for debug output", () => {
    expect(summarizeKey({
      ctrl: true,
      meta: false,
      shift: true,
      name: "return",
      return: true,
    })).toEqual({
      ctrl: true,
      shift: true,
      return: true,
    });
  });
});
