import React from "react";
import { renderToString } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat.js";

const useInputMock = vi.hoisted(() => vi.fn());
const stdoutMock = vi.hoisted(() => ({
  columns: 80,
  rows: 24,
  write: vi.fn(() => true),
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: useInputMock,
    useStdout: () => ({ stdout: stdoutMock }),
  };
});

describe("TUI chat processing scroll input", () => {
  afterEach(() => {
    useInputMock.mockReset();
    stdoutMock.write = vi.fn(() => true);
  });

  it("keeps normal chat scroll input active while text input is locked during processing", async () => {
    const { Chat } = await import("../chat.js");
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
      id: `m-${index}`,
      role: "pulseed",
      text: `message ${index}`,
      timestamp: new Date(),
    }));

    renderToString(React.createElement(Chat, {
      messages,
      onSubmit: () => {},
      isProcessing: true,
      availableRows: 12,
      availableCols: 60,
      controlStream: { write: vi.fn() },
    }), { columns: 60 });

    expect(useInputMock).toHaveBeenCalledWith(expect.any(Function), { isActive: true });
    expect(useInputMock).toHaveBeenCalledWith(expect.any(Function), { isActive: false });
  });

  it("keeps fullscreen chat scroll input active during processing", async () => {
    const { FullscreenChat } = await import("../fullscreen-chat.js");
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
      id: `m-${index}`,
      role: "pulseed",
      text: `message ${index}`,
      timestamp: new Date(),
    }));

    renderToString(React.createElement(FullscreenChat, {
      messages,
      onSubmit: () => {},
      isProcessing: true,
      availableRows: 12,
      availableCols: 60,
    }), { columns: 60 });

    expect(useInputMock).toHaveBeenCalledWith(expect.any(Function), { isActive: true });
    expect(useInputMock).toHaveBeenCalledWith(expect.any(Function), { isActive: false });
  });
});
