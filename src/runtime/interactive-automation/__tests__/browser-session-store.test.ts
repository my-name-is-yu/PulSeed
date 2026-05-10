import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserSessionStore } from "../browser-session-store.js";

describe("BrowserSessionStore", () => {
  it("persists browser auth lifecycle in the control database without legacy session JSON", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-session-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthRequired({
        sessionId: "session-1",
        providerId: "browser",
        serviceKey: "app.example.com",
        workspace: "/workspace",
        actorKey: "chat-1",
        failureCode: "auth_required",
        failureMessage: "login required",
      });

      await expect(new BrowserSessionStore(tmpRuntime).listPendingAuth()).resolves.toEqual([
        expect.objectContaining({
          session_id: "session-1",
          state: "auth_required",
          last_failure_code: "auth_required",
        }),
      ]);

      await store.recordAuthenticated({
        sessionId: "session-1",
        providerId: "browser",
        serviceKey: "app.example.com",
        workspace: "/workspace",
        actorKey: "chat-1",
        expiresAt: "2099-05-11T00:00:00.000Z",
      });

      await expect(new BrowserSessionStore(tmpRuntime).findLatest({
        providerId: "browser",
        serviceKey: "app.example.com",
        workspace: "/workspace",
        actorKey: "chat-1",
      })).resolves.toEqual(expect.objectContaining({
        session_id: "session-1",
        state: "authenticated",
      }));
      await expect(fs.stat(path.join(tmpRuntime, "browser-sessions", "session-1.json"))).rejects.toThrow();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });
});
