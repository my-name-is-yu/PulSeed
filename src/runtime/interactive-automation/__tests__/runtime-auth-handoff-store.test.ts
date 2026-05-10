import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeAuthHandoffStore } from "../runtime-auth-handoff-store.js";

describe("RuntimeAuthHandoffStore", () => {
  it("persists pending handoffs and lifecycle transitions across store instances", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-auth-handoff-"));
    try {
      const store = new RuntimeAuthHandoffStore(tmpRuntime);
      const created = await store.createPending({
        providerId: "browser",
        serviceKey: "app.example.com",
        workspace: "/workspace",
        actorKey: "chat-1",
        browserSessionId: "session-1",
        resumableSessionId: "session-1",
        failureCode: "auth_required",
        failureMessage: "login required",
        taskSummary: "Open dashboard",
      });

      await expect(new RuntimeAuthHandoffStore(tmpRuntime).load(created.handoff_id)).resolves.toEqual(
        expect.objectContaining({
          schema_version: "runtime-auth-handoff-v1",
          handoff_id: created.handoff_id,
          state: "pending_operator",
          browser_session_id: "session-1",
          failure_code: "auth_required",
        }),
      );
      await expect(fs.stat(path.join(tmpRuntime, "auth-handoffs", `${created.handoff_id}.json`))).rejects.toThrow();

      await expect(store.transition(created.handoff_id, "completed", {
        browser_session_id: "session-1",
      })).resolves.toEqual(expect.objectContaining({
        state: "completed",
        completed_at: expect.any(String),
      }));
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("supersedes older active handoffs for the same provider service workspace and actor", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-auth-handoff-supersede-"));
    try {
      const store = new RuntimeAuthHandoffStore(tmpRuntime);
      const first = await store.createPending({
        providerId: "browser",
        serviceKey: "app.example.com",
        workspace: "/workspace",
        actorKey: "chat-1",
        browserSessionId: "session-1",
        taskSummary: "Open dashboard",
      });
      const second = await store.createPending({
        providerId: "browser",
        serviceKey: "app.example.com",
        workspace: "/workspace",
        actorKey: "chat-1",
        browserSessionId: "session-2",
        taskSummary: "Open dashboard again",
      });

      await expect(store.load(first.handoff_id)).resolves.toEqual(expect.objectContaining({
        state: "superseded",
        superseded_by_handoff_id: second.handoff_id,
      }));
      expect(second.supersedes_handoff_id).toBe(first.handoff_id);
      await expect(store.listActive()).resolves.toEqual([
        expect.objectContaining({
          handoff_id: second.handoff_id,
          state: "pending_operator",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });
});
