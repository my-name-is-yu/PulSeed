import { afterEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { ChatSessionCatalog } from "../../chat/chat-session-store.js";
import {
  chatMessagesFromSession,
  parseChatCommandRequest,
  printChatCommandUsage,
  resolveSessionForIntent,
  runCatalogOnlyIntent,
} from "../commands/chat-session-cli.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

async function makeStateManager(): Promise<{ stateManager: StateManager; tmpDir: string }> {
  const tmpDir = makeTempDir();
  const stateManager = new StateManager(tmpDir);
  await stateManager.init();
  return { stateManager, tmpDir };
}

async function seedChatSession(stateManager: StateManager, id: string, title: string, cwd = "/repo"): Promise<void> {
  await stateManager.writeRaw(`chat/sessions/${id}.json`, {
    id,
    cwd,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    title,
    messages: [
      { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z", turnIndex: 0 },
      { role: "assistant", content: "hi", timestamp: "2026-01-01T00:00:01.000Z", turnIndex: 1 },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseChatCommandRequest", () => {
  it("parses continue without a selector", () => {
    const request = parseChatCommandRequest(["--continue"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "continue",
      selector: undefined,
    }));
  });

  it("parses continue with an optional selector", () => {
    const request = parseChatCommandRequest(["--continue", "nightly-session"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "continue",
      selector: "nightly-session",
    }));
  });

  it("parses resume with a selector and title", () => {
    const request = parseChatCommandRequest(["--resume", "session-123", "--title", "warm start"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "resume",
      selector: "session-123",
      title: "warm start",
    }));
  });

  it("parses short resume with a selector", () => {
    const request = parseChatCommandRequest(["-r", "session-123"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "resume",
      selector: "session-123",
    }));
  });

  it("parses title rename with an optional selector", () => {
    const request = parseChatCommandRequest(["--title", "warm start", "session-123"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "rename",
      selector: "session-123",
      title: "warm start",
    }));
  });

  it("cleanup enforces by default when dry-run is absent", () => {
    const request = parseChatCommandRequest(["--cleanup-sessions"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "cleanup",
      dryRun: false,
    }));
  });

  it("does not treat dry-run alone as cleanup", () => {
    const request = parseChatCommandRequest(["--dry-run", "inspect state"]);
    expect(request.intent).toBeNull();
    expect(request.task).toBe("inspect state");
  });

  it("parses cleanup with dry run", () => {
    const request = parseChatCommandRequest(["--cleanup-sessions", "--dry-run"]);
    expect(request.intent).toEqual(expect.objectContaining({
      action: "cleanup",
      dryRun: true,
    }));
  });

  it("treats a positional argument as a task when no session flags are present", () => {
    const request = parseChatCommandRequest(["refactor the chat entrypoint"]);
    expect(request.task).toBe("refactor the chat entrypoint");
    expect(request.intent).toBeNull();
  });
});

describe("printChatCommandUsage", () => {
  it("documents the chat session control surface and storage contract", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    printChatCommandUsage();

    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("--continue");
    expect(printed).toContain("--resume");
    expect(printed).toContain("~/.pulseed/chat/sessions/<id>.json");
    expect(printed).toContain("--cleanup-sessions");
  });
});

describe("chat session CLI helpers", () => {
  it("lists sessions and prints history", async () => {
    const { stateManager, tmpDir } = await makeStateManager();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await seedChatSession(stateManager, "session-1", "First");

      await expect(runCatalogOnlyIntent(stateManager, { action: "list" }, "/repo")).resolves.toBe(0);
      expect(writeSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("session-1");

      writeSpy.mockClear();
      await expect(runCatalogOnlyIntent(stateManager, { action: "history", selector: "First" }, "/repo")).resolves.toBe(0);
      const historyOutput = writeSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(historyOutput).toContain("User: hello");
      expect(historyOutput).toContain("Assistant: hi");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("renames and cleanup sessions through catalog-only intents", async () => {
    const { stateManager, tmpDir } = await makeStateManager();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await seedChatSession(stateManager, "session-1", "First", tmpDir);

      await expect(runCatalogOnlyIntent(stateManager, { action: "rename", selector: "session-1", title: "Renamed" }, tmpDir)).resolves.toBe(0);
      await expect(new ChatSessionCatalog(stateManager).loadSession("session-1")).resolves.toMatchObject({ title: "Renamed" });

      await expect(runCatalogOnlyIntent(stateManager, { action: "cleanup", dryRun: true }, tmpDir)).resolves.toBe(0);
      expect(writeSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("would remove");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("resolves resume intent and applies title rename before opening", async () => {
    const { stateManager, tmpDir } = await makeStateManager();
    try {
      await seedChatSession(stateManager, "session-1", "First", tmpDir);

      const resolved = await resolveSessionForIntent(
        new ChatSessionCatalog(stateManager),
        { action: "resume", selector: "session-1", title: "Warm Start" },
        tmpDir,
      );

      expect(resolved).toMatchObject({ id: "session-1", title: "Warm Start" });
      const messages = chatMessagesFromSession(resolved!);
      expect(messages.map((message) => message.text)).toEqual([
        "Resumed chat session session-1 \"Warm Start\".",
        "hello",
        "hi",
      ]);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
